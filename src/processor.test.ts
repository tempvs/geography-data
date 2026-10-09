import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processSources, writeBundle } from "./processor.js";
import { curateBundle, initializeDuplicateReview } from "./curation.js";
import { readCatalogue } from "./catalogue.js";

test("processes configured sources and leaves cross-source matches for review", async () => {
  const result = await processSources("config/test-sources.json");
  assert.equal(result.catalogue.length, 5);
  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0].reason, "BELOW_SIGNIFICANCE_THRESHOLD");
  assert.equal(result.duplicates.length, 1);
  assert.deepEqual(result.duplicates[0].stableIds.sort(), [
    "geonames-fixture:3169070",
    "pleiades-fixture:423025",
  ]);
  const rome = result.catalogue.find(
    (candidate) => candidate.stableId === "pleiades-fixture:423025",
  )!;
  assert.deepEqual(rome.names, [
    { value: "Roma", language: "la", validFrom: -753, validTo: 476 },
    { value: "Rome", language: "en", validFrom: 476 },
  ]);
});

test("requires explicit review then preserves merged provenance in an importable bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "tempvs-geography-curation-"));
  const firstPass = join(root, "first-pass");
  const reviewPath = join(root, "review.json");
  const curated = join(root, "curated");
  await writeBundle(
    await processSources("config/test-sources.json"),
    firstPass,
  );
  await initializeDuplicateReview(firstPass, reviewPath);
  await assert.rejects(
    () => curateBundle(firstPass, reviewPath, curated),
    /still need a MERGE decision/,
  );
  const review = JSON.parse(await readFile(reviewPath, "utf8"));
  review.decisions[0].action = "MERGE";
  review.decisions[0].canonicalStableId = "pleiades-fixture:423025";
  await writeFile(reviewPath, JSON.stringify(review));
  const result = await curateBundle(firstPass, reviewPath, curated);
  assert.equal(result.catalogue.length, 4);
  const rome = result.catalogue.find(
    (candidate) => candidate.stableId === "pleiades-fixture:423025",
  )!;
  assert.equal(rome.sources.length, 2);
  assert.ok(rome.aliases?.includes("Roma"));
  const manifest = JSON.parse(
    await readFile(join(curated, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.summary.duplicateClusters, 0);
  assert.equal(manifest.curatedFrom.mergedClusters, 1);
});

test("writes a checksummed, inspectable bundle", async () => {
  const output = await mkdtemp(join(tmpdir(), "tempvs-geography-"));
  await writeBundle(await processSources("config/test-sources.json"), output);
  const manifest = JSON.parse(
    await readFile(join(output, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.summary.count, 5);
  assert.match(manifest.files["catalogue.jsonl"].sha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.artifactId, /^geo-v1-[a-f0-9]{24}$/);
  assert.equal(manifest.transformVersion, 1);
});

test("rejects malformed aliases, provenance, and historical-name metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "tempvs-geography-validation-"));
  const catalogue = join(root, "bad.jsonl");
  const valid = {
    stableId: "curated:rome",
    name: "Rome",
    latitude: 41.89,
    longitude: 12.48,
    featureType: "HISTORIC_SETTLEMENT",
    selectionReasons: ["CURATED"],
    sources: [{ dataset: "Manual", externalId: "rome", license: "CC0" }],
  };
  await writeFile(
    catalogue,
    `${JSON.stringify({ ...valid, aliases: [" "] })}\n`,
  );
  await assert.rejects(() => readCatalogue(catalogue), /invalid alias/);

  await writeFile(
    catalogue,
    `${JSON.stringify({
      ...valid,
      sources: [{ dataset: "Manual", externalId: "rome", license: "" }],
    })}\n`,
  );
  await assert.rejects(() => readCatalogue(catalogue), /source provenance/);

  await writeFile(
    catalogue,
    `${JSON.stringify({ ...valid, names: { value: "Roma" } })}\n`,
  );
  await assert.rejects(() => readCatalogue(catalogue), /invalid historical name/);
});
