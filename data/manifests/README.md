# Dataset manifests

Each published catalogue bundle has a checked-in JSON manifest recording:

- bundle version and SHA-256 checksum;
- source datasets, licences, versions, and fetch dates;
- selection-rule version;
- record counts and rejected/merged candidates;
- S3 object key for large immutable artifacts.

Small curated samples may be committed directly. Raw downloads and generated
large bundles are intentionally excluded from ordinary Git history.
