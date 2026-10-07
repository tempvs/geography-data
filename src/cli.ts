import { readCatalogue, summarizeCatalogue } from "./catalogue.js";

const [command, path] = process.argv.slice(2);

if (!command || command === "help" || command === "--help") {
  console.log("Usage: geo <validate|summary> <catalogue.json|catalogue.jsonl[.gz]>");
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
} else {
  throw new Error(`Unknown command: ${command}`);
}
