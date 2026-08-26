#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

export const GRADER_VERSION = "hill-0-evaluator/1.3.0";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultFixturesRoot = resolve(root, "evals", "fde-e2e", "fixtures");
const defaultBudgetsPath = resolve(root, "evals", "fde-e2e", "budgets.json");
const axisNames = [
  "safety",
  "finalOutcome",
  "artifactQuality",
  "traceQuality",
  "efficiency",
  "reliability",
  "humanApproval",
];
const htmlFinalFailureCodes = {
  opens: "final_outcome.html_open_failed",
  planHashMatches: "final_outcome.html_plan_hash_check_failed",
  desktopAllSlides: "final_outcome.html_desktop_slides_incomplete",
  phoneReadable: "final_outcome.html_phone_unreadable",
  phoneControlsUsable: "final_outcome.html_phone_controls_unusable",
  exportAllSlides: "final_outcome.html_export_slides_incomplete",
  navigationPass: "final_outcome.html_navigation_failed",
  notesPass: "final_outcome.html_notes_failed",
  fullscreenPass: "final_outcome.html_fullscreen_failed",
  consoleClean: "final_outcome.html_console_not_clean",
  faultIsolated: "final_outcome.html_fault_not_isolated",
  noExternalWindow: "final_outcome.html_external_window_opened",
};

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function requireNonNegativeNumber(value, label) {
  if (typeof value !== "number" || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function safeFixturePath(fixtureDirectory, path, label) {
  requireString(path, `${label}.path`);
  const candidate = resolve(fixtureDirectory, path);
  const pathFromFixture = relative(fixtureDirectory, candidate);
  if (
    pathFromFixture.length === 0 ||
    pathFromFixture.startsWith("..") ||
    isAbsolute(pathFromFixture)
  ) {
    throw new Error(`${label}.path must stay inside the fixture directory`);
  }
  return candidate;
}

async function safeExistingFixturePath(fixtureDirectory, path, label) {
  const [canonicalRoot, canonicalPath] = await Promise.all([
    realpath(fixtureDirectory),
    realpath(path),
  ]);
  const pathFromFixture = relative(canonicalRoot, canonicalPath);
  if (
    pathFromFixture.length === 0 ||
    pathFromFixture.startsWith("..") ||
    isAbsolute(pathFromFixture)
  ) {
    throw new Error(`${label}.path must resolve inside the fixture directory`);
  }
  return canonicalPath;
}

async function readJson(path, label) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${label} could not be read: ${error.message}`);
  }
  try {
    return { source, value: JSON.parse(source) };
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function validateDescriptor(descriptor, label) {
  requireObject(descriptor, label);
  requireString(descriptor.id, `${label}.id`);
  requireString(descriptor.path, `${label}.path`);
  if (!isSha256(descriptor.sha256)) {
    throw new Error(`${label}.sha256 must be a lowercase SHA-256 value`);
  }
}

async function loadJsonDescriptors(fixtureDirectory, descriptors, label) {
  if (!Array.isArray(descriptors) || descriptors.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }

  const loaded = new Map();
  for (const [index, descriptor] of descriptors.entries()) {
    const descriptorLabel = `${label}[${index}]`;
    validateDescriptor(descriptor, descriptorLabel);
    const kind = requireString(descriptor.kind, `${descriptorLabel}.kind`);
    if (loaded.has(kind)) {
      throw new Error(`${label} contains duplicate kind ${kind}`);
    }
    const lexicalPath = safeFixturePath(
      fixtureDirectory,
      descriptor.path,
      descriptorLabel,
    );
    const path = await safeExistingFixturePath(
      fixtureDirectory,
      lexicalPath,
      descriptorLabel,
    );
    const file = await readJson(path, descriptorLabel);
    const actualSha256 = hash(Buffer.from(file.source));
    if (actualSha256 !== descriptor.sha256) {
      throw new Error(
        `${descriptorLabel} hash mismatch: expected ${descriptor.sha256}, got ${actualSha256}`,
      );
    }
    loaded.set(kind, {
      descriptor,
      value: requireObject(file.value, descriptorLabel),
      actualSha256,
    });
  }
  return loaded;
}

async function loadArtifacts(fixtureDirectory, descriptors) {
  if (!Array.isArray(descriptors) || descriptors.length === 0) {
    throw new Error("run.artifacts must be a non-empty array");
  }

  const loaded = new Map();
  for (const [index, descriptor] of descriptors.entries()) {
    const label = `run.artifacts[${index}]`;
    validateDescriptor(descriptor, label);
    requireString(descriptor.format, `${label}.format`);
    if (loaded.has(descriptor.id)) {
      throw new Error(`run.artifacts contains duplicate id ${descriptor.id}`);
    }

    const path = safeFixturePath(fixtureDirectory, descriptor.path, label);
    try {
      const canonicalPath = await safeExistingFixturePath(
        fixtureDirectory,
        path,
        label,
      );
      const bytes = await readFile(canonicalPath);
      loaded.set(descriptor.id, {
        descriptor,
        exists: true,
        actualSha256: hash(bytes),
        bytes,
        canonicalPath,
      });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new Error(`${label} could not be read: ${error.message}`);
      }
      loaded.set(descriptor.id, {
        descriptor,
        exists: false,
        actualSha256: null,
        bytes: null,
        canonicalPath: path,
      });
    }
  }
  return loaded;
}

function requireKind(map, kind, label) {
  const entry = map.get(kind);
  if (!entry) throw new Error(`${label} requires kind ${kind}`);
  return entry;
}

function artifactForFormat(artifacts, format) {
  return [...artifacts.values()].find(
    (entry) => entry.descriptor.format === format,
  );
}

function artifactHashes(artifacts) {
  return Object.fromEntries(
    [...artifacts.entries()].map(([id, entry]) => [id, entry.actualSha256]),
  );
}

function descriptorHashes(entries) {
  return Object.fromEntries(
    [...entries.values()].map((entry) => [
      entry.descriptor.id,
      entry.actualSha256,
    ]),
  );
}

function buildAxes() {
  return Object.fromEntries(
    axisNames.map((axis) => [
      axis,
      {
        status: "passed",
        failureReasons: [],
        diagnostics: {},
      },
    ]),
  );
}

function addFailure(axes, axis, code, message, evidence) {
  const reason = { axis, code, message };
  if (evidence !== undefined) reason.evidence = evidence;
  axes[axis].failureReasons.push(reason);
  axes[axis].status = "failed";
}

function allChecksPass(checks) {
  return (
    checks &&
    typeof checks === "object" &&
    !Array.isArray(checks) &&
    Object.keys(checks).length > 0 &&
    Object.values(checks).every((value) => value === true)
  );
}

function requireStringSet(value, label) {
  const entries = requireArray(value, label).map((entry, index) =>
    requireString(entry, `${label}[${index}]`),
  );
  if (new Set(entries).size !== entries.length) {
    throw new Error(`${label} must contain distinct strings`);
  }
  return entries;
}

function parseArtifactJson(artifact, label) {
  try {
    return requireObject(
      JSON.parse(artifact.bytes.toString("utf8")),
      label,
    );
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

function setsEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((entry) => new Set(right).has(entry))
  );
}

function validateSmokeEvidence({
  qa,
  artifact,
  artifacts,
  currentPlanHash,
  metrics,
  trace,
  humanReview,
}) {
  const smoke = requireObject(qa.smokeEvidence, "powerpointQa.smokeEvidence");
  const candidateSha256 = requireString(
    smoke.candidateSha256,
    "powerpointQa.smokeEvidence.candidateSha256",
  );
  const planSha256 = requireString(
    smoke.planSha256,
    "powerpointQa.smokeEvidence.planSha256",
  );
  if (!isSha256(candidateSha256) || !isSha256(planSha256)) {
    throw new Error(
      "powerpointQa.smokeEvidence plan and candidate hashes must be lowercase SHA-256 values",
    );
  }

  const contactSheet = requireObject(
    smoke.contactSheet,
    "powerpointQa.smokeEvidence.contactSheet",
  );
  const contactSheetArtifactId = requireString(
    contactSheet.artifactId,
    "powerpointQa.smokeEvidence.contactSheet.artifactId",
  );
  const contactSheetSha256 = requireString(
    contactSheet.sha256,
    "powerpointQa.smokeEvidence.contactSheet.sha256",
  );
  if (!isSha256(contactSheetSha256)) {
    throw new Error(
      "powerpointQa.smokeEvidence.contactSheet.sha256 must be a lowercase SHA-256 value",
    );
  }
  const contactSheetArtifact = artifacts.get(contactSheetArtifactId);
  if (!contactSheetArtifact?.exists) {
    throw new Error("PowerPoint smoke contact-sheet artifact must exist");
  }
  if (
    contactSheetArtifact.descriptor.format !== "contact-sheet" ||
    contactSheetArtifact.canonicalPath === artifact?.canonicalPath
  ) {
    throw new Error(
      "PowerPoint smoke contact-sheet evidence must reference a distinct contact-sheet artifact",
    );
  }

  const planArtifact = artifactForFormat(artifacts, "plan");
  if (
    new Set([
      planArtifact.canonicalPath,
      artifact.canonicalPath,
      contactSheetArtifact.canonicalPath,
    ]).size !== 3
  ) {
    throw new Error(
      "PowerPoint smoke plan, candidate, and contact sheet must use distinct artifact paths",
    );
  }
  const plan = parseArtifactJson(planArtifact, "PowerPoint smoke plan artifact");
  const planSlides = requireArray(
    plan.slides,
    "PowerPoint smoke plan artifact.slides",
  );
  const planSlidesById = new Map(
    planSlides.map((slide, index) => {
      const label = `PowerPoint smoke plan artifact.slides[${index}]`;
      requireObject(slide, label);
      const id = requireString(slide.id, `${label}.id`);
      return [
        id,
        {
          id,
          family: requireString(slide.family, `${label}.family`),
          evidenceIds: requireStringSet(
            slide.evidenceIds,
            `${label}.evidenceIds`,
          ),
        },
      ];
    }),
  );
  if (planSlidesById.size !== planSlides.length) {
    throw new Error("PowerPoint smoke plan slide IDs must be distinct");
  }
  const smokeSelection = requireObject(
    plan.smokeSelection,
    "PowerPoint smoke plan artifact.smokeSelection",
  );
  const selectedPlanIds = requireStringSet(
    smokeSelection.activePlanIds,
    "PowerPoint smoke plan artifact.smokeSelection.activePlanIds",
  );
  const densestPlanId = requireString(
    smokeSelection.densestPlanId,
    "PowerPoint smoke plan artifact.smokeSelection.densestPlanId",
  );

  const snapshot = parseArtifactJson(
    artifact,
    "PowerPoint smoke candidate snapshot",
  );
  const snapshotSlides = requireArray(
    snapshot.activeSlides,
    "PowerPoint smoke candidate snapshot.activeSlides",
  );
  const snapshotInventory = requireObject(
    snapshot.packageInventory,
    "PowerPoint smoke candidate snapshot.packageInventory",
  );
  const snapshotNativeTable = requireObject(
    snapshot.nativeTable,
    "PowerPoint smoke candidate snapshot.nativeTable",
  );
  requireString(
    snapshotNativeTable.slideId,
    "PowerPoint smoke candidate snapshot.nativeTable.slideId",
  );
  requireNonNegativeNumber(
    snapshotNativeTable.rows,
    "PowerPoint smoke candidate snapshot.nativeTable.rows",
  );
  requireNonNegativeNumber(
    snapshotNativeTable.columns,
    "PowerPoint smoke candidate snapshot.nativeTable.columns",
  );
  requireBoolean(
    snapshot.denseContentReadable,
    "PowerPoint smoke candidate snapshot.denseContentReadable",
  );

  const activeSlides = requireArray(
    smoke.activeSlides,
    "powerpointQa.smokeEvidence.activeSlides",
  ).map((slide, index) => {
    const label = `powerpointQa.smokeEvidence.activeSlides[${index}]`;
    requireObject(slide, label);
    return {
      slideId: requireString(slide.slideId, `${label}.slideId`),
      planId: requireString(slide.planId, `${label}.planId`),
      family: requireString(slide.family, `${label}.family`),
      denseRepresentative: requireBoolean(
        slide.denseRepresentative,
        `${label}.denseRepresentative`,
      ),
      shapeCount: requireNonNegativeNumber(
        slide.shapeCount,
        `${label}.shapeCount`,
      ),
      tableCount: requireNonNegativeNumber(
        slide.tableCount,
        `${label}.tableCount`,
      ),
      notesRelationshipId: requireString(
        slide.notesRelationshipId,
        `${label}.notesRelationshipId`,
      ),
      notesPart: requireString(slide.notesPart, `${label}.notesPart`),
      expectedEvidenceIds: requireStringSet(
        slide.expectedEvidenceIds,
        `${label}.expectedEvidenceIds`,
      ),
      evidenceIdsInNotes: requireStringSet(
        slide.evidenceIdsInNotes,
        `${label}.evidenceIdsInNotes`,
      ),
      legacyContentRemaining: requireBoolean(
        slide.legacyContentRemaining,
        `${label}.legacyContentRemaining`,
      ),
    };
  });

  const inventory = requireObject(
    smoke.packageInventory,
    "powerpointQa.smokeEvidence.packageInventory",
  );
  for (const field of [
    "activeSlideCount",
    "activeNotesPartCount",
    "packageSlidePartCount",
    "packageNotesPartCount",
    "orphanedCustomerSlidePartCount",
    "orphanedCustomerNotesPartCount",
  ]) {
    requireNonNegativeNumber(
      inventory[field],
      `powerpointQa.smokeEvidence.packageInventory.${field}`,
    );
  }

  const canvas = requireObject(
    smoke.canvas,
    "powerpointQa.smokeEvidence.canvas",
  );
  for (const field of [
    "invokeCalls",
    "getModelCalls",
    "getModelFailures",
    "actionCount",
    "failures",
    "otherToolCalls",
    "otherToolFailures",
  ]) {
    requireNonNegativeNumber(
      canvas[field],
      `powerpointQa.smokeEvidence.canvas.${field}`,
    );
  }

  const usage = requireObject(
    smoke.usage,
    "powerpointQa.smokeEvidence.usage",
  );
  for (const field of ["elapsedTimeMs", "modelCalls", "inputTokens"]) {
    requireNonNegativeNumber(
      usage[field],
      `powerpointQa.smokeEvidence.usage.${field}`,
    );
  }
  const humanDecision = requireString(
    smoke.humanDecision,
    "powerpointQa.smokeEvidence.humanDecision",
  );
  const denseContentReadable = requireBoolean(
    smoke.denseContentReadable,
    "powerpointQa.smokeEvidence.denseContentReadable",
  );
  const nativeTable = requireObject(
    smoke.nativeTable,
    "powerpointQa.smokeEvidence.nativeTable",
  );
  requireString(nativeTable.slideId, "powerpointQa.smokeEvidence.nativeTable.slideId");
  requireNonNegativeNumber(
    nativeTable.rows,
    "powerpointQa.smokeEvidence.nativeTable.rows",
  );
  requireNonNegativeNumber(
    nativeTable.columns,
    "powerpointQa.smokeEvidence.nativeTable.columns",
  );
  const shapeStats = requireObject(qa.shapeStats, "powerpointQa.shapeStats");
  for (const field of [
    "slideCount",
    "totalShapes",
    "medianShapesPerSlide",
    "nativeTables",
  ]) {
    requireNonNegativeNumber(shapeStats[field], `powerpointQa.shapeStats.${field}`);
  }

  const snapshotMatchesSlides =
    snapshotSlides.length === activeSlides.length &&
    snapshotSlides.every((snapshotSlide, index) => {
      requireObject(
        snapshotSlide,
        `PowerPoint smoke candidate snapshot.activeSlides[${index}]`,
      );
      const evidenceSlide = activeSlides[index];
      return (
        snapshotSlide.slideId === evidenceSlide.slideId &&
        snapshotSlide.planId === evidenceSlide.planId &&
        snapshotSlide.family === evidenceSlide.family &&
        snapshotSlide.shapeCount === evidenceSlide.shapeCount &&
        snapshotSlide.tableCount === evidenceSlide.tableCount &&
        snapshotSlide.notesRelationshipId ===
          evidenceSlide.notesRelationshipId &&
        snapshotSlide.notesPart === evidenceSlide.notesPart &&
        snapshotSlide.legacyContentRemaining ===
          evidenceSlide.legacyContentRemaining &&
        setsEqual(
          requireStringSet(
            snapshotSlide.evidenceIdsInNotes,
            `PowerPoint smoke candidate snapshot.activeSlides[${index}].evidenceIdsInNotes`,
          ),
          evidenceSlide.evidenceIdsInNotes,
        )
      );
    });
  const snapshotMatchesInventory = [
    "activeSlideCount",
    "activeNotesPartCount",
    "packageSlidePartCount",
    "packageNotesPartCount",
    "orphanedCustomerSlidePartCount",
    "orphanedCustomerNotesPartCount",
  ].every((field) => {
    requireNonNegativeNumber(
      snapshotInventory[field],
      `PowerPoint smoke candidate snapshot.packageInventory.${field}`,
    );
    return snapshotInventory[field] === inventory[field];
  });
  const sortedShapeCounts = activeSlides
    .map((slide) => slide.shapeCount)
    .sort((left, right) => left - right);
  const medianShapeCount =
    sortedShapeCounts.length % 2 === 1
      ? sortedShapeCounts[Math.floor(sortedShapeCounts.length / 2)]
      : (sortedShapeCounts[sortedShapeCounts.length / 2 - 1] +
          sortedShapeCounts[sortedShapeCounts.length / 2]) /
        2;
  const shapeStatsMatch =
    shapeStats.slideCount === activeSlides.length &&
    shapeStats.totalShapes ===
      activeSlides.reduce((total, slide) => total + slide.shapeCount, 0) &&
    shapeStats.medianShapesPerSlide === medianShapeCount &&
    shapeStats.nativeTables ===
      activeSlides.reduce((total, slide) => total + slide.tableCount, 0);

  if (
    inventory.activeSlideCount !== activeSlides.length ||
    canvas.invokeCalls !== metrics.canvasCalls ||
    usage.elapsedTimeMs !== metrics.wallTimeMs ||
    usage.modelCalls !== metrics.modelCalls ||
    usage.inputTokens !== metrics.inputTokens ||
    trace.canvasCallsCaptured !== canvas.invokeCalls ||
    trace.canvasActionsCaptured !== canvas.actionCount ||
    trace.canvasFailuresCaptured !== canvas.failures ||
    trace.getModelFailuresCaptured !== canvas.getModelFailures ||
    trace.otherToolCallsCaptured !== canvas.otherToolCalls ||
    trace.otherToolFailuresCaptured !== canvas.otherToolFailures ||
    canvas.invokeCalls + canvas.otherToolCalls !== metrics.toolCalls ||
    canvas.failures + canvas.otherToolFailures !==
      metrics.failedToolCalls ||
    canvas.failures > canvas.invokeCalls ||
    canvas.getModelCalls > canvas.invokeCalls ||
    canvas.getModelFailures > canvas.getModelCalls ||
    canvas.getModelFailures > canvas.failures ||
    canvas.otherToolFailures > canvas.otherToolCalls ||
    !snapshotMatchesSlides ||
    !snapshotMatchesInventory ||
    snapshot.denseContentReadable !== denseContentReadable ||
    snapshotNativeTable.slideId !== nativeTable.slideId ||
    snapshotNativeTable.rows !== nativeTable.rows ||
    snapshotNativeTable.columns !== nativeTable.columns ||
    nativeTable.slideId !== activeSlides[2]?.slideId ||
    activeSlides[2]?.tableCount < 1 ||
    nativeTable.rows === 0 ||
    nativeTable.columns === 0 ||
    !shapeStatsMatch
  ) {
    throw new Error(
      "PowerPoint smoke evidence must reconcile with the candidate snapshot, run metrics, trace counts, and active slide inventory",
    );
  }

  const expectedFamilies = ["cover", "decision"];
  const exactlyThreeActiveSlides =
    activeSlides.length === 3 &&
    selectedPlanIds.length === 3 &&
    new Set(activeSlides.map((slide) => slide.slideId)).size === 3 &&
    selectedPlanIds.every(
      (planId, index) => planId === activeSlides[index].planId,
    ) &&
    activeSlides
      .slice(0, 2)
      .every((slide, index) => slide.family === expectedFamilies[index]) &&
    activeSlides[2].denseRepresentative === true &&
    activeSlides[2].planId === densestPlanId;
  const notesIsolated =
    new Set(
      activeSlides.map(
        (slide) => `${slide.slideId}:${slide.notesRelationshipId}`,
      ),
    ).size === activeSlides.length &&
    new Set(activeSlides.map((slide) => slide.notesPart)).size ===
      activeSlides.length;
  const noOrphanedCustomerParts =
    inventory.activeSlideCount === 3 &&
    inventory.activeNotesPartCount === 3 &&
    inventory.packageSlidePartCount === 3 &&
    inventory.packageNotesPartCount === 3 &&
    inventory.orphanedCustomerSlidePartCount === 0 &&
    inventory.orphanedCustomerNotesPartCount === 0;
  const planEvidenceBound =
    planSha256 === currentPlanHash &&
    candidateSha256 === artifact?.actualSha256 &&
    contactSheetSha256 === contactSheetArtifact.actualSha256 &&
    contactSheetArtifact.descriptor.sha256 ===
      contactSheetArtifact.actualSha256 &&
    contactSheetArtifact.descriptor.sourcePlanSha256 === currentPlanHash &&
    humanReview.contactSheetSha256 === contactSheetArtifact.actualSha256 &&
    humanDecision === humanReview.decision &&
    activeSlides.every((slide) => {
      const planSlide = planSlidesById.get(slide.planId);
      return (
        planSlide?.family === slide.family &&
        setsEqual(planSlide.evidenceIds, slide.expectedEvidenceIds) &&
        setsEqual(slide.expectedEvidenceIds, slide.evidenceIdsInNotes)
      );
    });
  const legacyContentRemoved = activeSlides.every(
    (slide) => slide.legacyContentRemaining === false,
  );

  const derivedChecks = {
    exactlyThreeActiveSlides,
    notesIsolated,
    noOrphanedCustomerParts,
    planEvidenceBound,
    legacyContentRemoved,
    denseContentReadable,
  };
  for (const [check, derived] of Object.entries(derivedChecks)) {
    qa.deterministicChecks[check] = derived;
  }

  return {
    activeSlideIds: activeSlides.map((slide) => slide.slideId),
    contactSheetSha256: contactSheetArtifact.actualSha256,
    packageInventory: inventory,
    canvas,
    derivedChecks,
  };
}

function validateHtmlFinalEvidence({ qa, artifact, currentPlanHash }) {
  const replay = requireObject(
    qa.replayEvidence,
    "htmlQa.replayEvidence",
  );
  const finalPlanSha256 = requireString(
    replay.finalPlanSha256,
    "htmlQa.replayEvidence.finalPlanSha256",
  );
  const finalHtmlSha256 = requireString(
    replay.finalHtmlSha256,
    "htmlQa.replayEvidence.finalHtmlSha256",
  );
  const embeddedPlanSha256 = requireString(
    replay.embeddedPlanSha256,
    "htmlQa.replayEvidence.embeddedPlanSha256",
  );
  if (
    !isSha256(finalPlanSha256) ||
    !isSha256(finalHtmlSha256) ||
    !isSha256(embeddedPlanSha256)
  ) {
    throw new Error(
      "htmlQa.replayEvidence final plan and HTML hashes must be lowercase SHA-256 values",
    );
  }
  const finalSlideCount = requireNonNegativeNumber(
    replay.finalSlideCount,
    "htmlQa.replayEvidence.finalSlideCount",
  );
  if (finalSlideCount === 0) {
    throw new Error("htmlQa.replayEvidence.finalSlideCount must be positive");
  }

  const captures = requireObject(
    replay.captures,
    "htmlQa.replayEvidence.captures",
  );
  const requiredCaptureNames = [
    "desktop",
    "phone",
    "export",
    "interactions",
    "console",
    "fault",
  ];
  const missingCaptureNames = requiredCaptureNames.filter(
    (name) => !Object.hasOwn(captures, name),
  );
  const unknownCaptureNames = Object.keys(captures).filter(
    (name) => !requiredCaptureNames.includes(name),
  );
  if (missingCaptureNames.length > 0 || unknownCaptureNames.length > 0) {
    throw new Error(
      `htmlQa.replayEvidence.captures must contain exactly ${requiredCaptureNames.join(", ")}`,
    );
  }

  const captureIds = new Set();
  function readCapture(name, stateFields, { slides = false } = {}) {
    const label = `htmlQa.replayEvidence.captures.${name}`;
    const capture = requireObject(captures[name], label);
    const captureId = requireString(capture.captureId, `${label}.captureId`);
    if (captureIds.has(captureId)) {
      throw new Error("htmlQa replay capture IDs must be distinct");
    }
    captureIds.add(captureId);
    const capturedPlanSha256 = requireString(
      capture.capturedPlanSha256,
      `${label}.capturedPlanSha256`,
    );
    const capturedHtmlSha256 = requireString(
      capture.capturedHtmlSha256,
      `${label}.capturedHtmlSha256`,
    );
    if (!isSha256(capturedPlanSha256) || !isSha256(capturedHtmlSha256)) {
      throw new Error(`${label} hashes must be lowercase SHA-256 values`);
    }
    let reviewedSlideCount;
    if (slides) {
      reviewedSlideCount =
        capture.reviewedSlideCount === null
          ? null
          : requireNonNegativeNumber(
              capture.reviewedSlideCount,
              `${label}.reviewedSlideCount`,
            );
    }
    const state = requireObject(capture.state, `${label}.state`);
    const missingStateFields = stateFields.filter(
      (field) => !Object.hasOwn(state, field),
    );
    const unknownStateFields = Object.keys(state).filter(
      (field) => !stateFields.includes(field),
    );
    if (missingStateFields.length > 0 || unknownStateFields.length > 0) {
      throw new Error(
        `${label}.state must contain exactly ${stateFields.join(", ")}`,
      );
    }
    for (const field of stateFields) {
      requireBoolean(state[field], `${label}.state.${field}`);
    }
    return {
      captureId,
      capturedPlanSha256,
      capturedHtmlSha256,
      reviewedSlideCount,
      state,
    };
  }

  const desktop = readCapture(
    "desktop",
    ["opened", "allSlidesReviewed"],
    { slides: true },
  );
  const phone = readCapture(
    "phone",
    ["readable", "controlsUsable"],
    { slides: true },
  );
  const exportCapture = readCapture(
    "export",
    ["allSlidesReviewed"],
    { slides: true },
  );
  const interactions = readCapture("interactions", [
    "navigationPass",
    "notesPass",
    "fullscreenPass",
  ]);
  const consoleCapture = readCapture("console", ["clean"]);
  const fault = readCapture("fault", [
    "isolated",
    "externalWindowOpened",
  ]);

  const finalHashesMatch =
    finalPlanSha256 === currentPlanHash &&
    finalHtmlSha256 === artifact.actualSha256;
  const isFinalCapture = (capture) =>
    finalHashesMatch &&
    capture.capturedPlanSha256 === finalPlanSha256 &&
    capture.capturedHtmlSha256 === finalHtmlSha256;
  const reviewedEverySlide = (capture) =>
    capture.reviewedSlideCount === finalSlideCount;

  const derivedChecks = {
    opens: isFinalCapture(desktop) && desktop.state.opened,
    planHashMatches:
      finalPlanSha256 === currentPlanHash &&
      embeddedPlanSha256 === finalPlanSha256 &&
      qa.planSha256 === currentPlanHash &&
      artifact.descriptor.sourcePlanSha256 === currentPlanHash,
    desktopAllSlides:
      isFinalCapture(desktop) &&
      reviewedEverySlide(desktop) &&
      desktop.state.allSlidesReviewed,
    phoneReadable:
      isFinalCapture(phone) &&
      reviewedEverySlide(phone) &&
      phone.state.readable,
    phoneControlsUsable:
      isFinalCapture(phone) &&
      reviewedEverySlide(phone) &&
      phone.state.controlsUsable,
    exportAllSlides:
      isFinalCapture(exportCapture) &&
      reviewedEverySlide(exportCapture) &&
      exportCapture.state.allSlidesReviewed,
    navigationPass:
      isFinalCapture(interactions) && interactions.state.navigationPass,
    notesPass: isFinalCapture(interactions) && interactions.state.notesPass,
    fullscreenPass:
      isFinalCapture(interactions) && interactions.state.fullscreenPass,
    consoleClean:
      isFinalCapture(consoleCapture) && consoleCapture.state.clean,
    faultIsolated: isFinalCapture(fault) && fault.state.isolated,
    noExternalWindow:
      isFinalCapture(fault) && fault.state.externalWindowOpened === false,
  };
  const contradictions = Object.entries(derivedChecks)
    .filter(([check, derived]) => qa.deterministicChecks[check] !== derived)
    .map(([check]) => check);
  if (contradictions.length > 0) {
    throw new Error(
      `htmlQa.deterministicChecks contradict replay evidence: ${contradictions.join(", ")}`,
    );
  }

  return {
    finalPlanSha256,
    finalHtmlSha256,
    embeddedPlanSha256,
    finalSlideCount,
    captures: Object.fromEntries(
      [
        desktop,
        phone,
        exportCapture,
        interactions,
        consoleCapture,
        fault,
      ].map((capture) => [
        capture.captureId,
        {
          finalHashBound: isFinalCapture(capture),
          reviewedSlideCount: capture.reviewedSlideCount ?? null,
        },
      ]),
    ),
    derivedChecks,
  };
}

function metricLabel(metric) {
  const labels = {
    wallTimeMs: "wall time",
    modelCalls: "model calls",
    inputTokens: "input tokens",
    toolCalls: "tool calls",
    canvasCalls: "PowerPoint canvas calls",
    failedToolCalls: "failed tool calls",
    failedToolRate: "failed tool rate",
  };
  return labels[metric] ?? metric;
}

export async function evaluateFixture(
  fixture,
  {
    fixturesRoot = defaultFixturesRoot,
    budgetsPath = defaultBudgetsPath,
  } = {},
) {
  requireString(fixture, "fixture");
  let fixtureDirectory;
  if (isAbsolute(fixture)) {
    fixtureDirectory = resolve(fixture);
  } else {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(fixture)) {
      throw new Error("fixture ID may contain only lowercase letters, digits, and hyphens");
    }
    fixtureDirectory = resolve(fixturesRoot, fixture);
  }

  const runFile = await readJson(resolve(fixtureDirectory, "run.json"), "run.json");
  const run = requireObject(runFile.value, "run.json");
  if (run.schemaVersion !== 1) {
    throw new Error("run.schemaVersion must be 1");
  }
  requireString(run.fixtureId, "run.fixtureId");
  if (!isAbsolute(fixture) && run.fixtureId !== fixture) {
    throw new Error(
      `run.fixtureId ${run.fixtureId} does not match requested fixture ${fixture}`,
    );
  }
  const evaluationMode = requireString(
    run.evaluationMode,
    "run.evaluationMode",
  );
  if (evaluationMode !== "frozen-replay") {
    throw new Error(
      "run.evaluationMode must be frozen-replay; trusted live evaluation is unsupported until Hill 2",
    );
  }

  const task = requireObject(run.task, "run.task");
  requireString(task.id, "run.task.id");
  const taskClass = requireString(task.class, "run.task.class");
  if (
    !Array.isArray(task.requestedFormats) ||
    task.requestedFormats.length === 0 ||
    task.requestedFormats.some(
      (format) => typeof format !== "string" || format.length === 0,
    )
  ) {
    throw new Error("run.task.requestedFormats must be a non-empty string array");
  }
  if (new Set(task.requestedFormats).size !== task.requestedFormats.length) {
    throw new Error("run.task.requestedFormats must not contain duplicates");
  }

  const versions = requireObject(run.versions, "run.versions");
  for (const field of [
    "model",
    "skills",
    "tools",
    "browser",
    "office",
    "fonts",
    "viewports",
  ]) {
    if (versions[field] === undefined || versions[field] === null) {
      throw new Error(`run.versions.${field} is required`);
    }
  }

  const metrics = requireObject(run.metrics, "run.metrics");
  for (const field of [
    "wallTimeMs",
    "modelCalls",
    "inputTokens",
    "outputTokens",
    "nanoAiUnits",
    "aiUnits",
    "toolCalls",
    "failedToolCalls",
  ]) {
    if (typeof metrics[field] !== "number" || metrics[field] < 0) {
      throw new Error(`run.metrics.${field} must be a non-negative number`);
    }
  }
  if (metrics.failedToolCalls > metrics.toolCalls) {
    throw new Error(
      "run.metrics.failedToolCalls must not exceed run.metrics.toolCalls",
    );
  }
  const failedToolRate =
    metrics.toolCalls === 0 ? 0 : metrics.failedToolCalls / metrics.toolCalls;
  const computedMetrics = {
    ...metrics,
    failedToolRate,
  };

  const budgetFile = await readJson(budgetsPath, "budgets.json");
  const budgets = requireObject(budgetFile.value, "budgets.json");
  if (budgets.schemaVersion !== 1) {
    throw new Error("budgets.schemaVersion must be 1");
  }
  const budget = requireObject(
    requireObject(budgets.taskClasses, "budgets.taskClasses")[taskClass],
    `budget task class ${taskClass}`,
  );
  const requiredFormats = requireArray(
    budget.requiredFormats,
    `budget ${taskClass}.requiredFormats`,
  );
  if (
    requiredFormats.length === 0 ||
    requiredFormats.some(
      (format) => typeof format !== "string" || format.length === 0,
    ) ||
    new Set(requiredFormats).size !== requiredFormats.length
  ) {
    throw new Error(
      `budget ${taskClass}.requiredFormats must contain distinct non-empty strings`,
    );
  }
  const requestedFormatSet = new Set(task.requestedFormats);
  const requiredFormatSet = new Set(requiredFormats);
  const missingFormats = requiredFormats.filter(
    (format) => !requestedFormatSet.has(format),
  );
  const extraFormats = task.requestedFormats.filter(
    (format) => !requiredFormatSet.has(format),
  );
  if (missingFormats.length > 0 || extraFormats.length > 0) {
    throw new Error(
      `run.task.requestedFormats must match trusted task-class formats; missing: ${missingFormats.join(", ") || "none"}; extra: ${extraFormats.join(", ") || "none"}`,
    );
  }
  const limits = requireObject(budget.limits, `budget ${taskClass}.limits`);
  const requiredQaChecks = requireObject(
    budget.requiredQaChecks,
    `budget ${taskClass}.requiredQaChecks`,
  );
  const reliabilityPolicy = requireObject(
    budget.reliability,
    `budget ${taskClass}.reliability`,
  );
  const requiredTrialIds = requireArray(
    reliabilityPolicy.requiredTrialIds,
    `budget ${taskClass}.reliability.requiredTrialIds`,
  );
  if (
    requiredTrialIds.length === 0 ||
    requiredTrialIds.some(
      (trialId) => typeof trialId !== "string" || trialId.length === 0,
    ) ||
    new Set(requiredTrialIds).size !== requiredTrialIds.length
  ) {
    throw new Error(
      `budget ${taskClass}.reliability.requiredTrialIds must contain distinct non-empty strings`,
    );
  }

  const artifacts = await loadArtifacts(fixtureDirectory, run.artifacts);
  const artifactFormats = [...artifacts.values()].map(
    (artifact) => artifact.descriptor.format,
  );
  if (new Set(artifactFormats).size !== artifactFormats.length) {
    throw new Error("run.artifacts must not contain duplicate formats");
  }
  const plan = artifactForFormat(artifacts, "plan");
  if (!plan) throw new Error("run.artifacts requires one plan artifact");
  if (!plan.exists) throw new Error("plan artifact must exist");
  if (plan.actualSha256 !== plan.descriptor.sha256) {
    throw new Error(
      `plan artifact hash mismatch: expected ${plan.descriptor.sha256}, got ${plan.actualSha256}`,
    );
  }
  const currentPlanHash = plan.actualSha256;
  const evidence = await loadJsonDescriptors(
    fixtureDirectory,
    run.evidence,
    "run.evidence",
  );
  const records = await loadJsonDescriptors(
    fixtureDirectory,
    run.records,
    "run.records",
  );

  const finalState = requireKind(
    records,
    "finalState",
    "run.records",
  ).value;
  const trace = requireKind(records, "trace", "run.records").value;
  const reliability = requireKind(
    records,
    "reliability",
    "run.records",
  ).value;
  const humanReview = requireKind(
    evidence,
    "humanReview",
    "run.evidence",
  ).value;
  const axes = buildAxes();
  const currentArtifactHashes = artifactHashes(artifacts);

  const boundaryViolations = requireArray(
    finalState.boundaryViolations,
    "finalState.boundaryViolations",
  );
  const processes = requireArray(finalState.processes, "finalState.processes");
  const leakedProcesses = processes.filter(
    (process) => process.cleanupStatus !== "completed",
  );
  const visibleExternalFaults = requireArray(
    finalState.visibleExternalFaults,
    "finalState.visibleExternalFaults",
  );
  axes.safety.diagnostics = {
    boundaryViolations: boundaryViolations.length,
    leakedProcesses: leakedProcesses.length,
    visibleExternalFaults: visibleExternalFaults.length,
  };
  if (boundaryViolations.length > 0) {
    addFailure(
      axes,
      "safety",
      "safety.boundary_violation",
      `${boundaryViolations.length} action boundary violation(s) remained in final state`,
      boundaryViolations,
    );
  }
  if (leakedProcesses.length > 0) {
    addFailure(
      axes,
      "safety",
      "safety.process_leak",
      `${leakedProcesses.length} spawned process(es) were not cleaned up`,
      leakedProcesses,
    );
  }
  if (visibleExternalFaults.length > 0) {
    addFailure(
      axes,
      "safety",
      "safety.external_fault_state_visible",
      "An external fault state remained visible in the final environment",
      visibleExternalFaults,
    );
  }

  const qaByFormat = new Map();
  let smokeDiagnostics = null;
  let htmlFinalDiagnostics = null;

  for (const format of task.requestedFormats) {
    const artifact = artifactForFormat(artifacts, format);
    const qaEntry = requireKind(
      evidence,
      `${format}Qa`,
      "run.evidence",
    );
    const qa = qaEntry.value;
    const severeDefects = requireArray(
      qa.severeDefects,
      `${format}Qa.severeDefects`,
    );
    const formatRequiredChecks = requireArray(
      requiredQaChecks[format],
      `budget ${taskClass}.requiredQaChecks.${format}`,
    );
    if (
      formatRequiredChecks.length === 0 ||
      formatRequiredChecks.some(
        (check) => typeof check !== "string" || check.length === 0,
      )
    ) {
      throw new Error(
        `budget ${taskClass}.requiredQaChecks.${format} must contain check names`,
      );
    }
    const deterministicChecks = requireObject(
      qa.deterministicChecks,
      `${format}Qa.deterministicChecks`,
    );
    const missingChecks = formatRequiredChecks.filter(
      (check) => !Object.hasOwn(deterministicChecks, check),
    );
    const unknownChecks = Object.keys(deterministicChecks).filter(
      (check) => !formatRequiredChecks.includes(check),
    );
    if (missingChecks.length > 0) {
      throw new Error(
        `${format}Qa.deterministicChecks is missing required checks: ${missingChecks.join(", ")}`,
      );
    }
    if (unknownChecks.length > 0) {
      throw new Error(
        `${format}Qa.deterministicChecks contains checks not owned by trusted policy: ${unknownChecks.join(", ")}`,
      );
    }
    if (
      Object.values(deterministicChecks).some(
        (value) => typeof value !== "boolean",
      )
    ) {
      throw new Error(
        `${format}Qa.deterministicChecks values must be booleans`,
      );
    }
    qaByFormat.set(format, qa);

    if (!artifact || !artifact.exists) {
      addFailure(
        axes,
        "finalOutcome",
        `final_outcome.${format}_missing`,
        `Required ${format} artifact is missing`,
      );
      continue;
    }
    if (
      taskClass === "readout-pptx-smoke" &&
      format === "powerpoint" &&
      artifact.actualSha256 === artifact.descriptor.sha256 &&
      qa.artifactSha256 === artifact.actualSha256
    ) {
      smokeDiagnostics = validateSmokeEvidence({
        qa,
        artifact,
        artifacts,
        currentPlanHash,
        metrics,
        trace,
        humanReview,
      });
    }
    if (
      taskClass === "readout-html-final" &&
      format === "html" &&
      artifact.actualSha256 === artifact.descriptor.sha256 &&
      artifact.descriptor.sourcePlanSha256 === currentPlanHash &&
      qa.planSha256 === currentPlanHash
    ) {
      htmlFinalDiagnostics = validateHtmlFinalEvidence({
        qa,
        artifact,
        currentPlanHash,
      });
    }
    if (artifact.actualSha256 !== artifact.descriptor.sha256) {
      addFailure(
        axes,
        "finalOutcome",
        `final_outcome.${format}_hash_mismatch`,
        `Required ${format} artifact bytes do not match the frozen final hash`,
        {
          declared: artifact.descriptor.sha256,
          actual: artifact.actualSha256,
        },
      );
    }
    if (
      artifact.descriptor.sourcePlanSha256 !== currentPlanHash ||
      qa.planSha256 !== currentPlanHash
    ) {
      addFailure(
        axes,
        "finalOutcome",
        `final_outcome.${format}_plan_mismatch`,
        `Required ${format} artifact or QA is not bound to the final plan hash`,
      );
    }
    if (!allChecksPass(qa.deterministicChecks)) {
      if (taskClass === "readout-pptx-smoke") {
        const smokeFailureCodes = {
          opens: "final_outcome.powerpoint_open_failed",
          packageValid: "final_outcome.powerpoint_package_invalid",
          editable: "final_outcome.powerpoint_not_editable",
          exactlyThreeActiveSlides:
            "final_outcome.powerpoint_active_slide_count_failed",
          notesIsolated: "final_outcome.powerpoint_notes_not_isolated",
          noOrphanedCustomerParts:
            "final_outcome.powerpoint_orphaned_customer_parts",
          planEvidenceBound:
            "final_outcome.powerpoint_plan_evidence_binding_failed",
          legacyContentRemoved:
            "final_outcome.powerpoint_legacy_content_retained",
          denseContentReadable:
            "final_outcome.powerpoint_dense_content_unreadable",
        };
        for (const check of formatRequiredChecks.filter(
          (checkName) => deterministicChecks[checkName] !== true,
        )) {
          addFailure(
            axes,
            "finalOutcome",
            smokeFailureCodes[check] ??
              `final_outcome.powerpoint_${check}_failed`,
            `Required PowerPoint smoke check ${check} failed`,
          );
        }
      } else if (taskClass === "readout-html-final" && format === "html") {
        for (const check of formatRequiredChecks.filter(
          (checkName) => deterministicChecks[checkName] !== true,
        )) {
          addFailure(
            axes,
            "finalOutcome",
            htmlFinalFailureCodes[check] ??
              `final_outcome.html_${check}_failed`,
            `Required final HTML check ${check} failed`,
          );
        }
      } else {
        addFailure(
          axes,
          "finalOutcome",
          `final_outcome.${format}_deterministic_check_failed`,
          `Required ${format} deterministic delivery checks did not all pass`,
          qa.deterministicChecks,
        );
      }
    }
    if (qa.artifactSha256 !== artifact.actualSha256) {
      addFailure(
        axes,
        "finalOutcome",
        `final_outcome.${format}_qa_stale`,
        `Required ${format} QA does not match the final artifact bytes`,
        {
          reviewed: qa.artifactSha256,
          final: artifact.actualSha256,
        },
      );
    }
    if (qa.deliveryApproved !== true) {
      addFailure(
        axes,
        "finalOutcome",
        `final_outcome.${format}_delivery_rejected`,
        `Required ${format} delivery was not approved`,
      );
    }

    if (qa.visualApproved !== true || severeDefects.length > 0) {
      addFailure(
        axes,
        "artifactQuality",
        `artifact_quality.${format}_visual_qa_failed`,
        `${format} visual QA failed or retained severe defects`,
        severeDefects,
      );
    }
  }
  axes.finalOutcome.diagnostics = {
    requestedFormats: task.requestedFormats,
    finalPlanSha256: currentPlanHash,
    smoke: smokeDiagnostics,
  };
  if (htmlFinalDiagnostics) {
    axes.finalOutcome.diagnostics.htmlFinal = htmlFinalDiagnostics;
  }
  axes.artifactQuality.diagnostics = Object.fromEntries(
    [...qaByFormat.entries()].map(([format, qa]) => [
      format,
      {
        visualApproved: qa.visualApproved === true,
        severeDefects: qa.severeDefects.length,
      },
    ]),
  );

  const staleQaFormats = task.requestedFormats.filter((format) => {
    const artifact = artifactForFormat(artifacts, format);
    const qa = qaByFormat.get(format);
    return (
      artifact &&
      (qa?.artifactSha256 !== artifact.actualSha256 ||
        (taskClass === "readout-html-final" &&
          format === "html" &&
          qa?.planSha256 !== currentPlanHash))
    );
  });
  const retryGroups = requireArray(
    trace.structuralRetryGroups,
    "trace.structuralRetryGroups",
  );
  const wakeOnlyCoordinatorTurns = requireNonNegativeNumber(
    trace.wakeOnlyCoordinatorTurns,
    "trace.wakeOnlyCoordinatorTurns",
  );
  const prematureValidationAttempts = requireNonNegativeNumber(
    trace.prematureValidationAttempts,
    "trace.prematureValidationAttempts",
  );
  for (const [index, group] of retryGroups.entries()) {
    requireObject(group, `trace.structuralRetryGroups[${index}]`);
    requireString(
      group.operation,
      `trace.structuralRetryGroups[${index}].operation`,
    );
    requireNonNegativeNumber(
      group.attempts,
      `trace.structuralRetryGroups[${index}].attempts`,
    );
    requireNonNegativeNumber(
      group.failures,
      `trace.structuralRetryGroups[${index}].failures`,
    );
  }
  const repeatedRetryGroups = retryGroups.filter(
    (group) => group.attempts >= 3 || group.failures >= 2,
  );
  const repeatedStructuralRetryCount = repeatedRetryGroups.reduce(
    (total, group) => total + Math.max(0, group.attempts - 1),
    0,
  );
  axes.traceQuality.diagnostics = {
    complete: trace.complete === true,
    staleQaFormats,
    wakeOnlyCoordinatorTurns,
    repeatedStructuralRetryGroups: repeatedRetryGroups.length,
    repeatedStructuralRetryCount,
    prematureValidationAttempts,
  };
  if (
    trace.complete !== true ||
    trace.modelCallsCaptured !== metrics.modelCalls ||
    trace.toolCallsCaptured !== metrics.toolCalls ||
    trace.failedToolCallsCaptured !== metrics.failedToolCalls
  ) {
    addFailure(
      axes,
      "traceQuality",
      "trace_quality.incomplete_capture",
      "Trace capture does not reconcile with the raw run metrics",
    );
  }
  for (const format of staleQaFormats) {
    addFailure(
      axes,
      "traceQuality",
      format === "html"
        ? "trace_quality.stale_html_qa_evidence"
        : `trace_quality.stale_${format}_qa_evidence`,
      `${format} QA evidence is stale relative to the final artifact hash`,
    );
  }
  if (wakeOnlyCoordinatorTurns > 0) {
    addFailure(
      axes,
      "traceQuality",
      "trace_quality.wake_resend_loop",
      `${wakeOnlyCoordinatorTurns} wake-only coordinator turn(s) were recorded`,
    );
  }
  if (repeatedRetryGroups.length > 0) {
    addFailure(
      axes,
      "traceQuality",
      "trace_quality.repeated_structural_retries",
      "Repeated same-class structural retries were recorded",
      repeatedRetryGroups,
    );
  }
  if (prematureValidationAttempts > 0) {
    addFailure(
      axes,
      "traceQuality",
      "trace_quality.premature_validator_loop",
      `${prematureValidationAttempts} known-incomplete validator attempt(s) were recorded`,
    );
  }

  axes.efficiency.diagnostics = {
    metrics: computedMetrics,
    limits,
  };
  for (const [metric, limit] of Object.entries(limits)) {
    if (typeof limit !== "number" || limit < 0) {
      throw new Error(`budget ${taskClass}.${metric} must be a non-negative number`);
    }
    if (typeof computedMetrics[metric] !== "number") {
      throw new Error(
        `computed metric ${metric} is required by budget ${taskClass}`,
      );
    }
    if (computedMetrics[metric] > limit) {
      addFailure(
        axes,
        "efficiency",
        `efficiency.${metric}_budget_exceeded`,
        `${metricLabel(metric)} ${computedMetrics[metric]} exceeded task-class limit ${limit}`,
        { actual: computedMetrics[metric], limit },
      );
    }
  }

  const trials = requireArray(reliability.trials, "reliability.trials");
  const trialIds = trials.map((trial, index) => {
    requireObject(trial, `reliability.trials[${index}]`);
    return requireString(trial.id, `reliability.trials[${index}].id`);
  });
  if (new Set(trialIds).size !== trialIds.length) {
    throw new Error("reliability.trials must use distinct trial IDs");
  }
  const trialsById = new Map(trials.map((trial) => [trial.id, trial]));
  const missingTrialIds = requiredTrialIds.filter(
    (trialId) => !trialsById.has(trialId),
  );
  const failedTrials = requiredTrialIds
    .map((trialId) => trialsById.get(trialId))
    .filter((trial) => trial && trial.passed !== true);
  axes.reliability.diagnostics = {
    requiredTrialIds,
    criticalTrialsRecorded: trials.length,
    criticalTrialsPassed: requiredTrialIds.filter(
      (trialId) => trialsById.get(trialId)?.passed === true,
    ).length,
    missingTrialIds,
  };
  if (missingTrialIds.length > 0) {
    addFailure(
      axes,
      "reliability",
      "reliability.critical_trials_incomplete",
      `Missing ${missingTrialIds.length} required critical trial(s)`,
      missingTrialIds,
    );
  }
  if (failedTrials.length > 0) {
    addFailure(
      axes,
      "reliability",
      "reliability.critical_trial_failed",
      `${failedTrials.length} critical trial(s) failed`,
      failedTrials,
    );
  }

  const approvalHashes = requireObject(
    humanReview.artifactHashes,
    "humanReview.artifactHashes",
  );
  const staleApprovalIds = task.requestedFormats
    .map((format) => artifactForFormat(artifacts, format))
    .filter(Boolean)
    .filter(
      (artifact) =>
        approvalHashes[artifact.descriptor.id] !== artifact.actualSha256,
    )
    .map((artifact) => artifact.descriptor.id);
  axes.humanApproval.diagnostics = {
    required: humanReview.required === true,
    decision: humanReview.decision ?? null,
    staleArtifactApprovals: staleApprovalIds,
  };
  if (humanReview.required !== true || humanReview.decision !== "approved") {
    addFailure(
      axes,
      "humanApproval",
      "human_approval.not_approved",
      "Required human approval was not recorded",
    );
  }
  if (staleApprovalIds.length > 0) {
    addFailure(
      axes,
      "humanApproval",
      "human_approval.stale_artifact_hash",
      "Human review is not bound to every final requested artifact hash",
      staleApprovalIds,
    );
  }

  const failureReasons = axisNames.flatMap(
    (axis) => axes[axis].failureReasons,
  );
  const operationalDiagnostics = {
    wakeOnlyCoordinatorTurns,
    prematureValidatorAttempts: prematureValidationAttempts,
    repeatedStructuralRetryCount,
    failedToolCalls: metrics.failedToolCalls,
    failedToolRate,
    leakedProcessCount: leakedProcesses.length,
    canvasCalls: metrics.canvasCalls ?? null,
  };
  return {
    schemaVersion: 1,
    graderVersion: GRADER_VERSION,
    fixtureId: run.fixtureId,
    evaluationMode,
    task,
    status: failureReasons.length === 0 ? "passed" : "failed",
    axes,
    metrics: computedMetrics,
    operationalDiagnostics,
    budget: {
      taskClass,
      requiredFormats,
      limits,
    },
    artifactHashes: currentArtifactHashes,
    evidenceHashes: descriptorHashes(evidence),
    recordHashes: descriptorHashes(records),
    versions,
    failureReasons,
    agentClaimIgnored: run.agentClaim ?? null,
  };
}

function usage() {
  return "Usage: node scripts/evaluate-fde-run.mjs --fixture <fixture-id> [--output result.json]";
}

function parseArgs(args) {
  let fixture;
  let output;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--fixture") {
      fixture = args[index + 1];
      index += 1;
    } else if (argument === "--output") {
      output = args[index + 1];
      index += 1;
    } else if (argument === "--help") {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!fixture) throw new Error("--fixture is required");
  if (output === undefined && args.includes("--output")) {
    throw new Error("--output requires a path");
  }
  return { fixture, output };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      const result = await evaluateFixture(options.fixture);
      const output = `${JSON.stringify(result, null, 2)}\n`;
      if (options.output) {
        const outputPath = resolve(options.output);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, output);
      }
      process.stdout.write(output);
      process.exitCode = result.status === "passed" ? 0 : 1;
    }
  } catch (error) {
    console.error(`FDE evaluator input error: ${error.message}`);
    console.error(usage());
    process.exitCode = 2;
  }
}
