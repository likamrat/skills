import { createHash } from "node:crypto";
import { validateCaseFileData } from "./validate-case-file.mjs";
import { serializeJson, snapshotJson } from "./protocol-json.mjs";
const phases = ["qualify", "audit", "design", "build", "evaluate", "deploy", "handoff"];
const authorityTypes = new Set(["human-answer", "phase-approved", "action-authorized", "authorization-revoked"]);
function requireValue(condition, message) { if (!condition) throw new Error(message); }
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const digest = (value) => createHash("sha256").update(serializeJson(value)).digest("hex");
function validateAttribution(record) {
  requireValue(record.actor && typeof record.actor === "object", `${record.id}.actor is required`);
  requireValue(nonEmpty(record.actor.id), `${record.id}.actor.id is required`);
  requireValue(nonEmpty(record.actor.kind), `${record.id}.actor.kind is required`);
}
async function requireVerifiedAuthority(record, verifyAuthority) {
  validateAttribution(record);
  requireValue(record.actor.kind === "human", `${record.id} requires human attribution`);
  requireValue(record.attestation != null, `${record.id}.attestation is required`);
  requireValue(typeof verifyAuthority === "function", `${record.id} requires an external authority verifier`);
  requireValue((await verifyAuthority(record)) === true, `${record.id} authority verification failed`);
}
function requireCurrentCase(record, submission) {
  const current = record.caseEventId === submission.record.id &&
    record.caseDigest === submission.caseDigest;
  requireValue(current, `${record.id} must bind to the current case submission and digest`);
}
function validateEvidenceBindings(record) {
  const evidence = record.caseFile?.evidence ?? [];
  const sources = record.sourceManifest?.sources ?? [];
  const bindings = record.evidenceBindings;
  requireValue(Array.isArray(bindings), `${record.id}.evidenceBindings must be an array`);
  const evidenceIds = new Set(evidence.map((item) => item?.id));
  const sourceIds = new Set(sources.map((item) => item?.sourceId));
  requireValue(sourceIds.size === sources.length, `${record.id} manifest source IDs must be unique`);
  const validSources = sources.every((source) =>
    nonEmpty(source?.sourceId) && /^[a-f0-9]{64}$/.test(source?.sha256 ?? ""));
  requireValue(validSources, `${record.id} manifest sources require stable IDs and SHA-256 hashes`);
  const boundEvidence = new Set();
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];
    const prefix = `${record.id}.evidenceBindings[${index}]`;
    requireValue(evidenceIds.has(binding?.evidenceId), `${prefix}.evidenceId is unknown`);
    requireValue(sourceIds.has(binding?.sourceId), `${prefix}.sourceId is absent from the manifest`);
    requireValue(binding?.manifestSha256 === record.sourceManifest?.manifestSha256, `${prefix}.manifestSha256 does not match the manifest`);
    requireValue(!boundEvidence.has(binding.evidenceId), `${prefix}.evidenceId is duplicated`);
    boundEvidence.add(binding.evidenceId);
  }
  requireValue(evidenceIds.size === boundEvidence.size, `${record.id} must bind every evidence ID to the manifest`);
}
async function validateSubmission(record, verifyCaseSubmission) {
  requireValue(record.caseFile && typeof record.caseFile === "object", `${record.id}.caseFile is required`);
  requireValue(record.sourceManifest && typeof record.sourceManifest === "object", `${record.id}.sourceManifest is required`);
  requireValue(record.submissionReceipt != null, `${record.id}.submissionReceipt is required`);
  const validationErrors = await validateCaseFileData(record.caseFile, {
    sourceManifest: record.sourceManifest,
    requireSourceIntake: true,
  });
  requireValue(validationErrors.length === 0, `${record.id} case validation failed: ${validationErrors.join("; ")}`);
  validateEvidenceBindings(record);
  requireValue((await verifyCaseSubmission(record)) === true, `${record.id} case submission verification failed`);
}
function unresolvedItems(caseFile) {
  const items = (caseFile.unknowns ?? []).map((value, index) => ({
    path: `unknowns[${index}]`,
    value,
  }));
  const conflicts = caseFile.domainModel?.conflicts ?? [];
  for (let index = 0; index < conflicts.length; index += 1) {
    const conflict = conflicts[index];
    if (conflict?.status === "deferred") {
      items.push({ path: `domainModel.conflicts[${index}]`, value: conflict.description });
    }
  }
  const failures = caseFile.evalPlan?.unresolvedSevereFailures ?? [];
  for (let index = 0; index < failures.length; index += 1) {
    const value = failures[index];
    items.push({ path: `evalPlan.unresolvedSevereFailures[${index}]`, value });
  }
  return items.sort((left, right) => compare(left.path, right.path));
}
export async function replayEngagement(records, {
  verifyAuthority,
  verifyCaseSubmission,
} = {}) {
  requireValue(typeof verifyAuthority === "function", "verifyAuthority is required");
  requireValue(typeof verifyCaseSubmission === "function", "verifyCaseSubmission is required");
  const replayRecords = snapshotJson(records);
  requireValue(Array.isArray(replayRecords), "records must be an array");
  const uniqueRecords = [];
  const recordsById = new Map();
  let submission = null;
  let answers = new Map();
  let approvals = [];
  let authorizations = new Map();
  const grantsById = new Map();
  const revokedIds = new Set();
  for (const record of replayRecords) {
    requireValue(record && typeof record === "object", "each record must be an object");
    requireValue(nonEmpty(record.id), "each record requires an id");
    requireValue(nonEmpty(record.type), `${record.id}.type is required`);
    if (recordsById.has(record.id)) {
      requireValue(
        serializeJson(recordsById.get(record.id)) === serializeJson(record),
        `record ID ${record.id} conflicts with an earlier record`,
      );
      continue;
    }
    if (authorityTypes.has(record.type)) {
      await requireVerifiedAuthority(record, verifyAuthority);
    }
    if (record.type === "case-submitted") {
      validateAttribution(record);
      await validateSubmission(record, verifyCaseSubmission);
      submission = { record, caseDigest: digest(record.caseFile) };
      answers = new Map();
      approvals = [];
      authorizations = new Map();
      recordsById.set(record.id, record);
      uniqueRecords.push(record);
      continue;
    }
    requireValue(submission, `${record.id} requires a case submission`);
    if (record.type === "human-answer") {
      requireCurrentCase(record, submission);
      const node = (submission.record.caseFile.decisionTree?.nodes ?? []).find(
        (item) => item.id === record.nodeId,
      );
      requireValue(node, `${record.id}.nodeId is unknown`);
      requireValue(
        node.status === "settled" && node.answer === record.answer,
        `${record.id}.answer must match the settled decision node`,
      );
      answers.set(record.nodeId, record);
    } else if (record.type === "phase-approved") {
      requireCurrentCase(record, submission);
      const expectedPhase = phases[approvals.length];
      requireValue(
        record.phase === expectedPhase,
        `${record.id} cannot approve ${record.phase}; expected ${expectedPhase}`,
      );
      requireValue(
        phases.indexOf(record.phase) <=
          phases.indexOf(submission.record.caseFile.phase),
        `${record.id} cannot approve beyond the submitted case phase`,
      );
      const unsettledHumanAnswers = (
        submission.record.caseFile.decisionTree?.nodes ?? []
      ).filter((node) => node.status === "settled" && !answers.has(node.id));
      requireValue(
        unsettledHumanAnswers.length === 0,
        `${record.id} requires verified human answers for: ${unsettledHumanAnswers
          .map((node) => node.id).join(", ")}`,
      );
      approvals.push(record);
    } else if (record.type === "action-authorized") {
      requireCurrentCase(record, submission);
      requireValue(
        nonEmpty(record.authorizationId) &&
          nonEmpty(record.action) &&
          nonEmpty(record.resource) &&
          Array.isArray(record.constraints) &&
          record.constraints.every(nonEmpty),
        `${record.id} requires an authorization ID, action, resource, and constraints`,
      );
      requireValue(
        !grantsById.has(record.authorizationId),
        `${record.id}.authorizationId was already granted`,
      );
      grantsById.set(record.authorizationId, record);
      authorizations.set(record.authorizationId, record);
    } else if (record.type === "authorization-revoked") {
      requireValue(
        nonEmpty(record.authorizationId) &&
          grantsById.has(record.authorizationId) &&
          !revokedIds.has(record.authorizationId),
        `${record.id}.authorizationId does not identify one unrevoked grant`,
      );
      authorizations.delete(record.authorizationId);
      revokedIds.add(record.authorizationId);
    } else {
      throw new Error(`${record.id}.type is not supported`);
    }
    recordsById.set(record.id, record);
    uniqueRecords.push(record);
  }
  const caseFile = submission?.record.caseFile;
  const targetPhaseCount = caseFile ? phases.indexOf(caseFile.phase) + 1 : 0;
  const body = {
    version: 1,
    recordCount: uniqueRecords.length,
    recordDigest: digest(uniqueRecords),
    phase: caseFile?.phase ?? null,
    gate: {
      status: submission && approvals.length === targetPhaseCount &&
        approvals.every((record, index) => record.phase === phases[index]) ? "passed" : "blocked",
      caseEventId: submission?.record.id ?? null,
      caseDigest: submission?.caseDigest ?? null,
      approvedPhases: approvals.map((record) => record.phase),
    },
    manifestSha256: submission?.record.sourceManifest?.manifestSha256 ?? null,
    evidenceReferences: [...(submission?.record.evidenceBindings ?? [])].sort(
      (left, right) => compare(left.evidenceId, right.evidenceId),
    ),
    decisions: (caseFile?.decisionTree?.nodes ?? []).map((node) => ({
        id: node.id,
        prerequisites: node.prerequisites,
        status: node.status,
        evidenceIds: node.evidenceIds,
        reopenIf: node.reopenIf,
      })).sort((left, right) => compare(left.id, right.id)),
    humanAnswers: [...answers.values()].map((record) => ({
        recordId: record.id,
        nodeId: record.nodeId,
        answer: record.answer,
        actor: record.actor,
      })).sort((left, right) => compare(left.nodeId, right.nodeId)),
    approvals: approvals.map((record) => ({
      recordId: record.id,
      phase: record.phase,
      caseEventId: record.caseEventId,
      caseDigest: record.caseDigest,
      actor: record.actor,
    })),
    authorizations: [...authorizations.values()].map((record) => ({
        recordId: record.id,
        authorizationId: record.authorizationId,
        action: record.action,
        resource: record.resource,
        constraints: record.constraints,
        actor: record.actor,
      })).sort((left, right) => compare(left.authorizationId, right.authorizationId)),
    unresolved: caseFile ? unresolvedItems(caseFile) : [],
  };
  return snapshotJson({ ...body, digest: digest(body) });
}
export async function checkpointMatchesRecords(records, checkpoint, verifiers) {
  const expected = snapshotJson(checkpoint);
  return serializeJson(await replayEngagement(records, verifiers)) === serializeJson(expected);
}
