import { createHash } from "node:crypto";
import { validateCaseFileData } from "./validate-case-file.mjs";
import { serializeJson, snapshotJson } from "./protocol-json.mjs";
const SafeArray = Array; const SafeMap = Map; const SafeSet = Set; const SafeString = String; const SafeRegExp = RegExp; const SafeObject = Object; const SafeJson = JSON; const SafeReflect = Reflect; const SafeError = Error; const { every, filter, find, indexOf, join, map, push, slice, sort } = SafeArray.prototype; const { delete: mapDelete, forEach: mapForEach, get: mapGet, has: mapHas, set: mapSet } = SafeMap.prototype; const { add: setAdd, has: setHas } = SafeSet.prototype; const isArray = SafeArray.isArray; const trim = SafeString.prototype.trim; const regexTest = SafeRegExp.prototype.test;
const reflectApply = Reflect.apply; const apply = (method, values, ...args) => reflectApply(method, values, args);
const values = (source) => { const result = []; apply(mapForEach, source, (value) => apply(push, result, value)); return result; };
const phases = ["qualify", "audit", "design", "build", "evaluate", "deploy", "handoff"]; const authorityTypes = new SafeSet(["human-answer", "phase-approved", "action-authorized", "authorization-revoked"]);
function requireValue(condition, message) { if (!condition) throw new SafeError(message); }
const nonEmpty = (value) => typeof value === "string" && apply(trim, value).length > 0;
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const digest = (value) => createHash("sha256").update(serializeJson(value)).digest("hex");
const getDescriptors = Object.getOwnPropertyDescriptors; const ownKeys = Reflect.ownKeys;
const intrinsicGuards = apply(map, [SafeArray, SafeArray.prototype, SafeMap, SafeMap.prototype, SafeSet, SafeSet.prototype, SafeString, SafeString.prototype, SafeRegExp, SafeRegExp.prototype, SafeObject, SafeJson, SafeReflect, SafeError], (intrinsic) => [intrinsic, getDescriptors(intrinsic)]);
function requireSafeIntrinsics() { requireValue(globalThis.Array === SafeArray && globalThis.Map === SafeMap && globalThis.Set === SafeSet && globalThis.String === SafeString && globalThis.RegExp === SafeRegExp && globalThis.Object === SafeObject && globalThis.JSON === SafeJson && globalThis.Reflect === SafeReflect && globalThis.Error === SafeError, "runtime intrinsics changed during replay");
  for (let index = 0; index < intrinsicGuards.length; index += 1) { const prototype = intrinsicGuards[index][0]; const baseline = intrinsicGuards[index][1]; const current = getDescriptors(prototype); const keys = ownKeys(baseline); requireValue(keys.length === ownKeys(current).length, "runtime intrinsics changed during replay");
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) { const before = baseline[keys[keyIndex]]; const after = current[keys[keyIndex]]; requireValue(after && before.value === after.value && before.get === after.get && before.set === after.set && before.writable === after.writable && before.enumerable === after.enumerable && before.configurable === after.configurable, "runtime intrinsics changed during replay"); }
  }
}
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
  requireSafeIntrinsics();
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
  requireValue(isArray(bindings), `${record.id}.evidenceBindings must be an array`);
  const evidenceIds = new SafeSet(apply(map, evidence, (item) => item?.id));
  const sourceIds = new SafeSet(apply(map, sources, (item) => item?.sourceId));
  requireValue(sourceIds.size === sources.length, `${record.id} manifest source IDs must be unique`);
  const validSources = apply(every, sources, (source) =>
    nonEmpty(source?.sourceId) && apply(regexTest, /^[a-f0-9]{64}$/, source?.sha256 ?? ""));
  requireValue(validSources, `${record.id} manifest sources require stable IDs and SHA-256 hashes`);
  const boundEvidence = new SafeSet();
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];
    const prefix = `${record.id}.evidenceBindings[${index}]`;
    requireValue(apply(setHas, evidenceIds, binding?.evidenceId), `${prefix}.evidenceId is unknown`);
    requireValue(apply(setHas, sourceIds, binding?.sourceId), `${prefix}.sourceId is absent from the manifest`);
    requireValue(binding?.manifestSha256 === record.sourceManifest?.manifestSha256, `${prefix}.manifestSha256 does not match the manifest`);
    requireValue(!apply(setHas, boundEvidence, binding.evidenceId), `${prefix}.evidenceId is duplicated`);
    apply(setAdd, boundEvidence, binding.evidenceId);
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
  }); requireSafeIntrinsics();
  requireValue(validationErrors.length === 0, `${record.id} case validation failed: ${apply(join, validationErrors, "; ")}`);
  validateEvidenceBindings(record);
  requireValue((await verifyCaseSubmission(record)) === true, `${record.id} case submission verification failed`);
  requireSafeIntrinsics();
}
function unresolvedItems(caseFile) {
  const items = apply(map, caseFile.unknowns ?? [], (value, index) => ({
    path: `unknowns[${index}]`,
    value,
  }));
  const conflicts = caseFile.domainModel?.conflicts ?? [];
  for (let index = 0; index < conflicts.length; index += 1) {
    const conflict = conflicts[index];
    if (conflict?.status === "deferred") {
      apply(push, items, { path: `domainModel.conflicts[${index}]`, value: conflict.description });
    }
  }
  const failures = caseFile.evalPlan?.unresolvedSevereFailures ?? [];
  for (let index = 0; index < failures.length; index += 1) {
    const value = failures[index];
    apply(push, items, { path: `evalPlan.unresolvedSevereFailures[${index}]`, value });
  }
  return apply(sort, items, (left, right) => compare(left.path, right.path));
}
export async function replayEngagement(records, {
  verifyAuthority,
  verifyCaseSubmission,
} = {}) {
  requireValue(typeof verifyAuthority === "function", "verifyAuthority is required");
  requireValue(typeof verifyCaseSubmission === "function", "verifyCaseSubmission is required");
  requireSafeIntrinsics();
  const replayRecords = snapshotJson(records);
  requireValue(isArray(replayRecords), "records must be an array");
  const uniqueRecords = [];
  const recordsById = new SafeMap();
  let submission = null;
  let answers = new SafeMap();
  let approvals = [];
  let authorizations = new SafeMap();
  const grantsById = new SafeMap();
  const revokedIds = new SafeSet();
  for (const record of replayRecords) {
    requireValue(record && typeof record === "object", "each record must be an object");
    requireValue(nonEmpty(record.id), "each record requires an id");
    requireValue(nonEmpty(record.type), `${record.id}.type is required`);
    if (apply(mapHas, recordsById, record.id)) {
      requireValue(
        serializeJson(apply(mapGet, recordsById, record.id)) === serializeJson(record),
        `record ID ${record.id} conflicts with an earlier record`,
      );
      continue;
    }
    if (apply(setHas, authorityTypes, record.type)) {
      await requireVerifiedAuthority(record, verifyAuthority);
    }
    if (record.type === "case-submitted") {
      validateAttribution(record);
      await validateSubmission(record, verifyCaseSubmission);
      submission = { record, caseDigest: digest(record.caseFile) };
      answers = new SafeMap();
      approvals = [];
      authorizations = new SafeMap();
      apply(mapSet, recordsById, record.id, record);
      apply(push, uniqueRecords, record);
      continue;
    }
    requireValue(submission, `${record.id} requires a case submission`);
    if (record.type === "human-answer") {
      requireCurrentCase(record, submission);
      const node = apply(find, submission.record.caseFile.decisionTree?.nodes ?? [],
        (item) => item.id === record.nodeId,
      );
      requireValue(node, `${record.id}.nodeId is unknown`);
      requireValue(
        node.status === "settled" && node.answer === record.answer,
        `${record.id}.answer must match the settled decision node`,
      );
      apply(mapSet, answers, record.nodeId, record);
    } else if (record.type === "phase-approved") {
      requireCurrentCase(record, submission);
      const expectedPhase = phases[approvals.length];
      requireValue(
        record.phase === expectedPhase,
        `${record.id} cannot approve ${record.phase}; expected ${expectedPhase}`,
      );
      requireValue(
        apply(indexOf, phases, record.phase) <=
          apply(indexOf, phases, submission.record.caseFile.phase),
        `${record.id} cannot approve beyond the submitted case phase`,
      );
      const unsettledHumanAnswers = apply(filter,
        submission.record.caseFile.decisionTree?.nodes ?? [],
        (node) => node.status === "settled" && !apply(mapHas, answers, node.id),
      );
      requireValue(
        unsettledHumanAnswers.length === 0,
        `${record.id} requires verified human answers for: ${apply(
          join, apply(map, unsettledHumanAnswers, (node) => node.id), ", ")}`,
      );
      apply(push, approvals, record);
    } else if (record.type === "action-authorized") {
      requireCurrentCase(record, submission);
      requireValue(
        nonEmpty(record.authorizationId) &&
          nonEmpty(record.action) &&
          nonEmpty(record.resource) &&
          isArray(record.constraints) &&
          apply(every, record.constraints, nonEmpty),
        `${record.id} requires an authorization ID, action, resource, and constraints`,
      );
      requireValue(
        !apply(mapHas, grantsById, record.authorizationId),
        `${record.id}.authorizationId was already granted`,
      );
      apply(mapSet, grantsById, record.authorizationId, record);
      apply(mapSet, authorizations, record.authorizationId, record);
    } else if (record.type === "authorization-revoked") {
      requireValue(
        nonEmpty(record.authorizationId) &&
          apply(mapHas, grantsById, record.authorizationId) &&
          !apply(setHas, revokedIds, record.authorizationId),
        `${record.id}.authorizationId does not identify one unrevoked grant`,
      );
      apply(mapDelete, authorizations, record.authorizationId);
      apply(setAdd, revokedIds, record.authorizationId);
    } else {
      throw new Error(`${record.id}.type is not supported`);
    }
    apply(mapSet, recordsById, record.id, record);
    apply(push, uniqueRecords, record);
  }
  const caseFile = submission?.record.caseFile;
  const targetPhaseCount = caseFile ? apply(indexOf, phases, caseFile.phase) + 1 : 0;
  const body = {
    version: 1,
    recordCount: uniqueRecords.length,
    recordDigest: digest(uniqueRecords),
    phase: caseFile?.phase ?? null,
    gate: {
      status: approvals.length === targetPhaseCount && apply(every, approvals, (record, index) => record.phase === phases[index]) ? "passed" : "blocked",
      caseEventId: submission?.record.id ?? null,
      caseDigest: submission?.caseDigest ?? null,
      approvedPhases: apply(map, approvals, (record) => record.phase),
    },
    manifestSha256: submission?.record.sourceManifest?.manifestSha256 ?? null,
    evidenceReferences: apply(sort, apply(slice, submission?.record.evidenceBindings ?? [], 0),
      (left, right) => compare(left.evidenceId, right.evidenceId),
    ),
    decisions: apply(sort, apply(map, caseFile?.decisionTree?.nodes ?? [], (node) => ({
        id: node.id,
        prerequisites: node.prerequisites,
        status: node.status,
        evidenceIds: node.evidenceIds,
        reopenIf: node.reopenIf,
      })), (left, right) => compare(left.id, right.id)),
    humanAnswers: apply(sort, apply(map, values(answers), (record) => ({
        recordId: record.id,
        nodeId: record.nodeId,
        answer: record.answer,
        actor: record.actor,
      })), (left, right) => compare(left.nodeId, right.nodeId)),
    approvals: apply(map, approvals, (record) => ({
      recordId: record.id,
      phase: record.phase,
      caseEventId: record.caseEventId,
      caseDigest: record.caseDigest,
      actor: record.actor,
    })),
    authorizations: apply(sort, apply(map, values(authorizations), (record) => ({
        recordId: record.id,
        authorizationId: record.authorizationId,
        action: record.action,
        resource: record.resource,
        constraints: record.constraints,
        actor: record.actor,
      })), (left, right) => compare(left.authorizationId, right.authorizationId)),
    unresolved: caseFile ? unresolvedItems(caseFile) : [],
  };
  return snapshotJson({ ...body, digest: digest(body) });
}
export async function checkpointMatchesRecords(records, checkpoint, verifiers) {
  const expected = snapshotJson(checkpoint);
  return serializeJson(await replayEngagement(records, verifiers)) === serializeJson(expected);
}
