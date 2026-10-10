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

const digest = (content: Buffer | string) =>
  createHash("sha256").update(content).digest("hex");

async function reviewedBundle(directory: string): Promise<void> {
  const catalogue = `${JSON.stringify({
    stableId: "pleiades:423025",
    name: "Rome",
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

test("keeps the checked-in development pilot publishable", async () => {
  const bundle = await verifyReviewedBundle("data/releases/dev-pilot-v1");
  assert.equal(bundle.artifactId, "geo-v1-78b5b33efbbc8a99d5e4ecac");
  assert.equal(bundle.files["catalogue.jsonl"]?.bytes, 2242);
});
