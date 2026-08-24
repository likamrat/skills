#!/usr/bin/env node

import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const skillName = option("--skill");
const runs = Number(option("--runs", "1"));
const model = option("--model", "gpt-5.6-sol");
const outputPath = option("--output");
const threshold = Number(option("--threshold", "0.5"));
const caseFilter = option("--case")
  ?.split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (
  !skillName ||
  !Number.isInteger(runs) ||
  runs < 1 ||
  !Number.isFinite(threshold) ||
  threshold <= 0 ||
  threshold >= 1
) {
  console.error(
    "Usage: node scripts/evaluate-triggering.mjs --skill <name> [--runs N] [--model MODEL] [--threshold 0.5] [--case ID,ID] [--output FILE]",
  );
  process.exit(2);
}

const skillRoot = join(root, "skills", "fde", skillName);
const registeredSkillRoots = (manifest.skills ?? []).map((path) =>
  resolve(root, path),
);
const triggerPath = join(skillRoot, "evals", "trigger-cases.json");
const triggers = JSON.parse(await readFile(triggerPath, "utf8"));
const allCases = [
  ...(triggers.should_trigger ?? []).map((query, index) => ({
    id: `should-trigger-${index + 1}`,
    query,
    shouldTrigger: true,
  })),
  ...(triggers.should_not_trigger ?? []).map((query, index) => ({
    id: `should-not-trigger-${index + 1}`,
    query,
    shouldTrigger: false,
  })),
];
const cases = caseFilter
  ? allCases.filter((testCase) => caseFilter.includes(testCase.id))
  : allCases;

if (cases.length === 0) {
  console.error("No trigger cases matched --case.");
  process.exit(2);
}

const workspace = await mkdtemp(join(root, ".trigger-eval-"));
const project = join(workspace, "project");
const isolatedHome = join(workspace, "home");
const installedSkillsRoot = join(project, ".agents", "skills");
const disabledServers = [
  "insights-agent",
  "playwright",
  "azure",
  "workiq",
  "github-mcp-server",
];

function parseEvents(output) {
  const events = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Non-JSON process output is retained in the failure record.
    }
  }
  return events;
}

function grade(events) {
  const activated = events.some(
    (event) =>
      event.type === "tool.execution_start" &&
      event.data?.toolName === "skill" &&
      event.data?.arguments?.skill === skillName,
  );
  const result = events.findLast((event) => event.type === "result");
  const modelCalls = events.filter(
    (event) => event.type === "model.model_call_success",
  );
  const totalTokens = modelCalls.reduce(
    (total, event) =>
      total + (event.data?.responseUsage?.total_tokens ?? 0),
    0,
  );

  return {
    activated,
    totalTokens,
    apiDurationMs: result?.usage?.totalApiDurationMs ?? null,
    sessionDurationMs: result?.usage?.sessionDurationMs ?? null,
    premiumRequests: result?.usage?.premiumRequests ?? null,
  };
}

const results = [];

try {
  await mkdir(installedSkillsRoot, { recursive: true });
  await mkdir(isolatedHome, { recursive: true });
  for (const registeredSkillRoot of registeredSkillRoots) {
    await cp(
      registeredSkillRoot,
      join(installedSkillsRoot, basename(registeredSkillRoot)),
      { recursive: true },
    );
  }
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ name: "skill-trigger-eval", private: true }),
  );

  for (const testCase of cases) {
    for (let trial = 1; trial <= runs; trial += 1) {
      const commandArgs = [
        "-C",
        project,
        "-p",
        testCase.query,
        "--model",
        model,
        "--output-format",
        "json",
        "--allow-all-tools",
        "--available-tools=skill",
        "--disable-builtin-mcps",
        "--no-custom-instructions",
        "--no-color",
        ...disabledServers.flatMap((server) => [
          "--disable-mcp-server",
          server,
        ]),
      ];
      const startedAt = new Date().toISOString();
      const run = spawnSync("copilot", commandArgs, {
        cwd: project,
        env: {
          ...process.env,
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
        },
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
        timeout: 180_000,
      });
      const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      const events = parseEvents(output);
      const metrics = grade(events);
      const matchedExpectation =
        run.status === 0 &&
        metrics.activated === testCase.shouldTrigger;

      results.push({
        id: testCase.id,
        query: testCase.query,
        shouldTrigger: testCase.shouldTrigger,
        trial,
        matchedExpectation,
        exitCode: run.status,
        startedAt,
        ...metrics,
        error:
          run.error?.message ??
          (run.status === 0 ? null : output.slice(-2000)),
      });
      console.log(
        `${testCase.id} trial ${trial}: expected ${testCase.shouldTrigger ? "load" : "skip"}, observed ${metrics.activated ? "load" : "skip"}`,
      );
    }
  }
} finally {
  await rm(workspace, { recursive: true, force: true });
}

const caseResults = cases.map((testCase) => {
  const trials = results.filter((result) => result.id === testCase.id);
  const successfulRuns = trials.filter(
    (result) => result.exitCode === 0,
  );
  const triggerRate =
    successfulRuns.length > 0
      ? successfulRuns.filter((result) => result.activated).length /
        successfulRuns.length
      : null;
  const passed =
    triggerRate !== null &&
    successfulRuns.length === trials.length &&
    (testCase.shouldTrigger
      ? triggerRate > threshold
      : triggerRate < threshold);

  return {
    id: testCase.id,
    query: testCase.query,
    shouldTrigger: testCase.shouldTrigger,
    runs: trials.length,
    triggerRate,
    threshold,
    passed,
  };
});
const passedCases = caseResults.filter((result) => result.passed).length;
const positive = results.filter((result) => result.shouldTrigger);
const negative = results.filter((result) => !result.shouldTrigger);
const summary = {
  skill: skillName,
  model,
  registeredSkills: registeredSkillRoots.map((path) => basename(path)),
  runsPerCase: runs,
  generatedAt: new Date().toISOString(),
  cases: cases.length,
  trials: results.length,
  passedCases,
  casePassRate: cases.length > 0 ? passedCases / cases.length : 0,
  threshold,
  positiveTriggerRate:
    positive.length > 0
      ? positive.filter((result) => result.activated).length /
        positive.length
      : null,
  negativeTriggerRate:
    negative.length > 0
      ? negative.filter((result) => result.activated).length /
        negative.length
      : null,
  totalTokens: results.reduce(
    (total, result) => total + result.totalTokens,
    0,
  ),
  totalSessionDurationMs: results.reduce(
    (total, result) => total + (result.sessionDurationMs ?? 0),
    0,
  ),
};
const report = { summary, caseResults, trials: results };

if (outputPath) {
  const resolvedOutput = resolve(outputPath);
  await mkdir(dirname(resolvedOutput), { recursive: true });
  await writeFile(resolvedOutput, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${resolvedOutput}`);
}

console.log(JSON.stringify(summary, null, 2));
process.exit(passedCases === cases.length ? 0 : 1);
