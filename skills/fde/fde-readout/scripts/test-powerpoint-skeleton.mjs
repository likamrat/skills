#!/usr/bin/env node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
const powershellProbe = spawnSync(
  "powershell",
  ["-NoProfile", "-Command", "exit 0"],
  { encoding: "utf8" },
);

if (powershellProbe.error?.code === "ENOENT") {
  console.log("Windows PowerShell unavailable; PowerPoint skeleton tests skipped.");
  process.exit(0);
}

const temp = await mkdtemp(join(tmpdir(), "fde-readout-pptx-"));

function run(args) {
  return spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helper,
      "-Plan",
      plan,
      ...args,
    ],
    { encoding: "utf8" },
  );
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
    availability.status === 0 && availability.stdout.trim() === "True";

  if (hasPowerPoint) {
    const planBytes = await readFile(plan);
    const planSha256 = createHash("sha256").update(planBytes).digest("hex");
    const fullResult = run(["-Output", join(temp, "full.pptx")]);
    if (fullResult.status !== 0) {
      failures.push(`full-plan skeleton failed: ${fullResult.stderr}`);
    } else {
      const full = JSON.parse(fullResult.stdout);
      if (
        full.selectionMode !== "full" ||
        full.slides !== 11 ||
        full.selectedSlideIds.length !== 11 ||
        full.sourcePlanSha256 !== planSha256
      ) {
        failures.push("omitted SmokeSlideIds did not preserve full-plan behavior");
      }
    }

    const smokeResult = run([
      "-Output",
      join(temp, "smoke.pptx"),
      "-SmokeSlideIds",
      "pilot-risks,pilot-decision,cover",
    ]);
    if (smokeResult.status !== 0) {
      failures.push(`valid smoke skeleton failed: ${smokeResult.stderr}`);
    } else {
      const smoke = JSON.parse(smokeResult.stdout);
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
        JSON.stringify(smoke.selectedSlideIds) !== JSON.stringify(expectedIds) ||
        JSON.stringify(smoke.selectedSlideFamilies) !==
          JSON.stringify(expectedFamilies)
      ) {
        failures.push(
          `valid smoke skeleton did not preserve order and package bindings: ${smokeResult.stdout}`,
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
