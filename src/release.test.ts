import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { S3Client } from "@aws-sdk/client-s3";

import {
  fetchReviewedBundle,
  publishReviewedBundle,
  verifyReviewedBundle,
} from "./release.js";
import { materializeReleaseLayout } from "./release-layout.js";
import { verifyPromotionReports } from "./promotion.js";

const digest = (content: Buffer | string) =>
  createHash("sha256").update(content).digest("hex");

async function reviewedBundle(directory: string): Promise<void> {
  const catalogue = `${JSON.stringify({
    stableId: "pleiades:423025",
    name: "Rome",
    latitude: 41.8933,
    longitude: 12.4829,
    featureType: "HISTORIC_SETTLEMENT",
    selectionReasons: ["CURATED_HISTORICAL_GAZETTEER"],
    sources: [
      { dataset: "Pleiades", externalId: "423025", license: "CC-BY-4.0" },
    ],
  })}\n`;
  const summary = `${JSON.stringify({ count: 1, duplicateClusters: 0 })}\n`;
  const duplicates = "[]\n";
  await writeFile(join(directory, "catalogue.jsonl"), catalogue);
  await writeFile(join(directory, "summary.json"), summary);
  await writeFile(join(directory, "duplicates.json"), duplicates);
  await writeFile(
    join(directory, "manifest.json"),
    `${JSON.stringify(
      {
        artifactId: `geo-v1-${digest(catalogue).slice(0, 24)}`,
        transformVersion: 1,
        files: {
          "catalogue.jsonl": { sha256: digest(catalogue), bytes: Buffer.byteLength(catalogue) },
        },
        summary: { duplicateClusters: 0 },
        sourceRegistry: [
          {
            id: "pleiades",
            kind: "PLEIADES_JSON",
            dataset: "Pleiades",
            license: "CC-BY-4.0",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function memoryS3(): S3Client {
  const records = new Map<string, { content: Buffer; metadata: Record<string, string> }>();
  return {
    send: async (command: { input: { Bucket: string; Key: string; Body?: unknown; Metadata?: Record<string, string> } }) => {
      const key = `${command.input.Bucket}/${command.input.Key}`;
      if (command.constructor.name === "HeadObjectCommand") {
        const existing = records.get(key);
        if (!existing) throw Object.assign(new Error("missing"), { name: "NotFound" });
        return { Metadata: existing.metadata };
      }
      if (command.constructor.name === "PutObjectCommand") {
        records.set(key, {
          content: Buffer.from(command.input.Body as Uint8Array),
          metadata: command.input.Metadata ?? {},
        });
        return {};
      }
      if (command.constructor.name === "GetObjectCommand") {
        const existing = records.get(key);
        if (!existing) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
        return { Body: { transformToByteArray: async () => existing.content } };
      }
      throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
    },
  } as unknown as S3Client;
}

test("verifies, previews, publishes, and fetches one immutable reviewed bundle", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "tempvs-geo-release-"));
  const source = join(temporary, "source");
  const fetched = join(temporary, "fetched");
  await writeFile(join(temporary, ".keep"), "");
  await mkdir(source);
  try {
    await reviewedBundle(source);
    const verified = await verifyReviewedBundle(source);
    const client = memoryS3();
    const preview = await publishReviewedBundle({
      directory: source,
      bucket: "artifacts",
      client,
      apply: false,
    });
    assert.equal(preview.preview, true);
    assert.ok(preview.uploaded.includes("release.json"));

    const published = await publishReviewedBundle({
      directory: source,
      bucket: "artifacts",
      client,
      apply: true,
    });
    assert.equal(published.uploaded.length, preview.uploaded.length);
    const repeat = await publishReviewedBundle({
      directory: source,
      bucket: "artifacts",
      client,
      apply: true,
    });
    assert.equal(repeat.uploaded.length, 0);
    assert.equal(repeat.existing.length, preview.uploaded.length);

    const result = await fetchReviewedBundle({
      bucket: "artifacts",
      artifactId: verified.artifactId,
      outDirectory: fetched,
      client,
    });
    assert.equal(result.files, 4);
    assert.equal(
      await readFile(join(fetched, "catalogue.jsonl"), "utf8"),
      await readFile(join(source, "catalogue.jsonl"), "utf8"),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("rejects a bundle with unresolved duplicate clusters", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "tempvs-geo-release-"));
  try {
    await reviewedBundle(temporary);
    const manifestPath = join(temporary, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { summary: { duplicateClusters: number } };
    manifest.summary.duplicateClusters = 1;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(() => verifyReviewedBundle(temporary), /unresolved duplicate clusters/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("rejects a checksummed catalogue that lacks required provenance", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "tempvs-geo-release-"));
  try {
    await reviewedBundle(temporary);
    const cataloguePath = join(temporary, "catalogue.jsonl");
    const invalidCatalogue = `${JSON.stringify({
      stableId: "pleiades:423025",
      name: "Rome",
      latitude: 41.8933,
      longitude: 12.4829,
      featureType: "HISTORIC_SETTLEMENT",
      selectionReasons: ["CURATED_HISTORICAL_GAZETTEER"],
    })}\n`;
    await writeFile(cataloguePath, invalidCatalogue);
    const manifestPath = join(temporary, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      files: { "catalogue.jsonl": { sha256: string; bytes: number } };
    };
    manifest.files["catalogue.jsonl"] = {
      sha256: digest(invalidCatalogue),
      bytes: Buffer.byteLength(invalidCatalogue),
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(() => verifyReviewedBundle(temporary), /source provenance/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("rejects provenance that is absent from the pinned source registry", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "tempvs-geo-release-"));
  try {
    await reviewedBundle(temporary);
    const cataloguePath = join(temporary, "catalogue.jsonl");
    const content = await readFile(cataloguePath);
    const manifestPath = join(temporary, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      files: { "catalogue.jsonl": { sha256: string; bytes: number } };
      sourceRegistry: Array<{ id: string; kind: string; dataset: string; license: string }>;
    };
    manifest.sourceRegistry[0] = {
      id: "different",
      kind: "NORMALIZED_JSONL",
      dataset: "Different catalogue",
      license: "CC0-1.0",
    };
    manifest.files["catalogue.jsonl"] = {
      sha256: digest(content),
      bytes: content.byteLength,
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(() => verifyReviewedBundle(temporary), /not declared in the source registry/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("keeps the checked-in development pilot publishable", async () => {
  const bundle = await verifyReviewedBundle("data/releases/dev-pilot-v1");
  assert.equal(bundle.artifactId, "geo-v1-78b5b33efbbc8a99d5e4ecac");
  assert.equal(bundle.files["catalogue.jsonl"]?.bytes, 2242);
});

test("materializes deterministic component chunks without changing the canonical import stream", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "tempvs-geo-layout-"));
  const source = join(temporary, "source");
  const release = join(temporary, "release");
  await mkdir(source);
  try {
    await reviewedBundle(source);
    const result = await materializeReleaseLayout({
      sourceDirectory: source,
      outDirectory: release,
      chunkBytes: 1024,
    });
    assert.match(result.artifactId, /^geo-v2-[a-f0-9]{24}$/);
    assert.deepEqual(result.chunks, {
      places: 1,
      names: 1,
      parents: 1,
      "period-relevance": 1,
      provenance: 1,
    });
    const verified = await verifyReviewedBundle(release);
    assert.equal(verified.artifactId, result.artifactId);
    assert.equal(
      await readFile(join(release, "catalogue.jsonl"), "utf8"),
      await readFile(join(source, "catalogue.jsonl"), "utf8"),
    );
    assert.ok(verified.files["places/part-00001.jsonl.gz"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("requires equal semantic reconciliation before a production promotion", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "tempvs-geo-promotion-"));
  const development = join(temporary, "development.json");
  const candidate = join(temporary, "candidate.json");
  const report = (environment: string) => ({
    version: 1,
    artifactId: "geo-v1-1234567890abcdef12345678",
    target: { environment, tableName: `Map-${environment}` },
    summary: {
      mode: "CREATE_ONLY",
      dryRun: false,
      conflicts: 0,
      reconciliation: {
        accepted: 1,
        rejected: 0,
        merged: 0,
        unmatchedParents: 0,
        aliasesRetained: 1,
        aliasesDropped: 0,
        itemsWritten: 3,
        bytesStored: 512,
        consumedCapacityUnits: 2,
      },
    },
  });
  try {
    await writeFile(development, `${JSON.stringify(report("dev"))}\n`);
    await writeFile(candidate, `${JSON.stringify(report("prod"))}\n`);
    const verified = await verifyPromotionReports({
      developmentReportPath: development,
      candidateReportPath: candidate,
    });
    assert.equal(verified.artifactId, "geo-v1-1234567890abcdef12345678");
    const divergent = report("prod");
    divergent.summary.reconciliation.aliasesDropped = 1;
    await writeFile(candidate, `${JSON.stringify(divergent)}\n`);
    await assert.rejects(
      () =>
        verifyPromotionReports({
          developmentReportPath: development,
          candidateReportPath: candidate,
        }),
      /aliasesDropped/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
