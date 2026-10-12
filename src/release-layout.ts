import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { readCatalogue, type PlaceCandidate } from "./catalogue.js";
import { verifyReviewedBundle } from "./release.js";

type ManifestFile = { sha256: string; bytes: number };
type BundleManifest = {
  version?: number;
  transformVersion?: number;
  summary?: Record<string, unknown>;
  sourceRegistry?: unknown[];
  curatedFrom?: unknown;
  deterministicInputs?: boolean;
  note?: string;
};

export type ReleaseLayoutResult = {
  artifactId: string;
  files: number;
  chunks: Record<string, number>;
};

const DEFAULT_CHUNK_BYTES = 20 * 1024 * 1024;

/**
 * Builds the portable, component-oriented form of an already reviewed bundle.
 * `catalogue.jsonl` remains present as the canonical, streamable import input;
 * the five compressed component streams make inspection, transfer, and
 * restart planning independent from one opaque record file.  The layout is
 * deterministic: records are ordered by stable ID and Node's gzip encoder
 * emits a reproducible timestamp-free stream.
 */
export async function materializeReleaseLayout(options: {
  sourceDirectory: string;
  outDirectory: string;
  chunkBytes?: number;
}): Promise<ReleaseLayoutResult> {
  const source = await verifyReviewedBundle(options.sourceDirectory);
  await assertDoesNotExist(options.outDirectory);
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1024)
    throw new Error("chunkBytes must be a whole number of at least 1024.");

  await mkdir(options.outDirectory, { recursive: false });
  for (const [relativePath, file] of Object.entries(source.files)) {
    if (relativePath === "manifest.json") continue;
    const destination = join(options.outDirectory, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(options.sourceDirectory, relativePath), destination);
    // Preserve the verified bytes exactly. `file` is deliberately not used as
    // a write body to avoid accidentally changing line endings.
    void file;
  }

  const catalogue = await readCatalogue(join(options.sourceDirectory, "catalogue.jsonl"));
  const components = componentRecords(catalogue);
  const files: Record<string, ManifestFile> = {};
  for (const [relativePath, file] of Object.entries(source.files)) {
    if (relativePath !== "manifest.json")
      files[relativePath] = { sha256: file.sha256, bytes: file.bytes };
  }
  const chunks: Record<string, number> = {};
  for (const [name, records] of Object.entries(components)) {
    const written = await writeDeterministicChunks(
      options.outDirectory,
      name,
      records,
      chunkBytes,
    );
    chunks[name] = written.length;
    for (const file of written) files[file.path] = file.metadata;
  }

  const original = source.manifest as BundleManifest;
  const artifactId = `geo-v2-${digest(
    Object.entries(files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, metadata]) => `${path}:${metadata.sha256}`)
      .join("\n"),
  ).slice(0, 24)}`;
  const manifest = {
    version: 2,
    artifactId,
    transformVersion: original.transformVersion ?? 1,
    createdAt: new Date().toISOString(),
    files,
    summary: original.summary ?? {},
    sourceRegistry: original.sourceRegistry ?? [],
    ...(original.curatedFrom ? { curatedFrom: original.curatedFrom } : {}),
    deterministicInputs: original.deterministicInputs ?? true,
    releaseLayout: {
      version: 1,
      format: "COMPONENT_JSONL_GZIP",
      chunkBytes,
      sourceArtifactId: source.artifactId,
      components: chunks,
    },
    note:
      "Reviewed immutable component release. catalogue.jsonl is the canonical import stream; component files are deterministic transfer and review views.",
  };
  await writeFile(
    join(options.outDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { artifactId, files: Object.keys(files).length + 1, chunks };
}

function componentRecords(catalogue: PlaceCandidate[]): Record<string, unknown[]> {
  const sorted = [...catalogue].sort((left, right) =>
    left.stableId.localeCompare(right.stableId),
  );
  return {
    places: sorted.map((place) => ({
      stableId: place.stableId,
      name: place.name,
      latitude: place.latitude,
      longitude: place.longitude,
      featureType: place.featureType,
      confidence: place.confidence ?? "IMPORTED",
      selectionReasons: place.selectionReasons,
    })),
    names: sorted.flatMap((place) => [
      { stableId: place.stableId, value: place.name, preferred: true },
      ...(place.aliases ?? []).map((value) => ({
        stableId: place.stableId,
        value,
        preferred: false,
      })),
      ...(place.names ?? []).map((name) => ({
        stableId: place.stableId,
        preferred: false,
        ...name,
      })),
    ]),
    parents: sorted.flatMap((place) => [
      ...(place.parentStableId
        ? [
            {
              stableId: place.stableId,
              parentStableId: place.parentStableId,
              primary: true,
              ...(place.parentRelation ?? {}),
            },
          ]
        : []),
      ...(place.containmentRelations ?? []).map((relation) => ({
        stableId: place.stableId,
        primary: false,
        ...relation,
      })),
    ]),
    "period-relevance": sorted.flatMap((place) =>
      (place.periods ?? []).map((period) => ({ stableId: place.stableId, period })),
    ),
    provenance: sorted.flatMap((place) =>
      place.sources.map((source) => ({ stableId: place.stableId, ...source })),
    ),
  };
}

async function writeDeterministicChunks(
  output: string,
  component: string,
  records: unknown[],
  chunkBytes: number,
): Promise<Array<{ path: string; metadata: ManifestFile }>> {
  // Stable-ID hash ordering keeps chunks balanced when IDs from one upstream
  // provider are clustered lexically, while still producing byte-identical
  // partitions on every machine.
  const ordered = [...records].sort((left, right) =>
    stablePartition(left).localeCompare(stablePartition(right)) ||
    stableKey(left).localeCompare(stableKey(right)) ||
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  const groups: string[][] = [];
  let group: string[] = [];
  let groupBytes = 0;
  for (const record of ordered) {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (group.length && groupBytes + bytes > chunkBytes) {
      groups.push(group);
      group = [];
      groupBytes = 0;
    }
    group.push(line);
    groupBytes += bytes;
  }
  if (group.length || !groups.length) groups.push(group);
  const outputFiles: Array<{ path: string; metadata: ManifestFile }> = [];
  for (const [index, lines] of groups.entries()) {
    const relativePath = `${component}/part-${String(index + 1).padStart(5, "0")}.jsonl.gz`;
    const content = gzipSync(Buffer.from(lines.join("")));
    const destination = join(output, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
    outputFiles.push({
      path: relativePath,
      metadata: { sha256: digest(content), bytes: content.byteLength },
    });
  }
  return outputFiles;
}

function stableKey(value: unknown): string {
  return typeof value === "object" && value !== null && "stableId" in value
    ? String((value as { stableId: unknown }).stableId)
    : "";
}

function stablePartition(value: unknown): string {
  return digest(stableKey(value)).slice(0, 8);
}

async function assertDoesNotExist(path: string): Promise<void> {
  try {
    await access(path);
    throw new Error(`Output directory already exists: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Output directory")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function digest(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}
