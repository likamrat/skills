#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const skillRoot = fileURLToPath(new URL("..", import.meta.url));
const helper = join(skillRoot, "scripts", "create-powerpoint-skeleton.ps1");
const plan = join(
  skillRoot,
  "assets",
  "examples",
  "lattice-harbor-readout-plan.json",
);
const failures = [];
const helperSource = await readFile(helper, "utf8");
const staticOnly = process.argv.slice(2).includes("--static-only");

for (const [name, pattern] of [
  ["PowerPoint HWND lookup", /\$powerPoint\.HWND/],
  ["HWND-to-PID lookup", /GetWindowThreadProcessId/],
  ["baseline PowerPoint PID capture", /Get-Process\s+-Name\s+POWERPNT/i],
  ["exclusive zero baseline", /\$baselinePowerPointIds\.Count -ne 0[\s\S]*zero process baseline/],
  ["process start-time identity", /\$powerPointProcessStart/],
  ["process path identity", /\$powerPointProcessPath/],
  ["optional ownership receipt", /\[string\]\$OwnershipReceipt/],
  ["atomic ownership receipt", /\[IO\.FileInfo\]::new\(\$temporaryPath\)\.MoveTo\(\$receiptPath\)/],
  ["ownership receipt owner", /fde-powerpoint-skeleton\/1\.0/],
  ["cross-process automation mutex", /FdeReadoutPowerPointAutomation/],
  ["exact PID cleanup", /Stop-Process\s+-Id\s+\$powerPointProcessId/i],
  ["cleanup result metadata", /powerPointCleanup/],
  ["dedicated worker exit", /\[Environment\]::Exit\(/],
]) {
  if (!pattern.test(helperSource)) {
    failures.push(`helper omits ${name}`);
  }

  const presentationOpenIndex = helperSource.indexOf(
    "$presentation = $powerPoint.Presentations.Open",
  );
  const ownershipReceiptIndex = helperSource.lastIndexOf(
    "Write-OwnershipReceipt",
    presentationOpenIndex,
  );
  if (
    ownershipReceiptIndex < 0 ||
    ownershipReceiptIndex > presentationOpenIndex ||
    ownershipReceiptIndex <
      helperSource.indexOf("$powerPointProcessPath = $resolvedProcess.Path")
  ) {
    failures.push(
      "helper must validate exact process path and persist ownership before opening the presentation",
    );
  }
}

if (
  helperSource.indexOf("FdeReadoutPowerPointAutomation") >
  helperSource.indexOf("Copy-Item -LiteralPath $seedPath")
) {
  failures.push("helper must acquire its automation mutex before copying output");
}

for (const [name, pattern] of [
  ["name-based process termination", /Stop-Process\s+-Name\b/i],
  [
    "root PowerPoint COM release",
    /(?:Final)?ReleaseComObject\s*\(\s*\$powerPoint\s*\)/i,
  ],
  ["pending-finalizer wait", /WaitForPendingFinalizers/i],
]) {
  if (pattern.test(helperSource)) {
    failures.push(`helper still uses forbidden ${name}`);
  }
}

const powershellProbe = spawnSync(
  "powershell",
  ["-NoProfile", "-Command", "exit 0"],
  { encoding: "utf8" },
);

if (powershellProbe.error?.code === "ENOENT") {
  if (failures.length > 0) {
    console.error("PowerPoint skeleton static tests failed:");
    failures.forEach((failure, index) =>
      console.error(`${index + 1}. ${failure}`),
    );
    process.exit(1);
  }
  console.log("Windows PowerShell unavailable; PowerPoint skeleton tests skipped.");
  process.exit(0);
}

const temp = await mkdtemp(join(tmpdir(), "fde-readout-pptx-"));

function run(args, planPath = plan) {
  return spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helper,
      "-Plan",
      planPath,
      ...args,
    ],
    { encoding: "utf8" },
  );
}

function isPowerPointPidRunning(processId) {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$process = Get-Process -Id ${processId} -ErrorAction SilentlyContinue; if ($null -ne $process) { $process.ProcessName }; exit 0`,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `could not inspect PowerPoint PID ${processId}: ${result.stderr}`,
    );
  }

  return result.stdout.trim().toUpperCase() === "POWERPNT";
}

async function runWithExactCleanup(name, args, planPath = plan) {
  const result = run(args, planPath);
  let payload = null;

  if (result.status === 0) {
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      failures.push(`${name} did not return valid JSON: ${result.stdout}`);
      return { payload, result };
    }

    const cleanup = payload.powerPointCleanup;
    const ownedProcessId = cleanup?.ownedProcessId;
    if (
      !Number.isInteger(ownedProcessId) ||
      ownedProcessId <= 0 ||
      cleanup.exited !== true ||
      !["graceful", "forced"].includes(cleanup.mode) ||
      cleanup.graceSeconds !== 5
    ) {
      failures.push(
        `${name} returned invalid PowerPoint cleanup metadata: ${JSON.stringify(cleanup)}`,
      );
    } else {
      await delay(1000);
      if (isPowerPointPidRunning(ownedProcessId)) {
        failures.push(
          `${name} left its exact owned POWERPNT PID ${ownedProcessId} running`,
        );
      }
    }
  }

  return { payload, result };
}

function expectFailure(name, slideIds, pattern) {
  const result = run([
    "-Output",
    join(temp, `${name}.pptx`),
    "-SmokeSlideIds",
    slideIds.join(","),
  ]);
  const output = `${result.stdout}${result.stderr}`;
  if (result.status === 0 || !pattern.test(output)) {
    failures.push(`${name} did not fail with ${pattern}: ${output}`);
  }
}

try {
  expectFailure(
    "missing-count",
    ["cover", "pilot-decision"],
    /exactly 3 slide IDs/,
  );
  expectFailure(
    "duplicate",
    ["cover", "pilot-decision", "cover"],
    /3 unique slide IDs/,
  );
  expectFailure(
    "missing-id",
    ["cover", "pilot-decision", "not-in-plan"],
    /does not exist in the full plan/,
  );
  expectFailure(
    "wrong-cover",
    ["customer-profile", "fictional-baseline", "current-workflow"],
    /first cover slide ID/,
  );
  expectFailure(
    "wrong-decision",
    ["cover", "fictional-baseline", "current-workflow"],
    /second decision slide ID/,
  );

  const availability = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "[bool][type]::GetTypeFromProgID('PowerPoint.Application')",
    ],
    { encoding: "utf8" },
  );
  const hasPowerPoint =
    !staticOnly &&
    availability.status === 0 &&
    availability.stdout.trim() === "True";

  if (hasPowerPoint) {
    const planBytes = await readFile(plan);
    const planSha256 = createHash("sha256").update(planBytes).digest("hex");
    const { payload: full, result: fullResult } = await runWithExactCleanup(
      "full-plan skeleton",
      ["-Output", join(temp, "full.pptx")],
    );
    if (fullResult.status !== 0) {
      failures.push(`full-plan skeleton failed: ${fullResult.stderr}`);
    } else if (full !== null) {
      if (
        full.selectionMode !== "full" ||
        full.slides !== 11 ||
        full.selectedSlideIds.length !== 11 ||
        full.sourcePlanSha256 !== planSha256
      ) {
        failures.push("omitted SmokeSlideIds did not preserve full-plan behavior");
      }
    }

    for (let invocation = 1; invocation <= 2; invocation++) {
      const { payload: smoke, result: smokeResult } = await runWithExactCleanup(
        `valid smoke skeleton ${invocation}`,
        [
          "-Output",
          join(temp, `smoke-${invocation}.pptx`),
          "-SmokeSlideIds",
          "pilot-risks,pilot-decision,cover",
        ],
      );
      if (smokeResult.status !== 0) {
        failures.push(
          `valid smoke skeleton ${invocation} failed: ${smokeResult.stderr}`,
        );
      } else if (smoke !== null) {
        const expectedIds = ["cover", "pilot-decision", "pilot-risks"];
        const expectedFamilies = ["cover", "decision", "risks"];
        if (
          smoke.selectionMode !== "smoke" ||
          smoke.slides !== 3 ||
          smoke.verifiedNotes !== 3 ||
          smoke.packageSlides !== 3 ||
          smoke.packageNotesParts !== 3 ||
          smoke.uniqueNotesRelationships !== 3 ||
          smoke.macroFree !== true ||
          smoke.sourcePlanSha256 !== planSha256 ||
          JSON.stringify(smoke.selectedSlideIds) !==
            JSON.stringify(expectedIds) ||
          JSON.stringify(smoke.selectedSlideFamilies) !==
            JSON.stringify(expectedFamilies)
        ) {
          failures.push(
            `valid smoke skeleton ${invocation} did not preserve order and package bindings: ${smokeResult.stdout}`,
          );
        }
      }
    }

    const failurePlan = JSON.parse(planBytes.toString("utf8"));
    delete failurePlan.slides[0].notes;
    const failurePlanPath = join(temp, "missing-notes-plan.json");
    await writeFile(failurePlanPath, JSON.stringify(failurePlan), "utf8");
    const failureResult = run(
      ["-Output", join(temp, "post-com-failure.pptx")],
      failurePlanPath,
    );
    const failureCleanup = failureResult.stderr.match(
      /PowerPoint cleanup: PID (\d+) exited via (?:graceful|forced)\./,
    );
    if (
      failureResult.status === 0 ||
      failureResult.stdout.trim() !== "" ||
      !/PowerPoint skeleton creation failed:/.test(failureResult.stderr) ||
      failureCleanup === null
    ) {
      failures.push(
        `post-COM error did not fail without success JSON: ${failureResult.stdout}${failureResult.stderr}`,
      );
    } else {
      const failureProcessId = Number.parseInt(failureCleanup[1], 10);
      await delay(1000);
      if (isPowerPointPidRunning(failureProcessId)) {
        failures.push(
          `post-COM failure left its exact owned POWERPNT PID ${failureProcessId} running`,
        );
      }
    }
  } else {
    console.log("PowerPoint unavailable; native full and smoke skeleton checks skipped.");
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("PowerPoint skeleton tests failed:");
  failures.forEach((failure, index) =>
    console.error(`${index + 1}. ${failure}`),
  );
  process.exit(1);
}

console.log("PowerPoint skeleton tests passed.");
