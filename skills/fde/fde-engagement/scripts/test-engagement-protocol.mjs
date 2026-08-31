#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { checkpointMatchesRecords, replayEngagement } from "./engagement-protocol.mjs";
import { serializeJson, snapshotJson } from "./protocol-json.mjs";
import { validateCaseFileData } from "./validate-case-file.mjs";
const baseCase = JSON.parse(await readFile(new URL("../evals/files/readout-case.json", import.meta.url)));
const manifest = JSON.parse(await readFile(new URL("../evals/files/readout-case-source-manifest.json", import.meta.url)));
baseCase.gate = { ...baseCase.gate, status: "passed", reason: "Human review accepted the audit gate." }; baseCase.unknowns = ["Written authorization policy"]; baseCase.evalPlan = { unresolvedSevereFailures: [] };
baseCase.fieldJudgment = {
  entries: [{
    id: "judgment-observation-001", kind: "firsthand-observation",
    authorRole: "FDE", origin: "human-confirmed",
    statement: "Operators use distinct recommendation and authorization steps.",
    context: "Claims workflow audit",
    whyItMatters: "The distinction controls who may release payment.",
    evidenceIds: ["interview-001"], customerSafe: true,
  }],
  retrospective: { status: "pending", reason: "", evidenceIds: [] },
};
const actor = { kind: "human", id: "reviewer-1" };
const verifiers = {
  verifyAuthority: (record) => record.attestation === "trusted",
  verifyCaseSubmission: (record) => record.submissionReceipt === "trusted",
};
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
async function rejects(name, action, expected) {
  try {
    await action();
    failures.push(`${name}: expected rejection`);
  } catch (error) {
    check(error.message.includes(expected), `${name}: ${error.message}`);
  }
}
function submission(id = "case-1", data = structuredClone(baseCase)) {
  return {
    id, type: "case-submitted",
    actor: { kind: "agent", id: "driver-1" },
    caseFile: data, sourceManifest: structuredClone(manifest),
    submissionReceipt: "trusted",
    evidenceBindings: [["interview-001", "source-001"],
      ["interview-002", "source-001"], ["log-001", "source-002"],
    ].map(([evidenceId, sourceId]) => (
      { evidenceId, sourceId, manifestSha256: manifest.manifestSha256 })),
  };
}
const bind = ({ gate }) => ({ caseEventId: gate.caseEventId, caseDigest: gate.caseDigest });
const answer = (binding, id = "answer-1", attributedActor = actor) => ({
  id, type: "human-answer", actor: attributedActor, attestation: "trusted",
  ...binding, nodeId: "approval-language",
  answer: "Adjusters recommend; managers authorize above $25,000.",
});
const approval = (id, phase, binding) => ({
  id, type: "phase-approved", actor, attestation: "trusted", phase, ...binding,
});
const grant = (binding, id = "grant-1", authorizationId = "export-summary") => ({
  id, type: "action-authorized", actor, attestation: "trusted", ...binding,
  authorizationId, action: "write", resource: "engagement-summary", constraints: ["workspace-only"],
});
const revoke = (id = "revoke-1", authorizationId = "export-summary") => ({
  id, type: "authorization-revoked", actor, attestation: "trusted",
  authorizationId,
});
async function approved(caseRecord = submission()) {
  const binding = bind(await replayEngagement([caseRecord], verifiers));
  const records = [caseRecord, answer(binding),
    approval("approve-qualify", "qualify", binding),
    approval("approve-audit", "audit", binding)];
  return { binding, records   };
}
await rejects("missing authority verifier", () => replayEngagement(
  [], { verifyCaseSubmission: verifiers.verifyCaseSubmission }), "verifyAuthority is required");
await rejects("missing submission verifier", () => replayEngagement(
  [], { verifyAuthority: verifiers.verifyAuthority }), "verifyCaseSubmission is required");
const empty = await replayEngagement([], verifiers);
check(empty.gate.status === "blocked", "empty replay must not pass a gate");
await rejects("no current submission", () => replayEngagement([
  answer({ caseEventId: "missing", caseDigest: "missing" }, "orphan-answer"),
], verifiers), "requires a case submission");
await rejects("false authority verifier", async () => {
  const item = submission();
  const binding = bind(await replayEngagement([item], verifiers));
  await replayEngagement([item, answer(binding)], {
    ...verifiers, verifyAuthority: () => false,
  });
}, "authority verification failed");
for (const [name, verifyCaseSubmission] of [
  ["false", () => false],
  ["nonboolean", () => "true"],
  ["thrown", () => { throw new Error("untrusted receipt"); }],
]) {
  await rejects(`${name} submission verifier`, () =>
    replayEngagement([submission(`case-${name}`)], {
      ...verifiers, verifyCaseSubmission,
    }), name === "thrown" ? "untrusted receipt" : "verification failed");
}
await rejects("prerequisite ordering", async () => {
  const data = structuredClone(baseCase);
  const first = data.decisionTree.nodes[0];
  const dependent = structuredClone(first);
  first.status = "open";
  first.answer = "";
  Object.assign(dependent, { id: "dependent-decision", questionNumber: 2, prerequisites: [first.id] });
  data.decisionTree.nodes.push(dependent);
  data.decisionTree.nextQuestionNumber = 3;
  data.decisionTree.frontier = [first.id];
  data.decisionTree.rounds[0] = { id: "round-1", status: "active", nodeIds: [first.id, dependent.id] };
  await replayEngagement([submission("case-prerequisite", data)], verifiers);
}, "cannot settle before prerequisite");
await rejects("manifest binding", async () => {
  const item = submission();
  item.evidenceBindings[0].sourceId = "source-missing";
  await replayEngagement([item], verifiers);
}, "absent from the manifest");
const current = await approved();
const passed = await replayEngagement(current.records, verifiers);
check(passed.gate.status === "passed", "verified approval must close the gate");
check(passed.unresolved[0]?.path === "unknowns[0]", "unresolved state must come from the case");
check(await checkpointMatchesRecords(current.records, passed, verifiers), "exact replay must be deterministic");
const duplicated = await replayEngagement([...current.records, current.records[1]], verifiers);
check(duplicated.digest === passed.digest, "exact duplicate retries must be ignored");
await rejects("conflicting duplicate", () => replayEngagement(
  [...current.records, { ...current.records[1], answer: "conflict" }], verifiers),
"conflicts with an earlier record");
await rejects("agent claim", () => replayEngagement([
  current.records[0],
  answer(current.binding, "agent-answer", { kind: "agent", id: "model-1" }),
], verifiers), "human attribution");
await rejects("phase skip", () => replayEngagement(
  [current.records[0], current.records[1], approval("skip", "audit", current.binding)], verifiers),
"expected qualify");
await rejects("source action", () => replayEngagement([
  ...current.records,
  { ...grant(current.binding), actor: { kind: "source", id: "source-001" } },
], verifiers), "human attribution");
const grantedRecords = [...current.records, grant(current.binding)];
const granted = await replayEngagement(grantedRecords, verifiers);
check(granted.authorizations[0]?.constraints[0] === "workspace-only", "grant scope must be exact");
await rejects("duplicate grant ID", () => replayEngagement([
  ...grantedRecords, grant(current.binding, "grant-2"),
], verifiers), "already granted");
const next = submission("case-2");
const nextBinding = bind(await replayEngagement([next], verifiers));
const stale = await replayEngagement([...grantedRecords, next], verifiers);
check(stale.gate.status === "blocked" && stale.authorizations.length === 0, "new case must stale approvals and grants");
await rejects("stale answer", () => replayEngagement([
  ...current.records, next, answer(current.binding, "stale-answer"),
], verifiers), "current case submission");
await rejects("stale grant", () => replayEngagement([
  ...current.records, next, grant(current.binding, "stale-grant"),
], verifiers), "current case submission");
const revoked = await replayEngagement([...grantedRecords, next, revoke()], verifiers);
check(revoked.authorizations.length === 0, "revocation must find one prior stale grant");
await rejects("unknown revocation", () => replayEngagement([
  ...current.records, revoke("revoke-unknown", "missing"),
], verifiers), "one unrevoked grant");
const callerGrant = grant(current.binding, "mutable-grant", "mutable-scope");
const immutable = await replayEngagement([...current.records, callerGrant], verifiers);
callerGrant.constraints.push("caller-mutation");
check(Object.isFrozen(immutable.authorizations[0].constraints) &&
  immutable.authorizations[0].constraints.length === 1, "returned constraints must be detached and frozen");
const mutableSubmission = submission("case-async");
const pending = replayEngagement([mutableSubmission], {
  ...verifiers,
  verifyCaseSubmission: async (record) => {
    mutableSubmission.caseFile.version = "mutated";
    await Promise.resolve();
    return record.caseFile.version === "1.0";
  },
});
check((await pending).phase === "audit", "async verifier mutation must not alter the snapshot");
const queuedCase = structuredClone(baseCase); queuedCase.version = "invalid-at-call"; const queuedValidation = validateCaseFileData(queuedCase); queuedCase.version = "1.0"; check((await queuedValidation).some((error) => error.includes('version must be "1.0"')), "validation must snapshot inputs before queueing");
Object.prototype.inheritedSemantic = "rejected";
Object.prototype.toJSON = () => ({ polluted: true });
const clean = snapshotJson({ id: "clean" });
const distinct = serializeJson({ value: 1 }) !== serializeJson({ value: 2 });
const pollutionSafe = await replayEngagement([submission("case-pollution")], verifiers);
delete Object.prototype.inheritedSemantic; delete Object.prototype.toJSON;
check(!("inheritedSemantic" in clean), "snapshot copies must not inherit semantic properties");
check(distinct, "canonical serialization must ignore inherited toJSON"); check(pollutionSafe.phase === "audit", "manifest hashing must ignore inherited toJSON");
const protoCopy = snapshotJson(JSON.parse('{"__proto__":{"authority":true}}')); check(Object.getPrototypeOf(protoCopy) === null && Object.hasOwn(protoCopy, "__proto__"), "own __proto__ must remain inert data");
Object.prototype.value = "polluted";
try {
  const accessor = {}; const descriptor = Object.create(null); descriptor.enumerable = true; descriptor.get = () => "forged";
  Object.defineProperty(accessor, "secret", descriptor);
  await rejects("polluted accessor", () => snapshotJson(accessor), "enumerable data property");
} finally { delete Object.prototype.value; }
const inherited = Object.create({ type: "case-submitted" }); inherited.id = "inherited";
await rejects("inherited property", () => replayEngagement([inherited], verifiers), "plain object");
await rejects("proxy", () => snapshotJson(new Proxy({}, {})), "proxy");
for (const [name, mutate, message] of [
  ["cycle", (item) => { item.loop = item; }, "cycle"],
  ["undefined", (item) => { item.extra = undefined; }, "JSON data only"],
  ["function", (item) => { item.extra = () => {}; }, "JSON data only"],
  ["symbol", (item) => { item.extra = Symbol("x"); }, "JSON data only"],
  ["bigint", (item) => { item.extra = 1n; }, "JSON data only"],
  ["nonfinite", (item) => { item.extra = Infinity; }, "finite number"],
]) {
  await rejects(name, () => {
    const item = submission(`case-${name}`);
    mutate(item);
    return replayEngagement([item], verifiers);
  }, message);
}
const originalCwd = process.cwd(); process.chdir(tmpdir());
const otherCwd = await replayEngagement(current.records, verifiers); process.chdir(originalCwd);
check(otherCwd.digest === passed.digest, "in-memory replay must not depend on cwd");
for (const [name, mutate, message] of [
  ["unknowns", (data) => { data.unknowns = {}; }, "unknowns must be an array"],
  ["conflicts", (data) => { data.domainModel.conflicts = {}; }, "domainModel.conflicts must be an array"],
  ["conflict item", (data) => { data.domainModel.conflicts = [{ status: "deferred" }]; }, "description is required"],
  ["failures", (data) => { data.evalPlan.unresolvedSevereFailures = {}; }, "unresolvedSevereFailures must be an array"],
]) {
  await rejects(`malformed ${name}`, () => {
    const data = structuredClone(baseCase);
    mutate(data);
    return replayEngagement([submission(`case-${name}`, data)], verifiers);
  }, message);
}
const rewritten = [...grantedRecords]; rewritten[rewritten.length - 1] = { ...rewritten.at(-1), resource: "different-resource" };
const recomputed = await replayEngagement(rewritten, verifiers);
check(recomputed.digest !== granted.digest, "rewritten records must change the cache digest");
check(!(await checkpointMatchesRecords(rewritten, granted, verifiers)) &&
  (await checkpointMatchesRecords(rewritten, recomputed, verifiers)),
"checkpoint comparison must test current-record consistency only");
const mutableCheckpoint = structuredClone(passed);
const comparison = checkpointMatchesRecords(current.records, mutableCheckpoint, {
  ...verifiers,
  verifyCaseSubmission: async (record) =>
    (await Promise.resolve(), verifiers.verifyCaseSubmission(record)),
});
mutableCheckpoint.version = 2;
check(await comparison, "checkpoint comparison must snapshot before awaiting replay");
if (failures.length) {
  console.error("Engagement protocol tests failed:"); failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}
console.log("Engagement protocol tests passed.");
