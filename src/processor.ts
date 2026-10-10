import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";
import parser from "stream-json";
import { pick } from "stream-json/filters/pick.js";
import { streamArray } from "stream-json/streamers/stream-array.js";
import { PlaceCandidate, summarizeCatalogue } from "./catalogue.js";

export type SourceKind =
  "GEONAMES_TSV" | "PLEIADES_CSV" | "PLEIADES_JSON" | "NORMALIZED_JSONL";

export type SourceDefinition = {
  id: string;
  kind: SourceKind;
  path: string;
  dataset: string;
  license: string;
  url?: string;
  archiveEntry?: string;
};

type SourceConfiguration = { version: number; sources: SourceDefinition[] };

export type Rejection = {
  source: string;
  externalId: string | null;
  reason: string;
  detail?: string;
};

export type ProcessResult = {
  candidates: PlaceCandidate[];
  catalogue: PlaceCandidate[];
  rejections: Rejection[];
  duplicates: Array<{ key: string; stableIds: string[]; names: string[] }>;
  sourceStats: Record<string, { accepted: number; rejected: number }>;
  /** Pinned source/licence registry captured in every release manifest. */
  sources: SourceDefinition[];
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectPath = (path: string) =>
  isAbsolute(path) ? path : resolve(ROOT, path);
const relevantCodes = new Set([
  "PPLC",
  "PPLCH",
  "PPLA",
  "PPLA2",
  "ANS",
  "MUS",
  "RGNH",
]);
const modernPopulationThreshold = 5000;
/**
 * Gazetteers often represent a name that is still in use with an arbitrary
 * upper bound (for example, Pleiades uses 2100).  Tempvs represents that
 * explicitly as an open-ended interval instead: an omitted validTo means the
 * name remains applicable today and into the future.  Keeping the reference
 * year here makes a regenerated bundle follow the calendar without making
 * historical end dates disappear.
 */
const openEndedAtOrAfterYear = new Date().getUTCFullYear();

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numericValue(value: unknown): number | undefined {
  const valueAsNumber = typeof value === "number" ? value : Number(value);
  return Number.isFinite(valueAsNumber) ? valueAsNumber : undefined;
}

function confidenceValue(
  value: unknown,
): PlaceCandidate["confidence"] | undefined {
  return [
    "IMPORTED",
    "CURATED",
    "USER_CONTRIBUTED",
    "UNVERIFIED",
    "DISPUTED",
  ].includes(value as string)
    ? (value as PlaceCandidate["confidence"])
    : undefined;
}

function provenanceValues(
  value: unknown,
): PlaceCandidate["sources"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sources = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const source = item as Record<string, unknown>;
    const dataset = stringValue(source.dataset);
    const externalId = stringValue(source.externalId);
    const license = stringValue(source.license);
    return dataset && externalId && license
      ? [{ dataset, externalId, license }]
      : [];
  });
  return sources.length ? sources : undefined;
}

function validPoint(
  latitude: number | undefined,
  longitude: number | undefined,
): boolean {
  return (
    latitude !== undefined &&
    longitude !== undefined &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

function cleanAliases(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function cleanHistoricalNames(
  values: NonNullable<PlaceCandidate["names"]>,
): NonNullable<PlaceCandidate["names"]> {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const name = value.value.trim();
    if (
      !name ||
      (value.validFrom !== undefined &&
        value.validTo !== undefined &&
        value.validFrom > value.validTo)
    )
      return [];
    const validTo =
      value.validTo !== undefined && value.validTo >= openEndedAtOrAfterYear
        ? undefined
        : value.validTo;
    const key = JSON.stringify([
      name,
      value.language ?? null,
      value.validFrom ?? null,
      validTo ?? null,
      value.confidence ?? null,
      value.sources?.map((source) => [
        source.dataset,
        source.externalId,
        source.license,
      ]) ?? null,
    ]);
    if (seen.has(key)) return [];
    seen.add(key);
    const nameWithoutEnd = { ...value };
    delete nameWithoutEnd.validTo;
    return [
      {
        ...nameWithoutEnd,
        value: name,
        ...(validTo !== undefined ? { validTo } : {}),
      },
    ];
  });
}

function sourceOf(source: SourceDefinition, externalId: string) {
  return { dataset: source.dataset, externalId, license: source.license };
}

function candidate(
  source: SourceDefinition,
  externalId: string,
  name: string,
  latitude: number,
  longitude: number,
  featureType: string,
  selectionReasons: string[],
  aliases: string[] = [],
  periods: string[] = [],
  names: NonNullable<PlaceCandidate["names"]> = [],
  parentStableId?: string,
  parentRelation?: PlaceCandidate["parentRelation"],
  containmentRelations?: PlaceCandidate["containmentRelations"],
): PlaceCandidate {
  return {
    stableId: `${source.id}:${externalId}`,
    name,
    aliases: cleanAliases(aliases.filter((alias) => alias !== name)),
    ...(names.length ? { names: cleanHistoricalNames(names) } : {}),
    latitude,
    longitude,
    featureType,
    ...(parentStableId ? { parentStableId } : {}),
    ...(parentStableId && parentRelation
      ? {
          parentRelation: {
            ...parentRelation,
            ...(parentRelation.sources?.length
              ? {
                  sources: parentRelation.sources.map((value) => ({
                    ...value,
                  })),
                }
              : { sources: [sourceOf(source, externalId)] }),
          },
        }
      : {}),
    ...(containmentRelations?.length
      ? {
          containmentRelations: containmentRelations.map((relation) => ({
            ...relation,
            ...(relation.sources?.length
              ? { sources: relation.sources.map((value) => ({ ...value })) }
              : { sources: [sourceOf(source, externalId)] }),
          })),
        }
      : {}),
    periods: [...new Set(periods)],
    selectionReasons: [...new Set(selectionReasons)],
    sources: [sourceOf(source, externalId)],
  };
}

type PleiadesName = {
  romanized?: unknown;
  attested?: unknown;
  language?: unknown;
  start?: unknown;
  end?: unknown;
};

type PleiadesPlace = {
  id?: unknown;
  title?: unknown;
  reprPoint?: unknown;
  placeTypes?: unknown;
  placeTypeURIs?: unknown;
  names?: unknown;
};

function historicalYear(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function pleiadesFeatureType(place: PleiadesPlace): string {
  const types = Array.isArray(place.placeTypes)
    ? place.placeTypes
    : Array.isArray(place.placeTypeURIs)
      ? place.placeTypeURIs
      : [];
  const type = types.find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  return (
    type?.split("/").filter(Boolean).at(-1)?.toUpperCase() || "HISTORIC_PLACE"
  );
}

function pleiadesNames(
  place: PleiadesPlace,
): NonNullable<PlaceCandidate["names"]> {
  if (!Array.isArray(place.names)) return [];
  return cleanHistoricalNames(
    place.names.flatMap((raw) => {
      if (!raw || typeof raw !== "object") return [];
      const name = raw as PleiadesName;
      const value = stringValue(name.romanized) ?? stringValue(name.attested);
      if (!value) return [];
      const language = stringValue(name.language);
      const validFrom = historicalYear(name.start);
      const validTo = historicalYear(name.end);
      return [
        {
          value,
          ...(language ? { language } : {}),
          ...(validFrom !== undefined ? { validFrom } : {}),
          ...(validTo !== undefined ? { validTo } : {}),
        },
      ];
    }),
  );
}

async function processGeoNames(
  source: SourceDefinition,
  result: ProcessResult,
): Promise<void> {
  const rows = createInterface({
    input: createReadStream(projectPath(source.path)),
    crlfDelay: Infinity,
  });
  for await (const row of rows) {
    if (!row.trim() || row.startsWith("#")) continue;
    const fields = row.split("\t");
    const [
      externalId,
      name,
      asciiName,
      alternateNames,
      latitudeRaw,
      longitudeRaw,
      featureClass,
      featureCode,
      countryCode,
      ,
      admin1Code,
      ,
      ,
      ,
      populationRaw,
    ] = fields;
    const latitude = numericValue(latitudeRaw);
    const longitude = numericValue(longitudeRaw);
    const population = numericValue(populationRaw) ?? 0;
    if (!externalId || !name || !validPoint(latitude, longitude)) {
      result.rejections.push({
        source: source.id,
        externalId: externalId ?? null,
        reason: "INVALID_REQUIRED_DATA",
      });
      result.sourceStats[source.id].rejected += 1;
      continue;
    }
    const reasons: string[] = [];
    if (
      featureCode === "PPLC" ||
      featureCode === "PPLCH" ||
      featureCode.startsWith("PPLA")
    )
      reasons.push("CAPITAL_OR_ADMINISTRATIVE_CENTRE");
    if (featureCode === "RGNH") reasons.push("REGIONAL_CENTRE");
    if (relevantCodes.has(featureCode) && featureCode === "MUS")
      reasons.push("MUSEUM_ARCHIVE_OR_REPOSITORY");
    if (population >= modernPopulationThreshold)
      reasons.push("MODERN_POPULATION_THRESHOLD");
    if (
      featureClass === "S" &&
      ["ANS", "HSTS", "ARCH", "RUIN"].some((code) => featureCode.includes(code))
    )
      reasons.push("HISTORIC_OR_ARCHAEOLOGICAL_SITE");
    if (!reasons.length && !relevantCodes.has(featureCode)) {
      result.rejections.push({
        source: source.id,
        externalId,
        reason: "BELOW_SIGNIFICANCE_THRESHOLD",
        detail: `feature=${featureCode}; population=${population}`,
      });
      result.sourceStats[source.id].rejected += 1;
      continue;
    }
    const aliases = [asciiName, ...(alternateNames ?? "").split(",")].filter(
      (alias): alias is string => Boolean(alias),
    );
    result.candidates.push(
      candidate(
        source,
        externalId,
        modernSettlementDisplayName(name, countryCode, admin1Code),
        latitude!,
        longitude!,
        featureClass === "P" ? "SETTLEMENT" : featureCode,
        reasons,
        [name, ...aliases],
        ["CONTEMPORARY"],
      ),
    );
    result.sourceStats[source.id].accepted += 1;
  }
}

/**
 * GeoNames supplies a settlement and ISO administrative codes, not the
 * complete human-facing label. Keep the short settlement name as an alias for
 * lookup, while making a modern canonical display label unambiguous. The US
 * convention includes its state abbreviation because country alone is often
 * insufficient (for example, King of Prussia, PA, USA).
 */
export function modernSettlementDisplayName(
  settlement: string,
  countryCode: string | undefined,
  admin1Code: string | undefined,
): string {
  const name = settlement.trim();
  const country = countryCode ? countryDisplayName(countryCode) : undefined;
  if (!country) return name;
  if (countryCode === "US" && admin1Code?.trim())
    return `${name}, ${admin1Code.trim()}, ${country}`;
  return `${name}, ${country}`;
}

function countryDisplayName(code: string): string | undefined {
  try {
    const display = new Intl.DisplayNames(["en"], { type: "region" }).of(code);
    if (!display || display === code) return undefined;
    // Product copy uses USA rather than the longer formal country name.
    return code === "US" ? "USA" : display;
  } catch {
    return undefined;
  }
}

function headerValue(
  row: Record<string, string>,
  candidates: string[],
): string | undefined {
  const lookup = new Map(
    Object.entries(row).map(([key, value]) => [
      key.toLowerCase().replaceAll("_", ""),
      value,
    ]),
  );
  for (const key of candidates) {
    const value = lookup.get(key.toLowerCase().replaceAll("_", ""));
    if (value !== undefined) return value;
  }
  return undefined;
}

async function processPleiades(
  source: SourceDefinition,
  result: ProcessResult,
): Promise<void> {
  const text = await readFile(projectPath(source.path), "utf8");
  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as Record<string, string>[];
  for (const row of rows) {
    const externalId = headerValue(row, ["id", "pid"]);
    const name = headerValue(row, ["title", "name"]);
    const latitude = numericValue(
      headerValue(row, [
        "reprLat",
        "representative_latitude",
        "latitude",
        "lat",
      ]),
    );
    const longitude = numericValue(
      headerValue(row, [
        "reprLong",
        "representative_longitude",
        "longitude",
        "long",
        "lon",
      ]),
    );
    if (!externalId || !name || !validPoint(latitude, longitude)) {
      result.rejections.push({
        source: source.id,
        externalId: externalId ?? null,
        reason: "INVALID_REQUIRED_DATA",
      });
      result.sourceStats[source.id].rejected += 1;
      continue;
    }
    const aliases = (
      headerValue(row, ["names", "alternate_names", "aliases"]) ?? ""
    ).split("|");
    const placeTypes = headerValue(row, ["place_types", "placeTypes", "type"]);
    result.candidates.push(
      candidate(
        source,
        externalId,
        name,
        latitude!,
        longitude!,
        placeTypes?.toUpperCase() || "HISTORIC_PLACE",
        ["CURATED_HISTORICAL_GAZETTEER"],
        aliases,
        ["ANTIQUITY"],
      ),
    );
    result.sourceStats[source.id].accepted += 1;
  }
}

/**
 * Pleiades' legacy GIS CSV intentionally has no per-name chronology. The
 * comprehensive JSON export has each Name's romanized/attested value and its
 * exact known start/end years, so process it as a stream rather than loading
 * the multi-gigabyte decompressed document into memory.
 */
async function processPleiadesJson(
  source: SourceDefinition,
  result: ProcessResult,
): Promise<void> {
  const sourcePath = projectPath(source.path);
  const raw = createReadStream(sourcePath);
  const decoded = sourcePath.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  const records = decoded
    .pipe(parser())
    .pipe(pick.asStream({ filter: "@graph" }))
    .pipe(streamArray.asStream());
  for await (const item of records as AsyncIterable<{ value: unknown }>) {
    if (
      !item.value ||
      typeof item.value !== "object" ||
      Array.isArray(item.value)
    ) {
      result.rejections.push({
        source: source.id,
        externalId: null,
        reason: "INVALID_REQUIRED_DATA",
      });
      result.sourceStats[source.id].rejected += 1;
      continue;
    }
    const place = item.value as PleiadesPlace;
    const externalId = stringValue(place.id);
    const name = stringValue(place.title);
    const coordinates = Array.isArray(place.reprPoint) ? place.reprPoint : [];
    const longitude = numericValue(coordinates[0]);
    const latitude = numericValue(coordinates[1]);
    if (!externalId || !name || !validPoint(latitude, longitude)) {
      result.rejections.push({
        source: source.id,
        externalId: externalId ?? null,
        reason: "INVALID_REQUIRED_DATA",
      });
      result.sourceStats[source.id].rejected += 1;
      continue;
    }
    const names = pleiadesNames(place);
    result.candidates.push(
      candidate(
        source,
        externalId,
        name,
        latitude!,
        longitude!,
        pleiadesFeatureType(place),
        ["CURATED_HISTORICAL_GAZETTEER"],
        names.map((entry) => entry.value),
        ["ANTIQUITY"],
        names,
      ),
    );
    result.sourceStats[source.id].accepted += 1;
  }
}

async function processNormalized(
  source: SourceDefinition,
  result: ProcessResult,
): Promise<void> {
  const rows = createInterface({
    input: createReadStream(projectPath(source.path)),
    crlfDelay: Infinity,
  });
  for await (const row of rows) {
    if (!row.trim()) continue;
    const raw = JSON.parse(row) as Record<string, unknown>;
    const externalId = stringValue(raw.id) ?? stringValue(raw.stableId);
    const name = stringValue(raw.name);
    const latitude = numericValue(raw.latitude);
    const longitude = numericValue(raw.longitude);
    const featureType = stringValue(raw.featureType);
    const selectionReasons = Array.isArray(raw.selectionReasons)
      ? raw.selectionReasons.filter(
          (reason): reason is string => typeof reason === "string",
        )
      : [];
    if (
      !externalId ||
      !name ||
      !featureType ||
      !validPoint(latitude, longitude)
    ) {
      result.rejections.push({
        source: source.id,
        externalId: externalId ?? null,
        reason: "INVALID_REQUIRED_DATA",
      });
      result.sourceStats[source.id].rejected += 1;
      continue;
    }
    if (!selectionReasons.length) {
      result.rejections.push({
        source: source.id,
        externalId,
        reason: "NO_SELECTION_REASON",
      });
      result.sourceStats[source.id].rejected += 1;
      continue;
    }
    const aliases = Array.isArray(raw.aliases)
      ? raw.aliases.filter(
          (alias): alias is string => typeof alias === "string",
        )
      : [];
    const names = Array.isArray(raw.names)
      ? raw.names.flatMap((name) => {
          if (!name || typeof name !== "object") return [];
          const entry = name as Record<string, unknown>;
          const value = stringValue(entry.value);
          if (!value) return [];
          const language = stringValue(entry.language);
          const validFrom = historicalYear(entry.validFrom);
          const validTo = historicalYear(entry.validTo);
          const confidence = confidenceValue(entry.confidence);
          const sources = provenanceValues(entry.sources);
          return [
            {
              value,
              ...(language ? { language } : {}),
              ...(validFrom !== undefined ? { validFrom } : {}),
              ...(validTo !== undefined ? { validTo } : {}),
              ...(confidence ? { confidence } : {}),
              ...(sources ? { sources } : {}),
            },
          ];
        })
      : [];
    const periods = Array.isArray(raw.periods)
      ? raw.periods.filter(
          (period): period is string => typeof period === "string",
        )
      : [];
    const rawParentStableId = stringValue(raw.parentStableId);
    const parentStableId = rawParentStableId
      ? rawParentStableId.includes(":")
        ? rawParentStableId
        : `${source.id}:${rawParentStableId}`
      : undefined;
    const rawParentRelation = raw.parentRelation;
    const parentRelation =
      rawParentRelation && typeof rawParentRelation === "object"
        ? (() => {
            const relation = rawParentRelation as Record<string, unknown>;
            const validFrom = historicalYear(relation.validFrom);
            const validTo = historicalYear(relation.validTo);
            const confidence = confidenceValue(relation.confidence);
            const sources = provenanceValues(relation.sources);
            return {
              ...(validFrom !== undefined ? { validFrom } : {}),
              ...(validTo !== undefined ? { validTo } : {}),
              ...(confidence ? { confidence } : {}),
              ...(sources ? { sources } : {}),
            };
          })()
        : undefined;
    const containmentRelations = Array.isArray(raw.containmentRelations)
      ? raw.containmentRelations.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const relation = value as Record<string, unknown>;
          const rawStableId = stringValue(relation.parentStableId);
          if (!rawStableId) return [];
          const validFrom = historicalYear(relation.validFrom);
          const validTo = historicalYear(relation.validTo);
          const confidence = confidenceValue(relation.confidence);
          const sources = provenanceValues(relation.sources);
          return [
            {
              parentStableId: rawStableId.includes(":")
                ? rawStableId
                : `${source.id}:${rawStableId}`,
              ...(validFrom !== undefined ? { validFrom } : {}),
              ...(validTo !== undefined ? { validTo } : {}),
              ...(confidence ? { confidence } : {}),
              ...(sources ? { sources } : {}),
            },
          ];
        })
      : undefined;
    result.candidates.push(
      candidate(
        source,
        externalId,
        name,
        latitude!,
        longitude!,
        featureType,
        selectionReasons,
        aliases,
        periods,
        names,
        parentStableId,
        parentRelation,
        containmentRelations,
      ),
    );
    result.sourceStats[source.id].accepted += 1;
  }
}

function duplicateClusters(
  candidates: PlaceCandidate[],
): ProcessResult["duplicates"] {
  const clusters = new Map<string, Map<string, PlaceCandidate>>();
  for (const place of candidates) {
    // A modern canonical label may be qualified ("Rome, Italy") while a
    // historical source still calls the same point simply "Rome". Compare
    // every explicitly retained name at the same approximate point, instead
    // of treating display qualification as evidence that two records differ.
    const labels = [
      place.name,
      ...(place.aliases ?? []),
      ...(place.names ?? []).map((name) => name.value),
    ];
    for (const label of new Set(labels.map(normalizeDuplicateLabel))) {
      if (!label) continue;
      const key = `${label}@${place.latitude.toFixed(2)},${place.longitude.toFixed(2)}`;
      const cluster = clusters.get(key) ?? new Map<string, PlaceCandidate>();
      cluster.set(place.stableId, place);
      clusters.set(key, cluster);
    }
  }
  const emitted = new Set<string>();
  return [...clusters.entries()]
    .map(([key, items]) => ({ key, items: [...items.values()] }))
    .filter(({ items }) => items.length > 1)
    .filter(({ items }) => {
      const signature = items
        .map((item) => item.stableId)
        .sort()
        .join("|");
      if (emitted.has(signature)) return false;
      emitted.add(signature);
      return true;
    })
    .map(({ key, items }) => ({
      key,
      stableIds: items.map((item) => item.stableId),
      names: items.map((item) => item.name),
    }));
}

function normalizeDuplicateLabel(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLocaleLowerCase();
}

export async function loadSourceConfig(
  configPath: string,
): Promise<SourceConfiguration> {
  const raw = JSON.parse(
    await readFile(projectPath(configPath), "utf8"),
  ) as SourceConfiguration;
  if (!raw || raw.version !== 1 || !Array.isArray(raw.sources))
    throw new Error(`Invalid source configuration: ${configPath}`);
  for (const source of raw.sources) {
    if (
      !source.id ||
      !source.path ||
      !source.dataset ||
      !source.license ||
      ![
        "GEONAMES_TSV",
        "PLEIADES_CSV",
        "PLEIADES_JSON",
        "NORMALIZED_JSONL",
      ].includes(source.kind)
    ) {
      throw new Error(`Invalid source definition in ${configPath}`);
    }
  }
  return raw;
}

export async function processSources(
  configPath = "config/sources.json",
): Promise<ProcessResult> {
  const config = await loadSourceConfig(configPath);
  const result: ProcessResult = {
    candidates: [],
    catalogue: [],
    rejections: [],
    duplicates: [],
    sourceStats: {},
    sources: config.sources.map((source) => ({ ...source })),
  };
  for (const source of config.sources) {
    result.sourceStats[source.id] = { accepted: 0, rejected: 0 };
    if (!existsSync(projectPath(source.path))) {
      result.rejections.push({
        source: source.id,
        externalId: null,
        reason: "SOURCE_FILE_NOT_FOUND",
        detail: source.path,
      });
      result.sourceStats[source.id].rejected += 1;
      continue;
    }
    if (source.kind === "GEONAMES_TSV") await processGeoNames(source, result);
    if (source.kind === "PLEIADES_CSV") await processPleiades(source, result);
    if (source.kind === "PLEIADES_JSON")
      await processPleiadesJson(source, result);
    if (source.kind === "NORMALIZED_JSONL")
      await processNormalized(source, result);
  }
  result.catalogue = [...result.candidates].sort((a, b) =>
    a.stableId.localeCompare(b.stableId),
  );
  result.duplicates = duplicateClusters(result.catalogue);
  return result;
}

async function writeJsonl(
  path: string,
  values: unknown[],
): Promise<{ sha256: string; bytes: number }> {
  await mkdir(dirname(path), { recursive: true });
  const body =
    values
      .map((value) => JSON.stringify(value))
      .join(values.length ? "\n" : "") + (values.length ? "\n" : "");
  await writeFile(path, body, "utf8");
  return {
    sha256: createHash("sha256").update(body).digest("hex"),
    bytes: Buffer.byteLength(body),
  };
}

export async function writeBundle(
  result: ProcessResult,
  outDirectory: string,
): Promise<void> {
  const output = projectPath(outDirectory);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const candidates = await writeJsonl(
    join(output, "candidates.jsonl"),
    result.candidates,
  );
  const catalogue = await writeJsonl(
    join(output, "catalogue.jsonl"),
    result.catalogue,
  );
  const rejections = await writeJsonl(
    join(output, "rejections.jsonl"),
    result.rejections,
  );
  const summary = {
    ...summarizeCatalogue(result.catalogue),
    rejections: result.rejections.length,
    duplicateClusters: result.duplicates.length,
    sourceStats: result.sourceStats,
  };
  await writeFile(
    join(output, "duplicates.json"),
    JSON.stringify(result.duplicates, null, 2) + "\n",
  );
  await writeFile(
    join(output, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  const manifest = {
    version: 1,
    /** Derived only from deterministic file contents, never from createdAt.
     * It is therefore safe to use as the immutable release/audit key across
     * dev, staging, and production imports. */
    artifactId: `geo-v1-${createHash("sha256")
      .update(candidates.sha256)
      .update(catalogue.sha256)
      .update(rejections.sha256)
      .digest("hex")
      .slice(0, 24)}`,
    transformVersion: 1,
    createdAt: new Date().toISOString(),
    files: {
      "candidates.jsonl": candidates,
      "catalogue.jsonl": catalogue,
      "rejections.jsonl": rejections,
    },
    summary,
    sourceRegistry: result.sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      dataset: source.dataset,
      license: source.license,
      ...(source.url ? { url: source.url } : {}),
      ...(source.archiveEntry ? { archiveEntry: source.archiveEntry } : {}),
    })),
    deterministicInputs: true,
    note: "Cross-source duplicate clusters are review hints and are never auto-merged.",
  };
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

export async function fetchSource(
  sourceId: string,
  configPath = "config/sources.json",
  force = false,
): Promise<string> {
  const config = await loadSourceConfig(configPath);
  const source = config.sources.find((entry) => entry.id === sourceId);
  if (!source) throw new Error(`Unknown source: ${sourceId}`);
  if (!source.url)
    throw new Error(
      `${sourceId} is supplied locally; no download URL is configured.`,
    );
  const destination = projectPath(source.path);
  if (existsSync(destination) && !force) return `Using cached ${source.path}`;
  const response = await fetch(source.url, { redirect: "follow" });
  if (!response.ok || !response.body)
    throw new Error(`Download failed for ${sourceId}: HTTP ${response.status}`);
  const archive = join(
    projectPath("data/raw/.downloads"),
    `${source.id}-${basename(new URL(source.url).pathname)}`,
  );
  await mkdir(dirname(archive), { recursive: true });
  await pipeline(
    response.body as unknown as NodeJS.ReadableStream,
    createWriteStream(archive),
  );
  if (source.archiveEntry) {
    const zip = new AdmZip(archive);
    const entry = zip.getEntry(source.archiveEntry);
    if (!entry)
      throw new Error(
        `${source.archiveEntry} is not present in downloaded ${sourceId} archive.`,
      );
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, entry.getData());
  } else {
    await mkdir(dirname(destination), { recursive: true });
    await pipeline(createReadStream(archive), createWriteStream(destination));
  }
  const digest = createHash("sha256")
    .update(await readFile(destination))
    .digest("hex");
  const metadata = {
    sourceId,
    url: source.url,
    license: source.license,
    fetchedAt: new Date().toISOString(),
    sha256: digest,
    bytes: (await stat(destination)).size,
  };
  await writeFile(
    `${destination}.metadata.json`,
    JSON.stringify(metadata, null, 2) + "\n",
  );
  return `Fetched ${sourceId} to ${source.path} (${metadata.bytes} bytes, sha256 ${digest})`;
}
