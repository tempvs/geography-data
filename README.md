# Tempvs geography data

Reusable place-catalogue preparation tools and versioned catalogue manifests for
Tempvs. This repository is intentionally separate from the future Geography API
service: it can build, inspect, validate, and release deterministic place-data
bundles without deploying a Lambda.

## What belongs here

- TypeScript processing CLI, schemas, source adapters, and selection rules.
- Small curated JSON/JSONL samples and release manifests.
- Checksums, licences, provenance, and reproducible source configuration.

Raw global downloads and large regenerated bundles do **not** belong in normal
Git history. Publish them as immutable S3 artifacts named by a checked-in
manifest. A future `dataset:publish` command will support an optional GitHub
Release or Git LFS mirror after quota/cost review.

## Data scope

The first catalogue starts at 5000 BC and includes only significant places:
curated historical places, capitals/administrative centres, archaeological and
historic sites, battlefields/fortifications, religious/cultural sites,
museums/archives/repositories, and selected modern regional centres. A place
record must retain its selection reasons and source provenance.

The processing order is:

```text
fetch -> normalize -> validate/deduplicate -> inspect -> bundle -> dev import -> promote same bundle
```

The command-line interface currently validates and summarizes portable JSON or
JSONL catalogues. It is the foundation for source adapters and bundle/import
commands.

## Local use

```powershell
npm install
npm run check
npm run geo -- validate data/samples/catalogue.sample.jsonl
npm run geo -- summary data/samples/catalogue.sample.jsonl
```

## File format

For small data, use a JSON array. For catalogue bundles, use newline-delimited
JSON (`.jsonl` or `.jsonl.gz`) so processing is streaming and a malformed entry
can be identified by line number.

Every record requires a stable external/Tempvs ID, name, WGS84 point, feature
type, at least one transparent selection reason, and at least one source with
licence/provenance.
