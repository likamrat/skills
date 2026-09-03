#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32 as windowsPath,
} from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  stableSerialize,
  validateDrawingSpec,
} from "./powerpoint-layout.mjs";
import {
  canonicalizeJson,
  densityScore,
  PRODUCTION_COORDINATOR_ID,
  selectSmokeSlides,
  validateSmokeReport,
} from "./powerpoint-smoke-contract.mjs";

const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const SPEC_COMPILER = join(scriptDirectory, "render-powerpoint-spec.mjs");
const SKELETON_HELPER = join(scriptDirectory, "create-powerpoint-skeleton.ps1");
const WORKER = join(scriptDirectory, "render-powerpoint-worker.ps1");
const OWNED_PROCESS_WATCHDOG = join(
  scriptDirectory,
  "powerpoint-owned-process-watchdog.ps1",
);
const PACKAGE_QA = join(scriptDirectory, "pptx-package-qa.mjs");
const TRUSTED_WINDOWS_ROOT = String.raw`C:\Windows`;
const TEST_COORDINATOR_ID = "fde-powerpoint-native-coordinator/test-only";
const WORKER_ID = "fde-powerpoint-native-shapes/2.0";
const CONNECTOR_COST_STATUS = "not-declared-by-fde-drawing-spec/1.0";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const RETAINED_ENVIRONMENT_KEYS = Object.freeze([
  "APPDATA",
  "COMPUTERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "TEMP",
  "TMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
]);
const USAGE = [
  "Usage: node powerpoint-native-coordinator.mjs --mode smoke --plan <plan> --output <new-dir> [--diagnostic-output <new-dir>]",
  "       node powerpoint-native-coordinator.mjs --mode full --plan <plan> --smoke-bundle <dir> --approve-smoke --output <new-dir> [--diagnostic-output <new-dir>]",
].join("\n");

const SPEC_REPORT_KEYS = [
  "mode",
  "outputPath",
  "outputSha256",
  "primitiveCount",
  "selectedSlideFamilies",
  "selectedSlideIds",
  "sourcePlanSha256",
  "status",
];
const SKELETON_REPORT_KEYS = [
  "heightPoints",
  "macroFree",
  "output",
  "packageNotesParts",
  "packageSlides",
  "powerPointCleanup",
  "selectionMode",
  "selectedSlideFamilies",
  "selectedSlideIds",
  "sha256",
  "slides",
  "sourcePlanSha256",
  "uniqueNotesRelationships",
  "verifiedNotes",
  "widthPoints",
];
const WORKER_REPORT_KEYS = [
  "cleanup",
  "connectors",
  "contactSheet",
  "contactSheetSha256",
  "elapsedMilliseconds",
  "nativeShapes",
  "presentation",
  "presentationSha256",
  "renderDirectory",
  "report",
  "selectedSlideFamilies",
  "selectedSlideIds",
  "skeleton",
  "skeletonSha256",
  "slides",
  "spec",
  "specSha256",
  "stagingEvidence",
  "status",
  "worker",
];
const WORKER_SLIDE_KEYS = [
  "backgroundColorRole",
  "connectorCostStatus",
  "connectorPointSequenceSha256",
  "connectorPrimitiveSha256",
  "connectorRouteCount",
  "connectorRouteMetadataSha256",
  "connectorSegmentCount",
  "family",
  "id",
  "index",
  "nativeChartShapeCount",
  "nativeChartShapeNamesSha256",
  "nativeTableCellCount",
  "nativeTableCount",
  "notesSha256",
  "overflow",
  "primitiveCount",
  "primitiveSha256",
  "recursiveShapeContentSha256",
  "recursiveShapeCount",
  "recursiveShapeGeometrySha256",
  "recursiveShapeNamesSha256",
  "recursiveShapeStyleSha256",
  "render",
  "renderSha256",
  "shapeCount",
  "shapeNamesSha256",
];
const PACKAGE_QA_KEYS = [
  "counts",
  "findings",
  "package",
  "parts",
  "schemaVersion",
  "slides",
  "valid",
];
const UNSUPPORTED_PART_PATTERN =
  /(^|\/)(?:activex|charts|embeddings|externallinks|media)(?:\/|$)|(?:oleobject|vbaproject)/i;

export class CoordinatorError extends Error {
  constructor(code, message, { stage = "coordinator", details } = {}) {
    super(message);
    this.name = "CoordinatorError";
    this.code = code;
    this.stage = stage;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, options) {
  throw new CoordinatorError(code, message, options);
}

function assert(condition, code, message, options) {
  if (!condition) fail(code, message, options);
}

function failureRequiresEvidencePreservation(error) {
  if (!(error instanceof CoordinatorError)) return false;
  const details = isPlainObject(error.details) ? error.details : {};
  return (
    error.code === "CLEANUP_INVALID" ||
    details.contaminationRisk === true ||
    details.childExited === false ||
    ["ambiguous", "cleanup-failed"].includes(details.ownershipStatus)
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys, label, stage) {
  assert(isPlainObject(value), "REPORT_SCHEMA_INVALID", `${label} must be a plain object`, {
    stage,
  });
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert(
    isDeepStrictEqual(actual, expected),
    "REPORT_SCHEMA_INVALID",
    `${label} keys must equal ${expected.join(", ")}`,
    { stage, details: { actual, expected } },
  );
}

function assertHash(value, label, stage) {
  assert(
    typeof value === "string" && HASH_PATTERN.test(value),
    "HASH_INVALID",
    `${label} must be a lowercase SHA-256`,
    { stage },
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${canonicalizeJson(value)}\n`, "utf8");
}

function parseJson(bytes, label, stage) {
  try {
    const value = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes);
    assert(isPlainObject(value), "JSON_INVALID", `${label} must contain a JSON object`, {
      stage,
    });
    return value;
  } catch (error) {
    if (error instanceof CoordinatorError) throw error;
    fail("JSON_INVALID", `${label} is not valid JSON: ${error.message}`, { stage });
  }
}

function arraysEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right) && isDeepStrictEqual(left, right);
}

function nativeNotesText(value) {
  return String(value).replace(/\r\n|\n/g, "\r");
}

function integerAtLeast(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function normalizedPath(path) {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function environmentValue(environment, name) {
  const key = Object.keys(environment).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key === undefined ? undefined : environment[key];
}

function trustedPowerShellCandidate() {
  return windowsPath.join(
    TRUSTED_WINDOWS_ROOT,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function sanitizedChildEnvironment(
  environment = process.env,
  powerShellPath = trustedPowerShellCandidate(),
) {
  const systemRoot = TRUSTED_WINDOWS_ROOT;
  const sanitized = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
  };
  for (const key of RETAINED_ENVIRONMENT_KEYS) {
    const value = environmentValue(environment, key);
    if (typeof value === "string" && value.length > 0) sanitized[key] = value;
  }
  const trustedPath = [
    windowsPath.join(systemRoot, "System32"),
    systemRoot,
    windowsPath.dirname(powerShellPath),
    dirname(process.execPath),
  ];
  sanitized.PATH = [...new Map(
    trustedPath.map((entry) => [entry.toLowerCase(), entry]),
  ).values()].join(";");
  return Object.freeze(sanitized);
}

async function resolveTrustedWindowsPowerShell() {
  const candidate = trustedPowerShellCandidate();
  let facts;
  let canonical;
  try {
    facts = await lstat(candidate);
    canonical = await realpath(candidate);
  } catch (error) {
    fail(
      "TRUSTED_POWERSHELL_INVALID",
      `trusted Windows PowerShell could not be resolved: ${error.message}`,
      { stage: "trusted-runtime", details: { path: candidate } },
    );
  }
  assert(
    facts.isFile() &&
      !facts.isSymbolicLink() &&
      windowsPath.normalize(canonical).toLowerCase() ===
        windowsPath.normalize(candidate).toLowerCase(),
    "TRUSTED_POWERSHELL_INVALID",
    "trusted Windows PowerShell must be the exact non-reparse System32 executable",
    { stage: "trusted-runtime", details: { path: candidate, canonical } },
  );
  return canonical;
}

function pathsEqual(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function pathContains(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

async function existingPath(path, label, expectedType) {
  let canonical;
  try {
    canonical = await realpath(resolve(path));
  } catch (error) {
    fail("INPUT_NOT_FOUND", `${label} could not be resolved: ${error.message}`, {
      stage: "inputs",
    });
  }
  const facts = await stat(canonical);
  assert(
    expectedType === "file" ? facts.isFile() : facts.isDirectory(),
    "INPUT_TYPE_INVALID",
    `${label} must be a ${expectedType}`,
    { stage: "inputs" },
  );
  return canonical;
}

async function newDirectoryPath(path, label) {
  const absolute = resolve(path);
  let canonicalParent;
  try {
    canonicalParent = await realpath(dirname(absolute));
  } catch (error) {
    fail("OUTPUT_PARENT_INVALID", `${label} parent could not be resolved: ${error.message}`, {
      stage: "inputs",
    });
  }
  assert(
    (await stat(canonicalParent)).isDirectory(),
    "OUTPUT_PARENT_INVALID",
    `${label} parent must be a directory`,
    { stage: "inputs" },
  );
  try {
    await lstat(absolute);
    fail("OUTPUT_EXISTS", `${label} already exists`, { stage: "inputs" });
  } catch (error) {
    if (error instanceof CoordinatorError) throw error;
    if (error.code !== "ENOENT") throw error;
  }
  return join(canonicalParent, basename(absolute));
}

async function assertPathAbsent(path, label, stage) {
  try {
    await lstat(path);
    fail("OUTPUT_EXISTS", `${label} already exists`, { stage });
  } catch (error) {
    if (error instanceof CoordinatorError) throw error;
    if (error.code !== "ENOENT") throw error;
  }
}

async function removeDirectoryWithRetry(path) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      try {
        await lstat(path);
        throw new Error("directory still exists after recursive removal");
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(attempt * 100);
    }
  }
  throw lastError;
}

async function relativeFiles(root) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const facts = await lstat(path);
      assert(!facts.isSymbolicLink(), "PATH_ALIAS_INVALID", "bundle must not contain symlinks", {
        stage: "artifacts",
        details: { path: relative(root, path).split(sep).join("/") },
      });
      if (facts.isDirectory()) await walk(path);
      else if (facts.isFile()) files.push(relative(root, path).split(sep).join("/"));
      else {
        fail("ARTIFACT_TYPE_INVALID", "bundle contains an unsupported filesystem entry", {
          stage: "artifacts",
          details: { path: relative(root, path).split(sep).join("/") },
        });
      }
    }
  }
  await walk(root);
  return files.sort();
}

async function snapshotFiles(root, expectedFiles) {
  const actual = await relativeFiles(root);
  assert(
    isDeepStrictEqual(actual, [...expectedFiles].sort()),
    "BUNDLE_FILES_INVALID",
    "bundle file set does not match the coordinator contract",
    { stage: "smoke-bundle", details: { actual, expected: [...expectedFiles].sort() } },
  );
  const hashes = {};
  for (const file of actual) hashes[file] = sha256(await readFile(join(root, file)));
  return hashes;
}

async function snapshotBundle(root) {
  const paths = await relativeFiles(root);
  const files = [];
  for (const path of paths) {
    const bytes = await readFile(join(root, path));
    files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return { fileCount: files.length, files };
}

function assertSnapshotEqual(actual, expected, stage, message) {
  assert(isDeepStrictEqual(actual, expected), "PUBLICATION_MUTATED", message, {
    stage,
    details: { actual, expected },
  });
}

function assertPublicationPayloadMatchesReceipts(report, payload) {
  const stage = "publication";
  const artifacts = [
    report.artifacts.presentation,
    report.artifacts.contactSheet,
    report.artifacts.workerReport,
    report.artifacts.packageQa,
    ...(report.artifacts.smokeReport ? [report.artifacts.smokeReport] : []),
    ...report.artifacts.renders,
  ];
  const payloadByPath = new Map(
    payload.files.map((file) => [file.path, file]),
  );
  assert(
    payloadByPath.size === payload.files.length &&
      artifacts.length === payload.files.length,
    "PUBLICATION_RECEIPT_MISMATCH",
    "publication payload is not covered exactly once by verified receipts",
    { stage },
  );
  for (const artifact of artifacts) {
    assert(
      isPlainObject(artifact) &&
        typeof artifact.path === "string" &&
        HASH_PATTERN.test(artifact.sha256) &&
        payloadByPath.get(artifact.path)?.sha256 === artifact.sha256,
      "PUBLICATION_RECEIPT_MISMATCH",
      "publication payload bytes differ from a verified artifact receipt",
      { stage, details: { path: artifact?.path ?? null } },
    );
    payloadByPath.delete(artifact.path);
  }
  assert(
    payloadByPath.size === 0,
    "PUBLICATION_RECEIPT_MISMATCH",
    "publication payload contains an artifact without a verified receipt",
    { stage, details: { paths: [...payloadByPath.keys()].sort() } },
  );
}

async function assertSnapshotUnchanged(root, expectedFiles, hashes, stage = "inputs") {
  const current = await snapshotFiles(root, expectedFiles);
  assert(
    isDeepStrictEqual(current, hashes),
    "INPUT_MUTATED",
    "an input bundle changed while the coordinator was running",
    { stage },
  );
}

async function assertFileUnchanged(path, expectedHash, label, stage) {
  const actualHash = sha256(await readFile(path));
  assert(actualHash === expectedHash, "INPUT_MUTATED", `${label} changed while in use`, {
    stage,
    details: { expectedHash, actualHash },
  });
}

function trimmedEvidence(value) {
  const text = String(value ?? "");
  return text.length <= 16_384 ? text : `${text.slice(0, 16_384)}...[truncated]`;
}

function validateOwnershipReceipt(receipt, request) {
  exactKeys(
    receipt,
    [
      "owner",
      "processId",
      "processPath",
      "processStartTimeUtc",
      "schemaVersion",
      "status",
    ],
    "PowerPoint ownership receipt",
    request.name,
  );
  assert(
    receipt.schemaVersion === 1 &&
      receipt.owner === request.expectedOwnershipOwner &&
      receipt.status === "owned" &&
      integerAtLeast(receipt.processId, 1) &&
      typeof receipt.processPath === "string" &&
      /^POWERPNT\.EXE$/i.test(windowsPath.basename(receipt.processPath)) &&
      typeof receipt.processStartTimeUtc === "string" &&
      Number.isFinite(Date.parse(receipt.processStartTimeUtc)),
    "OWNERSHIP_RECEIPT_INVALID",
    `${request.name} wrote an invalid PowerPoint ownership receipt`,
    {
      stage: request.name,
      details: { ownershipReceiptPath: request.ownershipReceiptPath },
    },
  );
  return receipt;
}

async function readOwnershipReceipt(request) {
  try {
    const receipt = parseJson(
      await readFile(request.ownershipReceiptPath),
      "PowerPoint ownership receipt",
      request.name,
    );
    return validateOwnershipReceipt(receipt, request);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new CoordinatorError(
        "OWNERSHIP_RECEIPT_ABSENT",
        `${request.name} timed out before exact PowerPoint ownership was recorded`,
        {
          stage: request.name,
          details: { ownershipReceiptPath: request.ownershipReceiptPath },
        },
      );
    }
    throw error;
  }
}

async function cleanupOwnedPowerPoint(receipt, request) {
  const result = await runChildWithWatchdog(
    {
      name: `${request.name}-owned-process-watchdog`,
      command: request.command,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        OWNED_PROCESS_WATCHDOG,
        "-ProcessId",
        String(receipt.processId),
        "-ProcessStartTimeUtc",
        receipt.processStartTimeUtc,
        "-ProcessPath",
        receipt.processPath,
        "-Owner",
        receipt.owner,
      ],
      cwd: request.cwd,
      env: request.env,
      cleanupSensitive: false,
      timeoutMilliseconds: 30_000,
    },
    { spawnChild: spawn, cleanupOwnedProcess: null },
  );
  assert(
    result.exitCode === 0 && result.signal === null && result.stderr.length === 0,
    "OWNED_PROCESS_CLEANUP_FAILED",
    `${request.name} exact owned-process cleanup failed`,
    {
      stage: request.name,
      details: {
        exitCode: result.exitCode,
        signal: result.signal,
        stderr: trimmedEvidence(result.stderr),
      },
    },
  );
  const cleanup = parseJson(
    result.stdout,
    "owned-process watchdog stdout",
    request.name,
  );
  exactKeys(
    cleanup,
    [
      "exactIdentity",
      "exited",
      "mode",
      "owner",
      "processId",
      "processPath",
      "processStartTimeUtc",
      "status",
    ],
    "owned-process watchdog report",
    request.name,
  );
  assert(
    cleanup.processId === receipt.processId &&
      cleanup.processStartTimeUtc === receipt.processStartTimeUtc &&
      cleanup.processPath.toLowerCase() === receipt.processPath.toLowerCase() &&
      cleanup.owner === receipt.owner &&
      cleanup.exactIdentity === true &&
      cleanup.exited === true &&
      ["already-exited", "cleaned"].includes(cleanup.status) &&
      ["none", "graceful", "forced"].includes(cleanup.mode),
    "OWNED_PROCESS_CLEANUP_FAILED",
    `${request.name} exact owned-process cleanup report is invalid`,
    { stage: request.name },
  );
  return cleanup;
}

async function cleanupAfterAbnormalExit(request, cleanupOwnedProcess) {
  const details = {
    cleanupSensitive: true,
    childExited: true,
    ownershipReceiptPath: request.ownershipReceiptPath ?? null,
    ownershipStatus: "unverified",
    ownershipReceiptTiming: "after-exit",
    contaminationRisk: true,
  };
  try {
    const receipt = await readOwnershipReceipt(request);
    details.ownershipStatus = "validated";
    details.ownedProcessId = receipt.processId;
    try {
      details.ownershipCleanup = await cleanupOwnedProcess(receipt, request);
      details.contaminationRisk = false;
    } catch (error) {
      details.ownershipStatus = "cleanup-failed";
      details.ownershipCleanupError = error.message;
    }
  } catch (error) {
    details.ownershipStatus =
      error.code === "OWNERSHIP_RECEIPT_ABSENT" ? "absent" : "ambiguous";
    details.ownershipValidationError = error.message;
  }
  return details;
}

async function runChildWithWatchdog(
  request,
  { spawnChild = spawn, cleanupOwnedProcess = cleanupOwnedPowerPoint } = {},
) {
  const {
    command,
    args,
    cwd,
    cleanupSensitive,
    timeoutMilliseconds,
  } = request;
  assert(
    Number.isSafeInteger(timeoutMilliseconds) && timeoutMilliseconds > 0,
    "CHILD_REQUEST_INVALID",
    `${request.name} requires a positive bounded timeout`,
    { stage: request.name },
  );

  return new Promise((resolveChild, rejectChild) => {
    const child = spawnChild(command, args, {
      cwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timingOut = false;
    let closed = false;
    let closeResult;
    let resolveClose;
    const closePromise = new Promise((resolveClosed) => {
      resolveClose = resolveClosed;
    });
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (!timingOut) finish(rejectChild, error);
    });
    child.once("close", async (exitCode, signal) => {
      closed = true;
      closeResult = { exitCode, signal, stdout, stderr };
      resolveClose(closeResult);
      if (!timingOut) {
        if (cleanupSensitive && (exitCode !== 0 || signal !== null)) {
          closeResult.abnormalCleanup = await cleanupAfterAbnormalExit(
            request,
            cleanupOwnedProcess,
          );
        }
        finish(resolveChild, closeResult);
      }
    });
    const timer = setTimeout(async () => {
      if (settled || closed) return;
      timingOut = true;
      const details = {
        timeoutMilliseconds,
        cleanupSensitive,
        ownershipReceiptPath: request.ownershipReceiptPath ?? null,
        ownershipStatus: cleanupSensitive ? "unverified" : "not-applicable",
        ownershipReceiptTiming: cleanupSensitive ? "none" : "not-applicable",
        contaminationRisk: cleanupSensitive,
      };
      let receiptInitiallyAbsent = false;
      const cleanOwnedProcess = async (receipt, timing) => {
        details.ownershipStatus = timing === "late" ? "validated-late" : "validated";
        details.ownershipReceiptTiming = timing;
        details.ownedProcessId = receipt.processId;
        try {
          const cleanup = await cleanupOwnedProcess(receipt, request);
          details.ownershipCleanup = cleanup;
          details.contaminationRisk = false;
        } catch (error) {
          details.ownershipStatus = "cleanup-failed";
          details.ownershipCleanupError = error.message;
          details.contaminationRisk = true;
        }
      };
      try {
        if (cleanupSensitive) {
          const receipt = await readOwnershipReceipt(request);
          await cleanOwnedProcess(receipt, "initial");
        }
      } catch (error) {
        receiptInitiallyAbsent = error.code === "OWNERSHIP_RECEIPT_ABSENT";
        details.ownershipStatus = receiptInitiallyAbsent ? "absent" : "ambiguous";
        details.ownershipValidationError = error.message;
      }

      try {
        if (!closed) child.kill();
        if (!closed) {
          await Promise.race([closePromise, delay(10_000)]);
        }
        if (!closed) child.kill("SIGKILL");
        if (!closed) {
          await Promise.race([closePromise, delay(5_000)]);
        }
      } catch (error) {
        details.childTerminationError = error.message;
      }
      details.childExited = closed;
      if (cleanupSensitive && receiptInitiallyAbsent && closed) {
        try {
          const lateReceipt = await readOwnershipReceipt(request);
          await cleanOwnedProcess(lateReceipt, "late");
          delete details.ownershipValidationError;
        } catch (error) {
          details.ownershipStatus =
            error.code === "OWNERSHIP_RECEIPT_ABSENT" ? "absent" : "ambiguous";
          details.ownershipReceiptTiming =
            error.code === "OWNERSHIP_RECEIPT_ABSENT" ? "none" : "late";
          details.ownershipValidationError = error.message;
          details.contaminationRisk = true;
        }
      }
      if (!closed || details.childTerminationError) {
        details.contaminationRisk = cleanupSensitive;
      }
      if (closeResult) {
        details.exitCode = closeResult.exitCode;
        details.signal = closeResult.signal;
      }
      finish(
        rejectChild,
        new CoordinatorError(
          "CHILD_TIMEOUT",
          `${request.name} exceeded its bounded execution deadline`,
          { stage: request.name, details },
        ),
      );
    }, timeoutMilliseconds);
  });
}

export function defaultChildRunner(request) {
  return runChildWithWatchdog(request);
}

export function runChildWatchdogForTest(request, harness) {
  assert(
    isPlainObject(harness) &&
      typeof harness.spawnChild === "function" &&
      typeof harness.cleanupOwnedProcess === "function",
    "TEST_HARNESS_INVALID",
    "test-only watchdog requires injected spawn and ownership cleanup functions",
    { stage: "test-harness" },
  );
  return runChildWithWatchdog(request, harness);
}

async function runJsonChild(dependencies, request) {
  let result;
  try {
    result = await dependencies.childRunner(request);
  } catch (error) {
    if (error instanceof CoordinatorError) throw error;
    fail("CHILD_START_FAILED", `${request.name} could not start: ${error.message}`, {
      stage: request.name,
    });
  }
  assert(
    isPlainObject(result) &&
      Object.hasOwn(result, "exitCode") &&
      Object.hasOwn(result, "signal") &&
      typeof result.stdout === "string" &&
      typeof result.stderr === "string",
    "CHILD_RESULT_INVALID",
    `${request.name} returned an invalid process result`,
    { stage: request.name },
  );
  if (result.exitCode !== 0 || result.signal !== null) {
    const abnormalCleanup = isPlainObject(result.abnormalCleanup)
      ? result.abnormalCleanup
      : request.cleanupSensitive
        ? {
            cleanupSensitive: true,
            childExited: true,
            ownershipStatus: "unverified",
            contaminationRisk: true,
          }
        : {};
    fail("CHILD_FAILED", `${request.name} failed`, {
      stage: request.name,
      details: {
        exitCode: result.exitCode,
        signal: result.signal,
        stderr: trimmedEvidence(result.stderr),
        stdout: trimmedEvidence(result.stdout),
        ...abnormalCleanup,
      },
    });
  }
  assert(
    result.stderr.length === 0,
    "CHILD_STDERR_INVALID",
    `${request.name} wrote to stderr on success`,
    { stage: request.name, details: { stderr: trimmedEvidence(result.stderr) } },
  );
  assert(
    result.stdout.trim().length > 0,
    "CHILD_STDOUT_INVALID",
    `${request.name} returned empty stdout`,
    { stage: request.name },
  );
  return parseJson(result.stdout, `${request.name} stdout`, request.name);
}

function powerShellRequest(
  name,
  script,
  args,
  cwd,
  command,
  ownershipReceiptPath,
  expectedOwnershipOwner,
  environment,
) {
  return {
    name,
    command,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      ...args,
      "-OwnershipReceipt",
      ownershipReceiptPath,
    ],
    cwd,
    env: environment,
    cleanupSensitive: true,
    expectedOwnershipOwner,
    ownershipReceiptPath,
    timeoutMilliseconds: name === "native-worker" ? 1_800_000 : 300_000,
  };
}

function powerShellUtilityRequest(name, script, args, cwd, command, environment) {
  return {
    name,
    command,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      ...args,
    ],
    cwd,
    env: environment,
    cleanupSensitive: false,
    timeoutMilliseconds: 30_000,
  };
}

function nodeRequest(name, script, args, cwd, environment) {
  return {
    name,
    command: process.execPath,
    args: [script, ...args],
    cwd,
    env: environment,
    cleanupSensitive: false,
    timeoutMilliseconds: 120_000,
  };
}

function expectedSelection(plan, mode) {
  const slides = mode === "smoke" ? selectSmokeSlides(plan) : plan.slides;
  assert(
    Array.isArray(slides) && slides.length > 0,
    "PLAN_SELECTION_INVALID",
    "plan did not produce a nonempty slide selection",
    { stage: "selection" },
  );
  return {
    slides,
    ids: slides.map((slide) => slide.id),
    families: slides.map((slide) => slide.family),
  };
}

async function compileSpec({
  dependencies,
  planPath,
  planHash,
  plan,
  mode,
  workDirectory,
}) {
  const stage = "spec-compiler";
  const specPath = join(workDirectory, "s.json");
  const report = await runJsonChild(
    dependencies,
    nodeRequest(
      stage,
      dependencies.specCompiler,
      ["--plan", planPath, "--mode", mode, "--output", specPath],
      workDirectory,
      dependencies.childEnvironment,
    ),
  );
  exactKeys(report, SPEC_REPORT_KEYS, "spec compiler report", stage);
  const selection = expectedSelection(plan, mode);
  assert(report.status === "PASS", "SPEC_REPORT_INVALID", "spec compiler status must be PASS", {
    stage,
  });
  assert(report.mode === mode, "SPEC_REPORT_INVALID", "spec compiler mode mismatch", { stage });
  assert(
    report.sourcePlanSha256 === planHash,
    "HASH_MISMATCH",
    "spec compiler plan hash mismatch",
    { stage },
  );
  assert(
    arraysEqual(report.selectedSlideIds, selection.ids) &&
      arraysEqual(report.selectedSlideFamilies, selection.families),
    "SELECTION_MISMATCH",
    "spec compiler selection mismatch",
    { stage },
  );
  assert(pathsEqual(report.outputPath, specPath), "PATH_MISMATCH", "spec output path mismatch", {
    stage,
  });
  assertHash(report.outputSha256, "spec compiler outputSha256", stage);
  assert(integerAtLeast(report.primitiveCount, 1), "SPEC_REPORT_INVALID", "primitiveCount is invalid", {
    stage,
  });

  const specBytes = await readFile(specPath);
  const specHash = sha256(specBytes);
  assert(specHash === report.outputSha256, "HASH_MISMATCH", "drawing spec hash mismatch", {
    stage,
  });
  const spec = parseJson(specBytes, "drawing spec", stage);
  try {
    validateDrawingSpec(spec);
    assert(
      Buffer.from(stableSerialize(spec), "utf8").equals(specBytes),
      "SPEC_SERIALIZATION_INVALID",
      "drawing spec is not the canonical stable serialization",
      { stage },
    );
  } catch (error) {
    if (error instanceof CoordinatorError) throw error;
    fail("SPEC_VALIDATION_FAILED", error.message, { stage });
  }
  assert(
    spec.source?.planSha256 === planHash,
    "HASH_MISMATCH",
    "drawing spec source plan hash mismatch",
    { stage },
  );
  assert(
    arraysEqual(spec.selectedSlideIds, selection.ids) &&
      arraysEqual(spec.selectedSlideFamilies, selection.families),
    "SELECTION_MISMATCH",
    "drawing spec selection mismatch",
    { stage },
  );
  const primitiveCount = spec.slides.reduce(
    (total, slide) => total + slide.primitives.length,
    0,
  );
  assert(
    primitiveCount === report.primitiveCount,
    "SPEC_REPORT_INVALID",
    "spec compiler primitiveCount mismatch",
    { stage },
  );
  return { report, selection, spec, specBytes, specHash, specPath };
}

function verifyCleanupReceipt(cleanup, label, stage) {
  exactKeys(
    cleanup,
    [
      "contaminationDetected",
      "exited",
      "graceSeconds",
      "mode",
      "ownedProcessId",
      "ownedProcessPath",
      "ownedProcessStartUtc",
      "releaseErrors",
    ],
    label,
    stage,
  );
  assert(cleanup.exited === true, "CLEANUP_INVALID", `${label}.exited must be true`, { stage });
  assert(
    cleanup.contaminationDetected === false,
    "CLEANUP_INVALID",
    `${label}.contaminationDetected must be false`,
    { stage },
  );
  assert(
    Array.isArray(cleanup.releaseErrors) && cleanup.releaseErrors.length === 0,
    "CLEANUP_INVALID",
    `${label}.releaseErrors must be empty`,
    { stage },
  );
  assert(
    integerAtLeast(cleanup.ownedProcessId, 1) &&
      typeof cleanup.ownedProcessPath === "string" &&
      cleanup.ownedProcessPath.length > 0 &&
      typeof cleanup.ownedProcessStartUtc === "string" &&
      cleanup.ownedProcessStartUtc.length > 0 &&
      ["graceful", "forced"].includes(cleanup.mode) &&
      Number.isFinite(cleanup.graceSeconds) &&
      cleanup.graceSeconds > 0,
    "CLEANUP_INVALID",
    `${label} process receipt is invalid`,
    { stage },
  );
}

function normalizeWorkerReportForBundle(report) {
  const normalized = structuredClone(report);
  normalized.spec = null;
  normalized.skeleton = null;
  normalized.presentation = "readout.pptx";
  normalized.renderDirectory = "native-render";
  normalized.report = "worker-report.json";
  normalized.contactSheet = "native-render/contact-sheet.png";
  normalized.cleanup.ownedProcessPath =
    normalized.cleanup.ownedProcessPath.split(/[\\/]/).at(-1) || "POWERPNT.EXE";
  return normalized;
}

async function createSkeleton({
  dependencies,
  planPath,
  planHash,
  mode,
  selection,
  workDirectory,
}) {
  const stage = "native-skeleton";
  const skeletonPath = join(workDirectory, "s.pptx");
  const ownershipReceiptPath = join(workDirectory, "so.json");
  const args = ["-Plan", planPath, "-Output", skeletonPath];
  if (mode === "smoke") args.push("-SmokeSlideIds", selection.ids.join(","));
  const report = await runJsonChild(
    dependencies,
    powerShellRequest(
      stage,
      dependencies.skeletonHelper,
      args,
      workDirectory,
      dependencies.powerShellCommand,
      ownershipReceiptPath,
      "fde-powerpoint-skeleton/1.0",
      dependencies.childEnvironment,
    ),
  );
  exactKeys(report, SKELETON_REPORT_KEYS, "skeleton report", stage);
  assert(pathsEqual(report.output, skeletonPath), "PATH_MISMATCH", "skeleton output path mismatch", {
    stage,
  });
  assert(
    report.selectionMode === mode &&
      report.sourcePlanSha256 === planHash &&
      arraysEqual(report.selectedSlideIds, selection.ids) &&
      arraysEqual(report.selectedSlideFamilies, selection.families),
    "SKELETON_REPORT_INVALID",
    "skeleton plan, mode, or selection mismatch",
    { stage },
  );
  assert(
    report.slides === selection.ids.length &&
      report.verifiedNotes === selection.ids.length &&
      report.packageSlides === selection.ids.length &&
      report.packageNotesParts === selection.ids.length &&
      report.uniqueNotesRelationships === selection.ids.length &&
      report.macroFree === true &&
      report.widthPoints === 960 &&
      report.heightPoints === 540,
    "SKELETON_REPORT_INVALID",
    "skeleton geometry, notes, or package counts are invalid",
    { stage },
  );
  exactKeys(
    report.powerPointCleanup,
    ["exited", "graceSeconds", "mode", "ownedProcessId"],
    "skeleton powerPointCleanup",
    stage,
  );
  assert(
    report.powerPointCleanup.exited === true &&
      integerAtLeast(report.powerPointCleanup.ownedProcessId, 1) &&
      ["graceful", "forced"].includes(report.powerPointCleanup.mode) &&
      Number.isFinite(report.powerPointCleanup.graceSeconds) &&
      report.powerPointCleanup.graceSeconds > 0,
    "CLEANUP_INVALID",
    "skeleton cleanup receipt is invalid",
    { stage },
  );
  assertHash(report.sha256, "skeleton sha256", stage);
  const skeletonBytes = await readFile(skeletonPath);
  const skeletonHash = sha256(skeletonBytes);
  assert(skeletonHash === report.sha256, "HASH_MISMATCH", "skeleton hash mismatch", { stage });
  return { report, skeletonBytes, skeletonHash, skeletonPath };
}

function expectedWorkerFiles(slideCount) {
  return [
    "readout.pptx",
    "worker-report.json",
    "native-render/contact-sheet.png",
    ...Array.from(
      { length: slideCount },
      (_, index) => `native-render/slide-${String(index + 1).padStart(3, "0")}.png`,
    ),
  ].sort();
}

function expectedConnectorRoutes(slide) {
  const groups = new Map();
  for (const primitive of slide.primitives) {
    if (
      primitive.kind !== "line" ||
      !Number.isSafeInteger(primitive.edgeIndex) ||
      !Number.isSafeInteger(primitive.segmentIndex)
    ) {
      continue;
    }
    if (!groups.has(primitive.edgeIndex)) groups.set(primitive.edgeIndex, []);
    groups.get(primitive.edgeIndex).push(primitive);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([edgeIndex, segments]) => {
    segments.sort((left, right) => left.segmentIndex - right.segmentIndex);
    const first = segments[0];
    const kind = first.role.match(/^workflow-edge-(system|decision)-/)?.[1];
    assert(
      kind !== undefined &&
        segments.every(
          (segment, index) =>
            segment.edgeIndex === edgeIndex &&
            segment.segmentIndex === index + 1 &&
            segment.sourceNodeId === first.sourceNodeId &&
            segment.targetNodeId === first.targetNodeId,
        ),
      "WORKER_REPORT_INVALID",
      `drawing spec connector route ${edgeIndex} is inconsistent`,
      { stage: "native-worker" },
    );
    return {
      edgeIndex,
      kind,
      sourceNodeId: first.sourceNodeId,
      targetNodeId: first.targetNodeId,
      segmentCount: segments.length,
      points: [
        { x: first.x1, y: first.y1 },
        ...segments.map((segment) => ({ x: segment.x2, y: segment.y2 })),
      ],
      pointSequenceSha256: sha256(
        Buffer.from(
          JSON.stringify({
            edgeIndex,
            points: [
              { x: first.x1, y: first.y1 },
              ...segments.map((segment) => ({ x: segment.x2, y: segment.y2 })),
            ],
          }),
          "utf8",
        ),
      ),
    };
    });
}

function expectedConnectorProjection(spec) {
  const allPrimitives = [];
  const allMetadata = [];
  const allPointSequences = [];
  const slides = spec.slides.map((slide) => {
    const connectorPrimitives = slide.primitives
      .filter(
        (primitive) =>
          primitive.kind === "line" &&
          /^workflow-edge-(system|decision)-\d{2}$/.test(primitive.role),
      )
      .map((primitive) => ({
        name: primitive.name,
        role: primitive.role,
        z: primitive.z,
        x1: primitive.x1,
        y1: primitive.y1,
        x2: primitive.x2,
        y2: primitive.y2,
        colorRole: primitive.colorRole,
        transparency: primitive.transparency,
        width: primitive.width,
        dash: primitive.dash,
        arrowStart: primitive.arrowStart,
        arrowEnd: primitive.arrowEnd,
        sourceNodeId: primitive.sourceNodeId,
        targetNodeId: primitive.targetNodeId,
        edgeIndex: primitive.edgeIndex,
        segmentIndex: primitive.segmentIndex,
      }));
    const routes = expectedConnectorRoutes(slide);
    const metadata = routes.map((route) => ({
      edgeIndex: route.edgeIndex,
      kind: route.kind,
      sourceNodeId: route.sourceNodeId,
      targetNodeId: route.targetNodeId,
      segmentCount: route.segmentCount,
    }));
    const pointSequences = routes.map((route) => ({
      edgeIndex: route.edgeIndex,
      points: route.points,
    }));
    allPrimitives.push(...connectorPrimitives);
    allMetadata.push(...metadata);
    allPointSequences.push(...pointSequences);
    return {
      primitiveSha256: sha256(Buffer.from(JSON.stringify(connectorPrimitives), "utf8")),
      routeMetadataSha256: sha256(Buffer.from(JSON.stringify(metadata), "utf8")),
      pointSequenceSha256: sha256(Buffer.from(JSON.stringify(pointSequences), "utf8")),
      routes,
    };
  });
  return {
    primitiveSha256: sha256(Buffer.from(JSON.stringify(allPrimitives), "utf8")),
    routeMetadataSha256: sha256(Buffer.from(JSON.stringify(allMetadata), "utf8")),
    pointSequenceSha256: sha256(Buffer.from(JSON.stringify(allPointSequences), "utf8")),
    slides,
  };
}

function nativeChartShapeNames(primitive) {
  const boundsName = primitive.name.endsWith("-native-chart")
    ? `${primitive.name.slice(0, -13)}-chart-bounds`
    : `fde-chart-bounds-${sha256(Buffer.from(primitive.name, "utf8")).slice(0, 16)}`;
  const names = [
    primitive.name,
    boundsName,
    ...primitive.axis.ticks.map((tick) => tick.gridLine.name),
  ];
  if (primitive.chartType === "bar") {
    for (const series of primitive.series) {
      names.push(...series.bars.map((bar) => bar.name));
    }
  } else {
    for (const series of primitive.series) {
      names.push(...series.segments.map((segment) => segment.name));
    }
  }
  names.push(primitive.axis.baseline.name);
  if (primitive.chartType === "line") {
    for (const series of primitive.series) {
      names.push(...series.markers.map((marker) => marker.name));
    }
  }
  names.push(
    ...primitive.legend.map((entry) => entry.swatchName),
    primitive.unitLabel.name,
    ...primitive.axis.ticks.map((tick) => tick.labelBox.name),
    ...primitive.categories.map((category) => category.labelBox.name),
    ...primitive.legend.map((entry) => entry.labelBox.name),
  );
  for (const row of primitive.dataGrid.rows) {
    names.push(row.labelBox.name, ...row.values.map((value) => value.labelBox.name));
  }
  return names;
}

function expectedSlideShapeProjection(slide) {
  const recursiveNames = [];
  const nativeChartNames = [];
  for (const primitive of slide.primitives) {
    if (primitive.kind === "nativeChart") {
      const chartNames = nativeChartShapeNames(primitive);
      recursiveNames.push(...chartNames);
      nativeChartNames.push(...chartNames);
    } else {
      recursiveNames.push(primitive.name);
    }
  }
  const tables = slide.primitives.filter((primitive) => primitive.kind === "table");
  return {
    nativeChartShapeCount: nativeChartNames.length,
    nativeChartShapeNamesSha256: sha256(
      Buffer.from(nativeChartNames.join("\n"), "utf8"),
    ),
    nativeTableCount: tables.length,
    nativeTableCellCount: tables.reduce(
      (total, table) => total + table.headers.length * (table.rows.length + 1),
      0,
    ),
    primitiveSha256: sha256(
      Buffer.from(canonicalizeJson(slide.primitives), "utf8"),
    ),
    recursiveShapeCount: recursiveNames.length,
    recursiveShapeNamesSha256: sha256(
      Buffer.from(recursiveNames.join("\n"), "utf8"),
    ),
  };
}

async function verifyWorkerReport({
  workerDirectory,
  report,
  persistedReport,
  spec,
  specPath,
  specHash,
  skeletonPath,
  skeletonHash,
}) {
  const stage = "native-worker";
  exactKeys(report, WORKER_REPORT_KEYS, "worker report", stage);
  assert(
    isDeepStrictEqual(report, persistedReport),
    "REPORT_MISMATCH",
    "worker stdout and persisted reports differ",
    { stage },
  );
  assert(
    report.status === "WORKER_PASS" &&
      report.stagingEvidence === true &&
      report.worker === WORKER_ID,
    "WORKER_REPORT_INVALID",
    "worker success identity is invalid",
    { stage },
  );
  assert(
    pathsEqual(report.spec, specPath) &&
      pathsEqual(report.skeleton, skeletonPath) &&
      pathsEqual(report.presentation, join(workerDirectory, "readout.pptx")) &&
      pathsEqual(report.renderDirectory, join(workerDirectory, "native-render")) &&
      pathsEqual(report.report, join(workerDirectory, "worker-report.json")) &&
      pathsEqual(
        report.contactSheet,
        join(workerDirectory, "native-render", "contact-sheet.png"),
      ),
    "PATH_MISMATCH",
    "worker report artifact paths are invalid",
    { stage },
  );
  assert(
    report.specSha256 === specHash && report.skeletonSha256 === skeletonHash,
    "HASH_MISMATCH",
    "worker spec or skeleton hash mismatch",
    { stage },
  );
  assert(
    arraysEqual(report.selectedSlideIds, spec.selectedSlideIds) &&
      arraysEqual(report.selectedSlideFamilies, spec.selectedSlideFamilies),
    "SELECTION_MISMATCH",
    "worker selection mismatch",
    { stage },
  );
  verifyCleanupReceipt(report.cleanup, "worker cleanup", stage);
  assert(
    Number.isFinite(report.elapsedMilliseconds) && report.elapsedMilliseconds >= 0,
    "WORKER_REPORT_INVALID",
    "worker elapsedMilliseconds is invalid",
    { stage },
  );

  const presentationBytes = await readFile(join(workerDirectory, "readout.pptx"));
  const presentationHash = sha256(presentationBytes);
  const contactSheetBytes = await readFile(
    join(workerDirectory, "native-render", "contact-sheet.png"),
  );
  const contactSheetHash = sha256(contactSheetBytes);
  assert(
    report.presentationSha256 === presentationHash &&
      report.contactSheetSha256 === contactSheetHash,
    "HASH_MISMATCH",
    "worker presentation or contact-sheet hash mismatch",
    { stage },
  );
  assert(
    Array.isArray(report.slides) && report.slides.length === spec.slides.length,
    "WORKER_REPORT_INVALID",
    "worker slide report count mismatch",
    { stage },
  );

  const renders = [];
  const connectorProjection = expectedConnectorProjection(spec);
  for (let index = 0; index < spec.slides.length; index += 1) {
    const slide = report.slides[index];
    const expectedSlide = spec.slides[index];
    const expectedShapes = expectedSlideShapeProjection(expectedSlide);
    const expectedConnectors = connectorProjection.slides[index];
    exactKeys(slide, WORKER_SLIDE_KEYS, `worker slides[${index}]`, stage);
    const render = `slide-${String(index + 1).padStart(3, "0")}.png`;
    assert(
      slide.index === index + 1 &&
        slide.id === expectedSlide.id &&
        slide.family === expectedSlide.family &&
        slide.backgroundColorRole === expectedSlide.backgroundColorRole &&
        slide.primitiveCount === expectedSlide.primitives.length &&
        slide.shapeCount === expectedSlide.primitives.length &&
        slide.render === render &&
        slide.overflow === false,
      "WORKER_REPORT_INVALID",
      `worker slide ${index + 1} metadata is invalid`,
      { stage },
    );
    const expectedShapeNamesHash = sha256(
      Buffer.from(
        expectedSlide.primitives.map((primitive) => primitive.name).join("\n"),
        "utf8",
      ),
    );
    assert(
      slide.shapeNamesSha256 === expectedShapeNamesHash,
      "HASH_MISMATCH",
      `slide ${index + 1} shape-name hash mismatch`,
      { stage },
    );
    assert(
      slide.primitiveSha256 === expectedShapes.primitiveSha256 &&
        slide.recursiveShapeNamesSha256 ===
          expectedShapes.recursiveShapeNamesSha256 &&
        slide.nativeChartShapeNamesSha256 ===
          expectedShapes.nativeChartShapeNamesSha256 &&
        slide.connectorPrimitiveSha256 === expectedConnectors.primitiveSha256 &&
        slide.connectorRouteMetadataSha256 ===
          expectedConnectors.routeMetadataSha256 &&
        slide.connectorPointSequenceSha256 ===
          expectedConnectors.pointSequenceSha256,
      "HASH_MISMATCH",
      `slide ${index + 1} spec-derived hash mismatch`,
      { stage },
    );
    assert(
      slide.recursiveShapeCount === expectedShapes.recursiveShapeCount &&
        slide.nativeChartShapeCount === expectedShapes.nativeChartShapeCount &&
        slide.nativeTableCount === expectedShapes.nativeTableCount &&
        slide.nativeTableCellCount === expectedShapes.nativeTableCellCount,
      "WORKER_REPORT_INVALID",
      `slide ${index + 1} spec-derived shape or table count mismatch`,
      { stage },
    );
    const notesHash = sha256(
      Buffer.from(nativeNotesText(expectedSlide.notesText), "utf8"),
    );
    assert(slide.notesSha256 === notesHash, "HASH_MISMATCH", `slide ${index + 1} notes hash mismatch`, {
      stage,
    });
    const renderPath = join(workerDirectory, "native-render", render);
    const renderHash = sha256(await readFile(renderPath));
    assert(
      slide.renderSha256 === renderHash,
      "HASH_MISMATCH",
      `slide ${index + 1} render hash mismatch`,
      { stage },
    );
    for (const field of [
      "connectorRouteCount",
      "connectorSegmentCount",
      "nativeChartShapeCount",
      "nativeTableCellCount",
      "nativeTableCount",
      "recursiveShapeCount",
    ]) {
      assert(
        integerAtLeast(slide[field], 0),
        "WORKER_REPORT_INVALID",
        `worker slides[${index}].${field} is invalid`,
        { stage },
      );
    }
    for (const field of [
      "connectorPointSequenceSha256",
      "connectorPrimitiveSha256",
      "connectorRouteMetadataSha256",
      "nativeChartShapeNamesSha256",
      "primitiveSha256",
      "recursiveShapeContentSha256",
      "recursiveShapeGeometrySha256",
      "recursiveShapeNamesSha256",
      "recursiveShapeStyleSha256",
      "renderSha256",
      "shapeNamesSha256",
    ]) {
      assertHash(slide[field], `worker slides[${index}].${field}`, stage);
    }
    assert(
      slide.recursiveShapeCount >= slide.shapeCount &&
        typeof slide.connectorCostStatus === "string" &&
        slide.connectorCostStatus.length > 0,
      "WORKER_REPORT_INVALID",
      `worker slides[${index}] recursive-shape or connector status is invalid`,
      { stage },
    );
    renders.push({ path: `native-render/${render}`, sha256: renderHash });
  }

  exactKeys(
    report.nativeShapes,
    ["nativeChartShapeCount", "recursiveShapeCount", "recursiveShapeTreeSha256"],
    "worker nativeShapes",
    stage,
  );
  assertHash(
    report.nativeShapes.recursiveShapeTreeSha256,
    "worker nativeShapes.recursiveShapeTreeSha256",
    stage,
  );
  assert(
    report.nativeShapes.recursiveShapeCount ===
        report.slides.reduce((total, slide) => total + slide.recursiveShapeCount, 0) &&
      report.nativeShapes.nativeChartShapeCount ===
        report.slides.reduce((total, slide) => total + slide.nativeChartShapeCount, 0) &&
      report.nativeShapes.recursiveShapeTreeSha256 ===
        sha256(
          Buffer.from(
            report.slides
              .map(
                (slide) =>
                  `${slide.id}|${slide.recursiveShapeNamesSha256}|${slide.recursiveShapeGeometrySha256}|${slide.recursiveShapeContentSha256}|${slide.recursiveShapeStyleSha256}`,
              )
              .join("\n"),
            "utf8",
          ),
        ),
    "WORKER_REPORT_INVALID",
    "worker native-shape totals do not match slide receipts",
    { stage },
  );
  exactKeys(
    report.connectors,
    [
      "costStatus",
      "drawingNameCount",
      "pointSequenceSha256",
      "primitiveSha256",
      "reopenedExactVerification",
      "routeCount",
      "routeMetadataSha256",
      "segmentCount",
      "slideCount",
      "slides",
    ],
    "worker connectors",
    stage,
  );
  for (const field of [
    "drawingNameCount",
    "routeCount",
    "segmentCount",
    "slideCount",
  ]) {
    assert(
      integerAtLeast(report.connectors[field], 0),
      "WORKER_REPORT_INVALID",
      `worker connectors.${field} is invalid`,
      { stage },
    );
  }
  for (const field of [
    "pointSequenceSha256",
    "primitiveSha256",
    "routeMetadataSha256",
  ]) {
    assertHash(report.connectors[field], `worker connectors.${field}`, stage);
  }
  assert(
    report.connectors.reopenedExactVerification === true &&
      report.connectors.slideCount === spec.slides.length &&
      report.connectors.drawingNameCount ===
        spec.slides.reduce(
          (total, slide) => total + slide.primitives.length,
          0,
        ) &&
      report.connectors.routeCount ===
        report.slides.reduce((total, slide) => total + slide.connectorRouteCount, 0) &&
      report.connectors.segmentCount ===
        report.slides.reduce(
          (total, slide) => total + slide.connectorSegmentCount,
          0,
        ) &&
      report.connectors.costStatus === CONNECTOR_COST_STATUS &&
      report.connectors.primitiveSha256 === connectorProjection.primitiveSha256 &&
      report.connectors.routeMetadataSha256 ===
        connectorProjection.routeMetadataSha256 &&
      report.connectors.pointSequenceSha256 ===
        connectorProjection.pointSequenceSha256 &&
      Array.isArray(report.connectors.slides) &&
      report.connectors.slides.length === spec.slides.length,
    "WORKER_REPORT_INVALID",
    "worker connector totals, status, or reopen verification is invalid",
    { stage },
  );
  for (let index = 0; index < spec.slides.length; index += 1) {
    const connectorSlide = report.connectors.slides[index];
    const workerSlide = report.slides[index];
    const expectedSlide = spec.slides[index];
    exactKeys(
      connectorSlide,
      [
        "connectorPrimitiveSha256",
        "costStatus",
        "family",
        "id",
        "index",
        "pointSequenceSha256",
        "routeCount",
        "routeMetadataSha256",
        "routes",
        "segmentCount",
      ],
      `worker connectors.slides[${index}]`,
      stage,
    );
    assert(
      connectorSlide.index === index + 1 &&
        connectorSlide.id === expectedSlide.id &&
        connectorSlide.family === expectedSlide.family &&
        connectorSlide.routeCount === workerSlide.connectorRouteCount &&
        connectorSlide.segmentCount === workerSlide.connectorSegmentCount &&
        connectorSlide.connectorPrimitiveSha256 ===
          workerSlide.connectorPrimitiveSha256 &&
        connectorSlide.routeMetadataSha256 ===
          workerSlide.connectorRouteMetadataSha256 &&
        connectorSlide.pointSequenceSha256 ===
          workerSlide.connectorPointSequenceSha256 &&
        connectorSlide.costStatus === CONNECTOR_COST_STATUS,
      "WORKER_REPORT_INVALID",
      `worker connectors.slides[${index}] does not match the slide receipt`,
      { stage },
    );
    const expectedRoutes = expectedConnectorRoutes(expectedSlide);
    assert(
      Array.isArray(connectorSlide.routes) &&
        connectorSlide.routes.length === expectedRoutes.length &&
        connectorSlide.routeCount === expectedRoutes.length &&
        connectorSlide.segmentCount ===
          expectedRoutes.reduce((total, route) => total + route.segmentCount, 0),
      "WORKER_REPORT_INVALID",
      `worker connectors.slides[${index}] route counts are invalid`,
      { stage },
    );
    for (let routeIndex = 0; routeIndex < expectedRoutes.length; routeIndex += 1) {
      const route = connectorSlide.routes[routeIndex];
      const expectedRoute = expectedRoutes[routeIndex];
      exactKeys(
        route,
        [
          "costStatus",
          "declaredCost",
          "edgeIndex",
          "kind",
          "pointSequenceSha256",
          "points",
          "segmentCount",
          "sourceNodeId",
          "targetNodeId",
        ],
        `worker connectors.slides[${index}].routes[${routeIndex}]`,
        stage,
      );
      assertHash(
        route.pointSequenceSha256,
        `worker connectors.slides[${index}].routes[${routeIndex}].pointSequenceSha256`,
        stage,
      );
      assert(
        route.edgeIndex === expectedRoute.edgeIndex &&
          route.kind === expectedRoute.kind &&
          route.sourceNodeId === expectedRoute.sourceNodeId &&
          route.targetNodeId === expectedRoute.targetNodeId &&
          route.segmentCount === expectedRoute.segmentCount &&
          isDeepStrictEqual(route.points, expectedRoute.points) &&
          route.pointSequenceSha256 === expectedRoute.pointSequenceSha256 &&
          route.declaredCost === null &&
          route.costStatus === CONNECTOR_COST_STATUS,
        "WORKER_REPORT_INVALID",
        `worker connectors.slides[${index}].routes[${routeIndex}] is invalid`,
        { stage },
      );
    }
  }

  return {
    contactSheetHash,
    presentationHash,
    renders,
  };
}

async function runWorker({
  dependencies,
  spec,
  specPath,
  specHash,
  skeletonPath,
  skeletonHash,
  workDirectory,
}) {
  const workerDirectory = join(workDirectory, "b");
  const ownershipReceiptPath = join(workDirectory, "wo.json");
  const report = await runJsonChild(
    dependencies,
    powerShellRequest(
      "native-worker",
      dependencies.worker,
      [
        "-Spec",
        specPath,
        "-ExpectedSpecSha256",
        specHash,
        "-Skeleton",
        skeletonPath,
        "-OutputDirectory",
        workerDirectory,
        "-NodeExecutable",
        process.execPath,
      ],
      workDirectory,
      dependencies.powerShellCommand,
      ownershipReceiptPath,
      WORKER_ID,
      dependencies.childEnvironment,
    ),
  );
  const actualFiles = await relativeFiles(workerDirectory);
  const expectedFiles = expectedWorkerFiles(spec.slides.length);
  assert(
    isDeepStrictEqual(actualFiles, expectedFiles),
    "BUNDLE_FILES_INVALID",
    "worker bundle file set is invalid",
    { stage: "native-worker", details: { actual: actualFiles, expected: expectedFiles } },
  );
  const persistedReportBytes = await readFile(join(workerDirectory, "worker-report.json"));
  const persistedReport = parseJson(
    persistedReportBytes,
    "persisted worker report",
    "native-worker",
  );
  const artifacts = await verifyWorkerReport({
    workerDirectory,
    report,
    persistedReport,
    spec,
    specPath,
    specHash,
    skeletonPath,
    skeletonHash,
  });
  return { artifacts, report, reportBytes: persistedReportBytes, workerDirectory };
}

function validatePackageQaReceipt({
  report,
  presentationBytes,
  slideCount,
  stage,
}) {
  exactKeys(report, PACKAGE_QA_KEYS, "package QA report", stage);
  assert(report.schemaVersion === 1, "PACKAGE_QA_INVALID", "package QA schemaVersion is invalid", {
    stage,
  });
  assert(
    report.valid === true && Array.isArray(report.findings) && report.findings.length === 0,
    "PACKAGE_QA_FAILED",
    "PowerPoint package QA did not pass",
    { stage, details: { findings: report.findings } },
  );
  exactKeys(report.package, ["byteLength", "sha256"], "package QA package", stage);
  exactKeys(
    report.counts,
    ["archiveEntries", "notes", "parts", "relationships", "slides"],
    "package QA counts",
    stage,
  );
  for (const field of [
    "archiveEntries",
    "notes",
    "parts",
    "relationships",
    "slides",
  ]) {
    assert(
      integerAtLeast(report.counts[field], 0),
      "PACKAGE_QA_INVALID",
      `package QA counts.${field} is invalid`,
      { stage },
    );
  }
  const presentationHash = sha256(presentationBytes);
  assert(
    report.package?.sha256 === presentationHash &&
      Number.isSafeInteger(report.package?.byteLength) &&
      report.package.byteLength === presentationBytes.length &&
      report.package.byteLength > 0,
    "HASH_MISMATCH",
    "package QA presentation hash or size mismatch",
    { stage },
  );
  assert(
    report.counts?.slides === slideCount &&
      report.counts?.notes === slideCount &&
      Array.isArray(report.slides) &&
      report.slides.length === slideCount &&
      report.slides.every(
        (slide, index) =>
          slide.index === index + 1 &&
          typeof slide.part === "string" &&
          typeof slide.notesPart === "string" &&
          HASH_PATTERN.test(slide.sha256) &&
          HASH_PATTERN.test(slide.notesSha256),
      ),
    "PACKAGE_QA_INVALID",
    "package QA slide or unique-notes counts are invalid",
    { stage },
  );
  assert(
    Array.isArray(report.parts) && report.parts.length === report.counts.parts,
    "PACKAGE_QA_INVALID",
    "package QA part count is invalid",
    { stage },
  );
  const partNames = new Set();
  const partHashes = new Map();
  for (let index = 0; index < report.parts.length; index += 1) {
    const part = report.parts[index];
    exactKeys(
      part,
      [
        "compressedSize",
        "compressionMethod",
        "name",
        "sha256",
        "uncompressedSize",
      ],
      `package QA parts[${index}]`,
      stage,
    );
    assert(
      typeof part.name === "string" &&
        part.name.length > 0 &&
        !partNames.has(part.name) &&
        !UNSUPPORTED_PART_PATTERN.test(part.name) &&
        integerAtLeast(part.compressedSize, 0) &&
        ["stored", "deflate"].includes(part.compressionMethod) &&
        integerAtLeast(part.uncompressedSize, 0),
      "UNSUPPORTED_PACKAGE_PART",
      `package QA parts[${index}] is invalid or unsupported`,
      { stage },
    );
    assertHash(part.sha256, `package QA parts[${index}].sha256`, stage);
    partNames.add(part.name);
    partHashes.set(part.name, part.sha256);
  }
  const slideParts = new Set();
  const notesParts = new Set();
  for (let index = 0; index < report.slides.length; index += 1) {
    const slide = report.slides[index];
    exactKeys(
      slide,
      ["index", "notesPart", "notesSha256", "part", "sha256"],
      `package QA slides[${index}]`,
      stage,
    );
    assert(
      !slideParts.has(slide.part) &&
        !notesParts.has(slide.notesPart) &&
        partNames.has(slide.part) &&
        partNames.has(slide.notesPart),
      "PACKAGE_QA_INVALID",
      `package QA slides[${index}] has duplicate or missing parts`,
      { stage },
    );
    assert(
      slide.sha256 === partHashes.get(slide.part) &&
        slide.notesSha256 === partHashes.get(slide.notesPart),
      "HASH_MISMATCH",
      `package QA slides[${index}] hashes do not match their package parts`,
      { stage },
    );
    slideParts.add(slide.part);
    notesParts.add(slide.notesPart);
  }
  return report;
}

async function runPackageQa({ dependencies, presentationPath, workDirectory, slideCount }) {
  const stage = "package-qa";
  const report = await runJsonChild(
    dependencies,
    nodeRequest(
      stage,
      dependencies.packageQa,
      [presentationPath],
      workDirectory,
      dependencies.childEnvironment,
    ),
  );
  const presentationBytes = await readFile(presentationPath);
  validatePackageQaReceipt({
    report,
    presentationBytes,
    slideCount,
    stage,
  });
  return { report, reportBytes: jsonBytes(report) };
}

function buildSmokeReport({
  coordinatorId,
  executionProfile,
  plan,
  planHash,
  spec,
  workerReport,
  packageQa,
  artifacts,
}) {
  const slidesById = new Map(plan.slides.map((slide) => [slide.id, slide]));
  return {
    schemaVersion: 1,
    status: "PASS",
    coordinator: coordinatorId,
    executionProfile,
    selectionMode: "smoke",
    sourcePlanSha256: planHash,
    selectedSlideIds: [...spec.selectedSlideIds],
    selectedSlideFamilies: [...spec.selectedSlideFamilies],
    pptxSha256: artifacts.presentationHash,
    contactSheetSha256: artifacts.contactSheetHash,
    densestSlideReadable: workerReport.slides.every((slide) => slide.overflow === false),
    legacyContentRemoved: true,
    slides: workerReport.slides.map((workerSlide, index) => {
      const planSlide = slidesById.get(workerSlide.id);
      assert(
        isPlainObject(planSlide) &&
          Array.isArray(planSlide.evidenceIds) &&
          Array.isArray(planSlide.judgmentIds),
        "PLAN_SELECTION_INVALID",
        `selected plan slide ${workerSlide.id} is missing evidence metadata`,
        { stage: "smoke-report" },
      );
      return {
        id: workerSlide.id,
        family: workerSlide.family,
        overflow: workerSlide.overflow,
        notesVerified:
          workerSlide.notesSha256 ===
          sha256(
            Buffer.from(nativeNotesText(spec.slides[index].notesText), "utf8"),
          ),
        evidenceIds: [...planSlide.evidenceIds],
        judgmentIds: [...planSlide.judgmentIds],
        densityScore: densityScore(planSlide),
        nativeShapeCount: workerSlide.recursiveShapeCount,
        nativeTableCount: workerSlide.nativeTableCount,
      };
    }),
    package: {
      slides: packageQa.counts.slides,
      notesParts: packageQa.counts.notes,
      uniqueNotesRelationships: packageQa.counts.notes,
      macroFree: true,
      externalRelationships: 0,
      orphanSlides: 0,
      orphanNotes: 0,
    },
  };
}

function finalFiles(mode, slideCount) {
  return [
    "coordinator-report.json",
    "package-qa.json",
    "readout.pptx",
    "worker-report.json",
    "native-render/contact-sheet.png",
    ...Array.from(
      { length: slideCount },
      (_, index) => `native-render/slide-${String(index + 1).padStart(3, "0")}.png`,
    ),
    ...(mode === "smoke" ? ["smoke-report.json"] : []),
  ].sort();
}

async function verifySmokeBundle({
  dependencies,
  planBytes,
  plan,
  bundlePath,
}) {
  const stage = "smoke-bundle";
  const selection = expectedSelection(plan, "smoke");
  const expectedFiles = finalFiles("smoke", selection.ids.length);
  const snapshot = await snapshotFiles(bundlePath, expectedFiles);
  const smokeReportBytes = await readFile(join(bundlePath, "smoke-report.json"));
  const smokeReport = parseJson(smokeReportBytes, "smoke report", stage);
  const smokeReportResult = validateSmokeReport({
    planBytes,
    reportBytes: smokeReportBytes,
    expectedCoordinator: dependencies.coordinatorId,
    expectedExecutionProfile: dependencies.executionProfile,
  });
  assert(
    smokeReportResult.errors.length === 0,
    "SMOKE_BUNDLE_INVALID",
    "smoke report validation failed",
    { stage, details: { errors: smokeReportResult.errors } },
  );

  assert(
    snapshot["readout.pptx"] === smokeReport.pptxSha256 &&
      snapshot["native-render/contact-sheet.png"] === smokeReport.contactSheetSha256,
    "HASH_MISMATCH",
    "smoke PPTX or contact-sheet bytes do not match the smoke report",
    { stage },
  );
  const workerReport = parseJson(
    await readFile(join(bundlePath, "worker-report.json")),
    "smoke worker report",
    stage,
  );
  exactKeys(workerReport, WORKER_REPORT_KEYS, "smoke worker report", stage);
  verifyCleanupReceipt(workerReport.cleanup, "smoke worker cleanup", stage);
  assert(
    workerReport.status === "WORKER_PASS" &&
      workerReport.worker === WORKER_ID &&
      workerReport.spec === null &&
      workerReport.skeleton === null &&
      workerReport.presentation === "readout.pptx" &&
      workerReport.renderDirectory === "native-render" &&
      workerReport.report === "worker-report.json" &&
      workerReport.contactSheet === "native-render/contact-sheet.png" &&
      workerReport.presentationSha256 === smokeReport.pptxSha256 &&
      workerReport.contactSheetSha256 === smokeReport.contactSheetSha256 &&
      arraysEqual(workerReport.selectedSlideIds, selection.ids) &&
      arraysEqual(workerReport.selectedSlideFamilies, selection.families),
    "SMOKE_BUNDLE_INVALID",
    "smoke worker report does not match smoke evidence",
    { stage },
  );
  const packageQa = parseJson(
    await readFile(join(bundlePath, "package-qa.json")),
    "smoke package QA report",
    stage,
  );
  validatePackageQaReceipt({
    report: packageQa,
    presentationBytes: await readFile(join(bundlePath, "readout.pptx")),
    slideCount: 3,
    stage,
  });
  assert(
    packageQa.package.sha256 === smokeReport.pptxSha256,
    "SMOKE_BUNDLE_INVALID",
    "smoke package QA hash does not match the smoke report",
    { stage },
  );
  const rerunPackageQa = await runPackageQa({
    dependencies,
    presentationPath: join(bundlePath, "readout.pptx"),
    workDirectory: bundlePath,
    slideCount: 3,
  });
  assert(
    isDeepStrictEqual(rerunPackageQa.report, packageQa),
    "SMOKE_BUNDLE_INVALID",
    "persisted smoke package QA differs from a fresh inspection of the reviewed smoke PPTX",
    { stage },
  );
  const coordinatorReport = parseJson(
    await readFile(join(bundlePath, "coordinator-report.json")),
    "smoke coordinator report",
    stage,
  );
  const smokePublicationSnapshot = await snapshotBundle(bundlePath);
  const smokePublicationPayload = {
    fileCount: smokePublicationSnapshot.fileCount - 1,
    files: smokePublicationSnapshot.files.filter(
      (file) => file.path !== "coordinator-report.json",
    ),
  };
  assert(
    coordinatorReport.schemaVersion === 1 &&
      coordinatorReport.status === "COORDINATOR_PASS" &&
      coordinatorReport.coordinator === dependencies.coordinatorId &&
      coordinatorReport.executionProfile === dependencies.executionProfile &&
      coordinatorReport.mode === "smoke" &&
      coordinatorReport.source?.planSha256 === sha256(planBytes) &&
      arraysEqual(coordinatorReport.selection?.selectedSlideIds, selection.ids) &&
      arraysEqual(
        coordinatorReport.selection?.selectedSlideFamilies,
        selection.families,
      ) &&
      isDeepStrictEqual(coordinatorReport.approval, {
        requiredForFull: true,
        approved: false,
        method: "explicit-full-mode-flag",
      }) &&
      coordinatorReport.artifacts?.presentation?.sha256 === smokeReport.pptxSha256 &&
      coordinatorReport.artifacts?.contactSheet?.sha256 === smokeReport.contactSheetSha256 &&
      coordinatorReport.artifacts?.workerReport?.sha256 ===
        snapshot["worker-report.json"] &&
      coordinatorReport.artifacts?.packageQa?.sha256 ===
        snapshot["package-qa.json"] &&
      coordinatorReport.artifacts?.smokeReport?.sha256 === sha256(smokeReportBytes) &&
      coordinatorReport.publication?.algorithm === "sha256" &&
      isDeepStrictEqual(
        coordinatorReport.publication.expectedFiles,
        smokePublicationSnapshot.files.map((file) => file.path),
      ) &&
      isDeepStrictEqual(
        coordinatorReport.publication.payload,
        smokePublicationPayload,
      ),
    "SMOKE_BUNDLE_INVALID",
    "smoke coordinator report is invalid",
    { stage },
  );
  return {
    expectedFiles,
    selection,
    smokeReport,
    smokeReportBytes,
    snapshot,
  };
}

async function promoteWorkerBundle(workerDirectory, stageDirectory) {
  await rename(join(workerDirectory, "readout.pptx"), join(stageDirectory, "readout.pptx"));
  await rename(join(workerDirectory, "native-render"), join(stageDirectory, "native-render"));
  await rename(
    join(workerDirectory, "worker-report.json"),
    join(stageDirectory, "worker-report.json"),
  );
}

function buildCoordinatorReport({
  coordinatorId,
  executionProfile,
  mode,
  planHash,
  spec,
  specHash,
  skeletonHash,
  workerReport,
  packageQa,
  packageQaBytes,
  artifacts,
  smokeReportBytes,
  workerReportBytes,
  publicationPayload,
}) {
  return {
    schemaVersion: 1,
    status: "COORDINATOR_PASS",
    coordinator: coordinatorId,
    executionProfile,
    mode,
    source: {
      planSha256: planHash,
      drawingSpecSha256: specHash,
      freshSkeletonSha256: skeletonHash,
    },
    selection: {
      slideCount: spec.slides.length,
      selectedSlideIds: [...spec.selectedSlideIds],
      selectedSlideFamilies: [...spec.selectedSlideFamilies],
      densestSlideId: mode === "smoke" ? spec.selectedSlideIds[2] : null,
    },
    approval:
      mode === "smoke"
        ? {
            requiredForFull: true,
            approved: false,
            method: "explicit-full-mode-flag",
          }
        : {
            requiredForFull: true,
            approved: true,
            method: "explicit-full-mode-flag",
          },
    artifacts: {
      presentation: {
        path: "readout.pptx",
        sha256: artifacts.presentationHash,
      },
      contactSheet: {
        path: "native-render/contact-sheet.png",
        sha256: artifacts.contactSheetHash,
      },
      renders: artifacts.renders,
      workerReport: {
        path: "worker-report.json",
        sha256: sha256(workerReportBytes),
        normalizedForBundle: true,
        status: workerReport.status,
        worker: workerReport.worker,
        specSha256: workerReport.specSha256,
        skeletonSha256: workerReport.skeletonSha256,
      },
      packageQa: {
        path: "package-qa.json",
        sha256: sha256(packageQaBytes),
        valid: packageQa.valid,
      },
      ...(smokeReportBytes
        ? {
            smokeReport: {
              path: "smoke-report.json",
              sha256: sha256(smokeReportBytes),
            },
          }
        : {}),
    },
    publication: {
      algorithm: "sha256",
      expectedFiles: [
        "coordinator-report.json",
        ...publicationPayload.files.map((file) => file.path),
      ].sort(),
      payload: publicationPayload,
    },
    checks: {
      smokeBundleVerifiedBeforeSkeleton: mode === "smoke" ? null : true,
      freshSkeletonCreated: true,
      workerReportExact: true,
      cleanupExited: workerReport.cleanup.exited,
      contaminationDetected: workerReport.cleanup.contaminationDetected,
      releaseErrorCount: workerReport.cleanup.releaseErrors.length,
      packageQaValid: packageQa.valid,
      slideCountExact: packageQa.counts.slides === spec.slides.length,
      notesCountExact: packageQa.counts.notes === spec.slides.length,
      unsupportedPartCount: packageQa.parts.filter((part) =>
        UNSUPPORTED_PART_PATTERN.test(part.name),
      ).length,
      externalInputsUnchanged: true,
      publicationStrategy: "same-volume-atomic-directory-rename",
    },
  };
}

async function prepareInputs(options) {
  assert(isPlainObject(options), "ARGUMENT_INVALID", "options must be a plain object", {
    stage: "arguments",
  });
  const allowedOptionKeys = new Set([
    "approveSmoke",
    "diagnosticOutput",
    "mode",
    "output",
    "plan",
    "smokeBundle",
  ]);
  const unknownOptionKeys = Object.keys(options).filter(
    (key) => !allowedOptionKeys.has(key),
  );
  assert(unknownOptionKeys.length === 0, "ARGUMENT_INVALID", "unknown coordinator options", {
    stage: "arguments",
    details: { errors: unknownOptionKeys.map((key) => `unknown option: ${key}`) },
  });
  for (const key of ["mode", "plan", "output"]) {
    assert(
      Object.hasOwn(options, key) &&
        typeof options[key] === "string" &&
        options[key].length > 0,
      "ARGUMENT_INVALID",
      `${key} is required`,
      { stage: "arguments" },
    );
  }
  const mode = options.mode;
  assert(["smoke", "full"].includes(mode), "ARGUMENT_INVALID", "mode must be smoke or full", {
    stage: "arguments",
  });
  const planPath = await existingPath(options.plan, "plan", "file");
  const outputPath = await newDirectoryPath(options.output, "output");
  const diagnosticPath = options.diagnosticOutput
    ? await newDirectoryPath(options.diagnosticOutput, "diagnostic output")
    : undefined;
  const inputs = { mode, outputPath, planPath, diagnosticPath };

  if (mode === "smoke") {
    assert(
      !Object.hasOwn(options, "approveSmoke") && !Object.hasOwn(options, "smokeBundle"),
      "ARGUMENT_INVALID",
      "--approve-smoke and --smoke-bundle are accepted only in full mode",
      { stage: "arguments" },
    );
  } else {
    assert(
      Object.hasOwn(options, "approveSmoke") && options.approveSmoke === true,
      "ARGUMENT_INVALID",
      "full mode requires --approve-smoke",
      { stage: "arguments" },
    );
    assert(
      Object.hasOwn(options, "smokeBundle") &&
        typeof options.smokeBundle === "string" &&
        options.smokeBundle.length > 0,
      "ARGUMENT_INVALID",
      "full mode requires --smoke-bundle",
      { stage: "arguments" },
    );
    inputs.smokeBundlePath = await existingPath(
      options.smokeBundle,
      "smoke bundle",
      "directory",
    );
  }

  const namedPaths = Object.entries(inputs).filter(
    ([name, value]) =>
      name.endsWith("Path") &&
      typeof value === "string" &&
      !["diagnosticPath", "outputPath"].includes(name),
  );
  for (let left = 0; left < namedPaths.length; left += 1) {
    for (let right = left + 1; right < namedPaths.length; right += 1) {
      assert(
        !pathsEqual(namedPaths[left][1], namedPaths[right][1]),
        "PATH_ALIAS_INVALID",
        `${namedPaths[left][0]} and ${namedPaths[right][0]} must not alias`,
        { stage: "inputs" },
      );
    }
  }
  for (const [name, path] of namedPaths) {
    assert(
      !pathsEqual(outputPath, path),
      "PATH_ALIAS_INVALID",
      `output must not alias ${name}`,
      { stage: "inputs" },
    );
  }
  if (inputs.smokeBundlePath) {
    assert(
      !pathContains(inputs.smokeBundlePath, outputPath) &&
        !pathContains(outputPath, inputs.smokeBundlePath),
      "PATH_ALIAS_INVALID",
      "output and smoke bundle must be independent paths",
      { stage: "inputs" },
    );
  }
  if (diagnosticPath) {
    assert(
      !pathsEqual(diagnosticPath, outputPath),
      "PATH_ALIAS_INVALID",
      "diagnostic output and output must be independent paths",
      { stage: "inputs" },
    );
    for (const [name, path] of namedPaths) {
      assert(
        !pathsEqual(diagnosticPath, path) &&
          !(name === "smokeBundlePath" &&
            (pathContains(path, diagnosticPath) || pathContains(diagnosticPath, path))),
        "PATH_ALIAS_INVALID",
        `diagnostic output must be independent from ${name}`,
        { stage: "inputs" },
      );
    }
  }
  return inputs;
}

async function runCoordinator(options, dependencies) {
  assert(
    dependencies.executionProfile === "production" ||
      dependencies.executionProfile === "test-only",
    "COORDINATOR_PROFILE_INVALID",
    "coordinator execution profile is invalid",
    { stage: "arguments" },
  );
  assert(
    process.platform === "win32" || dependencies.executionProfile === "test-only",
    "PLATFORM_UNSUPPORTED",
    "native PowerPoint coordination requires Windows",
    { stage: "arguments" },
  );
  const inputs = await prepareInputs(options);
  if (dependencies.executionProfile === "test-only") {
    const temporaryRoot = await realpath(tmpdir());
    for (const [label, candidate] of [
      ["output", inputs.outputPath],
      ["diagnostic output", inputs.diagnosticPath],
    ]) {
      if (candidate === undefined) continue;
      assert(
        !pathsEqual(temporaryRoot, candidate) && pathContains(temporaryRoot, candidate),
        "TEST_OUTPUT_PATH_INVALID",
        `${label} must be a descendant of the operating-system temporary directory`,
        { stage: "arguments" },
      );
    }
  }
  const planBytes = await readFile(inputs.planPath);
  const planHash = sha256(planBytes);
  const plan = parseJson(planBytes, "plan", "inputs");
  let smokeContext;

  if (inputs.mode === "full") {
    const smoke = await verifySmokeBundle({
      dependencies,
      planBytes,
      plan,
      bundlePath: inputs.smokeBundlePath,
    });
    await assertFileUnchanged(inputs.planPath, planHash, "plan", "smoke-bundle");
    smokeContext = smoke;
  }

  const assertExternalInputsUnchanged = async (stage) => {
    await assertFileUnchanged(inputs.planPath, planHash, "plan", stage);
    if (!smokeContext) return;
    await assertSnapshotUnchanged(
      inputs.smokeBundlePath,
      smokeContext.expectedFiles,
      smokeContext.snapshot,
      stage,
    );
  };

  const stageDirectory = join(
    dirname(inputs.outputPath),
    `.fde-${randomUUID().replaceAll("-", "")}`,
  );
  let ownsStage = false;
  try {
    await mkdir(stageDirectory, { recursive: false });
    ownsStage = true;
    const workDirectory = join(stageDirectory, ".w");
    await mkdir(workDirectory, { recursive: false });

    const compiled = await compileSpec({
      dependencies,
      planPath: inputs.planPath,
      planHash,
      plan,
      mode: inputs.mode,
      workDirectory,
    });
    await assertFileUnchanged(inputs.planPath, planHash, "plan", "spec-compiler");

    const skeleton = await createSkeleton({
      dependencies,
      planPath: inputs.planPath,
      planHash,
      mode: inputs.mode,
      selection: compiled.selection,
      workDirectory,
    });
    await assertFileUnchanged(inputs.planPath, planHash, "plan", "native-skeleton");
    await assertFileUnchanged(
      compiled.specPath,
      compiled.specHash,
      "drawing spec",
      "native-skeleton",
    );

    const worker = await runWorker({
      dependencies,
      spec: compiled.spec,
      specPath: compiled.specPath,
      specHash: compiled.specHash,
      skeletonPath: skeleton.skeletonPath,
      skeletonHash: skeleton.skeletonHash,
      workDirectory,
    });
    await assertFileUnchanged(inputs.planPath, planHash, "plan", "native-worker");
    await assertFileUnchanged(
      compiled.specPath,
      compiled.specHash,
      "drawing spec",
      "native-worker",
    );
    await assertFileUnchanged(
      skeleton.skeletonPath,
      skeleton.skeletonHash,
      "fresh skeleton",
      "native-worker",
    );

    const packageQa = await runPackageQa({
      dependencies,
      presentationPath: join(worker.workerDirectory, "readout.pptx"),
      workDirectory,
      slideCount: compiled.spec.slides.length,
    });
    assert(
      packageQa.report.package.sha256 === worker.artifacts.presentationHash,
      "HASH_MISMATCH",
      "worker and package QA presentation hashes differ",
      { stage: "package-qa" },
    );

    let smokeReportBytes;
    if (inputs.mode === "smoke") {
      const smokeReport = buildSmokeReport({
        coordinatorId: dependencies.coordinatorId,
        executionProfile: dependencies.executionProfile,
        plan,
        planHash,
        spec: compiled.spec,
        workerReport: worker.report,
        packageQa: packageQa.report,
        artifacts: worker.artifacts,
      });
      smokeReportBytes = jsonBytes(smokeReport);
      await writeFile(join(stageDirectory, "smoke-report.json"), smokeReportBytes, {
        flag: "wx",
      });
    }

    const bundledWorkerReport = normalizeWorkerReportForBundle(worker.report);
    const bundledWorkerReportBytes = jsonBytes(bundledWorkerReport);
    await writeFile(
      join(worker.workerDirectory, "worker-report.json"),
      bundledWorkerReportBytes,
    );
    await promoteWorkerBundle(worker.workerDirectory, stageDirectory);
    await writeFile(join(stageDirectory, "package-qa.json"), packageQa.reportBytes, {
      flag: "wx",
    });
    await rm(workDirectory, { recursive: true, force: false });

    await assertExternalInputsUnchanged("publication");

    if (dependencies.publicationHook) {
      await dependencies.publicationHook({
        phase: "before-payload-seal",
        path: stageDirectory,
      });
    }
    const publicationPayload = await snapshotBundle(stageDirectory);
    const coordinatorReport = buildCoordinatorReport({
      coordinatorId: dependencies.coordinatorId,
      executionProfile: dependencies.executionProfile,
      mode: inputs.mode,
      planHash,
      spec: compiled.spec,
      specHash: compiled.specHash,
      skeletonHash: skeleton.skeletonHash,
      workerReport: bundledWorkerReport,
      packageQa: packageQa.report,
      packageQaBytes: packageQa.reportBytes,
      artifacts: worker.artifacts,
      smokeReportBytes,
      workerReportBytes: bundledWorkerReportBytes,
      publicationPayload,
    });
    assertPublicationPayloadMatchesReceipts(
      coordinatorReport,
      publicationPayload,
    );
    const coordinatorReportBytes = jsonBytes(coordinatorReport);
    await writeFile(
      join(stageDirectory, "coordinator-report.json"),
      coordinatorReportBytes,
      { flag: "wx" },
    );
    const persistedCoordinatorReport = parseJson(
      await readFile(join(stageDirectory, "coordinator-report.json")),
      "persisted coordinator report",
      "publication",
    );
    assert(
      isDeepStrictEqual(persistedCoordinatorReport, coordinatorReport),
      "REPORT_MISMATCH",
      "persisted coordinator report differs from the generated receipt",
      { stage: "publication" },
    );
    const actualFinalFiles = await relativeFiles(stageDirectory);
    const expectedFinalFiles = finalFiles(inputs.mode, compiled.spec.slides.length);
    assert(
      isDeepStrictEqual(actualFinalFiles, expectedFinalFiles),
      "BUNDLE_FILES_INVALID",
      "final coordinator bundle file set is invalid",
      {
        stage: "publication",
        details: { actual: actualFinalFiles, expected: expectedFinalFiles },
      },
    );
    const sealedSnapshot = await snapshotBundle(stageDirectory);
    assert(
      isDeepStrictEqual(
        coordinatorReport.publication.expectedFiles,
        sealedSnapshot.files.map((file) => file.path),
      ),
      "BUNDLE_FILES_INVALID",
      "publication manifest file set does not match the sealed bundle",
      { stage: "publication" },
    );
    assertSnapshotEqual(
      {
        fileCount: coordinatorReport.publication.payload.fileCount,
        files: coordinatorReport.publication.payload.files,
      },
      {
        fileCount: sealedSnapshot.fileCount - 1,
        files: sealedSnapshot.files.filter(
          (file) => file.path !== "coordinator-report.json",
        ),
      },
      "publication",
      "publication payload manifest does not match the verified bundle",
    );
    await assertExternalInputsUnchanged("publication");
    await assertPathAbsent(inputs.outputPath, "output", "publication");
    if (dependencies.publicationHook) {
      await dependencies.publicationHook({
        phase: "before-rename",
        path: stageDirectory,
      });
    }
    const preRenameSnapshot = await snapshotBundle(stageDirectory);
    assertSnapshotEqual(
      preRenameSnapshot,
      sealedSnapshot,
      "publication",
      "coordinator bundle changed immediately before publication",
    );
    await rename(stageDirectory, inputs.outputPath);
    ownsStage = false;
    try {
      if (dependencies.publicationHook) {
        await dependencies.publicationHook({
          phase: "after-rename",
          path: inputs.outputPath,
        });
      }
      const publishedSnapshot = await snapshotBundle(inputs.outputPath);
      assertSnapshotEqual(
        publishedSnapshot,
        sealedSnapshot,
        "publication",
        "published coordinator bundle does not match its final seal",
      );
      const publishedCoordinatorReport = parseJson(
        await readFile(join(inputs.outputPath, "coordinator-report.json")),
        "published coordinator report",
        "publication",
      );
      assert(
        isDeepStrictEqual(publishedCoordinatorReport, coordinatorReport),
        "REPORT_MISMATCH",
        "published coordinator report differs from the verified receipt",
        { stage: "publication" },
      );
    } catch (publicationError) {
      const error =
        publicationError instanceof CoordinatorError
          ? publicationError
          : new CoordinatorError("PUBLICATION_FAILED", publicationError.message, {
              stage: "publication",
            });
      if (inputs.diagnosticPath) {
        try {
          await assertPathAbsent(
            inputs.diagnosticPath,
            "diagnostic output",
            "publication",
          );
          await rename(inputs.outputPath, inputs.diagnosticPath);
          error.details = {
            ...(isPlainObject(error.details) ? error.details : {}),
            diagnosticPath: inputs.diagnosticPath,
          };
        } catch (quarantineFailure) {
          error.details = {
            ...(isPlainObject(error.details) ? error.details : {}),
            diagnosticPreservationError: quarantineFailure.message,
          };
          try {
            await dependencies.removeDirectory(inputs.outputPath);
            await assertPathAbsent(
              inputs.outputPath,
              "published output",
              "publication-cleanup",
            );
          } catch (cleanupFailure) {
            error.details = {
              ...(isPlainObject(error.details) ? error.details : {}),
              cleanupError: cleanupFailure.message,
              retainedPublishedPath: inputs.outputPath,
            };
          }
        }
      } else {
        try {
          await dependencies.removeDirectory(inputs.outputPath);
          await assertPathAbsent(
            inputs.outputPath,
            "published output",
            "publication-cleanup",
          );
        } catch (cleanupFailure) {
          error.details = {
            ...(isPlainObject(error.details) ? error.details : {}),
            cleanupError: cleanupFailure.message,
            retainedPublishedPath: inputs.outputPath,
          };
        }
      }
      throw error;
    }
    return coordinatorReport;
  } catch (caughtError) {
    const error =
      caughtError instanceof CoordinatorError
        ? caughtError
        : new CoordinatorError("COORDINATOR_FAILED", caughtError.message, {
            stage: "coordinator",
          });
    let diagnosticPath;
    let cleanupError;
    let retainedStagingPath;
    if (ownsStage) {
      const preserveEvidence = failureRequiresEvidencePreservation(error);
      if (inputs.diagnosticPath) {
        try {
          await assertPathAbsent(
            inputs.diagnosticPath,
            "diagnostic output",
            "diagnostics",
          );
          await rename(stageDirectory, inputs.diagnosticPath);
          diagnosticPath = inputs.diagnosticPath;
          ownsStage = false;
        } catch (diagnosticError) {
          if (preserveEvidence) {
            retainedStagingPath = stageDirectory;
          } else {
            try {
              await dependencies.removeDirectory(stageDirectory);
            } catch (removalError) {
              cleanupError = removalError.message;
              retainedStagingPath = stageDirectory;
            }
          }
          ownsStage = false;
          error.details = {
            ...(isPlainObject(error.details) ? error.details : {}),
            diagnosticPreservationError: diagnosticError.message,
          };
        }
      } else if (preserveEvidence) {
        retainedStagingPath = stageDirectory;
        ownsStage = false;
      } else {
        try {
          await dependencies.removeDirectory(stageDirectory);
        } catch (removalError) {
          cleanupError = removalError.message;
          retainedStagingPath = stageDirectory;
        }
        ownsStage = false;
      }
    }
    if (diagnosticPath) {
      error.details = {
        ...(isPlainObject(error.details) ? error.details : {}),
        diagnosticPath,
      };
    }
    if (cleanupError) {
      error.details = {
        ...(isPlainObject(error.details) ? error.details : {}),
        cleanupError,
        retainedStagingPath,
      };
    } else if (retainedStagingPath) {
      error.details = {
        ...(isPlainObject(error.details) ? error.details : {}),
        retainedStagingPath,
      };
    }
    throw error;
  }
}

export async function runPowerPointNativeCoordinator(options) {
  if (arguments.length !== 1) {
    fail(
      "ARGUMENT_INVALID",
      "production coordinator does not accept dependency overrides",
      { stage: "arguments" },
    );
  }
  assert(
    process.platform === "win32",
    "PLATFORM_UNSUPPORTED",
    "native PowerPoint coordination requires Windows",
    { stage: "arguments" },
  );
  assert(
    isAbsolute(process.execPath),
    "TRUSTED_NODE_INVALID",
    "production Node executable path must be absolute",
    { stage: "trusted-runtime" },
  );
  const powerShellCommand = await resolveTrustedWindowsPowerShell();
  const childEnvironment = sanitizedChildEnvironment(
    process.env,
    powerShellCommand,
  );
  const dependencies = Object.freeze({
    childEnvironment,
    childRunner: defaultChildRunner,
    coordinatorId: PRODUCTION_COORDINATOR_ID,
    executionProfile: "production",
    packageQa: PACKAGE_QA,
    powerShellCommand,
    removeDirectory: removeDirectoryWithRetry,
    skeletonHelper: SKELETON_HELPER,
    specCompiler: SPEC_COMPILER,
    worker: WORKER,
  });
  return runCoordinator(options, dependencies);
}

export async function runPowerPointNativeCoordinatorForTest(options, harness) {
  assert(
    arguments.length === 2 && isPlainObject(harness),
    "TEST_HARNESS_INVALID",
    "test-only coordinator requires an explicit harness",
    { stage: "arguments" },
  );
  const allowedHarnessKeys = new Set([
    "childRunner",
    "publicationHook",
    "removeDirectory",
  ]);
  assert(
    Object.keys(harness).every((key) => allowedHarnessKeys.has(key)),
    "TEST_HARNESS_INVALID",
    "test-only harness contains an unsupported dependency override",
    { stage: "arguments" },
  );
  assert(
    typeof harness.childRunner === "function",
    "TEST_HARNESS_INVALID",
    "test-only coordinator requires an injected stub child runner",
    { stage: "arguments" },
  );
  const testSystemRoot =
    environmentValue(process.env, "SystemRoot") ?? String.raw`C:\Windows`;
  const testPowerShellCommand = trustedPowerShellCandidate({
    ...process.env,
    SystemRoot: testSystemRoot,
  });
  const childEnvironment = sanitizedChildEnvironment(
    { ...process.env, SystemRoot: testSystemRoot },
    testPowerShellCommand,
  );
  const dependencies = Object.freeze({
    childEnvironment,
    childRunner: harness.childRunner,
    coordinatorId: TEST_COORDINATOR_ID,
    executionProfile: "test-only",
    packageQa: PACKAGE_QA,
    powerShellCommand: testPowerShellCommand,
    publicationHook: harness.publicationHook,
    removeDirectory: harness.removeDirectory ?? removeDirectoryWithRetry,
    skeletonHelper: SKELETON_HELPER,
    specCompiler: SPEC_COMPILER,
    worker: WORKER,
  });
  return runCoordinator(options, dependencies);
}

export function parseCoordinatorArgs(argv) {
  const values = {};
  const errors = [];
  const allowed = new Set([
    "--approve-smoke",
    "--diagnostic-output",
    "--mode",
    "--output",
    "--plan",
    "--smoke-bundle",
  ]);
  const booleanFlags = new Set(["--approve-smoke"]);
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) {
      errors.push(`unknown argument: ${flag}`);
      continue;
    }
    if (Object.hasOwn(values, flag)) errors.push(`duplicate argument: ${flag}`);
    if (booleanFlags.has(flag)) {
      values[flag] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      errors.push(`missing value for ${flag}`);
      continue;
    }
    values[flag] = value;
    index += 1;
  }
  for (const flag of ["--mode", "--plan", "--output"]) {
    if (!Object.hasOwn(values, flag)) errors.push(`missing required argument: ${flag}`);
  }
  if (values["--mode"] && !["smoke", "full"].includes(values["--mode"])) {
    errors.push("--mode must be smoke or full");
  }
  if (values["--mode"] === "full") {
    for (const flag of ["--smoke-bundle", "--approve-smoke"]) {
      if (!Object.hasOwn(values, flag)) errors.push(`full mode requires ${flag}`);
    }
  }
  if (values["--mode"] === "smoke") {
    for (const flag of ["--smoke-bundle", "--approve-smoke"]) {
      if (Object.hasOwn(values, flag)) errors.push(`smoke mode does not accept ${flag}`);
    }
  }
  if (errors.length > 0) {
    throw new CoordinatorError("ARGUMENT_INVALID", "invalid coordinator arguments", {
      stage: "arguments",
      details: { errors },
    });
  }
  return {
    help: false,
    options: {
      ...(values["--approve-smoke"] ? { approveSmoke: true } : {}),
      ...(values["--diagnostic-output"]
        ? { diagnosticOutput: values["--diagnostic-output"] }
        : {}),
      mode: values["--mode"],
      output: values["--output"],
      plan: values["--plan"],
      ...(values["--smoke-bundle"]
        ? { smokeBundle: values["--smoke-bundle"] }
        : {}),
    },
  };
}

function errorReceipt(error) {
  const normalized =
    error instanceof CoordinatorError
      ? error
      : new CoordinatorError("COORDINATOR_FAILED", error.message, {
          stage: "coordinator",
        });
  return {
    schemaVersion: 1,
    status: "COORDINATOR_ERROR",
    code: normalized.code,
    stage: normalized.stage,
    message: normalized.message,
    ...(normalized.details !== undefined ? { details: normalized.details } : {}),
  };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseCoordinatorArgs(argv);
    if (parsed.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const report = await runPowerPointNativeCoordinator(parsed.options);
    process.stdout.write(`${canonicalizeJson(report)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${canonicalizeJson(errorReceipt(error))}\n`);
    return error instanceof CoordinatorError && error.code === "ARGUMENT_INVALID" ? 2 : 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
