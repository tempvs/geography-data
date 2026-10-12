import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type ImportReconciliationReport = {
  version: 1;
  artifactId: string;
  target: { environment: string; tableName: string };
  summary: {
    mode: "PREVIEW" | "CREATE_ONLY";
    dryRun: boolean;
    conflicts: number;
    reconciliation: {
      accepted: number;
      rejected: number;
      merged: number;
      unmatchedParents: number;
      aliasesRetained: number;
      aliasesDropped: number;
      itemsWritten: number;
      bytesStored: number;
      consumedCapacityUnits: number;
    };
  };
};

const invariantFields = [
  "accepted",
  "rejected",
  "merged",
  "unmatchedParents",
  "aliasesRetained",
  "aliasesDropped",
] as const;

/** Promotion is allowed only after a matching dev run. Capacity and physical
 * storage naturally vary by environment, while the semantic reconciliation
 * values must be identical for the same immutable source artifact. */
export async function verifyPromotionReports(options: {
  developmentReportPath: string;
  candidateReportPath: string;
}): Promise<{ artifactId: string; fingerprint: string }> {
  const development = await readReport(options.developmentReportPath);
  const candidate = await readReport(options.candidateReportPath);
  if (development.target.environment.toLowerCase() !== "dev")
    throw new Error("The baseline report must be a development import report.");
  if (candidate.target.environment.toLowerCase() === "dev")
    throw new Error("The promotion candidate must target a non-development environment.");
  if (development.artifactId !== candidate.artifactId)
    throw new Error("Promotion reports do not reference the same immutable artifact.");
  if (development.summary.dryRun || development.summary.mode !== "CREATE_ONLY")
    throw new Error("The baseline report must be a completed development CREATE_ONLY report.");
  if (
    !(
      (candidate.summary.dryRun && candidate.summary.mode === "PREVIEW") ||
      (!candidate.summary.dryRun && candidate.summary.mode === "CREATE_ONLY")
    )
  )
    throw new Error("The target report must be a PREVIEW or completed CREATE_ONLY report.");
  if (development.summary.conflicts || candidate.summary.conflicts)
    throw new Error("Promotion reports contain unresolved stable-key conflicts.");
  for (const field of invariantFields) {
    if (
      development.summary.reconciliation[field] !==
      candidate.summary.reconciliation[field]
    ) {
      throw new Error(
        `Promotion reconciliation mismatch for ${field}: dev=${development.summary.reconciliation[field]}, target=${candidate.summary.reconciliation[field]}.`,
      );
    }
  }
  return {
    artifactId: development.artifactId,
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ development, candidate }))
      .digest("hex"),
  };
}

async function readReport(path: string): Promise<ImportReconciliationReport> {
  const value = JSON.parse(await readFile(path, "utf8")) as ImportReconciliationReport;
  if (
    value.version !== 1 ||
    !/^geo-v\d+-[a-f0-9]{12,64}$/i.test(value.artifactId) ||
    !value.target?.environment?.trim() ||
    !value.target?.tableName?.trim() ||
    !value.summary?.reconciliation
  )
    throw new Error(`Invalid import reconciliation report: ${path}`);
  return value;
}
