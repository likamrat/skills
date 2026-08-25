#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { evaluateFixture, GRADER_VERSION } from "./evaluate-fde-run.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturesRoot = join(root, "evals", "fde-e2e", "fixtures");
const passFixtureId = "hill-0-minimal-pass-v1";
const failureFixtureId = "hill-0-observed-failure-v1";
const passFixture = join(fixturesRoot, passFixtureId);
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

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function copyPassFixture(name) {
  const target = join(temporaryRoot, name);
  await cp(passFixture, target, { recursive: true });
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
    "efficiency.wallTimeMs_budget_exceeded",
    "efficiency.modelCalls_budget_exceeded",
    "efficiency.inputTokens_budget_exceeded",
    "efficiency.toolCalls_budget_exceeded",
    "efficiency.failedToolCalls_budget_exceeded",
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

  const passRun = await readJson(join(passFixture, "run.json"));
  for (const descriptor of passRun.artifacts) {
    const actual = sha256(await readFile(join(passFixture, descriptor.path)));
    check(
      passed.artifactHashes[descriptor.id] === actual,
      `emitted hash for ${descriptor.id} must match bytes on disk`,
    );
  }

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

  const reliabilityFixture = await copyPassFixture("reliability");
  const reliabilityPath = join(reliabilityFixture, "reliability.json");
  const reliability = await readJson(reliabilityPath);
  reliability.trials = reliability.trials.slice(0, 4);
  await writeJson(reliabilityPath, reliability);
  await updateDescriptorHash(reliabilityFixture, "records", "reliability");
  const reliabilityResult = await evaluateFixture(reliabilityFixture);
  check(
    reasonCodes(reliabilityResult).has(
      "reliability.critical_trials_incomplete",
    ),
    "reliability must require every one of five critical trials",
  );

  const budgets = await readJson(join(root, "evals", "fde-e2e", "budgets.json"));
  const limits = budgets.taskClasses["full-fde-dual-format"].limits;
  for (const [metric, limit] of Object.entries(limits)) {
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
  "FDE end-to-end evaluator tests passed: frozen failure, passing fixture, hard gates, hashes, budgets, reliability, and CLI.",
);
