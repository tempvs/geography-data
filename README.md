# Tempvs geography data

Reusable place-catalogue preparation tools and versioned catalogue manifests for
Tempvs. This repository is intentionally separate from the future Geography API
service: it can build, inspect, validate, and release deterministic place-data
bundles without deploying a Lambda.

## What belongs here

- TypeScript processing CLI, schemas, source adapters, and selection rules.
- Small curated JSON/JSONL samples and release manifests.
- Checksums, licences, provenance, and reproducible source configuration.

Raw global downloads do **not** belong in normal Git history. Small curated
catalogue releases are committed as 10–25 MB compressed JSONL chunks alongside
their manifest and Git tag. Introduce immutable S3 artifacts only when a
release exceeds the repository policy, needs durable AWS-side dev→production
promotion, or needs lifecycle/backup controls. A future `dataset:publish`
command will choose the appropriate target and may support an optional GitHub
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

## Release layout

Canonical places are **not** split primarily by historical period: one place
may be relevant in several periods. A published release uses separately
chunked, deterministic stable-ID-hash partitions:

```text
releases/vX.Y.Z/
  manifest.json
  summary.json
  places/part-*.jsonl.gz
  names/part-*.jsonl.gz
  parents/part-*.jsonl.gz
  period-relevance/part-*.jsonl.gz
  provenance/part-*.jsonl.gz
```

Country and period summaries are generated views for review; they do not
duplicate canonical records. The first curated 150k–300k catalogue is expected
to occupy roughly 75–350 MB compressed, depending on aliases and provenance.

## CI policy

Do not make ordinary CI runs fetch the internet and commit generated catalogue
data. Build locally from pinned sources, inspect the generated manifest and
summary, then publish a reviewed release. A manually triggered CI workflow may
validate the selected release and import its exact checksum into an environment.
