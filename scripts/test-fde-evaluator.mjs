#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  appendFile,
  cp,
  copyFile,
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
const nativePowerpointExample = join(
  root,
  "skills",
  "fde",
  "fde-readout",
  "assets",
  "examples",
  "lattice-harbor-readout.pptx",
);
const cli = join(root, "scripts", "evaluate-fde-run.mjs");
const temporaryRoot = await mkdtemp(join(tmpdir(), "fde-e2e-evaluator-"));
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;
  for (const [entryName, value] of Object.entries(entries)) {
    const name = Buffer.from(entryName, "utf8");
    const content = Buffer.from(value, "utf8");
    const entryCrc32 = crc32(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(entryCrc32, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    const localRecord = Buffer.concat([localHeader, name, content]);
    localRecords.push(localRecord);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(entryCrc32, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralRecords.push(Buffer.concat([centralHeader, name]));
    localOffset += localRecord.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(Object.keys(entries).length, 8);
  endOfCentralDirectory.writeUInt16LE(Object.keys(entries).length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(localOffset, 16);
  return Buffer.concat([
    ...localRecords,
    centralDirectory,
    endOfCentralDirectory,
  ]);
}

function addZipComment(bytes, comment) {
  const signature = 0x06054b50;
  let endOfCentralDirectory = -1;
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (
      bytes.readUInt32LE(index) === signature &&
      index + 22 + bytes.readUInt16LE(index + 20) === bytes.length
    ) {
      endOfCentralDirectory = index;
      break;
    }
  }
  if (endOfCentralDirectory < 0) throw new Error("test PPTX has no EOCD");
  const output = Buffer.concat([bytes, comment]);
  output.writeUInt16LE(comment.length, endOfCentralDirectory + 20);
  return output;
}

function minimalPptxEntries(overrides = {}) {
  return {
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    "ppt/presentation.xml":
      '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels":
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    "ppt/slides/slide1.xml":
      '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"></p:sld>',
    ...overrides,
  };
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

async function configureLivePowerpoint(
  fixture,
  sourcePath,
  { slideCount } = {},
) {
  const runPath = join(fixture, "run.json");
  const run = await readJson(runPath);
  run.evaluationMode = "live";
  const powerpointPath = join(fixture, "artifacts", "readout.pptx");
  await copyFile(sourcePath, powerpointPath);
  const powerpointHash = sha256(await readFile(powerpointPath));
  const powerpointDescriptor = run.artifacts.find(
    (artifact) => artifact.format === "powerpoint",
  );
  powerpointDescriptor.path = "artifacts/readout.pptx";
  powerpointDescriptor.sha256 = powerpointHash;
  powerpointDescriptor.representation = "native-pptx";

  const powerpointQaDescriptor = run.evidence.find(
    (entry) => entry.kind === "powerpointQa",
  );
  const powerpointQaPath = join(fixture, powerpointQaDescriptor.path);
  const powerpointQa = await readJson(powerpointQaPath);
  powerpointQa.artifactSha256 = powerpointHash;
  if (slideCount !== undefined && powerpointQa.shapeStats) {
    powerpointQa.shapeStats.slideCount = slideCount;
  }
  await writeJson(powerpointQaPath, powerpointQa);
  powerpointQaDescriptor.sha256 = sha256(await readFile(powerpointQaPath));

  const humanReviewDescriptor = run.evidence.find(
    (entry) => entry.kind === "humanReview",
  );
  const humanReviewPath = join(fixture, humanReviewDescriptor.path);
  const humanReview = await readJson(humanReviewPath);
  humanReview.artifactHashes.powerpoint = powerpointHash;
  await writeJson(humanReviewPath, humanReview);
  humanReviewDescriptor.sha256 = sha256(await readFile(humanReviewPath));
  await writeJson(runPath, run);
}

async function expectLivePowerpointRejected(name, bytes, message) {
  const sourcePath = join(temporaryRoot, `${name}.pptx`);
  await writeFile(sourcePath, bytes);
  const fixture = await copyPassFixture(name);
  await configureLivePowerpoint(fixture, sourcePath);
  const result = await evaluateFixture(fixture);
  check(
    reasonCodes(result).has("final_outcome.powerpoint_requires_native_pptx"),
    message,
  );
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

  const liveSnapshotFixture = await copyPassFixture("live-snapshot");
  const liveSnapshotRunPath = join(liveSnapshotFixture, "run.json");
  const liveSnapshotRun = await readJson(liveSnapshotRunPath);
  liveSnapshotRun.evaluationMode = "live";
  await writeJson(liveSnapshotRunPath, liveSnapshotRun);
  const liveSnapshotResult = await evaluateFixture(liveSnapshotFixture);
  check(
    liveSnapshotResult.evaluationMode === "live" &&
      reasonCodes(liveSnapshotResult).has(
        "final_outcome.powerpoint_requires_native_pptx",
      ),
    "live PowerPoint evaluation must reject a synthetic replay snapshot",
  );

  await expectLivePowerpointRejected(
    "live-malformed-xml",
    createStoredZip({
      ...minimalPptxEntries(),
      "ppt/presentation.xml":
        '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst>&broken;</p:presentation><extra/>',
    }),
    "live PowerPoint evaluation must reject a ZIP with malformed XML contents",
  );

  await expectLivePowerpointRejected(
    "live-invalid-entity",
    createStoredZip(
      minimalPptxEntries({
        "ppt/slides/slide1.xml":
          '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">&#0;</p:sld>',
      }),
    ),
    "live PowerPoint evaluation must reject XML-invalid numeric entities",
  );

  await expectLivePowerpointRejected(
    "live-spoofed-relationships",
    createStoredZip(
      minimalPptxEntries({
        "_rels/.rels":
          '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><!-- <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/> --></Relationships>',
      }),
    ),
    "live PowerPoint evaluation must ignore relationship text in comments",
  );

  await expectLivePowerpointRejected(
    "live-rebound-relationship-namespace",
    createStoredZip(
      minimalPptxEntries({
        "_rels/.rels":
          '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship xmlns="urn:not-opc" Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
      }),
    ),
    "live PowerPoint evaluation must reject relationship namespace rebinding",
  );

  await expectLivePowerpointRejected(
    "live-malformed-utf8",
    createStoredZip(
      minimalPptxEntries({
        "ppt/slides/slide1.xml": Buffer.from([0xff, 0xfe, 0x00]),
      }),
    ),
    "live PowerPoint evaluation must reject malformed UTF-8 XML",
  );

  await expectLivePowerpointRejected(
    "live-invalid-xml-declaration",
    createStoredZip(
      minimalPptxEntries({
        "ppt/slides/slide1.xml":
          '<?xml version="1.0" garbage?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"></p:sld>',
      }),
    ),
    "live PowerPoint evaluation must reject invalid XML declarations",
  );

  await expectLivePowerpointRejected(
    "live-leading-declaration-whitespace",
    createStoredZip(
      minimalPptxEntries({
        "ppt/slides/slide1.xml":
          ' \n<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
      }),
    ),
    "live PowerPoint evaluation must reject whitespace before an XML declaration",
  );

  await expectLivePowerpointRejected(
    "live-invalid-tag-whitespace",
    createStoredZip(
      minimalPptxEntries({
        "ppt/slides/slide1.xml":
          '<?xml version="1.0"?>< p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
      }),
    ),
    "live PowerPoint evaluation must reject whitespace after an opening bracket",
  );

  await expectLivePowerpointRejected(
    "live-invalid-self-close-whitespace",
    createStoredZip(
      minimalPptxEntries({
        "ppt/slides/slide1.xml":
          '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/ >',
      }),
    ),
    "live PowerPoint evaluation must reject whitespace after a self-closing slash",
  );

  await expectLivePowerpointRejected(
    "live-non-xml-whitespace",
    createStoredZip(
      minimalPptxEntries({
        "ppt/slides/slide1.xml":
          '<?xml version="1.0"?><p:sld\u00a0xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
      }),
    ),
    "live PowerPoint evaluation must reject non-XML whitespace as an attribute separator",
  );

  await expectLivePowerpointRejected(
    "live-invalid-namespace-declaration",
    createStoredZip(
      minimalPptxEntries({
        "ppt/slides/slide1.xml":
          '<?xml version="1.0"?><p:sld xmlns:="urn:not-valid" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
      }),
    ),
    "live PowerPoint evaluation must reject invalid namespace declarations",
  );

  await expectLivePowerpointRejected(
    "live-malformed-namespace-prefix",
    createStoredZip(
      minimalPptxEntries({
        "ppt/slides/slide1.xml":
          '<?xml version="1.0"?><p:sld xmlns:bad:name="urn:not-valid" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
      }),
    ),
    "live PowerPoint evaluation must reject malformed namespace prefixes",
  );

  await expectLivePowerpointRejected(
    "live-invalid-comment-ending",
    createStoredZip(
      minimalPptxEntries({
        "ppt/slides/slide1.xml":
          '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><!--invalid---></p:sld>',
      }),
    ),
    "live PowerPoint evaluation must reject comments ending in a hyphen",
  );

  await expectLivePowerpointRejected(
    "live-encoding-mismatch",
    createStoredZip(
      minimalPptxEntries({
        "ppt/slides/slide1.xml":
          '<?xml version="1.0" encoding="UTF-16"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
      }),
    ),
    "live PowerPoint evaluation must reject XML encoding declarations that contradict UTF-8 bytes",
  );

  const deepPresentation =
    '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    "<p:x>".repeat(600) +
    '<p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst>' +
    "</p:x>".repeat(600) +
    "</p:presentation>";
  await expectLivePowerpointRejected(
    "live-excessive-xml-depth",
    createStoredZip(
      minimalPptxEntries({
        "ppt/presentation.xml": deepPresentation,
      }),
    ),
    "live PowerPoint evaluation must reject excessive XML nesting",
  );

  const widePresentation =
    '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    "<p:x/>".repeat(100_001) +
    '<p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>';
  await expectLivePowerpointRejected(
    "live-excessive-xml-width",
    createStoredZip(
      minimalPptxEntries({
        "ppt/presentation.xml": widePresentation,
      }),
    ),
    "live PowerPoint evaluation must reject excessive XML node counts",
  );

  const corruptCrcPackage = createStoredZip(minimalPptxEntries());
  const centralDirectorySignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const centralDirectoryOffset = corruptCrcPackage.indexOf(
    centralDirectorySignature,
  );
  corruptCrcPackage.writeUInt32LE(
    corruptCrcPackage.readUInt32LE(centralDirectoryOffset + 16) ^ 1,
    centralDirectoryOffset + 16,
  );
  await expectLivePowerpointRejected(
    "live-corrupt-crc",
    corruptCrcPackage,
    "live PowerPoint evaluation must reject corrupt entry CRC values",
  );

  const splitNamePackage = createStoredZip(minimalPptxEntries());
  splitNamePackage[30] = "X".charCodeAt(0);
  await expectLivePowerpointRejected(
    "live-split-name",
    splitNamePackage,
    "live PowerPoint evaluation must reject mismatched local and central filenames",
  );

  const backslashEntries = Object.fromEntries(
    Object.entries(minimalPptxEntries()).map(([name, content]) => [
      name.replaceAll("/", "\\"),
      content,
    ]),
  );
  await expectLivePowerpointRejected(
    "live-backslash-paths",
    createStoredZip(backslashEntries),
    "live PowerPoint evaluation must reject backslash OPC entry paths",
  );

  const contradictoryDirectorySizePackage = createStoredZip(
    minimalPptxEntries(),
  );
  contradictoryDirectorySizePackage.writeUInt32LE(
    0,
    contradictoryDirectorySizePackage.length - 22 + 12,
  );
  await expectLivePowerpointRejected(
    "live-contradictory-directory-size",
    contradictoryDirectorySizePackage,
    "live PowerPoint evaluation must reject contradictory central-directory sizes",
  );

  const liveNativeFixture = await copyPassFixture("live-native-pptx");
  await configureLivePowerpoint(liveNativeFixture, nativePowerpointExample, {
    slideCount: 11,
  });
  const liveNativeResult = await evaluateFixture(liveNativeFixture);
  check(
    liveNativeResult.status === "passed" &&
      liveNativeResult.evaluationMode === "live",
    "live PowerPoint evaluation must accept native PPTX bytes with current hash-bound QA",
  );

  const entityNamespaceFixture = await copyPassFixture(
    "live-entity-namespace",
  );
  const entityNamespacePath = join(temporaryRoot, "entity-namespace.pptx");
  await writeFile(
    entityNamespacePath,
    createStoredZip(
      minimalPptxEntries({
        "ppt/presentation.xml":
          '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/ma&#x69;n" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>',
        "ppt/slides/slide1.xml":
          '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/ma&#x69;n"></p:sld>',
      }),
    ),
  );
  await configureLivePowerpoint(
    entityNamespaceFixture,
    entityNamespacePath,
    { slideCount: 1 },
  );
  const entityNamespaceResult = await evaluateFixture(
    entityNamespaceFixture,
  );
  check(
    entityNamespaceResult.status === "passed",
    "live PowerPoint evaluation must expand valid namespace entities",
  );

  const commentedNativeFixture = await copyPassFixture(
    "live-commented-native-pptx",
  );
  const commentedNativePath = join(temporaryRoot, "commented-native.pptx");
  const zipComment = Buffer.concat([
    Buffer.from("comment-before-signature"),
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    Buffer.from("comment-after-signature"),
  ]);
  await writeFile(
    commentedNativePath,
    addZipComment(await readFile(nativePowerpointExample), zipComment),
  );
  await configureLivePowerpoint(
    commentedNativeFixture,
    commentedNativePath,
    { slideCount: 11 },
  );
  const commentedNativeResult = await evaluateFixture(
    commentedNativeFixture,
  );
  check(
    commentedNativeResult.status === "passed",
    "live PowerPoint evaluation must accept a legal ZIP comment containing an EOCD signature",
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
  "FDE end-to-end evaluator tests passed: replay and live modes, trusted QA, hard gates, hashes, budgets, reliability, and CLI.",
);
