import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

export type PlaceCandidate = {
  stableId: string;
  name: string;
  latitude: number;
  longitude: number;
  featureType: string;
  aliases?: string[];
  periods?: string[];
  selectionReasons: string[];
  sources: Array<{ dataset: string; externalId: string; license: string }>;
};

export type CatalogueSummary = {
  count: number;
  featureTypes: Record<string, number>;
  selectionReasons: Record<string, number>;
  datasets: Record<string, number>;
};

function assertCandidate(value: unknown, line: number): asserts value is PlaceCandidate {
  if (!value || typeof value !== "object") throw new Error(`Line ${line} is not an object.`);
  const item = value as Partial<PlaceCandidate>;
  if (!item.stableId || !item.name || !item.featureType) {
    throw new Error(`Line ${line} is missing stableId, name, or featureType.`);
  }
  if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)
    || Math.abs(item.latitude as number) > 90 || Math.abs(item.longitude as number) > 180) {
    throw new Error(`Line ${line} has invalid coordinates.`);
  }
  if (!Array.isArray(item.selectionReasons) || item.selectionReasons.length === 0) {
    throw new Error(`Line ${line} needs at least one selection reason.`);
  }
  if (!Array.isArray(item.sources) || item.sources.length === 0) {
    throw new Error(`Line ${line} needs source provenance.`);
  }
}

export async function readCatalogue(path: string): Promise<PlaceCandidate[]> {
  if (path.endsWith(".json")) {
    const content = await readFile(path, "utf8");
    const values = JSON.parse(content) as unknown[];
    if (!Array.isArray(values)) throw new Error("A .json catalogue must be an array.");
    values.forEach((value, index) => assertCandidate(value, index + 1));
    return values as PlaceCandidate[];
  }
  const input = createReadStream(path);
  const stream = path.endsWith(".gz") ? input.pipe(createGunzip()) : input;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const result: PlaceCandidate[] = [];
  let line = 0;
  for await (const text of lines) {
    line += 1;
    if (!text.trim()) continue;
    const value = JSON.parse(text) as unknown;
    assertCandidate(value, line);
    result.push(value);
  }
  return result;
}

export function summarizeCatalogue(items: PlaceCandidate[]): CatalogueSummary {
  const summary: CatalogueSummary = {
    count: items.length,
    featureTypes: {},
    selectionReasons: {},
    datasets: {},
  };
  for (const item of items) {
    summary.featureTypes[item.featureType] = (summary.featureTypes[item.featureType] || 0) + 1;
    for (const reason of item.selectionReasons) {
      summary.selectionReasons[reason] = (summary.selectionReasons[reason] || 0) + 1;
    }
    for (const source of item.sources) {
      summary.datasets[source.dataset] = (summary.datasets[source.dataset] || 0) + 1;
    }
  }
  return summary;
}
