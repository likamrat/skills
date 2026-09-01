#!/usr/bin/env node

// CLI: node validate-powerpoint-smoke-approval.mjs --approval <json> --plan <json> --smoke-report <json>
//
// Validates a smoke approval record against the raw bytes of the plan and
// smoke report it references. Prints compact JSON on success, numbered
// errors to stderr on failure, and never prints a success-shaped payload
// alongside failures.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateSmokeApproval } from "./powerpoint-smoke-contract.mjs";

function parseArgs(argv) {
  const args = { approval: undefined, plan: undefined, smokeReport: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--approval") {
      args.approval = value;
      index += 1;
    } else if (flag === "--plan") {
      args.plan = value;
      index += 1;
    } else if (flag === "--smoke-report") {
      args.smokeReport = value;
      index += 1;
    } else if (flag === "--help") {
      args.help = true;
    }
  }
  return args;
}

function usage() {
  console.log(
    "Usage: node validate-powerpoint-smoke-approval.mjs --approval <json> --plan <json> --smoke-report <json>",
  );
}

function fail(errors) {
  console.error("PowerPoint smoke approval validation failed:");
  errors.forEach((error, index) => console.error(`${index + 1}. ${error}`));
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  usage();
  process.exit(0);
}

if (!args.approval || !args.plan || !args.smokeReport) {
  usage();
  process.exit(2);
}

const errors = [];
let approvalBytes;
let planBytes;
let reportBytes;

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

if (errors.length > 0) fail(errors);

let approval;
try {
  approval = JSON.parse(approvalBytes.toString("utf8"));
} catch (error) {
  fail([`approval file is not valid JSON: ${error.message}`]);
}

const result = validateSmokeApproval({ planBytes, reportBytes, approval });

if (result.errors.length > 0) fail(result.errors);

console.log(
  JSON.stringify({
    status: result.status,
    approver: result.approver,
    approvedAt: result.approvedAt,
    hashes: result.hashes,
    selectedSlideIds: result.selectedSlideIds,
    densestSlideId: result.densestSlideId,
  }),
);
