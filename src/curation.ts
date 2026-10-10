import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PlaceCandidate } from "./catalogue.js";
import { ProcessResult, Rejection, writeBundle } from "./processor.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type DuplicateCluster = {
  key: string;
  stableIds: string[];
  names: string[];
};
export type ReviewAction = "UNRESOLVED" | "MERGE" | "KEEP_SEPARATE";
export type DuplicateReviewDecision = {
  key: string;
  action: ReviewAction;
  canonicalStableId?: string;
  note?: string;
};

export type DuplicateReview = {
  version: 1;
  generatedAt: string;
  sourceBundle: { manifestSha256: string; duplicateClusters: number };
  decisions: DuplicateReviewDecision[];
};

function inputPath(path: string): string {
  return isAbsolute(path) ? path : resolve(ROOT, path);
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const content = await readFile(path, "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function uniqueNames(
  candidates: PlaceCandidate[],
): NonNullable<PlaceCandidate["names"]> {
  const seen = new Set<string>();
  return candidates
    .flatMap((candidate) => candidate.names ?? [])
    .filter((name) => {
      const key = `${name.value}\u0000${name.language || ""}\u0000${name.validFrom ?? ""}\u0000${name.validTo ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function mergeCluster(
  candidates: PlaceCandidate[],
  canonicalStableId: string,
): PlaceCandidate {
  const canonical = candidates.find(
    (candidate) => candidate.stableId === canonicalStableId,
  );
  if (!canonical)
    throw new Error(
      `Canonical record ${canonicalStableId} is not in its duplicate cluster.`,
    );
  const aliases = unique(
    candidates.flatMap((candidate) => [
      candidate.name,
      ...(candidate.aliases ?? []),
    ]),
  ).filter((name) => name !== canonical.name);
  const sources = candidates
    .flatMap((candidate) => candidate.sources)
    .filter(
      (source, index, all) =>
        all.findIndex(
          (item) =>
            item.dataset === source.dataset &&
            item.externalId === source.externalId,
        ) === index,
    );
  return {
    ...canonical,
    aliases,
    ...(uniqueNames(candidates).length
      ? { names: uniqueNames(candidates) }
      : {}),
    periods: unique(candidates.flatMap((candidate) => candidate.periods ?? [])),
    selectionReasons: unique(
      candidates.flatMap((candidate) => candidate.selectionReasons),
    ),
    sources,
  };
}

/** Writes a deliberately unresolved review file. Do not mark a cluster MERGE without inspecting it. */
export async function initializeDuplicateReview(
  bundleDirectory: string,
  outputPath: string,
): Promise<DuplicateReview> {
  const bundle = inputPath(bundleDirectory);
  const manifestText = await readFile(join(bundle, "manifest.json"), "utf8");
  const duplicates = await readJson<DuplicateCluster[]>(
    join(bundle, "duplicates.json"),
  );
  const review: DuplicateReview = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceBundle: {
      manifestSha256: digest(manifestText),
      duplicateClusters: duplicates.length,
    },
    decisions: duplicates.map((cluster) => ({
      key: cluster.key,
      action: "UNRESOLVED",
    })),
  };
  const destination = inputPath(outputPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(review, null, 2) + "\n", "utf8");
  return review;
}

/**
 * Creates an importable release only when every detected duplicate has been
 * deliberately merged. KEEP_SEPARATE is recorded as a valid review decision,
 * but intentionally leaves the release blocked: the map importer will never
 * choose between two canonical place records on its own.
 */
export async function curateBundle(
  bundleDirectory: string,
  reviewPath: string,
  outputDirectory: string,
): Promise<ProcessResult> {
  const bundle = inputPath(bundleDirectory);
  const manifestText = await readFile(join(bundle, "manifest.json"), "utf8");
  const duplicates = await readJson<DuplicateCluster[]>(
    join(bundle, "duplicates.json"),
  );
  const review = await readJson<DuplicateReview>(inputPath(reviewPath));
  if (review.version !== 1)
    throw new Error("Unsupported duplicate-review version.");
  if (review.sourceBundle.manifestSha256 !== digest(manifestText)) {
    throw new Error(
      "The review decisions belong to a different bundle. Run review:init again after processing a new bundle.",
    );
  }
  const decisions = new Map(
    review.decisions.map((decision) => [decision.key, decision]),
  );
  if (decisions.size !== review.decisions.length)
    throw new Error(
      "Duplicate-review file contains the same cluster more than once.",
    );
  const expectedKeys = new Set(duplicates.map((cluster) => cluster.key));
  const unknown = review.decisions.filter(
    (decision) => !expectedKeys.has(decision.key),
  );
  if (unknown.length)
    throw new Error(
      `Duplicate-review file contains ${unknown.length} unknown cluster decision(s).`,
    );
  const unresolved = duplicates.filter((cluster) => {
    const decision = decisions.get(cluster.key);
    return !decision || decision.action !== "MERGE";
  });
  if (unresolved.length) {
    throw new Error(
      `${unresolved.length} duplicate cluster(s) still need a MERGE decision. KEEP_SEPARATE intentionally cannot be imported.`,
    );
  }

  const catalogue = await readJsonl<PlaceCandidate>(
    join(bundle, "catalogue.jsonl"),
  );
  const byId = new Map(
    catalogue.map((candidate) => [candidate.stableId, candidate]),
  );
  const mergedIds = new Set<string>();
  const replacements = new Map<string, PlaceCandidate>();
  for (const cluster of duplicates) {
    const decision = decisions.get(cluster.key)!;
    if (
      !decision.canonicalStableId ||
      !cluster.stableIds.includes(decision.canonicalStableId)
    ) {
      throw new Error(
        `Cluster ${cluster.key} needs canonicalStableId set to one of its records.`,
      );
    }
    const members = cluster.stableIds
      .map((id) => byId.get(id))
      .filter((candidate): candidate is PlaceCandidate => Boolean(candidate));
    if (members.length !== cluster.stableIds.length)
      throw new Error(
        `Cluster ${cluster.key} references a missing catalogue record.`,
      );
    replacements.set(
      decision.canonicalStableId,
      mergeCluster(members, decision.canonicalStableId),
    );
    members.forEach((candidate) => mergedIds.add(candidate.stableId));
  }
  const curated = catalogue
    .filter((candidate) => !mergedIds.has(candidate.stableId))
    .concat([...replacements.values()])
    .sort((left, right) => left.stableId.localeCompare(right.stableId));
  const candidates = await readJsonl<PlaceCandidate>(
    join(bundle, "candidates.jsonl"),
  );
  const rejections = await readJsonl<Rejection>(
    join(bundle, "rejections.jsonl"),
  );
  const sourceStats = (
    await readJson<{ sourceStats: ProcessResult["sourceStats"] }>(
      join(bundle, "summary.json"),
    )
  ).sourceStats;
  const sourceRegistry = (
    JSON.parse(manifestText) as { sourceRegistry?: ProcessResult["sources"] }
  ).sourceRegistry;
  const result: ProcessResult = {
    candidates,
    catalogue: curated,
    rejections,
    duplicates: [],
    sourceStats,
    sources: sourceRegistry || [],
  };
  await writeBundle(result, outputDirectory);

  const output = inputPath(outputDirectory);
  const outputManifest = await readJson<Record<string, unknown>>(
    join(output, "manifest.json"),
  );
  outputManifest.curatedFrom = {
    manifestSha256: digest(manifestText),
    reviewSha256: digest(await readFile(inputPath(reviewPath))),
    mergedClusters: duplicates.length,
  };
  outputManifest.note =
    "Reviewed duplicate clusters were explicitly merged; this bundle is safe for the Map importer.";
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(outputManifest, null, 2) + "\n",
    "utf8",
  );
  return result;
}
