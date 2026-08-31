#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { checkpointMatchesRecords, replayEngagement } from "./engagement-protocol.mjs";

const baseCase = JSON.parse(await readFile(new URL("../evals/files/readout-case.json", import.meta.url)));
const manifest = JSON.parse(await readFile(new URL("../evals/files/readout-case-source-manifest.json", import.meta.url)));
baseCase.gate.status = "passed";
baseCase.gate.reason = "Human review accepted the audit gate.";
baseCase.fieldJudgment = {
  entries: [{
    id: "judgment-observation-001",
    kind: "firsthand-observation",
    authorRole: "FDE",
    origin: "human-confirmed",
    statement: "Operators use distinct recommendation and authorization steps.",
    context: "Claims workflow audit",
    whyItMatters: "The distinction controls who may release payment.",
    evidenceIds: ["interview-001"],
    customerSafe: true,
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
function submission(id = "case-1", caseFile = structuredClone(baseCase)) {
  return {
    id,
    type: "case-submitted",
    actor: { kind: "agent", id: "driver-1" },
    caseFile,
    sourceManifest: structuredClone(manifest),
    submissionReceipt: "trusted",
    evidenceBindings: [
      ["interview-001", "source-001"],
      ["interview-002", "source-001"],
      ["log-001", "source-002"],
    ].map(([evidenceId, sourceId]) => ({
      evidenceId, sourceId, manifestSha256: manifest.manifestSha256,
    })),
  };
}
const answer = (id = "answer-1", attributedActor = actor) => ({
  id,
  type: "human-answer",
  actor: attributedActor,
  attestation: "trusted",
  nodeId: "approval-language",
  answer: "Adjusters recommend; managers authorize above $25,000.",
});
const approval = (id, phase, caseEventId, caseDigest) => ({
  id,
  type: "phase-approved",
  actor,
  attestation: "trusted",
  phase,
  caseEventId,
  caseDigest,
});
async function approvedRecords(caseRecord = submission()) {
  const initial = await replayEngagement([caseRecord], verifiers);
  return [caseRecord, answer(),
    approval("approve-qualify", "qualify", caseRecord.id, initial.gate.caseDigest),
    approval("approve-audit", "audit", caseRecord.id, initial.gate.caseDigest)];
}

await rejects(
  "prerequisite ordering",
  async () => {
    const data = structuredClone(baseCase);
    const first = data.decisionTree.nodes[0];
    const dependent = structuredClone(first);
    first.status = "open";
    first.answer = "";
    dependent.id = "dependent-decision";
    dependent.questionNumber = 2;
    dependent.prerequisites = [first.id];
    data.decisionTree.nodes.push(dependent);
    data.decisionTree.nextQuestionNumber = 3;
    data.decisionTree.frontier = [first.id];
    data.decisionTree.rounds[0] = {
      id: "round-1", status: "active", nodeIds: [first.id, dependent.id],
    };
    await replayEngagement([submission("case-prerequisite", data)], verifiers);
  },
  "cannot settle before prerequisite",
);
await rejects(
  "manifest binding",
  async () => {
    const record = submission();
    record.evidenceBindings[0].sourceId = "source-missing";
    await replayEngagement([record], verifiers);
  },
  "absent from the manifest",
);
await rejects(
  "self-declared human",
  () => replayEngagement([submission(), answer()], {
    verifyCaseSubmission: verifiers.verifyCaseSubmission,
  }),
  "external authority verifier",
);
await rejects(
  "false authority verifier",
  () => replayEngagement([submission(), answer()], {
    ...verifiers,
    verifyAuthority: () => false,
  }),
  "authority verification failed",
);
await rejects(
  "unattested case",
  () => replayEngagement([submission(), answer()], {
    ...verifiers,
    verifyCaseSubmission: () => false,
  }),
  "verified case submission",
);
await rejects(
  "agent claim",
  () => replayEngagement([
    submission(),
    answer("agent-answer", { kind: "agent", id: "model-1" }),
  ], verifiers),
  "human attribution",
);

const records = await approvedRecords();
const approved = await replayEngagement(records, verifiers);
check(approved.gate.status === "passed", "verified human approval must close the gate");
await rejects(
  "phase skip",
  async () => {
    const record = submission("case-skip");
    const initial = await replayEngagement([record], verifiers);
    await replayEngagement([
      record,
      answer("answer-skip"),
      approval("approve-skip", "audit", record.id, initial.gate.caseDigest),
    ], verifiers);
  },
  "expected qualify",
);

const grant = {
  id: "grant-1", type: "action-authorized", actor, attestation: "trusted",
  authorizationId: "export-summary",
  action: "write",
  resource: "engagement-summary",
  constraints: ["workspace-only"],
};
const granted = await replayEngagement([...records, grant], verifiers);
check(
  granted.authorizations[0]?.resource === "engagement-summary",
  "authorization must preserve its exact scope",
);
const revoke = {
  id: "revoke-1", type: "authorization-revoked", actor,
  attestation: "trusted", authorizationId: "export-summary",
};
const revoked = await replayEngagement([...records, grant, revoke], verifiers);
check(revoked.authorizations.length === 0, "verified revocation must remove authority");

const duplicated = await replayEngagement([...records, records[1]], verifiers);
check(duplicated.digest === approved.digest, "exact duplicate retries must be ignored");
await rejects(
  "conflicting duplicate",
  () => replayEngagement([
    ...records,
    { ...records[1], answer: "A conflicting answer" },
  ], verifiers),
  "conflicts with an earlier record",
);
await rejects(
  "source-triggered action",
  () => replayEngagement([
    ...records,
    { ...grant, id: "source-grant", actor: { kind: "source", id: "source-001" } },
  ], verifiers),
  "human attribution",
);

const replacement = submission("case-2");
const stale = await replayEngagement([...records, replacement], verifiers);
check(stale.gate.status === "blocked", "a later case submission must stale prior approvals");
check(
  await checkpointMatchesRecords(records, approved, verifiers),
  "exact replay must reproduce the checkpoint",
);
const rewritten = [...records, { ...grant, resource: "different-resource" }];
const rewrittenCheckpoint = await replayEngagement(rewritten, verifiers);
check(
  rewrittenCheckpoint.digest !== granted.digest,
  "a rewritten log must produce a different replay digest",
);
check(
  !(await checkpointMatchesRecords(rewritten, granted, verifiers)) &&
    (await checkpointMatchesRecords(rewritten, rewrittenCheckpoint, verifiers)),
  "checkpoint verification must assert current-record consistency only",
);
check(
  approved.unresolved.some((item) => item.path.includes("unknowns[")),
  "unresolved items must derive from the canonical case",
);
const invalid = submission("case-invalid");
invalid.caseFile.version = "invalid";
const concurrent = await Promise.allSettled([replayEngagement([submission("case-concurrent")], verifiers), replayEngagement([invalid], verifiers)]);
check(concurrent[0].status === "fulfilled" && concurrent[1].status === "rejected", "concurrent validation must not lose errors");

if (failures.length > 0) {
  console.error("Engagement protocol tests failed:");
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}
console.log("Engagement protocol tests passed.");
