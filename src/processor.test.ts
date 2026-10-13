import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  modernSettlementDisplayName,
  processSources,
  writeBundle,
} from "./processor.js";
import { curateBundle, initializeDuplicateReview } from "./curation.js";
import {
  estimateCatalogueImport,
  readCatalogue,
  summarizeCatalogue,
} from "./catalogue.js";

test("estimates suffix-name index fan-out from canonical records", () => {
  const estimate = estimateCatalogueImport([
    {
      stableId: "pleiades:423025",
      name: "Rome, Italy",
      aliases: ["Rome", "Roma"],
      latitude: 41.8933,
      longitude: 12.4829,
      featureType: "HISTORIC_SETTLEMENT",
      selectionReasons: ["CURATED_HISTORICAL_GAZETTEER"],
      sources: [
        { dataset: "Pleiades", externalId: "423025", license: "CC-BY-3.0" },
      ],
    },
  ]);
  assert.equal(estimate.records, 1);
  assert.equal(estimate.nameIndexItems, 15); // "rome italy", "rome", "roma"
  assert.equal(estimate.estimatedDynamoItems, 16);
  assert.ok(estimate.estimatedDynamoBytes > estimate.canonicalBytes);
  assert.ok(estimate.estimatedWriteRequestUnits > 0);
});

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
  assert.equal(
    result.catalogue.find(
      (candidate) => candidate.stableId === "geonames-fixture:3169070",
    )?.name,
    "Rome, Italy",
  );
});

test("qualifies modern settlement display names while retaining short aliases", () => {
  assert.equal(modernSettlementDisplayName("Rome", "IT", "07"), "Rome, Italy");
  assert.equal(
    modernSettlementDisplayName("King of Prussia", "US", "PA"),
    "King of Prussia, PA, USA",
  );
  assert.equal(
    modernSettlementDisplayName("Unknown", undefined, undefined),
    "Unknown",
  );
});

test("processes Natural Earth country reference points without persisting boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "tempvs-natural-earth-"));
  const geojson = join(root, "countries.geojson");
  const config = join(root, "sources.json");
  await writeFile(
    geojson,
    JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {
            ADM0_A3: "ITA",
            NAME_EN: "Italy",
            LABEL_X: 12.5,
            LABEL_Y: 42.8,
          },
          geometry: { type: "Polygon", coordinates: [[[6, 36], [19, 47], [6, 36]]] },
        },
        {
          type: "Feature",
          properties: { ADM0_A3: "FRA", NAME_EN: "France" },
          geometry: { type: "Polygon", coordinates: [[[-5, 42], [8, 51], [-5, 42]]] },
        },
      ],
    }),
  );
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      sources: [
        {
          id: "natural-earth-fixture",
          kind: "NATURAL_EARTH_GEOJSON",
          path: geojson,
          dataset: "Natural Earth fixture",
          license: "PUBLIC_DOMAIN",
        },
      ],
    }),
  );

  const result = await processSources(config);
  assert.deepEqual(
    result.catalogue.map((item) => ({
      stableId: item.stableId,
      name: item.name,
      featureType: item.featureType,
      latitude: item.latitude,
      longitude: item.longitude,
    })),
    [
      {
        stableId: "natural-earth-fixture:FRA",
        name: "France",
        featureType: "COUNTRY_OR_TERRITORY",
        latitude: 46.5,
        longitude: 1.5,
      },
      {
        stableId: "natural-earth-fixture:ITA",
        name: "Italy",
        featureType: "COUNTRY_OR_TERRITORY",
        latitude: 42.8,
        longitude: 12.5,
      },
    ],
  );
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
  assert.equal(manifest.sourceRegistry.length, 3);
  assert.deepEqual(manifest.sourceRegistry[0], {
    id: "geonames-fixture",
    kind: "GEONAMES_TSV",
    dataset: "GeoNames fixture",
    license: "CC-BY-4.0",
  });
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
  await assert.rejects(
    () => readCatalogue(catalogue),
    /invalid historical name/,
  );

  await writeFile(
    catalogue,
    `${JSON.stringify({
      ...valid,
      parentRelation: { validFrom: 200 },
    })}\n`,
  );
  await assert.rejects(
    () => readCatalogue(catalogue),
    /invalid parent relationship/,
  );

  await writeFile(
    catalogue,
    `${JSON.stringify({
      ...valid,
      names: [
        {
          value: "Roma",
          confidence: "CURATED",
          sources: [
            { dataset: "Manual", externalId: "rome-name", license: "" },
          ],
        },
      ],
    })}\n`,
  );
  await assert.rejects(
    () => readCatalogue(catalogue),
    /invalid historical name/,
  );

  await writeFile(
    catalogue,
    `${JSON.stringify({ ...valid, parentStableId: "not valid parent" })}\n`,
  );
  await assert.rejects(
    () => readCatalogue(catalogue),
    /invalid parent stable ID/,
  );
});

test("rejects duplicate stable keys and impossible parent hierarchies", async () => {
  const duplicate = await temporaryCatalogue([
    candidate({ stableId: "wikidata:q1" }),
    candidate({ stableId: "wikidata:q1", name: "Also Rome" }),
  ]);
  await assert.rejects(() => readCatalogue(duplicate), /Duplicate stable ID/);

  const selfParent = await temporaryCatalogue([
    candidate({ stableId: "wikidata:q2", parentStableId: "wikidata:q2" }),
  ]);
  await assert.rejects(() => readCatalogue(selfParent), /own parent/);

  const cycle = await temporaryCatalogue([
    candidate({ stableId: "wikidata:q3", parentStableId: "wikidata:q4" }),
    candidate({ stableId: "wikidata:q4", parentStableId: "wikidata:q3" }),
  ]);
  await assert.rejects(() => readCatalogue(cycle), /contains a cycle/);
});

test("retains normalized parent relationships and reports unresolved parents", async () => {
  const root = await mkdtemp(join(tmpdir(), "tempvs-geography-parent-"));
  const source = join(root, "places.jsonl");
  await writeFile(
    source,
    [
      candidate({ stableId: "region", name: "Latium" }),
      candidate({
        stableId: "rome",
        name: "Rome",
        parentStableId: "region",
        parentRelation: {
          validFrom: -753,
          confidence: "CURATED",
          sources: [
            {
              dataset: "Roman history fixture",
              externalId: "latium-rome",
              license: "CC0",
            },
          ],
        },
        containmentRelations: [
          {
            parentStableId: "empire",
            validFrom: -27,
            validTo: 476,
            confidence: "DISPUTED",
            sources: [
              {
                dataset: "Roman history fixture",
                externalId: "rome-empire",
                license: "CC0",
              },
            ],
          },
        ],
      }),
      candidate({ stableId: "empire", name: "Roman Empire" }),
      candidate({
        stableId: "orphan",
        name: "Far point",
        parentStableId: "other-source:missing",
      }),
    ]
      .map((item) => JSON.stringify(item))
      .join("\n") + "\n",
  );
  const config = join(root, "sources.json");
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      sources: [
        {
          id: "curated",
          kind: "NORMALIZED_JSONL",
          path: source,
          dataset: "Manual",
          license: "CC0",
        },
      ],
    }),
  );
  const result = await processSources(config);
  assert.equal(
    result.catalogue.find((item) => item.stableId === "curated:rome")
      ?.parentStableId,
    "curated:region",
  );
  assert.deepEqual(
    result.catalogue.find((item) => item.stableId === "curated:rome")
      ?.parentRelation,
    {
      validFrom: -753,
      confidence: "CURATED",
      sources: [
        {
          dataset: "Roman history fixture",
          externalId: "latium-rome",
          license: "CC0",
        },
      ],
    },
  );
  assert.deepEqual(summarizeCatalogue(result.catalogue).parentRelationships, {
    declared: 2,
    resolvedWithinBundle: 1,
    unresolvedParent: 1,
  });
  assert.deepEqual(
    result.catalogue.find((item) => item.stableId === "curated:rome")
      ?.containmentRelations,
    [
      {
        parentStableId: "curated:empire",
        validFrom: -27,
        validTo: 476,
        confidence: "DISPUTED",
        sources: [
          {
            dataset: "Roman history fixture",
            externalId: "rome-empire",
            license: "CC0",
          },
        ],
      },
    ],
  );
  assert.deepEqual(
    summarizeCatalogue(result.catalogue).supplementalContainmentRelationships,
    { declared: 1, resolvedWithinBundle: 1, unresolvedParent: 0 },
  );
});

function candidate(overrides: Record<string, unknown>) {
  return {
    stableId: "wikidata:q0",
    name: "Rome",
    latitude: 41.89,
    longitude: 12.48,
    featureType: "HISTORIC_SETTLEMENT",
    selectionReasons: ["CURATED"],
    sources: [{ dataset: "Manual", externalId: "rome", license: "CC0" }],
    ...overrides,
  };
}

async function temporaryCatalogue(values: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tempvs-geography-validation-"));
  const catalogue = join(root, "catalogue.jsonl");
  await writeFile(
    catalogue,
    values.map((value) => JSON.stringify(value)).join("\n") + "\n",
  );
  return catalogue;
}
