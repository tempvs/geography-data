import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";
import { PlaceCandidate, summarizeCatalogue } from "./catalogue.js";

export type SourceKind = "GEONAMES_TSV" | "PLEIADES_CSV" | "NORMALIZED_JSONL";

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
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectPath = (path: string) => isAbsolute(path) ? path : resolve(ROOT, path);
const relevantCodes = new Set(["PPLC", "PPLCH", "PPLA", "PPLA2", "ANS", "MUS", "RGNH"]);
const modernPopulationThreshold = 5000;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numericValue(value: unknown): number | undefined {
  const valueAsNumber = typeof value === "number" ? value : Number(value);
  return Number.isFinite(valueAsNumber) ? valueAsNumber : undefined;
}

function validPoint(latitude: number | undefined, longitude: number | undefined): boolean {
  return latitude !== undefined && longitude !== undefined && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

function cleanAliases(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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
): PlaceCandidate {
  return {
    stableId: `${source.id}:${externalId}`,
    name,
    aliases: cleanAliases(aliases.filter((alias) => alias !== name)),
    latitude,
    longitude,
    featureType,
    periods: [...new Set(periods)],
    selectionReasons: [...new Set(selectionReasons)],
    sources: [sourceOf(source, externalId)],
  };
}

async function processGeoNames(source: SourceDefinition, result: ProcessResult): Promise<void> {
  const rows = createInterface({ input: createReadStream(projectPath(source.path)), crlfDelay: Infinity });
  for await (const row of rows) {
    if (!row.trim() || row.startsWith("#")) continue;
    const fields = row.split("\t");
    const [externalId, name, asciiName, alternateNames, latitudeRaw, longitudeRaw, featureClass, featureCode, , , , , , , populationRaw] = fields;
    const latitude = numericValue(latitudeRaw);
    const longitude = numericValue(longitudeRaw);
    const population = numericValue(populationRaw) ?? 0;
    if (!externalId || !name || !validPoint(latitude, longitude)) {
      result.rejections.push({ source: source.id, externalId: externalId ?? null, reason: "INVALID_REQUIRED_DATA" });
      result.sourceStats[source.id].rejected += 1;
      continue;
    }
    const reasons: string[] = [];
    if (featureCode === "PPLC" || featureCode === "PPLCH" || featureCode.startsWith("PPLA")) reasons.push("CAPITAL_OR_ADMINISTRATIVE_CENTRE");
    if (featureCode === "RGNH") reasons.push("REGIONAL_CENTRE");
    if (relevantCodes.has(featureCode) && featureCode === "MUS") reasons.push("MUSEUM_ARCHIVE_OR_REPOSITORY");
    if (population >= modernPopulationThreshold) reasons.push("MODERN_POPULATION_THRESHOLD");
    if (featureClass === "S" && ["ANS", "HSTS", "ARCH", "RUIN"].some((code) => featureCode.includes(code))) reasons.push("HISTORIC_OR_ARCHAEOLOGICAL_SITE");
    if (!reasons.length && !relevantCodes.has(featureCode)) {
      result.rejections.push({ source: source.id, externalId, reason: "BELOW_SIGNIFICANCE_THRESHOLD", detail: `feature=${featureCode}; population=${population}` });
      result.sourceStats[source.id].rejected += 1;
      continue;
    }
    const aliases = [asciiName, ...(alternateNames ?? "").split(",")].filter((alias): alias is string => Boolean(alias));
    result.candidates.push(candidate(source, externalId, name, latitude!, longitude!, featureClass === "P" ? "SETTLEMENT" : featureCode, reasons, aliases, ["CONTEMPORARY"]));
    result.sourceStats[source.id].accepted += 1;
  }
}

function headerValue(row: Record<string, string>, candidates: string[]): string | undefined {
  const lookup = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase().replaceAll("_", ""), value]));
  for (const key of candidates) {
    const value = lookup.get(key.toLowerCase().replaceAll("_", ""));
    if (value !== undefined) return value;
  }
  return undefined;
}

async function processPleiades(source: SourceDefinition, result: ProcessResult): Promise<void> {
  const text = await readFile(projectPath(source.path), "utf8");
  const rows = parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true }) as Record<string, string>[];
  for (const row of rows) {
    const externalId = headerValue(row, ["id", "pid"]);
    const name = headerValue(row, ["title", "name"]);
    const latitude = numericValue(headerValue(row, ["reprLat", "representative_latitude", "latitude", "lat"]));
    const longitude = numericValue(headerValue(row, ["reprLong", "representative_longitude", "longitude", "long", "lon"]));
    if (!externalId || !name || !validPoint(latitude, longitude)) {
      result.rejections.push({ source: source.id, externalId: externalId ?? null, reason: "INVALID_REQUIRED_DATA" });
      result.sourceStats[source.id].rejected += 1;
      continue;
    }
    const aliases = (headerValue(row, ["names", "alternate_names", "aliases"]) ?? "").split("|");
    const placeTypes = headerValue(row, ["place_types", "placeTypes", "type"]);
    result.candidates.push(candidate(source, externalId, name, latitude!, longitude!, placeTypes?.toUpperCase() || "HISTORIC_PLACE", ["CURATED_HISTORICAL_GAZETTEER"], aliases, ["ANTIQUITY"]));
    result.sourceStats[source.id].accepted += 1;
  }
}

async function processNormalized(source: SourceDefinition, result: ProcessResult): Promise<void> {
  const rows = createInterface({ input: createReadStream(projectPath(source.path)), crlfDelay: Infinity });
  for await (const row of rows) {
    if (!row.trim()) continue;
    const raw = JSON.parse(row) as Record<string, unknown>;
    const externalId = stringValue(raw.id) ?? stringValue(raw.stableId);
    const name = stringValue(raw.name);
    const latitude = numericValue(raw.latitude);
    const longitude = numericValue(raw.longitude);
    const featureType = stringValue(raw.featureType);
    const selectionReasons = Array.isArray(raw.selectionReasons) ? raw.selectionReasons.filter((reason): reason is string => typeof reason === "string") : [];
    if (!externalId || !name || !featureType || !validPoint(latitude, longitude)) {
      result.rejections.push({ source: source.id, externalId: externalId ?? null, reason: "INVALID_REQUIRED_DATA" });
      result.sourceStats[source.id].rejected += 1;
      continue;
    }
    if (!selectionReasons.length) {
      result.rejections.push({ source: source.id, externalId, reason: "NO_SELECTION_REASON" });
      result.sourceStats[source.id].rejected += 1;
      continue;
    }
    const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter((alias): alias is string => typeof alias === "string") : [];
    const periods = Array.isArray(raw.periods) ? raw.periods.filter((period): period is string => typeof period === "string") : [];
    result.candidates.push(candidate(source, externalId, name, latitude!, longitude!, featureType, selectionReasons, aliases, periods));
    result.sourceStats[source.id].accepted += 1;
  }
}

function duplicateClusters(candidates: PlaceCandidate[]): ProcessResult["duplicates"] {
  const clusters = new Map<string, PlaceCandidate[]>();
  for (const place of candidates) {
    const key = `${place.name.normalize("NFKD").replace(/[^\w]/g, "").toLowerCase()}@${place.latitude.toFixed(2)},${place.longitude.toFixed(2)}`;
    clusters.set(key, [...(clusters.get(key) ?? []), place]);
  }
  return [...clusters.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([key, items]) => ({ key, stableIds: items.map((item) => item.stableId), names: items.map((item) => item.name) }));
}

export async function loadSourceConfig(configPath: string): Promise<SourceConfiguration> {
  const raw = JSON.parse(await readFile(projectPath(configPath), "utf8")) as SourceConfiguration;
  if (!raw || raw.version !== 1 || !Array.isArray(raw.sources)) throw new Error(`Invalid source configuration: ${configPath}`);
  for (const source of raw.sources) {
    if (!source.id || !source.path || !source.dataset || !source.license || !["GEONAMES_TSV", "PLEIADES_CSV", "NORMALIZED_JSONL"].includes(source.kind)) {
      throw new Error(`Invalid source definition in ${configPath}`);
    }
  }
  return raw;
}

export async function processSources(configPath = "config/sources.json"): Promise<ProcessResult> {
  const config = await loadSourceConfig(configPath);
  const result: ProcessResult = { candidates: [], catalogue: [], rejections: [], duplicates: [], sourceStats: {} };
  for (const source of config.sources) {
    result.sourceStats[source.id] = { accepted: 0, rejected: 0 };
    if (!existsSync(projectPath(source.path))) {
      result.rejections.push({ source: source.id, externalId: null, reason: "SOURCE_FILE_NOT_FOUND", detail: source.path });
      result.sourceStats[source.id].rejected += 1;
      continue;
    }
    if (source.kind === "GEONAMES_TSV") await processGeoNames(source, result);
    if (source.kind === "PLEIADES_CSV") await processPleiades(source, result);
    if (source.kind === "NORMALIZED_JSONL") await processNormalized(source, result);
  }
  result.catalogue = [...result.candidates].sort((a, b) => a.stableId.localeCompare(b.stableId));
  result.duplicates = duplicateClusters(result.catalogue);
  return result;
}

async function writeJsonl(path: string, values: unknown[]): Promise<{ sha256: string; bytes: number }> {
  await mkdir(dirname(path), { recursive: true });
  const body = values.map((value) => JSON.stringify(value)).join(values.length ? "\n" : "") + (values.length ? "\n" : "");
  await writeFile(path, body, "utf8");
  return { sha256: createHash("sha256").update(body).digest("hex"), bytes: Buffer.byteLength(body) };
}

export async function writeBundle(result: ProcessResult, outDirectory: string): Promise<void> {
  const output = projectPath(outDirectory);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const candidates = await writeJsonl(join(output, "candidates.jsonl"), result.candidates);
  const catalogue = await writeJsonl(join(output, "catalogue.jsonl"), result.catalogue);
  const rejections = await writeJsonl(join(output, "rejections.jsonl"), result.rejections);
  const summary = { ...summarizeCatalogue(result.catalogue), rejections: result.rejections.length, duplicateClusters: result.duplicates.length, sourceStats: result.sourceStats };
  await writeFile(join(output, "duplicates.json"), JSON.stringify(result.duplicates, null, 2) + "\n");
  await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    files: { "candidates.jsonl": candidates, "catalogue.jsonl": catalogue, "rejections.jsonl": rejections },
    summary,
    deterministicInputs: true,
    note: "Cross-source duplicate clusters are review hints and are never auto-merged.",
  };
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

export async function fetchSource(sourceId: string, configPath = "config/sources.json", force = false): Promise<string> {
  const config = await loadSourceConfig(configPath);
  const source = config.sources.find((entry) => entry.id === sourceId);
  if (!source) throw new Error(`Unknown source: ${sourceId}`);
  if (!source.url) throw new Error(`${sourceId} is supplied locally; no download URL is configured.`);
  const destination = projectPath(source.path);
  if (existsSync(destination) && !force) return `Using cached ${source.path}`;
  const response = await fetch(source.url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed for ${sourceId}: HTTP ${response.status}`);
  const archive = join(projectPath("data/raw/.downloads"), `${source.id}-${basename(new URL(source.url).pathname)}`);
  await mkdir(dirname(archive), { recursive: true });
  await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(archive));
  if (source.archiveEntry) {
    const zip = new AdmZip(archive);
    const entry = zip.getEntry(source.archiveEntry);
    if (!entry) throw new Error(`${source.archiveEntry} is not present in downloaded ${sourceId} archive.`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, entry.getData());
  } else {
    await mkdir(dirname(destination), { recursive: true });
    await pipeline(createReadStream(archive), createWriteStream(destination));
  }
  const digest = createHash("sha256").update(await readFile(destination)).digest("hex");
  const metadata = { sourceId, url: source.url, license: source.license, fetchedAt: new Date().toISOString(), sha256: digest, bytes: (await stat(destination)).size };
  await writeFile(`${destination}.metadata.json`, JSON.stringify(metadata, null, 2) + "\n");
  return `Fetched ${sourceId} to ${source.path} (${metadata.bytes} bytes, sha256 ${digest})`;
}
