import { readCatalogue, summarizeCatalogue } from "./catalogue.js";
import { fetchSource, processSources, writeBundle } from "./processor.js";

const [command, ...arguments_] = process.argv.slice(2);
const path = arguments_[0];

if (!command || command === "help" || command === "--help") {
  console.log(`Usage:
  geo validate <catalogue.json|catalogue.jsonl[.gz]>
  geo summary <catalogue.json|catalogue.jsonl[.gz]>
  geo inspect <catalogue.json|catalogue.jsonl[.gz]> <stable-id>
  geo fetch <source-id|all> [--config config/sources.json] [--force]
  geo process [--config config/sources.json] [--out data/work/<release>]

fetch downloads only explicitly configured data. process never downloads data.`);
  process.exit(0);
}

function option(name: string, fallback: string): string {
  const index = arguments_.indexOf(name);
  return index >= 0 && arguments_[index + 1] ? arguments_[index + 1] : fallback;
}

if (command === "fetch") {
  if (!path) throw new Error("A source ID or 'all' is required.");
  const config = option("--config", "config/sources.json");
  const force = arguments_.includes("--force");
  if (path === "all") {
    const { loadSourceConfig } = await import("./processor.js");
    const configuration = await loadSourceConfig(config);
    for (const source of configuration.sources.filter((entry) => entry.url)) console.log(await fetchSource(source.id, config, force));
  } else {
    console.log(await fetchSource(path, config, force));
  }
  process.exit(0);
}

if (command === "process") {
  const config = option("--config", "config/sources.json");
  const out = option("--out", "data/work/latest");
  const result = await processSources(config);
  await writeBundle(result, out);
  console.log(`Wrote ${result.catalogue.length} accepted records, ${result.rejections.length} rejections, and ${result.duplicates.length} duplicate-review clusters to ${out}.`);
  process.exit(0);
}

if (!path) throw new Error("A catalogue path is required.");
const catalogue = await readCatalogue(path);

if (command === "validate") {
  const duplicateIds = catalogue
    .map((item) => item.stableId)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateIds.length) {
    throw new Error(`Duplicate stable IDs: ${[...new Set(duplicateIds)].join(", ")}`);
  }
  console.log(`Valid catalogue: ${catalogue.length} records.`);
} else if (command === "summary") {
  console.log(JSON.stringify(summarizeCatalogue(catalogue), null, 2));
} else if (command === "inspect") {
  const stableId = arguments_[1];
  if (!stableId) throw new Error("A stable ID is required for inspect.");
  const record = catalogue.find((item) => item.stableId === stableId);
  if (!record) throw new Error(`No record with stable ID: ${stableId}`);
  console.log(JSON.stringify(record, null, 2));
} else {
  throw new Error(`Unknown command: ${command}`);
}
