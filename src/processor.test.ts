import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processSources, writeBundle } from "./processor.js";

test("processes configured sources and leaves cross-source matches for review", async () => {
  const result = await processSources("config/test-sources.json");
  assert.equal(result.catalogue.length, 5);
  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0].reason, "BELOW_SIGNIFICANCE_THRESHOLD");
  assert.equal(result.duplicates.length, 1);
  assert.deepEqual(result.duplicates[0].stableIds.sort(), ["geonames-fixture:3169070", "pleiades-fixture:423025"]);
});

test("writes a checksummed, inspectable bundle", async () => {
  const output = await mkdtemp(join(tmpdir(), "tempvs-geography-"));
  await writeBundle(await processSources("config/test-sources.json"), output);
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.summary.count, 5);
  assert.match(manifest.files["catalogue.jsonl"].sha256, /^[a-f0-9]{64}$/);
});
