#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import * as smokeContract from "./powerpoint-smoke-contract.mjs";

const {
  EXCLUDED_SMOKE_FAMILIES,
  FAMILY_DENSITY_FIELDS,
  PRODUCTION_COORDINATOR_ID,
  PRODUCTION_EXECUTION_PROFILE,
  canonicalizeJson,
  densityScore,
  isDenseArray,
  selectSmokeSlides,
  validateSmokeReport,
} = smokeContract;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function buildPlan() {
  return {
    slides: [
      { id: "cover", family: "cover", evidenceIds: [], judgmentIds: [], content: {} },
      { id: "decision", family: "decision", evidenceIds: [], judgmentIds: [], content: {} },
      {
        id: "profile-a",
        family: "profile",
        evidenceIds: ["ev-profile"],
        judgmentIds: ["jc-profile"],
        content: { facts: [1, 2], contexts: ["a"] },
      },
      {
        id: "metrics-a",
        family: "metrics",
        evidenceIds: ["ev-metrics"],
        judgmentIds: ["jc-metrics"],
        content: { metrics: [1, 2, 3, 4] },
      },
      { id: "evidence", family: "evidence", evidenceIds: [], judgmentIds: [], content: {} },
    ],
  };
}

function slideEntry(slide) {
  return {
    id: slide.id,
    family: slide.family,
    overflow: false,
    notesVerified: true,
    evidenceIds: [...slide.evidenceIds],
    judgmentIds: [...slide.judgmentIds],
    densityScore: densityScore(slide),
    nativeShapeCount: 5,
    nativeTableCount: ["table", "evaluation"].includes(slide.family) ? 1 : 0,
  };
}

function buildFixture(plan = buildPlan(), provenance = {}) {
  const selection = selectSmokeSlides(plan);
  const planBytes = Buffer.from(JSON.stringify(plan), "utf8");
  const report = {
    schemaVersion: 1,
    status: "PASS",
    coordinator: provenance.coordinator ?? PRODUCTION_COORDINATOR_ID,
    executionProfile: provenance.executionProfile ?? PRODUCTION_EXECUTION_PROFILE,
    selectionMode: "smoke",
    sourcePlanSha256: sha256(planBytes),
    selectedSlideIds: selection.map((slide) => slide.id),
    selectedSlideFamilies: selection.map((slide) => slide.family),
    pptxSha256: sha256("smoke-pptx-fixture"),
    contactSheetSha256: sha256("contact-sheet-fixture"),
    densestSlideReadable: true,
    legacyContentRemoved: true,
    slides: selection.map(slideEntry),
    package: {
      slides: 3,
      notesParts: 3,
      uniqueNotesRelationships: 3,
      macroFree: true,
      externalRelationships: 0,
      orphanSlides: 0,
      orphanNotes: 0,
    },
  };
  return {
    plan,
    planBytes,
    report,
    reportBytes: Buffer.from(JSON.stringify(report), "utf8"),
    selection,
  };
}

function validate(fixture, overrides = {}) {
  return validateSmokeReport({
    planBytes: fixture.planBytes,
    reportBytes: fixture.reportBytes,
    ...overrides,
  });
}

function expectReportFailure(label, mutate, pattern) {
  const fixture = buildFixture();
  mutate(fixture.report, fixture);
  fixture.reportBytes = Buffer.from(JSON.stringify(fixture.report), "utf8");
  const result = validate(fixture);
  assert.ok(result.errors.length > 0, `${label} unexpectedly passed`);
  assert.ok(
    result.errors.some((error) => pattern.test(error)),
    `${label} expected ${pattern}, got: ${result.errors.join("; ")}`,
  );
}

{
  const fixture = buildFixture();
  const result = validate(fixture);
  assert.deepEqual(result.errors, []);
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.provenance, {
    coordinator: PRODUCTION_COORDINATOR_ID,
    executionProfile: PRODUCTION_EXECUTION_PROFILE,
  });
  assert.deepEqual(result.hashes, {
    planSha256: sha256(fixture.planBytes),
    smokeReportSha256: sha256(fixture.reportBytes),
    smokePptxSha256: fixture.report.pptxSha256,
    contactSheetSha256: fixture.report.contactSheetSha256,
  });
  assert.deepEqual(result.selectedSlideIds, ["cover", "decision", "metrics-a"]);
  assert.deepEqual(result.selectedSlideFamilies, ["cover", "decision", "metrics"]);
  assert.equal(result.densestSlideId, "metrics-a");
  assert.equal(Object.hasOwn(result, "authenticated"), false);
  assert.equal(Object.hasOwn(result, "approver"), false);
  assert.equal(Object.hasOwn(result, "attestation"), false);
}

{
  const fixture = buildFixture(buildPlan(), {
    coordinator: "fde-powerpoint-native-coordinator/test-only",
    executionProfile: "test-only",
  });
  const result = validate(fixture, {
    expectedCoordinator: "fde-powerpoint-native-coordinator/test-only",
    expectedExecutionProfile: "test-only",
  });
  assert.deepEqual(result.errors, []);
}

assert.equal(
  canonicalizeJson({ z: 1, a: { y: 2, x: [true, null, "ok"] } }),
  '{"a":{"x":[true,null,"ok"],"y":2},"z":1}',
);
for (const value of [
  undefined,
  Number.POSITIVE_INFINITY,
  () => {},
  Symbol("x"),
  1n,
  new Date(),
  { value: undefined },
]) {
  assert.throws(() => canonicalizeJson(value));
}
{
  const sparse = new Array(2);
  sparse[1] = "x";
  assert.equal(isDenseArray(sparse), false);
  assert.throws(() => canonicalizeJson(sparse));
}

assert.throws(() => EXCLUDED_SMOKE_FAMILIES.push("metrics"));
assert.throws(() => FAMILY_DENSITY_FIELDS.metrics.push("extra"));

{
  const plan = buildPlan();
  assert.equal(densityScore(plan.slides[0]), 0);
  assert.equal(densityScore(plan.slides[2]), 3);
  assert.equal(densityScore(plan.slides[3]), 4);
  assert.deepEqual(
    selectSmokeSlides(plan).map((slide) => slide.id),
    ["cover", "decision", "metrics-a"],
  );
}

{
  const plan = buildPlan();
  plan.slides.splice(
    2,
    0,
    {
      id: "table-2x20",
      family: "table",
      evidenceIds: [],
      judgmentIds: [],
      content: { columns: Array(20).fill("c"), rows: Array(2).fill({}) },
    },
    {
      id: "table-10x10",
      family: "table",
      evidenceIds: [],
      judgmentIds: [],
      content: { columns: Array(10).fill("c"), rows: Array(10).fill({}) },
    },
  );
  assert.ok(densityScore(plan.slides[3]) > densityScore(plan.slides[2]));
  assert.equal(selectSmokeSlides(plan)[2].id, "table-10x10");
}

{
  const plan = buildPlan();
  plan.slides.splice(
    2,
    0,
    {
      id: "chart-line",
      family: "chart",
      evidenceIds: [],
      judgmentIds: [],
      content: {
        chartType: "line",
        categories: Array(12).fill("c"),
        series: Array(3).fill({}),
        insight: {},
      },
    },
    {
      id: "chart-bar",
      family: "chart",
      evidenceIds: [],
      judgmentIds: [],
      content: {
        chartType: "bar",
        categories: Array(12).fill("c"),
        series: Array(4).fill({}),
        insight: {},
      },
    },
  );
  assert.equal(densityScore(plan.slides[2]), 132);
  assert.equal(densityScore(plan.slides[3]), 127);
  assert.equal(selectSmokeSlides(plan)[2].id, "chart-line");
  assert.equal(
    densityScore({
      family: "workflow",
      content: { nodes: [{}, {}, {}], edges: [{}, {}, {}] },
    }),
    9,
  );
}

{
  const plan = buildPlan();
  plan.slides[2] = {
    id: "table-first",
    family: "table",
    evidenceIds: [],
    judgmentIds: [],
    content: { columns: ["a"], rows: ["r1"] },
  };
  plan.slides[3] = {
    id: "metrics-second",
    family: "metrics",
    evidenceIds: [],
    judgmentIds: [],
    content: { metrics: [1, 2] },
  };
  assert.equal(densityScore(plan.slides[2]), densityScore(plan.slides[3]));
  assert.equal(selectSmokeSlides(plan)[2].id, "table-first");
}

for (const plan of [
  { slides: [{ id: "cover", family: "cover", content: {} }] },
  {
    slides: [
      { id: "cover", family: "cover", content: {} },
      { id: "decision", family: "decision", content: {} },
      { id: "evidence", family: "evidence", content: {} },
    ],
  },
]) {
  assert.throws(() => selectSmokeSlides(plan));
}
{
  const plan = buildPlan();
  delete plan.slides[2];
  assert.throws(() => selectSmokeSlides(plan), /dense slides array/);
}
assert.throws(() => selectSmokeSlides(Object.create(buildPlan())), /plain object/);

for (const [label, field, value, pattern] of [
  ["schema version", "schemaVersion", 2, /schemaVersion must equal 1/],
  ["status", "status", "FAIL", /status must equal PASS/],
  ["coordinator", "coordinator", "test-only", /coordinator must equal/],
  ["profile", "executionProfile", "test-only", /executionProfile must equal production/],
  ["selection mode", "selectionMode", "full", /selectionMode must equal smoke/],
  ["plan hash", "sourcePlanSha256", sha256("wrong"), /sourcePlanSha256 must equal/],
  ["slide IDs", "selectedSlideIds", ["cover", "decision", "profile-a"], /selectedSlideIds/],
  [
    "slide families",
    "selectedSlideFamilies",
    ["cover", "decision", "profile"],
    /selectedSlideFamilies/,
  ],
  ["PPTX hash", "pptxSha256", "invalid", /pptxSha256 must be a lowercase SHA-256/],
  [
    "contact sheet hash",
    "contactSheetSha256",
    "invalid",
    /contactSheetSha256 must be a lowercase SHA-256/,
  ],
  ["readability", "densestSlideReadable", false, /densestSlideReadable must equal true/],
  ["legacy content", "legacyContentRemoved", false, /legacyContentRemoved must equal true/],
]) {
  expectReportFailure(label, (report) => {
    report[field] = value;
  }, pattern);
}

expectReportFailure(
  "unexpected report property",
  (report) => {
    report.trusted = true;
  },
  /report has unexpected keys/,
);
expectReportFailure(
  "missing report property",
  (report) => {
    delete report.selectionMode;
  },
  /report\.selectionMode must be an own property/,
);

for (const [label, mutate, pattern] of [
  ["slide id", (slide) => (slide.id = "other"), /id must equal metrics-a/],
  ["slide family", (slide) => (slide.family = "table"), /family must equal metrics/],
  ["overflow", (slide) => (slide.overflow = true), /overflow must equal false/],
  ["notes", (slide) => (slide.notesVerified = false), /notesVerified must equal true/],
  ["evidence", (slide) => (slide.evidenceIds = []), /evidenceIds must exactly equal/],
  ["judgment", (slide) => (slide.judgmentIds = []), /judgmentIds must exactly equal/],
  ["density", (slide) => (slide.densityScore += 1), /densityScore must equal/],
  ["shape count", (slide) => (slide.nativeShapeCount = 0), /nativeShapeCount/],
  ["table count", (slide) => (slide.nativeTableCount = -1), /nativeTableCount/],
  ["extra slide key", (slide) => (slide.trusted = true), /slides\[2\] has unexpected keys/],
]) {
  expectReportFailure(label, (report) => mutate(report.slides[2]), pattern);
}

for (const field of [
  "slides",
  "notesParts",
  "uniqueNotesRelationships",
  "externalRelationships",
  "orphanSlides",
  "orphanNotes",
]) {
  expectReportFailure(
    `package ${field}`,
    (report) => {
      report.package[field] += 1;
    },
    new RegExp(`package\\.${field} must equal`),
  );
}
expectReportFailure(
  "package macro flag",
  (report) => {
    report.package.macroFree = false;
  },
  /package\.macroFree must equal true/,
);
expectReportFailure(
  "package extra key",
  (report) => {
    report.package.trusted = true;
  },
  /report\.package has unexpected keys/,
);

{
  const plan = buildPlan();
  plan.slides[3] = {
    ...plan.slides[3],
    family: "table",
    content: { columns: ["a"], rows: ["r1", "r2", "r3"] },
  };
  const fixture = buildFixture(plan);
  fixture.report.slides[2].nativeTableCount = 0;
  fixture.reportBytes = Buffer.from(JSON.stringify(fixture.report), "utf8");
  assert.ok(validate(fixture).errors.some((error) => /nativeTableCount.*1/.test(error)));
}

{
  const fixture = buildFixture();
  fixture.planBytes = Buffer.concat([fixture.planBytes, Buffer.from(" ")]);
  assert.ok(validate(fixture).errors.some((error) => /sourcePlanSha256/.test(error)));
}
assert.ok(
  validateSmokeReport({ planBytes: Buffer.from("{"), reportBytes: Buffer.from("{}") }).errors.some(
    (error) => /plan is not valid JSON/.test(error),
  ),
);
assert.ok(
  validateSmokeReport({ planBytes: Buffer.from("{}"), reportBytes: Buffer.from("{") }).errors.some(
    (error) => /smoke report is not valid JSON/.test(error),
  ),
);

for (const name of Object.keys(smokeContract)) {
  assert.doesNotMatch(name, /approval|attestation|keyring|signature|signer/i);
}

console.log("PowerPoint smoke contract tests passed.");
