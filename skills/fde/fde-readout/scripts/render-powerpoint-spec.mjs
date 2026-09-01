#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compileReadoutPlan,
  stableSerialize,
  validateDrawingSpec,
} from "./powerpoint-layout.mjs";

const usage =
  "Usage: node scripts/render-powerpoint-spec.mjs --plan <json> --mode <smoke|full> --output <json>";
const args = process.argv.slice(2);
const errors = [];

function argumentError(message) {
  errors.push(message);
}

function printErrors(items) {
  items.forEach((message, index) => console.error(`${index + 1}. ${message}`));
}

if (args.length === 1 && args[0] === "--help") {
  console.log(usage);
  process.exit(0);
}

const values = {};
const allowed = new Set(["--plan", "--mode", "--output"]);
for (let index = 0; index < args.length; index += 1) {
  const flag = args[index];
  if (!allowed.has(flag)) {
    argumentError(`unknown argument: ${flag}`);
    continue;
  }
  if (Object.hasOwn(values, flag)) argumentError(`duplicate argument: ${flag}`);
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    argumentError(`missing value for ${flag}`);
    continue;
  }
  values[flag] = value;
  index += 1;
}
for (const flag of allowed) {
  if (!Object.hasOwn(values, flag)) argumentError(`missing required argument: ${flag}`);
}
if (values["--mode"] && !["smoke", "full"].includes(values["--mode"])) {
  argumentError("--mode must be smoke or full");
}
if (errors.length > 0) {
  printErrors(errors);
  process.exit(2);
}

const planPath = resolve(values["--plan"]);
const outputPath = resolve(values["--output"]);
let tempPath;
let validationTempPath;

try {
  const canonicalPlanPath = await realpath(planPath);
  let canonicalOutputPath;
  try {
    canonicalOutputPath = await realpath(outputPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    canonicalOutputPath = join(await realpath(dirname(outputPath)), basename(outputPath));
  }
  const foldPath = (path) => (process.platform === "win32" ? path.toLowerCase() : path);
  if (foldPath(canonicalPlanPath) === foldPath(canonicalOutputPath)) {
    throw Object.assign(new Error("--output must not refer to --plan"), {
      exitCode: 2,
    });
  }
  const rawPlan = await readFile(planPath);
  validationTempPath = resolve(
    dirname(planPath),
    `.${randomUUID()}.${process.pid}.readout-plan.tmp.json`,
  );
  await writeFile(validationTempPath, rawPlan, { flag: "wx" });
  const validatorPath = fileURLToPath(
    new URL("./validate-readout-plan.mjs", import.meta.url),
  );
  const validation = spawnSync(process.execPath, [validatorPath, validationTempPath], {
    encoding: "utf8",
  });
  await rm(validationTempPath, { force: true });
  validationTempPath = undefined;
  if (validation.status !== 0) {
    const detail = `${validation.stderr ?? ""}${validation.stdout ?? ""}`.trim();
    throw Object.assign(new Error(detail || "ReadoutPlan validation failed"), {
      exitCode: validation.status === 2 ? 2 : 1,
    });
  }

  let plan;
  try {
    plan = JSON.parse(rawPlan.toString("utf8"));
  } catch (error) {
    throw Object.assign(new Error(`invalid plan JSON: ${error.message}`), {
      exitCode: 2,
    });
  }
  const sourcePlanSha256 = createHash("sha256").update(rawPlan).digest("hex");
  const spec = compileReadoutPlan(plan, {
    sourcePlanSha256,
    mode: values["--mode"],
  });
  validateDrawingSpec(spec);
  const bytes = Buffer.from(stableSerialize(spec), "utf8");
  tempPath = resolve(
    dirname(outputPath),
    `.${randomUUID()}.${process.pid}.powerpoint-spec.tmp`,
  );
  await writeFile(tempPath, bytes, { flag: "wx" });
  await rename(tempPath, outputPath);
  tempPath = undefined;
  const primitiveCount = spec.slides.reduce(
    (total, slide) => total + slide.primitives.length,
    0,
  );
  console.log(
    JSON.stringify({
      status: "PASS",
      mode: values["--mode"],
      sourcePlanSha256,
      selectedSlideIds: spec.selectedSlideIds,
      selectedSlideFamilies: spec.selectedSlideFamilies,
      outputPath,
      outputSha256: createHash("sha256").update(bytes).digest("hex"),
      primitiveCount,
    }),
  );
} catch (error) {
  if (tempPath) await rm(tempPath, { force: true }).catch(() => {});
  if (validationTempPath) await rm(validationTempPath, { force: true }).catch(() => {});
  console.error(`1. ${error.code ? `${error.code}: ` : ""}${error.message}`);
  process.exit(error.exitCode ?? (error.code === "ENOENT" ? 2 : 1));
}
