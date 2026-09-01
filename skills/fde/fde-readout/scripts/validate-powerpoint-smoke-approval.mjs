#!/usr/bin/env node

// CLI: node validate-powerpoint-smoke-approval.mjs --approval <json> --plan <json> --smoke-report <json> --trusted-keyring <json>
//
// Validates a smoke approval record against the raw bytes of the plan and
// smoke report it references. Prints compact JSON on success, numbered
// errors to stderr on failure, and never prints a success-shaped payload
// alongside failures.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateSmokeApproval } from "./powerpoint-smoke-contract.mjs";

function parseArgs(argv) {
  const args = {
    approval: undefined,
    plan: undefined,
    smokeReport: undefined,
    trustedKeyring: undefined,
  };
  const errors = [];
  const flags = new Map([
    ["--approval", "approval"],
    ["--plan", "plan"],
    ["--smoke-report", "smokeReport"],
    ["--trusted-keyring", "trustedKeyring"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") {
      args.help = true;
      continue;
    }
    const key = flags.get(flag);
    if (!key) {
      errors.push(`unknown argument: ${flag}`);
      continue;
    }
    if (args[key] !== undefined) {
      errors.push(`duplicate argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      errors.push(`missing value for ${flag}`);
      continue;
    }
    args[key] = value;
    index += 1;
  }
  if (args.help && argv.length !== 1) {
    errors.push("--help must be used alone");
  }
  if (!args.help) {
    for (const [flag, key] of flags) {
      if (args[key] === undefined) errors.push(`missing required argument: ${flag}`);
    }
  }
  return { args, errors };
}

function usage() {
  console.log(
    "Usage: node validate-powerpoint-smoke-approval.mjs --approval <json> --plan <json> --smoke-report <json> --trusted-keyring <json>",
  );
}

function fail(errors) {
  console.error("PowerPoint smoke approval validation failed:");
  errors.forEach((error, index) => console.error(`${index + 1}. ${error}`));
  process.exit(1);
}

const parsedArgs = parseArgs(process.argv.slice(2));
const { args } = parsedArgs;

if (parsedArgs.errors.length > 0) {
  fail(parsedArgs.errors);
}
if (args.help) {
  usage();
  process.exit(0);
}

const errors = [];
let approvalBytes;
let planBytes;
let reportBytes;
let trustedKeyringBytes;

try {
  approvalBytes = await readFile(resolve(args.approval));
} catch (error) {
  errors.push(`could not read approval file: ${error.message}`);
}
try {
  planBytes = await readFile(resolve(args.plan));
} catch (error) {
  errors.push(`could not read plan file: ${error.message}`);
}
try {
  reportBytes = await readFile(resolve(args.smokeReport));
} catch (error) {
  errors.push(`could not read smoke report file: ${error.message}`);
}
try {
  trustedKeyringBytes = await readFile(resolve(args.trustedKeyring));
} catch (error) {
  errors.push(`could not read trusted keyring file: ${error.message}`);
}

if (errors.length > 0) fail(errors);

let approval;
let trustedKeyring;
try {
  approval = JSON.parse(approvalBytes.toString("utf8"));
} catch (error) {
  fail([`approval file is not valid JSON: ${error.message}`]);
}
try {
  trustedKeyring = JSON.parse(trustedKeyringBytes.toString("utf8"));
} catch (error) {
  fail([`trusted keyring file is not valid JSON: ${error.message}`]);
}

const result = validateSmokeApproval({ planBytes, reportBytes, approval, trustedKeyring });

if (result.errors.length > 0) fail(result.errors);

console.log(
  JSON.stringify({
    status: result.status,
    authenticated: result.authenticated,
    attestation: result.attestation,
    approver: result.approver,
    approvedAt: result.approvedAt,
    hashes: result.hashes,
    selectedSlideIds: result.selectedSlideIds,
    densestSlideId: result.densestSlideId,
  }),
);
