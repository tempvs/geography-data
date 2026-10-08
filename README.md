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
fetch -> normalize -> validate/deduplicate -> inspect -> review duplicates -> curate -> dev import -> promote same bundle
```

The command-line interface fetches only explicitly configured source files,
normalizes them locally, validates the result, emits a reviewable bundle, and
never uploads anything. It does not use an external autocomplete API and it
does not auto-merge different source records: likely duplicates are reported
for human review.

## Local use

```powershell
npm install
npm run check
npm run geo -- validate data/samples/catalogue.sample.jsonl
npm run geo -- summary data/samples/catalogue.sample.jsonl
```

### Create a local first-pass dataset

This is intentionally a local, manually reviewed operation. The two public
downloads are cached under `data/raw/` (which is ignored by Git), while the
generated bundle goes under `data/work/` (also ignored by Git).

```powershell
# Download only the configured public sources. Re-run with --force to refresh.
npm run geo -- fetch geonames-cities5000
npm run geo -- fetch pleiades-places

# Optional: place a hand-curated Wikidata extract at
# data/raw/wikidata/candidates.jsonl. See the fixture for the required JSONL shape.

# Normalize, select transparent candidates, validate basic data, and build reports.
npm run geo -- process --out data/work/first-pass

# Inspect the result before any future import.
Get-Content data/work/first-pass/summary.json
Get-Content data/work/first-pass/duplicates.json
Get-Content data/work/first-pass/rejections.jsonl
npm run geo -- validate data/work/first-pass/catalogue.jsonl
npm run geo -- inspect data/work/first-pass/catalogue.jsonl geonames-cities5000:3169070
```

### Resolve duplicate-review clusters before import

`process` deliberately produces a **first-pass** bundle. It is not importable
when `summary.duplicateClusters` is non-zero. Generate a review file, inspect
every cluster, and explicitly choose the canonical record for each actual
match. Do not use an automatic bulk merge: nearby places with the same name
are often distinct historical places.

```powershell
npm run geo -- review:init data/work/first-pass --out data/work/first-pass-review.json
# Edit data/work/first-pass-review.json. For every decision set action to MERGE
# and set canonicalStableId to one ID listed in that cluster.
npm run geo -- curate data/work/first-pass --decisions data/work/first-pass-review.json --out data/work/reviewed-v1
npm run geo -- validate data/work/reviewed-v1/catalogue.jsonl
```

`KEEP_SEPARATE` is deliberately not importable. It documents that the reviewer
does not want to merge a cluster, but it keeps the bundle blocked until the
records are re-modelled or excluded in a future, separately reviewed release.
The curated manifest stores hashes of both the original bundle and review file;
changing the source bundle requires a fresh review file.

`config/sources.json` is the pinned source registry. The current first pass
uses GeoNames `cities5000` for significant modern settlements/admin centres
and Pleiades for curated ancient places. A full Wikidata dump is deliberately
not fetched automatically: add a small, documented curated extract when it is
ready. Each fetched file receives adjacent metadata recording URL, access time,
licence, byte size, and SHA-256. Pleiades' release currently contains a nested
`data/gis/places.csv`; the configured extractor records that exact entry.

## File format

For small data, use a JSON array. For catalogue bundles, use newline-delimited
JSON (`.jsonl` or `.jsonl.gz`) so processing is streaming and a malformed entry
can be identified by line number.

Every record requires a stable external/Tempvs ID, name, WGS84 point, feature
type, at least one transparent selection reason, and at least one source with
licence/provenance.

Historical place-name validity uses astronomical years internally. A missing
`validTo` is intentional and means the name remains current indefinitely. The
processor converts source-specific present/future horizons (such as `2100`) to
that open-ended form; real historical end dates are retained.

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

### Checked-in development pilot

`data/releases/dev-pilot-v1` is a deliberately small, reviewed development
bundle: Rome, Mainz (Mogontiacum), Regensburg (Castra Regina), Dura-Europos,
and Krefeld (Gelduba). It is kept in Git so development environments can repeat
the exact import without re-fetching external data. Validate it with:

```powershell
npm.cmd run geo -- validate data/releases/dev-pilot-v1/catalogue.jsonl
```
