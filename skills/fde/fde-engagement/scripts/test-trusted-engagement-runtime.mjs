#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, link, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeKeyHex, EMPTY_HEAD, mintSubmission, replayRecords } from "./trusted-engagement-auth.mjs";
import {
  appendRecord as appendRecordApi, appendTrustedAuthority as appendAuthorityApi,
  appendTrustedSubmission as appendSubmissionApi, initializeLog,
  verifyAndReplay as verifyApi } from "./trusted-engagement-runtime.mjs";
const root = await mkdtemp(join(tmpdir(), "fde-runtime-"));
const key = randomBytes(32);
const wrongKey = randomBytes(32);
const keyId = "local-test-key";
const provider = async (requested) => requested === keyId ? key : undefined;
const wrongProvider = async (requested) => requested === keyId ? wrongKey : undefined;
function call(operation, options) {
  const { keyProvider = provider, ...input } = options;
  return operation(input, keyProvider);
}
const appendRecord = (options) => call(appendRecordApi, options);
const appendTrustedAuthority = (options) => call(appendAuthorityApi, options);
const appendTrustedSubmission = (options) => call(appendSubmissionApi, options);
const verifyAndReplay = (options) => call(verifyApi, options);
const baseCase = JSON.parse(await readFile(new URL("../evals/files/readout-case.json", import.meta.url)));
const manifest = JSON.parse(await readFile(new URL("../evals/files/readout-case-source-manifest.json", import.meta.url)));
baseCase.gate = { ...baseCase.gate, status: "passed", reason: "Human review accepted the audit gate." };
baseCase.unknowns = ["Written authorization policy"];
baseCase.evalPlan = { unresolvedSevereFailures: [] };
baseCase.fieldJudgment = {
  entries: [{
    id: "judgment-observation-001", kind: "firsthand-observation", authorRole: "FDE", origin: "human-confirmed",
    statement: "Operators use distinct recommendation and authorization steps.",
    context: "Claims workflow audit", whyItMatters: "The distinction controls who may release payment.",
    evidenceIds: ["interview-001"], customerSafe: true,
  }],
  retrospective: { status: "pending", reason: "", evidenceIds: [] },
};
const evidenceBindings = [
  ["interview-001", "source-001"], ["interview-002", "source-001"], ["log-001", "source-002"],
].map(([evidenceId, sourceId]) => ({ evidenceId, sourceId, manifestSha256: manifest.manifestSha256 }));
const submission = (id = "case-1") => ({
  id, type: "case-submitted", actor: { kind: "forged", id: "payload-actor" },
  caseFile: structuredClone(baseCase), sourceManifest: structuredClone(manifest),
  evidenceBindings: structuredClone(evidenceBindings),
});
const paths = (name) => ({ logPath: join(root, `${name}.jsonl`),
  checkpointPath: join(root, `${name}.checkpoint.json`) });
const trusted = (files, record, expectedHead, extra = {}) => ({
  ...files, record, expectedHead, keyId, keyProvider: provider, ...extra });
async function rejects(action, text) {
  await assert.rejects(action, (error) => {
    assert.match(error.message, new RegExp(text));
    return true;
  });
}
async function initialized(name) { const files = paths(name); await initializeLog(files); return files; }
async function seeded(name = "seeded") {
  const files = await initialized(name);
  const submitted = await appendTrustedSubmission(trusted(files, submission(), EMPTY_HEAD,
    { submitter: { kind: "agent", id: "driver-1" } }));
  const binding = { caseEventId: submitted.state.gate.caseEventId,
    caseDigest: submitted.state.gate.caseDigest };
  const answer = {
    id: "answer-1", type: "human-answer", actor: { kind: "agent", id: "forged-model" },
    ...binding, nodeId: "approval-language",
    answer: "Adjusters recommend; managers authorize above $25,000.",
  };
  const answered = await appendTrustedAuthority(trusted(files, answer, submitted.head,
    { authority: { kind: "human", id: "reviewer-1" } }));
  return { ...files, submitted, answered, binding };
}
try {
  const alias = join(root, "aliased.jsonl");
  for (const checkpointPath of [alias, `${alias}.lock`]) {
    await rejects(() => initializeLog({ logPath: alias, checkpointPath }), "paths must differ");
  }
  await assert.rejects(() => access(alias));
  const variant = { logPath: join(root, "case-variant.jsonl"),
    checkpointPath: join(root, "CASE-VARIANT.JSONL") };
  try {
    await initializeLog(variant); assert.ok((await readFile(variant.checkpointPath)).length > 0);
  } catch (error) {
    assert.match(error.message, /checkpoint path exists/); assert.equal((await readFile(variant.logPath)).length, 0);
  }
  const missing = await initialized("missing-key");
  await rejects(() => appendTrustedSubmission({
    ...trusted(missing, submission("missing"), EMPTY_HEAD), keyProvider: async () => undefined,
    submitter: { kind: "agent", id: "driver-1" },
  }), "exactly 32 bytes");
  assert.equal((await readFile(missing.logPath)).length, 0);
  assert.equal(decodeKeyHex(key.toString("hex")).byteLength, 32);
  for (const length of [62, 66, 128])
    assert.throws(() => decodeKeyHex("a".repeat(length)), /exactly 64/);
  for (const length of [31, 33, 64]) {
    await rejects(() => mintSubmission(submission(`key-${length}`), {
      kind: "agent", id: "driver-1" }, keyId, async () => Buffer.alloc(length)), "exactly 32 bytes");
  }
  const logDirectory = join(root, "separate-log"), checkpointDirectory = join(root, "separate-checkpoint");
  await Promise.all([mkdir(logDirectory), mkdir(checkpointDirectory)]);
  const ordered = { logPath: join(logDirectory, "engagement.jsonl"),
    checkpointPath: join(checkpointDirectory, "engagement.json") };
  let parentSyncObserved = false;
  await initializeLog(ordered, async (logPath) => {
    await access(logPath); await assert.rejects(() => access(ordered.checkpointPath));
    parentSyncObserved = true; });
  assert.ok(parentSyncObserved, "log parent sync must precede checkpoint creation");
  const snapshotted = await initialized("snapshotted-inputs");
  let releaseSubmission;
  const submissionWait = new Promise((resolve) => { releaseSubmission = resolve; });
  const mutableOptions = { ...trusted(snapshotted, submission("snapshot-case"),
    structuredClone(EMPTY_HEAD)), submitter: { kind: "agent", id: "original-submitter" } };
  delete mutableOptions.keyProvider;
  const pendingSubmission = appendSubmissionApi(mutableOptions,
    async (requested) => (await submissionWait, provider(requested)));
  mutableOptions.record.caseFile.version = "mutated"; mutableOptions.submitter.id = "mutated-submitter";
  mutableOptions.expectedHead.sequence = 99;
  releaseSubmission();
  const snapshotResult = await pendingSubmission;
  const storedEntry = JSON.parse(await readFile(snapshotted.logPath, "utf8"));
  const storedRecord = JSON.parse(storedEntry.record);
  assert.equal(storedRecord.caseFile.version, "1.0"); assert.equal(storedRecord.actor.id, "original-submitter");
  assert.equal(snapshotResult.head.sequence, 1);
  let releaseAuthority;
  const authorityWait = new Promise((resolve) => { releaseAuthority = resolve; });
  const mutableAuthority = { ...trusted(snapshotted, {
    id: "snapshot-answer", type: "human-answer",
    caseEventId: snapshotResult.state.gate.caseEventId,
    caseDigest: snapshotResult.state.gate.caseDigest, nodeId: "approval-language",
    answer: "Adjusters recommend; managers authorize above $25,000.",
  }, snapshotResult.head), authority: { kind: "human", id: "original-reviewer" } };
  delete mutableAuthority.keyProvider;
  const pendingAuthority = appendAuthorityApi(mutableAuthority,
    async (requested) => (await authorityWait, provider(requested)));
  mutableAuthority.authority.id = "mutated-reviewer";
  releaseAuthority();
  const authorityResult = await pendingAuthority;
  assert.equal(authorityResult.state.humanAnswers[0].actor.id, "original-reviewer");
  const main = await seeded();
  const hardLink = join(root, "log-hard-link.jsonl");
  let hardLinksAvailable = true;
  try {
    await link(main.logPath, hardLink);
  } catch (error) {
    if (["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(error.code)) {
      hardLinksAvailable = false;
    } else throw error;
  }
  if (hardLinksAvailable) {
    const aliasRecord = { id: "alias-race", type: "phase-approved",
      phase: "qualify", ...main.binding };
    const attempts = await Promise.allSettled([
      appendTrustedAuthority({ ...trusted(main, aliasRecord, main.answered.head),
        authority: { kind: "human", id: "reviewer-1" } }),
      appendTrustedAuthority({ ...trusted({ ...main, logPath: hardLink },
        aliasRecord, main.answered.head), authority: { kind: "human", id: "reviewer-1" } }),
    ]);
    assert.ok(attempts.every((result) =>
      result.status === "rejected" &&
        /exactly one filesystem link/.test(result.reason.message)));
    await unlink(hardLink);
  }
  await rejects(() => verifyAndReplay({
    ...main, trustedHead: main.answered.head, keyProvider: wrongProvider,
  }), "authentication failed");
  const signedCase = await mintSubmission(submission("signed-case"),
    { kind: "agent", id: "driver-1" }, keyId, provider);
  const changed = structuredClone(signedCase);
  changed.caseFile.version = "mutated";
  const mutationLog = await initialized("record-mutation");
  await rejects(() => appendRecord(trusted(mutationLog, changed, EMPTY_HEAD)),
    "case validation failed|verification failed");
  assert.equal((await readFile(mutationLog.logPath)).length, 0);
  for (const [mutate, text] of [
    [(item) => { item.submissionReceipt.extra = true; }, "unexpected fields"],
    [(item) => { item.submissionReceipt.version = 2; }, "version is unsupported"],
    [(item) => { item.submissionReceipt.algorithm = "none"; }, "algorithm is unsupported"],
    [(item) => { item.submissionReceipt.domain = "fde-authority-v1"; }, "domain is unsupported"],
    [(item) => { item.submissionReceipt.signature = "z".repeat(64); }, "64 lowercase hex"],
    [(item) => { item.submissionReceipt.signature = "aa"; }, "64 lowercase hex"],
  ]) {
    const item = structuredClone(signedCase);
    mutate(item);
    await rejects(() => replayRecords([item], provider), text);
  }
  await rejects(() => appendTrustedSubmission(trusted(
    mutationLog, { ...submission("preexisting"), submissionReceipt: {} },
    EMPTY_HEAD, { submitter: { kind: "agent", id: "driver-1" } },
  )), "preexisting trust envelope");
  const confused = {
    id: "confused-answer", type: "human-answer",
    actor: { kind: "human", id: "reviewer-1" }, ...main.binding,
    nodeId: "approval-language",
    answer: "Adjusters recommend; managers authorize above $25,000.",
    attestation: signedCase.submissionReceipt,
  };
  await rejects(() => appendRecord(trusted(main, confused, main.answered.head)),
    "domain is unsupported");
  await rejects(() => appendRecord(trusted(main, {
    ...confused, id: "forged-answer", attestation: { trusted: true },
  }, main.answered.head)), "unexpected fields");
  await rejects(() => appendRecord(trusted(main, {
    id: "case-1", type: "human-answer",
    actor: { kind: "human", id: "reviewer-1" },
  }, main.answered.head)), "conflicts with an earlier record");
  await rejects(() => appendTrustedAuthority(trusted(main, {
    id: "unknown", type: "unknown-record",
  }, main.answered.head, {
    authority: { kind: "human", id: "reviewer-1" },
  })), "type is not supported");
  await rejects(() => appendRecord(trusted(main, {
    id: "trusted-field", type: "unknown-record", trusted: true,
  }, main.answered.head)), "record.trusted");
  const original = await readFile(main.logPath, "utf8");
  const lines = original.trimEnd().split("\n");
  for (const [name, text, error] of [
    ["changed-bytes", original.replace('"version":1', '"version":1 '), "not canonical"],
    ["partial", original.slice(0, -1), "trailing partial"],
    ["duplicate-sequence", `${lines[0]}\n${lines[0]}\n`, "sequence is invalid"],
    ["reordered", `${lines[1]}\n${lines[0]}\n`, "sequence is invalid"],
  ]) {
    const logPath = join(root, `${name}.jsonl`);
    await writeFile(logPath, text);
    await rejects(() => verifyAndReplay({
      logPath, checkpointPath: join(root, `${name}.checkpoint`),
      trustedHead: EMPTY_HEAD, keyProvider: provider,
    }), error);
  }
  const invalidUtf8 = Buffer.from(original);
  invalidUtf8[0] = 0xff;
  const invalidUtf8Path = join(root, "invalid-utf8.jsonl");
  await writeFile(invalidUtf8Path, invalidUtf8);
  await rejects(() => verifyAndReplay({ logPath: invalidUtf8Path,
    checkpointPath: join(root, "invalid-utf8.checkpoint"),
    trustedHead: EMPTY_HEAD, keyProvider: provider }), "not valid UTF-8");
  await rejects(() => verifyAndReplay({
    ...main, trustedHead: { ...main.answered.head, sequence: 3 }, keyProvider: provider,
  }), "truncated log");
  await rejects(() => verifyAndReplay({
    ...main, trustedHead: { ...main.submitted.head, digest: "0".repeat(64) }, keyProvider: provider,
  }), "verified log prefix");
  await rejects(() => appendTrustedAuthority(trusted(main, {
    id: "stale", type: "phase-approved", phase: "qualify", ...main.binding,
  }, main.submitted.head, {
    authority: { kind: "human", id: "reviewer-1" },
  })), "does not equal");
  const race = await initialized("race");
  const raceResults = await Promise.allSettled(["race-1", "race-2"].map((id) =>
    appendTrustedSubmission(trusted(race, submission(id), EMPTY_HEAD,
      { submitter: { kind: "agent", id: "driver-1" } }))));
  assert.deepEqual(raceResults.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  const crash = await initialized("crash");
  const badCheckpoint = join(root, "checkpoint-directory");
  await mkdir(badCheckpoint);
  await rejects(() => appendTrustedSubmission(trusted(
    { ...crash, checkpointPath: badCheckpoint }, submission("crash-case"), EMPTY_HEAD,
    { submitter: { kind: "agent", id: "driver-1" } },
  )), "EISDIR|EPERM|directory|exists");
  const recovered = await verifyAndReplay(
    { ...crash, trustedHead: EMPTY_HEAD, keyProvider: provider });
  assert.equal(recovered.head.sequence, 1);
  await rejects(() => appendTrustedSubmission(trusted(
    crash, submission("stale-after-crash"), EMPTY_HEAD,
    { submitter: { kind: "agent", id: "driver-1" } },
  )), "does not equal");
  const initRecovery = paths("init-recovery");
  const badInitCheckpoint = join(root, "init-checkpoint-directory");
  await mkdir(badInitCheckpoint);
  await rejects(() => initializeLog({ logPath: initRecovery.logPath,
    checkpointPath: badInitCheckpoint }), "EISDIR|EPERM|directory|exists");
  await verifyAndReplay({ ...initRecovery, trustedHead: EMPTY_HEAD, keyProvider: provider });
  await unlink(main.checkpointPath);
  const replayed = await verifyAndReplay(
    { ...main, trustedHead: main.submitted.head, keyProvider: provider });
  const replayedAgain = await verifyAndReplay(
    { ...main, trustedHead: replayed.head, keyProvider: provider });
  assert.equal(replayed.state.digest, replayedAgain.state.digest);
  await access(main.checkpointPath);
  let releaseHead;
  const headWait = new Promise((resolve) => { releaseHead = resolve; });
  const mutableHead = structuredClone(replayed.head);
  const pendingReplay = verifyApi({ logPath: main.logPath,
    checkpointPath: main.checkpointPath, trustedHead: mutableHead },
  async (requested) => (await headWait, provider(requested)));
  mutableHead.digest = "0".repeat(64);
  releaseHead();
  assert.equal((await pendingReplay).head.digest, replayed.head.digest);
  let keyReads = 0;
  await verifyAndReplay({
    ...main, trustedHead: main.submitted.head,
    keyProvider: async (requested) => {
      keyReads += 1;
      return provider(requested);
    },
  });
  assert.ok(keyReads >= 4, "replay must wire log and protocol verifiers");
  const sentinel = join(root, "must-not-exist.txt");
  await appendTrustedAuthority(trusted(main, {
    id: "grant-no-execution", type: "action-authorized", ...main.binding,
    authorizationId: "write-sentinel", action: "write", resource: sentinel,
    constraints: ["test-only"],
  }, main.answered.head, {
    authority: { kind: "human", id: "reviewer-1" },
  }));
  await assert.rejects(() => access(sentinel));
  const secret = key.toString("hex");
  assert.ok(!(await readFile(main.logPath, "utf8")).includes(secret));
  assert.ok(!(await readFile(main.checkpointPath, "utf8")).includes(secret));
  console.log("Trusted engagement runtime tests passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
