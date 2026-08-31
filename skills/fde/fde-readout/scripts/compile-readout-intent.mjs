#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const validator = resolve(scriptRoot, "validate-readout-plan.mjs");
const writingLint = resolve(scriptRoot, "lint-writing.mjs");

function fail(message, status = 1) {
  console.error(message);
  process.exit(status);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!["--source", "--authorization", "--intent", "--output"].includes(flag) || !value) {
      fail(
        "Usage: node scripts/compile-readout-intent.mjs --source <preflighted-source.json> --authorization <preflighted-auth.json> --intent <intent.json> --output <readout-plan.json>",
        2,
      );
    }
    if (parsed[flag]) fail(`Duplicate argument: ${flag}`, 2);
    parsed[flag] = value;
  }
  if (
    values.length !== 8 ||
    !["--source", "--authorization", "--intent", "--output"].every(
      (flag) => parsed[flag],
    )
  ) {
    fail(
      "Usage: node scripts/compile-readout-intent.mjs --source <preflighted-source.json> --authorization <preflighted-auth.json> --intent <intent.json> --output <readout-plan.json>",
      2,
    );
  }
  return parsed;
}

async function readJson(path, label) {
  try {
    const value = JSON.parse(await readFile(resolve(path), "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(`${label} must be a JSON object`);
    }
    return value;
  } catch (error) {
    fail(`Cannot read ${label}: ${error.message}`, 2);
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function recordsById(records, label) {
  if (!Array.isArray(records)) fail(`${label} must be an array`);
  const byId = new Map();
  for (const [index, record] of records.entries()) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      fail(`${label}[${index}] must be an object`);
    }
    if (!nonEmpty(record.id)) fail(`${label}[${index}].id must be a non-empty string`);
    if (byId.has(record.id)) fail(`${label} contains duplicate or conflicting ID: ${record.id}`);
    byId.set(record.id, record);
  }
  return byId;
}

function select(records, selectedIds, label) {
  if (!Array.isArray(selectedIds) || selectedIds.some((id) => !nonEmpty(id))) {
    fail(`${label} must be an array of non-empty IDs`);
  }
  if (new Set(selectedIds).size !== selectedIds.length) {
    fail(`${label} contains duplicate IDs`);
  }
  const selected = new Set(selectedIds);
  const byId = recordsById(records, label.replace("selected", "source "));
  for (const id of selected) {
    if (!byId.has(id)) fail(`${label} references missing ID: ${id}`);
  }
  return records
    .filter((record) => selected.has(record.id))
    .map((record) => ({
      ...structuredClone(record),
      sourceId: nonEmpty(record.sourceId) ? record.sourceId : record.id,
    }));
}

function withoutAuthorization(value) {
  const copy = structuredClone(value);
  delete copy.authorized;
  delete copy.evidenceIds;
  if (copy.styleReference) delete copy.styleReference.authorized;
  return copy;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function assertOutputBoundary(outputPath) {
  const workspace = await realpath(process.cwd());
  const output = resolve(outputPath);
  let parent;
  try {
    parent = await realpath(dirname(output));
  } catch (error) {
    fail(`Output parent must already exist: ${error.message}`, 2);
  }
  const pathFromWorkspace = relative(workspace, output);
  const parentFromWorkspace = relative(workspace, parent);
  if (
    pathFromWorkspace === "" ||
    pathFromWorkspace.startsWith("..") ||
    pathFromWorkspace.includes(":") ||
    parentFromWorkspace.startsWith("..") ||
    parentFromWorkspace.includes(":")
  ) {
    fail("Output must be a file inside the current workspace", 2);
  }
  try {
    const info = await lstat(output);
    if (info.isSymbolicLink() || !info.isFile()) {
      fail("Output must be a regular file inside the current workspace", 2);
    }
  } catch (error) {
    if (error.code !== "ENOENT") fail(`Cannot inspect output: ${error.message}`, 2);
  }
  return output;
}

function runGate(command, args, label) {
  const result = spawnSync(process.execPath, [command, ...args], {
    encoding: "utf8",
  });
  if (result.error) {
    return {
      message: `${label} could not run: ${result.error.message}`,
      status: 2,
    };
  }
  if (result.status !== 0) {
    const diagnostics = `${result.stdout}${result.stderr}`.trim();
    return { message: `${label} failed:\n${diagnostics}`, status: 1 };
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));
const [source, authorization, intent] = await Promise.all([
  readJson(args["--source"], "source"),
  readJson(args["--authorization"], "authorization"),
  readJson(args["--intent"], "intent"),
]);
const output = await assertOutputBoundary(args["--output"]);

if ("evidence" in intent || "humanContext" in intent) {
  fail("Intent cannot contain materialized evidence or humanContext");
}
if (!authorization.brandDefaults || typeof authorization.brandDefaults !== "object") {
  fail("authorization.brandDefaults must be an object");
}
if (!Array.isArray(authorization.evidence) || authorization.evidence.length === 0) {
  fail("authorization.evidence requires at least one record");
}
if (
  intent.brand?.authorized !== undefined ||
  intent.brand?.evidenceIds !== undefined ||
  intent.brand?.styleReference?.authorized !== undefined
) {
  fail("Intent cannot self-authorize branding");
}
if (
  intent.brand &&
  canonical(withoutAuthorization(intent.brand)) !==
    canonical(withoutAuthorization(authorization.brandDefaults))
) {
  fail("Intent brand settings do not match authorization.brandDefaults");
}

const evidence = select(
  source.evidence,
  intent.selectedEvidenceIds,
  "selectedEvidenceIds",
);
const humanContext = select(
  source.humanContext,
  intent.selectedHumanContextIds,
  "selectedHumanContextIds",
);
const sourceEvidenceById = recordsById(source.evidence, "source.evidence");
const sourceHumanById = recordsById(source.humanContext, "source.humanContext");
for (const id of sourceHumanById.keys()) {
  if (sourceEvidenceById.has(id)) fail(`Source evidence and humanContext conflict on ID: ${id}`);
}
const authorizationById = recordsById(
  authorization.evidence,
  "authorization.evidence",
);
if (
  !Array.isArray(authorization.brandDefaults.evidenceIds) ||
  authorization.brandDefaults.evidenceIds.length === 0
) {
  fail("authorization.brandDefaults.evidenceIds requires at least one ID");
}
if (
  new Set(authorization.brandDefaults.evidenceIds).size !==
  authorization.brandDefaults.evidenceIds.length
) {
  fail("authorization.brandDefaults.evidenceIds contains duplicate IDs");
}
const sourceIds = new Set([
  ...source.evidence.map((record) => record.id),
  ...source.humanContext.map((record) => record.id),
]);
for (const id of authorizationById.keys()) {
  if (sourceIds.has(id)) fail(`Authorization ID conflicts with source ID: ${id}`);
}
for (const id of authorization.brandDefaults.evidenceIds ?? []) {
  if (!authorizationById.has(id)) {
    fail(`authorization.brandDefaults.evidenceIds references missing ID: ${id}`);
  }
}

const authorizationEvidence = authorization.evidence.map((record) => ({
  ...structuredClone(record),
  sourceId: nonEmpty(record.sourceId) ? record.sourceId : record.id,
}));
const {
  selectedEvidenceIds,
  selectedHumanContextIds,
  brand: _intentBrand,
  ...planFields
} = intent;
const plan = {
  ...structuredClone(planFields),
  brand: structuredClone(authorization.brandDefaults),
  evidence: [...evidence, ...authorizationEvidence],
  humanContext,
};
const text = `${JSON.stringify(plan, null, 2)}\n`;
const temporary = resolve(dirname(output), `.${randomUUID()}.readout-plan.tmp.json`);

try {
  await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
  const gateFailures = [
    runGate(validator, [temporary], "ReadoutPlan validation"),
    runGate(writingLint, ["--profile", "report", temporary], "Writing lint"),
  ].filter(Boolean);
  if (gateFailures.length > 0) {
    const error = new Error(gateFailures.map(({ message }) => message).join("\n"));
    error.status = Math.max(...gateFailures.map(({ status }) => status));
    throw error;
  }
  await rename(temporary, output);
} catch (error) {
  await rm(temporary, { force: true });
  if (error?.code) fail(`Cannot write ReadoutPlan: ${error.message}`, 2);
  fail(error.message, error.status);
}

console.log(
  JSON.stringify({
    output,
    sha256: createHash("sha256").update(text).digest("hex"),
    selectedEvidenceIds,
    selectedHumanContextIds,
    authorizationEvidenceIds: authorization.evidence.map((record) => record.id),
  }),
);
