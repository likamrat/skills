#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { evaluateFixture, GRADER_VERSION } from "./evaluate-fde-run.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturesRoot = join(root, "evals", "fde-e2e", "fixtures");
const passFixtureId = "hill-0-minimal-pass-v1";
const failureFixtureId = "hill-0-observed-failure-v1";
const smokeFixtureId = "hill-2-pptx-smoke-attempt-2-v1";
const passFixture = join(fixturesRoot, passFixtureId);
const smokeFixture = join(fixturesRoot, smokeFixtureId);
const cli = join(root, "scripts", "evaluate-fde-run.mjs");
const temporaryRoot = await mkdtemp(join(tmpdir(), "fde-e2e-evaluator-"));
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function copyPassFixture(name) {
  const target = join(temporaryRoot, name);
  await cp(passFixture, target, { recursive: true });
  return target;
}

async function copySmokeFixture(name) {
  const target = join(temporaryRoot, name);
  await cp(smokeFixture, target, { recursive: true });
  return target;
}

async function updateDescriptorHash(fixture, collection, kind) {
  const runPath = join(fixture, "run.json");
  const run = await readJson(runPath);
  const descriptor = run[collection].find((entry) => entry.kind === kind);
  const bytes = await readFile(join(fixture, descriptor.path));
  descriptor.sha256 = sha256(bytes);
  await writeJson(runPath, run);
}

async function syncTraceToMetrics(fixture) {
  const runPath = join(fixture, "run.json");
  const run = await readJson(runPath);
  const traceDescriptor = run.records.find((entry) => entry.kind === "trace");
  const tracePath = join(fixture, traceDescriptor.path);
  const trace = await readJson(tracePath);
  trace.modelCallsCaptured = run.metrics.modelCalls;
  trace.toolCallsCaptured = run.metrics.toolCalls;
  trace.failedToolCallsCaptured = run.metrics.failedToolCalls;
  await writeJson(tracePath, trace);
  traceDescriptor.sha256 = sha256(await readFile(tracePath));
  await writeJson(runPath, run);
}

async function makeCleanSmokeFixture(name) {
  const fixture = await copySmokeFixture(name);
  const runPath = join(fixture, "run.json");
  const run = await readJson(runPath);
  run.metrics.modelCalls = 32;
  run.metrics.inputTokens = 3000000;

  const candidateDescriptor = run.artifacts.find(
    (entry) => entry.format === "powerpoint",
  );
  const candidatePath = join(fixture, candidateDescriptor.path);
  const candidate = await readJson(candidatePath);
  const [, candidateDecision, candidateDense] = candidate.activeSlides;
  candidateDecision.notesRelationshipId = "rId3";
  candidateDecision.notesPart = "ppt/notesSlides/notesSlide3.xml";
  candidateDecision.evidenceIdsInNotes = ["EV-DEC-01", "HC-DEC-01"];
  candidateDense.notesRelationshipId = "rId4";
  candidateDense.notesPart = "ppt/notesSlides/notesSlide4.xml";
  Object.assign(candidate.packageInventory, {
    activeNotesPartCount: 3,
    packageSlidePartCount: 3,
    packageNotesPartCount: 3,
    orphanedCustomerSlidePartCount: 0,
    orphanedCustomerNotesPartCount: 0,
  });
  await writeJson(candidatePath, candidate);
  const candidateSha256 = sha256(await readFile(candidatePath));
  candidateDescriptor.sha256 = candidateSha256;

  const qaDescriptor = run.evidence.find(
    (entry) => entry.kind === "powerpointQa",
  );
  const qaPath = join(fixture, qaDescriptor.path);
  const qa = await readJson(qaPath);
  const [, decision, dense] = qa.smokeEvidence.activeSlides;
  decision.notesRelationshipId = "rId3";
  decision.notesPart = "ppt/notesSlides/notesSlide3.xml";
  decision.evidenceIdsInNotes = [...decision.expectedEvidenceIds];
  dense.notesRelationshipId = "rId4";
  dense.notesPart = "ppt/notesSlides/notesSlide4.xml";
  Object.assign(qa.smokeEvidence.packageInventory, {
    activeNotesPartCount: 3,
    packageSlidePartCount: 3,
    packageNotesPartCount: 3,
    orphanedCustomerSlidePartCount: 0,
    orphanedCustomerNotesPartCount: 0,
  });
  Object.assign(qa.smokeEvidence.usage, {
    modelCalls: 32,
    inputTokens: 3000000,
  });
  Object.assign(qa.deterministicChecks, {
    notesIsolated: true,
    noOrphanedCustomerParts: true,
    planEvidenceBound: true,
  });
  qa.artifactSha256 = candidateSha256;
  qa.smokeEvidence.candidateSha256 = candidateSha256;
  await writeJson(qaPath, qa);
  qaDescriptor.sha256 = sha256(await readFile(qaPath));

  const humanReviewDescriptor = run.evidence.find(
    (entry) => entry.kind === "humanReview",
  );
  const humanReviewPath = join(fixture, humanReviewDescriptor.path);
  const humanReview = await readJson(humanReviewPath);
  humanReview.artifactHashes.powerpoint = candidateSha256;
  await writeJson(humanReviewPath, humanReview);
  humanReviewDescriptor.sha256 = sha256(await readFile(humanReviewPath));

  await writeJson(runPath, run);
  await syncTraceToMetrics(fixture);
  return fixture;
}

async function setSmokeCanvasCalls(fixture, canvasCalls) {
  const runPath = join(fixture, "run.json");
  const run = await readJson(runPath);
  run.metrics.canvasCalls = canvasCalls;

  const qaDescriptor = run.evidence.find(
    (entry) => entry.kind === "powerpointQa",
  );
  const qaPath = join(fixture, qaDescriptor.path);
  const qa = await readJson(qaPath);
  qa.smokeEvidence.canvas.invokeCalls = canvasCalls;
  run.metrics.toolCalls =
    canvasCalls +
    qa.smokeEvidence.canvas.getModelCalls +
    qa.smokeEvidence.canvas.otherToolCalls;
  await writeJson(qaPath, qa);
  qaDescriptor.sha256 = sha256(await readFile(qaPath));

  const traceDescriptor = run.records.find((entry) => entry.kind === "trace");
  const tracePath = join(fixture, traceDescriptor.path);
  const trace = await readJson(tracePath);
  trace.canvasCallsCaptured = canvasCalls;
  trace.toolCallsCaptured = run.metrics.toolCalls;
  await writeJson(tracePath, trace);
  traceDescriptor.sha256 = sha256(await readFile(tracePath));
  await writeJson(runPath, run);
}

async function syncSmokeCandidateBindings(fixture) {
  const runPath = join(fixture, "run.json");
  const run = await readJson(runPath);
  const candidateDescriptor = run.artifacts.find(
    (entry) => entry.format === "powerpoint",
  );
  const candidateSha256 = sha256(
    await readFile(join(fixture, candidateDescriptor.path)),
  );
  candidateDescriptor.sha256 = candidateSha256;

  const qaDescriptor = run.evidence.find(
    (entry) => entry.kind === "powerpointQa",
  );
  const qaPath = join(fixture, qaDescriptor.path);
  const qa = await readJson(qaPath);
  qa.artifactSha256 = candidateSha256;
  qa.smokeEvidence.candidateSha256 = candidateSha256;
  await writeJson(qaPath, qa);
  qaDescriptor.sha256 = sha256(await readFile(qaPath));

  const humanReviewDescriptor = run.evidence.find(
    (entry) => entry.kind === "humanReview",
  );
  const humanReviewPath = join(fixture, humanReviewDescriptor.path);
  const humanReview = await readJson(humanReviewPath);
  humanReview.artifactHashes.powerpoint = candidateSha256;
  await writeJson(humanReviewPath, humanReview);
  humanReviewDescriptor.sha256 = sha256(await readFile(humanReviewPath));
  await writeJson(runPath, run);
}

function reasonCodes(result) {
  return new Set(result.failureReasons.map((reason) => reason.code));
}

function containsScoreField(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsScoreField);
  return Object.entries(value).some(
    ([key, child]) =>
      ["score", "overallScore", "weightedScore"].includes(key) ||
      containsScoreField(child),
  );
}

async function expectInputError(action, label) {
  try {
    await action();
    failures.push(`${label} should fail as invalid evaluator input`);
  } catch {
    // Expected.
  }
}

try {
  const replayTextFiles = (await walk(join(root, "evals", "fde-e2e"))).filter(
    (path) => [".json", ".html", ".md", ".svg"].includes(extname(path)),
  );
  for (const path of replayTextFiles) {
    check(
      !(await readFile(path, "utf8")).includes("\r"),
      `${path} must use LF line endings`,
    );
  }

  const failed = await evaluateFixture(failureFixtureId);
  const failedCodes = reasonCodes(failed);
  check(failed.status === "failed", "observed fixture must fail");
  check(
    failed.graderVersion === GRADER_VERSION,
    "result must report the current grader version",
  );
  for (const code of [
    "artifact_quality.powerpoint_visual_qa_failed",
    "trace_quality.stale_html_qa_evidence",
    "safety.external_fault_state_visible",
    "trace_quality.wake_resend_loop",
    "trace_quality.repeated_structural_retries",
    "trace_quality.premature_validator_loop",
    "efficiency.wallTimeMs_budget_exceeded",
    "efficiency.modelCalls_budget_exceeded",
    "efficiency.inputTokens_budget_exceeded",
    "efficiency.toolCalls_budget_exceeded",
    "efficiency.failedToolCalls_budget_exceeded",
    "efficiency.failedToolRate_budget_exceeded",
  ]) {
    check(failedCodes.has(code), `observed fixture must report ${code}`);
  }
  check(
    failed.agentClaimIgnored?.status === "passed",
    "observed fixture must retain the ignored optimistic agent claim",
  );
  check(
    !containsScoreField(failed),
    "evaluator output must not contain a blended score field",
  );
  check(
    failed.metrics.wallTimeMs === 2853000 &&
      failed.metrics.modelCalls === 193 &&
      failed.metrics.inputTokens === 29645256 &&
      failed.metrics.outputTokens === 131740 &&
      failed.metrics.nanoAiUnits === 815191200000 &&
      failed.metrics.aiUnits === 815.1912 &&
      failed.metrics.toolCalls === 220 &&
      failed.metrics.failedToolCalls === 8,
    "observed fixture must preserve the frozen raw metrics",
  );
  check(
    failed.evaluationMode === "frozen-replay",
    "observed fixture must identify frozen replay mode",
  );
  check(
    failed.operationalDiagnostics.wakeOnlyCoordinatorTurns === 12 &&
      failed.operationalDiagnostics.prematureValidatorAttempts === 11 &&
      failed.operationalDiagnostics.repeatedStructuralRetryCount === 5 &&
      failed.operationalDiagnostics.failedToolCalls === 8 &&
      failed.operationalDiagnostics.failedToolRate === 8 / 220 &&
      failed.operationalDiagnostics.leakedProcessCount === 2,
    "observed fixture must emit all raw operational diagnostics",
  );
  const failureFixture = join(fixturesRoot, failureFixtureId);
  const powerpointSnapshot = await readJson(
    join(failureFixture, "artifacts", "powerpoint-snapshot.json"),
  );
  const shapeCounts = [...powerpointSnapshot.shapeCounts].sort(
    (left, right) => left - right,
  );
  const medianShapeCount =
    (shapeCounts[shapeCounts.length / 2 - 1] +
      shapeCounts[shapeCounts.length / 2]) /
    2;
  check(
    powerpointSnapshot.slideCount === 12 &&
      shapeCounts.reduce((total, count) => total + count, 0) === 40 &&
      medianShapeCount === 3,
    "observed PowerPoint snapshot must preserve 12 slides, 40 shapes, and median 3",
  );

  const passed = await evaluateFixture(passFixtureId);
  check(passed.status === "passed", "minimal passing fixture must pass");
  check(
    Object.values(passed.axes).every((axis) => axis.status === "passed"),
    "minimal passing fixture must pass every axis",
  );
  check(
    passed.failureReasons.length === 0,
    "minimal passing fixture must not report failure reasons",
  );
  check(
    passed.evaluationMode === "frozen-replay" &&
      passed.operationalDiagnostics.wakeOnlyCoordinatorTurns === 0 &&
      passed.operationalDiagnostics.prematureValidatorAttempts === 0 &&
      passed.operationalDiagnostics.repeatedStructuralRetryCount === 0 &&
      passed.operationalDiagnostics.failedToolCalls === 0 &&
      passed.operationalDiagnostics.failedToolRate === 0 &&
      passed.operationalDiagnostics.leakedProcessCount === 0,
    "minimal passing fixture must emit zero operational diagnostics",
  );
  check(
    passed.budget.requiredFormats.join(",") === "html,powerpoint",
    "result must emit the trusted required format set",
  );

  const passRun = await readJson(join(passFixture, "run.json"));
  for (const descriptor of passRun.artifacts) {
    const actual = sha256(await readFile(join(passFixture, descriptor.path)));
    check(
      passed.artifactHashes[descriptor.id] === actual,
      `emitted hash for ${descriptor.id} must match bytes on disk`,
    );
  }

  const smokeFailure = await evaluateFixture(smokeFixtureId);
  const expectedSmokeFailureCodes = [
    "efficiency.inputTokens_budget_exceeded",
    "efficiency.modelCalls_budget_exceeded",
    "final_outcome.powerpoint_notes_not_isolated",
    "final_outcome.powerpoint_orphaned_customer_parts",
    "final_outcome.powerpoint_plan_evidence_binding_failed",
  ].sort();
  check(smokeFailure.status === "failed", "attempt-2 smoke fixture must fail");
  check(
    JSON.stringify([...reasonCodes(smokeFailure)].sort()) ===
      JSON.stringify(expectedSmokeFailureCodes),
    "attempt-2 smoke fixture must fail for only notes, package, evidence binding, and model/token budgets",
  );
  check(
    smokeFailure.axes.artifactQuality.status === "passed" &&
      smokeFailure.axes.humanApproval.status === "passed" &&
      smokeFailure.axes.reliability.status === "passed",
    "attempt-2 visual success and approval must not compensate for structural or budget failures",
  );
  check(
    smokeFailure.metrics.wallTimeMs === 337328 &&
      smokeFailure.metrics.modelCalls === 37 &&
      smokeFailure.metrics.inputTokens === 3735253 &&
      smokeFailure.metrics.canvasCalls === 8 &&
      smokeFailure.operationalDiagnostics.canvasCalls === 8,
    "attempt-2 smoke fixture must preserve elapsed, model, token, and canvas usage",
  );
  check(
    smokeFailure.axes.finalOutcome.diagnostics.smoke.packageInventory
      .packageSlidePartCount === 12 &&
      smokeFailure.axes.finalOutcome.diagnostics.smoke.packageInventory
        .packageNotesPartCount === 11 &&
      smokeFailure.axes.finalOutcome.diagnostics.smoke.canvas.actionCount === 49,
    "attempt-2 smoke fixture must preserve package and canvas-action evidence",
  );
  const smokeSnapshot = await readJson(
    join(smokeFixture, "artifacts", "powerpoint-snapshot.json"),
  );
  check(
    smokeSnapshot.activeSlides.length === 3 &&
      smokeSnapshot.nativeTable.rows === 6 &&
      smokeSnapshot.nativeTable.columns === 3,
    "attempt-2 smoke fixture must preserve three active slides and the native 6x3 table",
  );

  const cleanSmokeFixture = await makeCleanSmokeFixture(
    "clean-powerpoint-smoke",
  );
  const cleanSmoke = await evaluateFixture(cleanSmokeFixture);
  check(
    cleanSmoke.status === "passed" &&
      Object.values(cleanSmoke.axes).every((axis) => axis.status === "passed"),
    "clean PowerPoint smoke control must pass every axis",
  );

  const missingSmokeArtifactFixture = await makeCleanSmokeFixture(
    "missing-smoke-artifact",
  );
  const missingSmokeArtifactRun = await readJson(
    join(missingSmokeArtifactFixture, "run.json"),
  );
  const missingSmokeArtifact = missingSmokeArtifactRun.artifacts.find(
    (entry) => entry.format === "powerpoint",
  );
  await rm(join(missingSmokeArtifactFixture, missingSmokeArtifact.path));
  const missingSmokeArtifactResult = await evaluateFixture(
    missingSmokeArtifactFixture,
  );
  check(
    reasonCodes(missingSmokeArtifactResult).has(
      "final_outcome.powerpoint_missing",
    ),
    "missing smoke candidate must fail the outcome gate instead of rejecting evaluator input",
  );

  const incompleteSmokeQaFixture = await makeCleanSmokeFixture(
    "incomplete-smoke-qa",
  );
  const incompleteSmokeRun = await readJson(
    join(incompleteSmokeQaFixture, "run.json"),
  );
  const incompleteSmokeQaDescriptor = incompleteSmokeRun.evidence.find(
    (entry) => entry.kind === "powerpointQa",
  );
  const incompleteSmokeQaPath = join(
    incompleteSmokeQaFixture,
    incompleteSmokeQaDescriptor.path,
  );
  const incompleteSmokeQa = await readJson(incompleteSmokeQaPath);
  delete incompleteSmokeQa.deterministicChecks.notesIsolated;
  await writeJson(incompleteSmokeQaPath, incompleteSmokeQa);
  incompleteSmokeQaDescriptor.sha256 = sha256(
    await readFile(incompleteSmokeQaPath),
  );
  await writeJson(
    join(incompleteSmokeQaFixture, "run.json"),
    incompleteSmokeRun,
  );
  await expectInputError(
    () => evaluateFixture(incompleteSmokeQaFixture),
    "missing required smoke QA check",
  );

  const staleSnapshotFixture = await makeCleanSmokeFixture(
    "stale-smoke-snapshot",
  );
  const staleSnapshotRun = await readJson(
    join(staleSnapshotFixture, "run.json"),
  );
  const staleSnapshotQaDescriptor = staleSnapshotRun.evidence.find(
    (entry) => entry.kind === "powerpointQa",
  );
  const staleSnapshotQaPath = join(
    staleSnapshotFixture,
    staleSnapshotQaDescriptor.path,
  );
  const staleSnapshotQa = await readJson(staleSnapshotQaPath);
  staleSnapshotQa.smokeEvidence.activeSlides[0].shapeCount += 1;
  await writeJson(staleSnapshotQaPath, staleSnapshotQa);
  await updateDescriptorHash(
    staleSnapshotFixture,
    "evidence",
    "powerpointQa",
  );
  await expectInputError(
    () => evaluateFixture(staleSnapshotFixture),
    "smoke QA that disagrees with the candidate snapshot",
  );

  const detachedNativeTableFixture = await makeCleanSmokeFixture(
    "detached-native-table",
  );
  const detachedNativeTableRun = await readJson(
    join(detachedNativeTableFixture, "run.json"),
  );
  const detachedNativeTableQaDescriptor =
    detachedNativeTableRun.evidence.find(
      (entry) => entry.kind === "powerpointQa",
    );
  const detachedNativeTableQaPath = join(
    detachedNativeTableFixture,
    detachedNativeTableQaDescriptor.path,
  );
  const detachedNativeTableQa = await readJson(detachedNativeTableQaPath);
  detachedNativeTableQa.smokeEvidence.activeSlides[2].tableCount = 0;
  detachedNativeTableQa.shapeStats.nativeTables = 0;
  await writeJson(detachedNativeTableQaPath, detachedNativeTableQa);
  const detachedNativeTableCandidateDescriptor =
    detachedNativeTableRun.artifacts.find(
      (entry) => entry.format === "powerpoint",
    );
  const detachedNativeTableCandidatePath = join(
    detachedNativeTableFixture,
    detachedNativeTableCandidateDescriptor.path,
  );
  const detachedNativeTableCandidate = await readJson(
    detachedNativeTableCandidatePath,
  );
  detachedNativeTableCandidate.activeSlides[2].tableCount = 0;
  await writeJson(
    detachedNativeTableCandidatePath,
    detachedNativeTableCandidate,
  );
  await syncSmokeCandidateBindings(detachedNativeTableFixture);
  await expectInputError(
    () => evaluateFixture(detachedNativeTableFixture),
    "native table dimensions detached from the dense slide table count",
  );

  const selfDeclaredPlanFixture = await makeCleanSmokeFixture(
    "self-declared-smoke-plan",
  );
  const selfDeclaredPlanRun = await readJson(
    join(selfDeclaredPlanFixture, "run.json"),
  );
  const selfDeclaredPlanQaDescriptor = selfDeclaredPlanRun.evidence.find(
    (entry) => entry.kind === "powerpointQa",
  );
  const selfDeclaredPlanQaPath = join(
    selfDeclaredPlanFixture,
    selfDeclaredPlanQaDescriptor.path,
  );
  const selfDeclaredPlanQa = await readJson(selfDeclaredPlanQaPath);
  selfDeclaredPlanQa.smokeEvidence.activeSlides[1].expectedEvidenceIds = [
    "EV-FALSE",
  ];
  selfDeclaredPlanQa.smokeEvidence.activeSlides[1].evidenceIdsInNotes = [
    "EV-FALSE",
  ];
  await writeJson(selfDeclaredPlanQaPath, selfDeclaredPlanQa);
  const selfDeclaredPlanCandidateDescriptor =
    selfDeclaredPlanRun.artifacts.find(
      (entry) => entry.format === "powerpoint",
    );
  const selfDeclaredPlanCandidatePath = join(
    selfDeclaredPlanFixture,
    selfDeclaredPlanCandidateDescriptor.path,
  );
  const selfDeclaredPlanCandidate = await readJson(
    selfDeclaredPlanCandidatePath,
  );
  selfDeclaredPlanCandidate.activeSlides[1].evidenceIdsInNotes = [
    "EV-FALSE",
  ];
  await writeJson(
    selfDeclaredPlanCandidatePath,
    selfDeclaredPlanCandidate,
  );
  await syncSmokeCandidateBindings(selfDeclaredPlanFixture);
  const selfDeclaredPlanResult = await evaluateFixture(
    selfDeclaredPlanFixture,
  );
  check(
    reasonCodes(selfDeclaredPlanResult).has(
      "final_outcome.powerpoint_plan_evidence_binding_failed",
    ),
    "smoke evidence IDs that disagree with the frozen plan must fail the binding gate",
  );

  const wrongContactSheetFixture = await makeCleanSmokeFixture(
    "wrong-contact-sheet-artifact",
  );
  const wrongContactSheetRun = await readJson(
    join(wrongContactSheetFixture, "run.json"),
  );
  const wrongContactSheetQaDescriptor = wrongContactSheetRun.evidence.find(
    (entry) => entry.kind === "powerpointQa",
  );
  const wrongContactSheetQaPath = join(
    wrongContactSheetFixture,
    wrongContactSheetQaDescriptor.path,
  );
  const wrongContactSheetQa = await readJson(wrongContactSheetQaPath);
  wrongContactSheetQa.smokeEvidence.contactSheet.artifactId = "powerpoint";
  wrongContactSheetQa.smokeEvidence.contactSheet.sha256 =
    wrongContactSheetQa.artifactSha256;
  await writeJson(wrongContactSheetQaPath, wrongContactSheetQa);
  await updateDescriptorHash(
    wrongContactSheetFixture,
    "evidence",
    "powerpointQa",
  );
  await expectInputError(
    () => evaluateFixture(wrongContactSheetFixture),
    "contact-sheet evidence that points to the candidate",
  );

  const aliasedContactSheetFixture = await makeCleanSmokeFixture(
    "aliased-contact-sheet-path",
  );
  const aliasedContactSheetRunPath = join(
    aliasedContactSheetFixture,
    "run.json",
  );
  const aliasedContactSheetRun = await readJson(aliasedContactSheetRunPath);
  const aliasedCandidateDescriptor = aliasedContactSheetRun.artifacts.find(
    (entry) => entry.format === "powerpoint",
  );
  const aliasedContactDescriptor = aliasedContactSheetRun.artifacts.find(
    (entry) => entry.format === "contact-sheet",
  );
  aliasedContactDescriptor.path = "artifacts/./powerpoint-snapshot.json";
  aliasedContactDescriptor.sha256 = aliasedCandidateDescriptor.sha256;
  const aliasedQaDescriptor = aliasedContactSheetRun.evidence.find(
    (entry) => entry.kind === "powerpointQa",
  );
  const aliasedQaPath = join(
    aliasedContactSheetFixture,
    aliasedQaDescriptor.path,
  );
  const aliasedQa = await readJson(aliasedQaPath);
  aliasedQa.smokeEvidence.contactSheet.sha256 =
    aliasedCandidateDescriptor.sha256;
  await writeJson(aliasedQaPath, aliasedQa);
  aliasedQaDescriptor.sha256 = sha256(await readFile(aliasedQaPath));
  const aliasedHumanDescriptor = aliasedContactSheetRun.evidence.find(
    (entry) => entry.kind === "humanReview",
  );
  const aliasedHumanPath = join(
    aliasedContactSheetFixture,
    aliasedHumanDescriptor.path,
  );
  const aliasedHuman = await readJson(aliasedHumanPath);
  aliasedHuman.contactSheetSha256 = aliasedCandidateDescriptor.sha256;
  await writeJson(aliasedHumanPath, aliasedHuman);
  aliasedHumanDescriptor.sha256 = sha256(
    await readFile(aliasedHumanPath),
  );
  await writeJson(aliasedContactSheetRunPath, aliasedContactSheetRun);
  await expectInputError(
    () => evaluateFixture(aliasedContactSheetFixture),
    "contact-sheet descriptor that aliases the candidate path",
  );

  const extraFalseCheckFixture = await makeCleanSmokeFixture(
    "extra-false-smoke-check",
  );
  const extraFalseCheckRun = await readJson(
    join(extraFalseCheckFixture, "run.json"),
  );
  const extraFalseCheckQaDescriptor = extraFalseCheckRun.evidence.find(
    (entry) => entry.kind === "powerpointQa",
  );
  const extraFalseCheckQaPath = join(
    extraFalseCheckFixture,
    extraFalseCheckQaDescriptor.path,
  );
  const extraFalseCheckQa = await readJson(extraFalseCheckQaPath);
  extraFalseCheckQa.deterministicChecks.extraSmokeCheck = false;
  await writeJson(extraFalseCheckQaPath, extraFalseCheckQa);
  await updateDescriptorHash(
    extraFalseCheckFixture,
    "evidence",
    "powerpointQa",
  );
  const extraFalseCheckResult = await evaluateFixture(
    extraFalseCheckFixture,
  );
  check(
    reasonCodes(extraFalseCheckResult).has(
      "final_outcome.powerpoint_extraSmokeCheck_failed",
    ),
    "an additional false deterministic smoke check must fail the outcome gate",
  );

  const staleSmokeCandidateFixture = await makeCleanSmokeFixture(
    "stale-smoke-candidate",
  );
  const staleSmokeCandidateRun = await readJson(
    join(staleSmokeCandidateFixture, "run.json"),
  );
  const staleSmokeCandidate = staleSmokeCandidateRun.artifacts.find(
    (entry) => entry.format === "powerpoint",
  );
  await appendFile(
    join(staleSmokeCandidateFixture, staleSmokeCandidate.path),
    "\n",
  );
  const staleSmokeCandidateResult = await evaluateFixture(
    staleSmokeCandidateFixture,
  );
  check(
    reasonCodes(staleSmokeCandidateResult).has(
      "final_outcome.powerpoint_hash_mismatch",
    ) &&
      reasonCodes(staleSmokeCandidateResult).has(
        "final_outcome.powerpoint_qa_stale",
      ),
    "post-QA smoke candidate changes must fail hard gates instead of rejecting evaluator input",
  );

  const unreconciledToolsFixture = await makeCleanSmokeFixture(
    "unreconciled-smoke-tools",
  );
  const unreconciledToolsRunPath = join(
    unreconciledToolsFixture,
    "run.json",
  );
  const unreconciledToolsRun = await readJson(unreconciledToolsRunPath);
  unreconciledToolsRun.metrics.toolCalls += 1;
  await writeJson(unreconciledToolsRunPath, unreconciledToolsRun);
  await syncTraceToMetrics(unreconciledToolsFixture);
  await expectInputError(
    () => evaluateFixture(unreconciledToolsFixture),
    "tool totals that disagree with smoke evidence",
  );

  const impossibleToolCategoryFixture = await makeCleanSmokeFixture(
    "impossible-smoke-tool-category",
  );
  const impossibleToolCategoryRunPath = join(
    impossibleToolCategoryFixture,
    "run.json",
  );
  const impossibleToolCategoryRun = await readJson(
    impossibleToolCategoryRunPath,
  );
  impossibleToolCategoryRun.metrics.failedToolCalls = 1;
  const impossibleToolQaDescriptor =
    impossibleToolCategoryRun.evidence.find(
      (entry) => entry.kind === "powerpointQa",
    );
  const impossibleToolQaPath = join(
    impossibleToolCategoryFixture,
    impossibleToolQaDescriptor.path,
  );
  const impossibleToolQa = await readJson(impossibleToolQaPath);
  impossibleToolQa.smokeEvidence.canvas.otherToolFailures = 1;
  await writeJson(impossibleToolQaPath, impossibleToolQa);
  impossibleToolQaDescriptor.sha256 = sha256(
    await readFile(impossibleToolQaPath),
  );
  const impossibleToolTraceDescriptor =
    impossibleToolCategoryRun.records.find(
      (entry) => entry.kind === "trace",
    );
  const impossibleToolTracePath = join(
    impossibleToolCategoryFixture,
    impossibleToolTraceDescriptor.path,
  );
  const impossibleToolTrace = await readJson(impossibleToolTracePath);
  impossibleToolTrace.failedToolCallsCaptured = 1;
  impossibleToolTrace.otherToolFailuresCaptured = 1;
  await writeJson(impossibleToolTracePath, impossibleToolTrace);
  impossibleToolTraceDescriptor.sha256 = sha256(
    await readFile(impossibleToolTracePath),
  );
  await writeJson(
    impossibleToolCategoryRunPath,
    impossibleToolCategoryRun,
  );
  await expectInputError(
    () => evaluateFixture(impossibleToolCategoryFixture),
    "failed tool category count above its call count",
  );

  const canvasBoundaryFixture = await makeCleanSmokeFixture(
    "smoke-canvas-boundary",
  );
  await setSmokeCanvasCalls(canvasBoundaryFixture, 10);
  const canvasBoundary = await evaluateFixture(canvasBoundaryFixture);
  check(
    canvasBoundary.status === "passed",
    "canvas calls equal to the smoke budget must pass",
  );
  await setSmokeCanvasCalls(canvasBoundaryFixture, 11);
  const canvasOver = await evaluateFixture(canvasBoundaryFixture);
  check(
    reasonCodes(canvasOver).has("efficiency.canvasCalls_budget_exceeded"),
    "canvas calls above the smoke budget must fail",
  );

  const oneGateFixture = await copyPassFixture("one-hard-gate");
  const finalStatePath = join(oneGateFixture, "final-state.json");
  const finalState = await readJson(finalStatePath);
  finalState.boundaryViolations.push({
    id: "synthetic-boundary-violation",
  });
  await writeJson(finalStatePath, finalState);
  await updateDescriptorHash(oneGateFixture, "records", "finalState");
  const oneGateResult = await evaluateFixture(oneGateFixture);
  check(
    oneGateResult.status === "failed" &&
      oneGateResult.axes.safety.status === "failed",
    "one failed hard gate must fail the overall run",
  );
  check(
    Object.entries(oneGateResult.axes)
      .filter(([axis]) => axis !== "safety")
      .every(([, result]) => result.status === "passed"),
    "single hard-gate test must not create unrelated axis failures",
  );

  const staleFixture = await copyPassFixture("stale-artifact");
  await appendFile(
    join(staleFixture, "artifacts", "readout.html"),
    "\n<!-- changed after QA -->\n",
  );
  const staleResult = await evaluateFixture(staleFixture);
  const staleCodes = reasonCodes(staleResult);
  check(
    staleCodes.has("final_outcome.html_hash_mismatch") &&
      staleCodes.has("trace_quality.stale_html_qa_evidence"),
    "changing final artifact bytes must invalidate frozen and QA hashes",
  );

  const missingPlanFixture = await copyPassFixture("missing-plan");
  await rm(join(missingPlanFixture, "artifacts", "readout-plan.json"));
  await expectInputError(
    () => evaluateFixture(missingPlanFixture),
    "missing plan artifact",
  );

  const tamperedPlanFixture = await copyPassFixture("tampered-plan");
  await appendFile(
    join(tamperedPlanFixture, "artifacts", "readout-plan.json"),
    "\n",
  );
  await expectInputError(
    () => evaluateFixture(tamperedPlanFixture),
    "tampered plan artifact",
  );

  const prematureFixture = await copyPassFixture("premature-validator");
  const prematureTracePath = join(prematureFixture, "trace.json");
  const prematureTrace = await readJson(prematureTracePath);
  prematureTrace.prematureValidationAttempts = 1;
  await writeJson(prematureTracePath, prematureTrace);
  await updateDescriptorHash(prematureFixture, "records", "trace");
  const prematureResult = await evaluateFixture(prematureFixture);
  check(
    reasonCodes(prematureResult).has(
      "trace_quality.premature_validator_loop",
    ),
    "one known-incomplete validator attempt must fail trace quality",
  );

  const unsupportedLiveFixture = await copyPassFixture("unsupported-live");
  const unsupportedLiveRunPath = join(unsupportedLiveFixture, "run.json");
  const unsupportedLiveRun = await readJson(unsupportedLiveRunPath);
  unsupportedLiveRun.evaluationMode = "live";
  await writeJson(unsupportedLiveRunPath, unsupportedLiveRun);
  await expectInputError(
    () => evaluateFixture(unsupportedLiveFixture),
    "unsupported live evaluation mode",
  );
  const unsupportedLiveCli = spawnSync(
    process.execPath,
    [cli, "--fixture", unsupportedLiveFixture],
    { encoding: "utf8" },
  );
  check(
    unsupportedLiveCli.status === 2 &&
      unsupportedLiveCli.stderr.includes(
        "trusted live evaluation is unsupported until Hill 2",
      ),
    "live mode must exit 2 with the Hill 2 deferral message",
  );

  const reliabilityFixture = await copyPassFixture("reliability");
  const reliabilityPath = join(reliabilityFixture, "reliability.json");
  const reliability = await readJson(reliabilityPath);
  reliability.criticalTrialsRequired = 1;
  reliability.trials = reliability.trials.slice(0, 1);
  await writeJson(reliabilityPath, reliability);
  await updateDescriptorHash(reliabilityFixture, "records", "reliability");
  const reliabilityResult = await evaluateFixture(reliabilityFixture);
  check(
    reasonCodes(reliabilityResult).has(
      "reliability.critical_trials_incomplete",
    ),
    "fixture-local reliability requirements must not lower the trusted five-trial policy",
  );

  const duplicateTrialsFixture = await copyPassFixture("duplicate-trials");
  const duplicateTrialsPath = join(
    duplicateTrialsFixture,
    "reliability.json",
  );
  const duplicateTrials = await readJson(duplicateTrialsPath);
  duplicateTrials.trials = Array.from({ length: 5 }, (_, index) => ({
    id: "trial-1",
    passed: true,
    attempt: index + 1,
  }));
  await writeJson(duplicateTrialsPath, duplicateTrials);
  await updateDescriptorHash(duplicateTrialsFixture, "records", "reliability");
  await expectInputError(
    () => evaluateFixture(duplicateTrialsFixture),
    "duplicate reliability trial IDs",
  );

  const budgets = await readJson(join(root, "evals", "fde-e2e", "budgets.json"));
  const limits = budgets.taskClasses["full-fde-dual-format"].limits;
  for (const [metric, limit] of Object.entries(limits).filter(
    ([metric]) => !["failedToolCalls", "failedToolRate"].includes(metric),
  )) {
    const fixture = await copyPassFixture(`budget-${metric}`);
    const runPath = join(fixture, "run.json");
    const run = await readJson(runPath);
    run.metrics[metric] = limit;
    await writeJson(runPath, run);
    await syncTraceToMetrics(fixture);
    const boundary = await evaluateFixture(fixture);
    check(
      boundary.axes.efficiency.status === "passed",
      `${metric} equal to its budget must pass`,
    );

    const overRun = await readJson(runPath);
    overRun.metrics[metric] = limit + 1;
    await writeJson(runPath, overRun);
    await syncTraceToMetrics(fixture);
    const over = await evaluateFixture(fixture);
    check(
      reasonCodes(over).has(`efficiency.${metric}_budget_exceeded`),
      `${metric} above its budget must fail`,
    );
  }

  const failedCountFixture = await copyPassFixture("failed-tool-count");
  const failedCountRunPath = join(failedCountFixture, "run.json");
  const failedCountRun = await readJson(failedCountRunPath);
  failedCountRun.metrics.toolCalls = 160;
  failedCountRun.metrics.failedToolCalls = 2;
  await writeJson(failedCountRunPath, failedCountRun);
  await syncTraceToMetrics(failedCountFixture);
  const failedCountBoundary = await evaluateFixture(failedCountFixture);
  check(
    failedCountBoundary.axes.efficiency.status === "passed",
    "failed tool count equal to 2 must pass when its rate is below 2 percent",
  );
  const failedCountOverRun = await readJson(failedCountRunPath);
  failedCountOverRun.metrics.failedToolCalls = 3;
  await writeJson(failedCountRunPath, failedCountOverRun);
  await syncTraceToMetrics(failedCountFixture);
  const failedCountOver = await evaluateFixture(failedCountFixture);
  check(
    reasonCodes(failedCountOver).has(
      "efficiency.failedToolCalls_budget_exceeded",
    ) &&
      !reasonCodes(failedCountOver).has(
        "efficiency.failedToolRate_budget_exceeded",
      ),
    "failed tool count above 2 must fail independently of rate",
  );

  const failedRateFixture = await copyPassFixture("failed-tool-rate");
  const failedRateRunPath = join(failedRateFixture, "run.json");
  const failedRateRun = await readJson(failedRateRunPath);
  failedRateRun.metrics.toolCalls = 100;
  failedRateRun.metrics.failedToolCalls = 2;
  await writeJson(failedRateRunPath, failedRateRun);
  await syncTraceToMetrics(failedRateFixture);
  const failedRateBoundary = await evaluateFixture(failedRateFixture);
  check(
    failedRateBoundary.axes.efficiency.status === "passed" &&
      failedRateBoundary.metrics.failedToolRate === 0.02,
    "failed tool rate equal to 2 percent must pass",
  );
  const failedRateOverRun = await readJson(failedRateRunPath);
  failedRateOverRun.metrics.toolCalls = 99;
  await writeJson(failedRateRunPath, failedRateOverRun);
  await syncTraceToMetrics(failedRateFixture);
  const failedRateOver = await evaluateFixture(failedRateFixture);
  check(
    reasonCodes(failedRateOver).has(
      "efficiency.failedToolRate_budget_exceeded",
    ) &&
      !reasonCodes(failedRateOver).has(
        "efficiency.failedToolCalls_budget_exceeded",
      ),
    "failed tool rate above 2 percent must fail independently of count",
  );

  for (const [name, requestedFormats] of [
    ["missing-powerpoint-format", ["html"]],
    ["missing-html-format", ["powerpoint"]],
    ["extra-requested-format", ["html", "powerpoint", "pdf"]],
  ]) {
    const fixture = await copyPassFixture(name);
    const runPath = join(fixture, "run.json");
    const run = await readJson(runPath);
    run.task.requestedFormats = requestedFormats;
    await writeJson(runPath, run);
    await expectInputError(
      () => evaluateFixture(fixture),
      `${name} requested format set`,
    );
  }

  const reorderedFormatsFixture = await copyPassFixture(
    "reordered-required-formats",
  );
  const reorderedFormatsRunPath = join(
    reorderedFormatsFixture,
    "run.json",
  );
  const reorderedFormatsRun = await readJson(reorderedFormatsRunPath);
  reorderedFormatsRun.task.requestedFormats.reverse();
  await writeJson(reorderedFormatsRunPath, reorderedFormatsRun);
  const reorderedFormatsResult = await evaluateFixture(
    reorderedFormatsFixture,
  );
  check(
    reorderedFormatsResult.status === "passed",
    "requested formats may match trusted policy in any order",
  );

  const duplicateRequestedFixture = await copyPassFixture(
    "duplicate-requested-format",
  );
  const duplicateRequestedRunPath = join(
    duplicateRequestedFixture,
    "run.json",
  );
  const duplicateRequestedRun = await readJson(duplicateRequestedRunPath);
  duplicateRequestedRun.task.requestedFormats.push("html");
  await writeJson(duplicateRequestedRunPath, duplicateRequestedRun);
  await expectInputError(
    () => evaluateFixture(duplicateRequestedFixture),
    "duplicate requested formats",
  );

  const duplicateArtifactFixture = await copyPassFixture(
    "duplicate-artifact-format",
  );
  const duplicateArtifactRunPath = join(
    duplicateArtifactFixture,
    "run.json",
  );
  const duplicateArtifactRun = await readJson(duplicateArtifactRunPath);
  duplicateArtifactRun.artifacts.find(
    (artifact) => artifact.format === "powerpoint",
  ).format = "html";
  await writeJson(duplicateArtifactRunPath, duplicateArtifactRun);
  await expectInputError(
    () => evaluateFixture(duplicateArtifactFixture),
    "duplicate artifact formats",
  );

  const incompleteQaFixture = await copyPassFixture("incomplete-html-qa");
  const incompleteQaRun = await readJson(
    join(incompleteQaFixture, "run.json"),
  );
  const incompleteQaDescriptor = incompleteQaRun.evidence.find(
    (entry) => entry.kind === "htmlQa",
  );
  const incompleteQaPath = join(
    incompleteQaFixture,
    incompleteQaDescriptor.path,
  );
  const incompleteQa = await readJson(incompleteQaPath);
  delete incompleteQa.deterministicChecks.consoleClean;
  await writeJson(incompleteQaPath, incompleteQa);
  incompleteQaDescriptor.sha256 = sha256(await readFile(incompleteQaPath));
  await writeJson(join(incompleteQaFixture, "run.json"), incompleteQaRun);
  await expectInputError(
    () => evaluateFixture(incompleteQaFixture),
    "missing required HTML QA check",
  );

  const incompletePowerpointQaFixture = await copyPassFixture(
    "incomplete-powerpoint-qa",
  );
  const incompletePowerpointQaRun = await readJson(
    join(incompletePowerpointQaFixture, "run.json"),
  );
  const incompletePowerpointQaDescriptor =
    incompletePowerpointQaRun.evidence.find(
      (entry) => entry.kind === "powerpointQa",
    );
  const incompletePowerpointQaPath = join(
    incompletePowerpointQaFixture,
    incompletePowerpointQaDescriptor.path,
  );
  const incompletePowerpointQa = await readJson(incompletePowerpointQaPath);
  delete incompletePowerpointQa.deterministicChecks.editable;
  await writeJson(incompletePowerpointQaPath, incompletePowerpointQa);
  incompletePowerpointQaDescriptor.sha256 = sha256(
    await readFile(incompletePowerpointQaPath),
  );
  await writeJson(
    join(incompletePowerpointQaFixture, "run.json"),
    incompletePowerpointQaRun,
  );
  await expectInputError(
    () => evaluateFixture(incompletePowerpointQaFixture),
    "missing required PowerPoint QA check",
  );

  const traversalFixture = await copyPassFixture("invalid-path");
  const traversalRunPath = join(traversalFixture, "run.json");
  const traversalRun = await readJson(traversalRunPath);
  traversalRun.artifacts[0].path = "..\\outside.json";
  await writeJson(traversalRunPath, traversalRun);
  await expectInputError(
    () => evaluateFixture(traversalFixture),
    "path traversal fixture",
  );

  const missingFixture = await copyPassFixture("missing-file");
  const missingRunPath = join(missingFixture, "run.json");
  const missingRun = await readJson(missingRunPath);
  missingRun.evidence[0].path = "evidence/missing.json";
  await writeJson(missingRunPath, missingRun);
  await expectInputError(
    () => evaluateFixture(missingFixture),
    "missing evidence fixture",
  );

  const invalidHashFixture = await copyPassFixture("invalid-hash");
  const invalidHashRunPath = join(invalidHashFixture, "run.json");
  const invalidHashRun = await readJson(invalidHashRunPath);
  invalidHashRun.records[0].sha256 = "not-a-sha256";
  await writeJson(invalidHashRunPath, invalidHashRun);
  await expectInputError(
    () => evaluateFixture(invalidHashFixture),
    "invalid hash fixture",
  );

  const impossibleToolCountsFixture = await copyPassFixture(
    "impossible-tool-counts",
  );
  const impossibleToolCountsRunPath = join(
    impossibleToolCountsFixture,
    "run.json",
  );
  const impossibleToolCountsRun = await readJson(
    impossibleToolCountsRunPath,
  );
  impossibleToolCountsRun.metrics.failedToolCalls =
    impossibleToolCountsRun.metrics.toolCalls + 1;
  await writeJson(impossibleToolCountsRunPath, impossibleToolCountsRun);
  await expectInputError(
    () => evaluateFixture(impossibleToolCountsFixture),
    "failed tool calls above total tool calls",
  );

  const incompleteFinalStateFixture = await copyPassFixture(
    "incomplete-final-state",
  );
  const incompleteFinalStatePath = join(
    incompleteFinalStateFixture,
    "final-state.json",
  );
  const incompleteFinalState = await readJson(incompleteFinalStatePath);
  delete incompleteFinalState.visibleExternalFaults;
  await writeJson(incompleteFinalStatePath, incompleteFinalState);
  await updateDescriptorHash(
    incompleteFinalStateFixture,
    "records",
    "finalState",
  );
  await expectInputError(
    () => evaluateFixture(incompleteFinalStateFixture),
    "incomplete final-state fixture",
  );

  const passCli = spawnSync(
    process.execPath,
    [cli, "--fixture", passFixtureId],
    { encoding: "utf8" },
  );
  check(passCli.status === 0, "passing CLI fixture must exit 0");
  check(
    JSON.parse(passCli.stdout).status === "passed",
    "passing CLI fixture must emit passing JSON",
  );

  const failureCli = spawnSync(
    process.execPath,
    [cli, "--fixture", failureFixtureId],
    { encoding: "utf8" },
  );
  check(failureCli.status === 1, "failed CLI fixture must exit 1");
  check(
    JSON.parse(failureCli.stdout).status === "failed",
    "failed CLI fixture must emit failed JSON",
  );

  const cleanSmokeCli = spawnSync(
    process.execPath,
    [cli, "--fixture", cleanSmokeFixture],
    { encoding: "utf8" },
  );
  check(cleanSmokeCli.status === 0, "clean smoke CLI fixture must exit 0");
  check(
    JSON.parse(cleanSmokeCli.stdout).status === "passed",
    "clean smoke CLI fixture must emit passing JSON",
  );

  const smokeFailureCli = spawnSync(
    process.execPath,
    [cli, "--fixture", smokeFixtureId],
    { encoding: "utf8" },
  );
  check(smokeFailureCli.status === 1, "attempt-2 smoke CLI fixture must exit 1");
  check(
    JSON.parse(smokeFailureCli.stdout).status === "failed",
    "attempt-2 smoke CLI fixture must emit failed JSON",
  );

  const invalidCli = spawnSync(
    process.execPath,
    [cli, "--fixture", "..\\outside"],
    { encoding: "utf8" },
  );
  check(invalidCli.status === 2, "invalid CLI fixture must exit 2");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("FDE end-to-end evaluator tests failed:");
  failures.forEach((failure, index) =>
    console.error(`${index + 1}. ${failure}`),
  );
  process.exit(1);
}

console.log(
  "FDE end-to-end evaluator tests passed: replay-only mode, trusted QA, hard gates, hashes, budgets, reliability, and CLI.",
);
