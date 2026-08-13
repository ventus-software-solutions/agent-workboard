const LEGACY_ARTIFACT_NOTE = "Entered testing before verification targets were required; identify the running artifact before verification.";

export function normalizeVerificationTarget(value, { migrating = false } = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const target = {
    commitSha: normalizeText(source.commitSha),
    mergedTo: normalizeText(source.mergedTo),
    artifactNote: normalizeText(source.artifactNote || source.artifact)
  };

  if (target.commitSha || target.mergedTo || target.artifactNote) return target;
  if (migrating) {
    return { commitSha: "", mergedTo: "", artifactNote: LEGACY_ARTIFACT_NOTE };
  }

  throw verificationTargetRequiredError();
}

export function verificationTargetRequiredError() {
  return Object.assign(
    new Error("A verification target with commitSha, mergedTo, or artifactNote is required before moving a task to testing."),
    {
      status: 400,
      details: {
        reason: "verification_target_required",
        field: "verificationTarget",
        acceptedFields: ["commitSha", "mergedTo", "artifactNote"]
      }
    }
  );
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}
