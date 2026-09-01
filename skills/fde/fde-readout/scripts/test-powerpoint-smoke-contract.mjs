#!/usr/bin/env node

// Unit and CLI-contract tests for the PowerPoint smoke approval contract.
// Builds minimal fixture plan/report/approval JSON, exercises success and
// every documented failure mode, and cleans up its temp directory.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  APPROVAL_ALLOWED_KEYS,
  BLOCKED_IDENTITY_TERMS,
  EXCLUDED_SMOKE_FAMILIES,
  FAMILY_DENSITY_FIELDS,
  densityScore,
  isDenseArray,
  selectSmokeSlides,
  validateSmokeApproval,
} from "./powerpoint-smoke-contract.mjs";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const cli = resolve(scriptsDir, "validate-powerpoint-smoke-approval.mjs");
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
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

function buildTiePlan() {
  return {
    slides: [
      { id: "cover", family: "cover", evidenceIds: [], judgmentIds: [], content: {} },
      { id: "decision", family: "decision", evidenceIds: [], judgmentIds: [], content: {} },
      {
        id: "table-first",
        family: "table",
        evidenceIds: [],
        judgmentIds: [],
        content: { columns: ["a"], rows: ["r1"] },
      },
      {
        id: "metrics-second",
        family: "metrics",
        evidenceIds: [],
        judgmentIds: [],
        content: { metrics: [1, 2] },
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

function buildFixture(plan = buildPlan()) {
  const selection = selectSmokeSlides(plan);
  const planBytes = Buffer.from(JSON.stringify(plan), "utf8");
  const pptxSha256 = sha256("smoke-pptx-fixture");
  const contactSheetSha256 = sha256("contact-sheet-fixture");

  const report = {
    schemaVersion: 1,
    status: "PASS",
    selectionMode: "smoke",
    sourcePlanSha256: sha256(planBytes),
    selectedSlideIds: selection.map((slide) => slide.id),
    selectedSlideFamilies: selection.map((slide) => slide.family),
    pptxSha256,
    contactSheetSha256,
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
  const reportBytes = Buffer.from(JSON.stringify(report), "utf8");

  const approval = {
    schemaVersion: 1,
    approved: true,
    approver: {
      name: "Jane Doe",
      role: "Engagement Director",
    },
    approvedAt: "2026-01-15T09:30:00Z",
    planSha256: sha256(planBytes),
    smokeReportSha256: sha256(reportBytes),
    smokePptxSha256: pptxSha256,
    contactSheetSha256: contactSheetSha256,
    selectedSlideIds: selection.map((slide) => slide.id),
  };

  return { plan, planBytes, report, reportBytes, approval, selection };
}

function expectPass(label, mutate) {
  const fixture = buildFixture();
  if (mutate) mutate(fixture);
  const result = validateSmokeApproval({
    planBytes: fixture.planBytes,
    reportBytes: fixture.reportBytes,
    approval: fixture.approval,
  });
  check(result.errors.length === 0, `${label} expected success, got: ${result.errors.join("; ")}`);
  return result;
}

function expectFail(label, mutate, pattern) {
  const fixture = buildFixture();
  mutate(fixture);
  const result = validateSmokeApproval({
    planBytes: fixture.planBytes,
    reportBytes: fixture.reportBytes,
    approval: fixture.approval,
  });
  check(result.errors.length > 0, `${label} expected failure but validation passed`);
  check(
    result.errors.some((error) => pattern.test(error)),
    `${label} expected an error matching ${pattern}, got: ${result.errors.join("; ")}`,
  );
}

function reserialize(fixture, { plan, report } = {}) {
  if (plan) fixture.planBytes = Buffer.from(JSON.stringify(plan), "utf8");
  if (report) fixture.reportBytes = Buffer.from(JSON.stringify(report), "utf8");
}

function replaceReport(fixture, report) {
  fixture.report = report;
  reserialize(fixture, { report });
  fixture.approval.smokeReportSha256 = sha256(fixture.reportBytes);
}

// --- Success ---
{
  const result = expectPass("baseline success");
  check(result.approver.name === "Jane Doe", "success must return the approver name");
  check(
    result.approver.role === "Engagement Director",
    "success must return the accountable approver role",
  );
}

// --- Exported constants cannot mutate private validation lookups ---
for (const [label, mutate] of [
  ["excluded families", () => EXCLUDED_SMOKE_FAMILIES.push("metrics")],
  ["density fields", () => FAMILY_DENSITY_FIELDS.metrics.push("extra")],
  ["blocked identity terms", () => BLOCKED_IDENTITY_TERMS.splice(0)],
  ["approval keys", () => APPROVAL_ALLOWED_KEYS.push("bypass")],
]) {
  let threw = false;
  try {
    mutate();
  } catch {
    threw = true;
  }
  check(threw, `${label} export must be frozen`);
}
check(
  selectSmokeSlides(buildPlan())[2].id === "metrics-a",
  "constant mutation attempts must not change smoke selection",
);
expectFail(
  "constant mutation attempts do not bypass identity validation",
  (fixture) => {
    fixture.approval.approver.role = "Copilot Reviewer";
  },
  /accountable human role/,
);

{
  const sparse = new Array(3);
  sparse[0] = "cover";
  sparse[2] = "metrics-a";
  check(!isDenseArray(sparse), "isDenseArray must reject missing numeric indices");
}

// --- densityScore and selectSmokeSlides determinism ---
{
  const plan = buildPlan();
  const selection = selectSmokeSlides(plan);
  check(selection[0].id === "cover", "selection[0] must be the cover slide");
  check(selection[1].id === "decision", "selection[1] must be the decision slide");
  check(selection[2].id === "metrics-a", "densest eligible slide must be metrics-a (score 4)");
  check(densityScore(plan.slides[2]) === 3, "profile-a density score must be 3");
  check(densityScore(plan.slides[3]) === 4, "metrics-a density score must be 4");
  check(densityScore(plan.slides[0]) === 0, "cover density score must be 0");

  const tiePlan = buildTiePlan();
  const tieSelection = selectSmokeSlides(tiePlan);
  check(densityScore(tiePlan.slides[2]) === 2, "table-first density score must be 2");
  check(densityScore(tiePlan.slides[3]) === 2, "metrics-second density score must be 2");
  check(
    tieSelection[2].id === "table-first",
    "tied density scores must keep the earlier slide (table-first)",
  );
}

{
  const noThirdPlan = {
    slides: [
      { id: "cover", family: "cover", content: {} },
      { id: "decision", family: "decision", content: {} },
      { id: "evidence", family: "evidence", content: {} },
    ],
  };
  let threw = false;
  try {
    selectSmokeSlides(noThirdPlan);
  } catch {
    threw = true;
  }
  check(threw, "selectSmokeSlides must reject a plan with no eligible third slide");
}

{
  const sparsePlan = buildPlan();
  delete sparsePlan.slides[2];
  let message = "";
  try {
    selectSmokeSlides(sparsePlan);
  } catch (error) {
    message = error.message;
  }
  check(/dense slides array/.test(message), "selectSmokeSlides must reject sparse plan.slides");
}

{
  const inheritedPlan = Object.create(buildPlan());
  let message = "";
  try {
    selectSmokeSlides(inheritedPlan);
  } catch (error) {
    message = error.message;
  }
  check(/plain object/.test(message), "selectSmokeSlides must reject inherited plan data");
}

// --- Wrong / easy third slide ---
expectFail(
  "wrong third slide",
  (fixture) => {
    fixture.approval.selectedSlideIds = ["cover", "decision", "profile-a"];
  },
  /selectedSlideIds must equal selectSmokeSlides order/,
);

// --- Wrong order ---
expectFail(
  "wrong order",
  (fixture) => {
    fixture.approval.selectedSlideIds = ["cover", "metrics-a", "decision"];
  },
  /selectedSlideIds must equal selectSmokeSlides order/,
);

// --- Duplicate IDs ---
expectFail(
  "duplicate IDs",
  (fixture) => {
    fixture.approval.selectedSlideIds = ["cover", "cover", "metrics-a"];
  },
  /selectedSlideIds must (contain exactly 3|not contain duplicates)/,
);

expectFail(
  "sparse approval selectedSlideIds",
  (fixture) => {
    fixture.approval.selectedSlideIds = new Array(3);
    fixture.approval.selectedSlideIds[0] = "cover";
    fixture.approval.selectedSlideIds[2] = "metrics-a";
  },
  /selectedSlideIds must be a dense array/,
);

expectFail(
  "inherited approval",
  (fixture) => {
    fixture.approval = Object.create(fixture.approval);
  },
  /approval must be a plain object/,
);

// --- Raw plan/report tampering ---
expectFail(
  "tampered plan bytes",
  (fixture) => {
    fixture.planBytes = Buffer.concat([fixture.planBytes, Buffer.from(" ")]);
  },
  /planSha256 must equal the plan's actual SHA-256/,
);
expectFail(
  "tampered report bytes",
  (fixture) => {
    fixture.reportBytes = Buffer.concat([fixture.reportBytes, Buffer.from(" ")]);
  },
  /smokeReportSha256 must equal the report's actual SHA-256/,
);

// --- Each hash mismatch ---
expectFail(
  "planSha256 mismatch",
  (fixture) => {
    fixture.approval.planSha256 = sha256("wrong");
  },
  /planSha256 must equal the plan's actual SHA-256/,
);
expectFail(
  "smokeReportSha256 mismatch",
  (fixture) => {
    fixture.approval.smokeReportSha256 = sha256("wrong");
  },
  /smokeReportSha256 must equal the report's actual SHA-256/,
);
expectFail(
  "smokePptxSha256 mismatch",
  (fixture) => {
    fixture.approval.smokePptxSha256 = sha256("wrong");
  },
  /report.pptxSha256 must equal approval.smokePptxSha256/,
);
expectFail(
  "contactSheetSha256 mismatch",
  (fixture) => {
    fixture.approval.contactSheetSha256 = sha256("wrong");
  },
  /report.contactSheetSha256 must equal approval.contactSheetSha256/,
);

// --- False approval ---
expectFail(
  "approved false",
  (fixture) => {
    fixture.approval.approved = false;
  },
  /approval\.approved must equal true/,
);

// --- Structured accountable human approvers ---
for (const approver of [
  { name: "Copilot Agent", role: "Engagement Director" },
  { name: "Jane Bot", role: "Engagement Director" },
  { name: "Jane Doe", role: "Service Principal" },
  { name: "Jane Doe", role: "CI Pipeline Owner" },
  { name: "Jane Doe", role: "AI Review Lead" },
  { name: "ChatGPT Reviewer", role: "Engagement Director" },
  { name: "Automated Reviewer", role: "Engagement Director" },
  { name: "CopilotAgent Reviewer", role: "Engagement Director" },
  { name: "GitHub Actions", role: "Engagement Director" },
  { name: "GitHub Workflow", role: "Release Reviewer" },
  { name: "Build Runner", role: "Release Reviewer" },
  { name: "Jane Doe", role: "Service Account" },
]) {
  expectFail(
    `machine approver: ${JSON.stringify(approver)}`,
    (fixture) => {
      fixture.approval.approver = approver;
    },
    /must identify (a human|an accountable human role)/,
  );
}
expectFail(
  "approver string",
  (fixture) => {
    fixture.approval.approver = "Jane Doe";
  },
  /approver must be a plain object/,
);
expectFail(
  "approver name only",
  (fixture) => {
    fixture.approval.approver = { name: "Jane Doe" };
  },
  /approver\.role must be an own property/,
);
expectFail(
  "approver role only",
  (fixture) => {
    fixture.approval.approver = { role: "Engagement Director" };
  },
  /approver\.name must be an own property/,
);
expectFail(
  "single-word approver name",
  (fixture) => {
    fixture.approval.approver.name = "Jane";
  },
  /at least two nontrivial name words/,
);
expectFail(
  "approver extra property",
  (fixture) => {
    fixture.approval.approver.email = "jane@example.com";
  },
  /approval\.approver has unexpected keys/,
);
expectPass("common personal-name punctuation", (fixture) => {
  fixture.approval.approver.name = "Anne-Marie O'Neil";
});

// --- Real ISO calendar timestamps with explicit zones ---
expectFail(
  "timestamp without zone",
  (fixture) => {
    fixture.approval.approvedAt = "2026-01-15T09:30:00";
  },
  /approvedAt must be a real ISO-8601 calendar timestamp/,
);
for (const timestamp of [
  "2026-02-29T09:30:00Z",
  "2026-04-31T09:30:00Z",
  "2026-01-15T24:00:00Z",
  "2026-01-15T09:60:00Z",
  "2026-01-15T09:30:60Z",
  "2026-01-15T09:30:00+14:01",
  "2026-01-15T09:30:00+02:60",
]) {
  expectFail(
    `invalid timestamp: ${timestamp}`,
    (fixture) => {
      fixture.approval.approvedAt = timestamp;
    },
    /approvedAt must be a real ISO-8601 calendar timestamp/,
  );
}
expectPass("valid leap-day timestamp", (fixture) => {
  fixture.approval.approvedAt = "2028-02-29T23:59:59.123Z";
});
expectPass("timestamp with numeric offset", (fixture) => {
  fixture.approval.approvedAt = "2026-01-15T09:30:00+02:00";
});
expectPass("timestamp with maximum offset", (fixture) => {
  fixture.approval.approvedAt = "2026-01-15T09:30:00-14:00";
});

// --- Unexpected key ---
expectFail(
  "unexpected approval key",
  (fixture) => {
    fixture.approval.notes = "extra";
  },
  /approval has unexpected keys/,
);

// --- Report hard-gate failures ---
expectFail(
  "report status not PASS",
  (fixture) => {
    const report = { ...fixture.report, status: "FAIL" };
    reserialize(fixture, { report });
    fixture.approval.smokeReportSha256 = sha256(fixture.reportBytes);
  },
  /report\.status must equal PASS/,
);
expectFail(
  "report selectionMode not smoke",
  (fixture) => {
    const report = { ...fixture.report, selectionMode: "full" };
    reserialize(fixture, { report });
    fixture.approval.smokeReportSha256 = sha256(fixture.reportBytes);
  },
  /report\.selectionMode must equal smoke/,
);
expectFail(
  "report sourcePlanSha256 mismatch",
  (fixture) => {
    const report = { ...fixture.report, sourcePlanSha256: sha256("wrong") };
    reserialize(fixture, { report });
    fixture.approval.smokeReportSha256 = sha256(fixture.reportBytes);
  },
  /report\.sourcePlanSha256 must equal the plan's actual SHA-256/,
);
expectFail(
  "report selectedSlideIds mismatch",
  (fixture) => {
    const report = { ...fixture.report, selectedSlideIds: ["cover", "decision", "profile-a"] };
    reserialize(fixture, { report });
    fixture.approval.smokeReportSha256 = sha256(fixture.reportBytes);
  },
  /report\.selectedSlideIds must equal the expected smoke selection/,
);
expectFail(
  "report selectedSlideFamilies mismatch",
  (fixture) => {
    const report = {
      ...fixture.report,
      selectedSlideFamilies: ["cover", "decision", "profile"],
    };
    reserialize(fixture, { report });
    fixture.approval.smokeReportSha256 = sha256(fixture.reportBytes);
  },
  /report\.selectedSlideFamilies must equal the plan's actual slide families/,
);
expectFail(
  "sparse report selectedSlideIds",
  (fixture) => {
    const sparse = new Array(3);
    sparse[0] = "cover";
    sparse[2] = "metrics-a";
    check(!isDenseArray(sparse), "sparse report selectedSlideIds fixture must contain a hole");
    replaceReport(fixture, { ...fixture.report, selectedSlideIds: sparse });
  },
  /report\.selectedSlideIds must contain non-empty strings/,
);
expectFail(
  "sparse report slides",
  (fixture) => {
    const sparse = new Array(3);
    sparse[0] = fixture.report.slides[0];
    sparse[2] = fixture.report.slides[2];
    check(!isDenseArray(sparse), "sparse report.slides fixture must contain a hole");
    replaceReport(fixture, { ...fixture.report, slides: sparse });
  },
  /report\.slides\[1\] must be a plain object/,
);
expectFail(
  "missing report own property",
  (fixture) => {
    const report = { ...fixture.report };
    delete report.selectionMode;
    replaceReport(fixture, report);
  },
  /report\.selectionMode must be an own property/,
);
expectFail(
  "unexpected report property",
  (fixture) => {
    replaceReport(fixture, { ...fixture.report, trusted: true });
  },
  /report has unexpected keys/,
);
for (const field of [
  "slides",
  "notesParts",
  "uniqueNotesRelationships",
  "macroFree",
  "externalRelationships",
  "orphanSlides",
  "orphanNotes",
]) {
  expectFail(
    `report.package.${field} wrong`,
    (fixture) => {
      const current = fixture.report.package[field];
      const wrong = typeof current === "boolean" ? !current : current + 1;
      const report = {
        ...fixture.report,
        package: { ...fixture.report.package, [field]: wrong },
      };
      reserialize(fixture, { report });
      fixture.approval.smokeReportSha256 = sha256(fixture.reportBytes);
    },
    new RegExp(`report\\.package\\.${field} must equal`),
  );
}
expectFail(
  "report.package integer must be finite and integral",
  (fixture) => {
    replaceReport(fixture, {
      ...fixture.report,
      package: { ...fixture.report.package, slides: 3.5 },
    });
  },
  /report\.package\.slides must equal 3/,
);
expectFail(
  "report.package missing own property",
  (fixture) => {
    const pkg = { ...fixture.report.package };
    delete pkg.notesParts;
    replaceReport(fixture, { ...fixture.report, package: pkg });
  },
  /report\.package\.notesParts must be an own property/,
);
expectFail(
  "report.package unexpected property",
  (fixture) => {
    replaceReport(fixture, {
      ...fixture.report,
      package: { ...fixture.report.package, trusted: true },
    });
  },
  /report\.package has unexpected keys/,
);
expectFail(
  "report slide overflow true",
  (fixture) => {
    const slides = fixture.report.slides.map((entry, index) =>
      index === 2 ? { ...entry, overflow: true } : entry,
    );
    const report = { ...fixture.report, slides };
    reserialize(fixture, { report });
    fixture.approval.smokeReportSha256 = sha256(fixture.reportBytes);
  },
  /report\.slides\[2\]\.overflow must equal false/,
);
expectFail(
  "report slide notesVerified false",
  (fixture) => {
    const slides = fixture.report.slides.map((entry, index) =>
      index === 2 ? { ...entry, notesVerified: false } : entry,
    );
    const report = { ...fixture.report, slides };
    reserialize(fixture, { report });
    fixture.approval.smokeReportSha256 = sha256(fixture.reportBytes);
  },
  /report\.slides\[2\]\.notesVerified must equal true/,
);
expectFail(
  "report slide missing evidence ID",
  (fixture) => {
    const slides = fixture.report.slides.map((entry, index) =>
      index === 2 ? { ...entry, evidenceIds: [] } : entry,
    );
    const report = { ...fixture.report, slides };
    reserialize(fixture, { report });
    fixture.approval.smokeReportSha256 = sha256(fixture.reportBytes);
  },
  /report\.slides\[2\]\.evidenceIds must exactly equal the plan evidence IDs/,
);
expectFail(
  "report slide extra evidence ID",
  (fixture) => {
    const slides = fixture.report.slides.map((entry, index) =>
      index === 2 ? { ...entry, evidenceIds: [...entry.evidenceIds, "ev-extra"] } : entry,
    );
    replaceReport(fixture, { ...fixture.report, slides });
  },
  /report\.slides\[2\]\.evidenceIds must exactly equal the plan evidence IDs/,
);
expectFail(
  "report slide duplicate evidence ID",
  (fixture) => {
    const slides = fixture.report.slides.map((entry, index) =>
      index === 2
        ? { ...entry, evidenceIds: [...entry.evidenceIds, entry.evidenceIds[0]] }
        : entry,
    );
    replaceReport(fixture, { ...fixture.report, slides });
  },
  /report\.slides\[2\]\.evidenceIds must not contain duplicates/,
);
expectFail(
  "sparse report slide evidenceIds",
  (fixture) => {
    const sparse = new Array(2);
    sparse[0] = fixture.report.slides[2].evidenceIds[0];
    check(!isDenseArray(sparse), "sparse report evidenceIds fixture must contain a hole");
    const slides = fixture.report.slides.map((entry, index) =>
      index === 2 ? { ...entry, evidenceIds: sparse } : entry,
    );
    replaceReport(fixture, { ...fixture.report, slides });
  },
  /report\.slides\[2\]\.evidenceIds must contain non-empty strings/,
);
expectFail(
  "report slide missing judgment ID",
  (fixture) => {
    const slides = fixture.report.slides.map((entry, index) =>
      index === 2 ? { ...entry, judgmentIds: [] } : entry,
    );
    const report = { ...fixture.report, slides };
    reserialize(fixture, { report });
    fixture.approval.smokeReportSha256 = sha256(fixture.reportBytes);
  },
  /report\.slides\[2\]\.judgmentIds must exactly equal the plan judgment IDs/,
);
expectFail(
  "report slide extra judgment ID",
  (fixture) => {
    const slides = fixture.report.slides.map((entry, index) =>
      index === 2 ? { ...entry, judgmentIds: [...entry.judgmentIds, "jc-extra"] } : entry,
    );
    replaceReport(fixture, { ...fixture.report, slides });
  },
  /report\.slides\[2\]\.judgmentIds must exactly equal the plan judgment IDs/,
);
expectFail(
  "report slide duplicate judgment ID",
  (fixture) => {
    const slides = fixture.report.slides.map((entry, index) =>
      index === 2
        ? { ...entry, judgmentIds: [...entry.judgmentIds, entry.judgmentIds[0]] }
        : entry,
    );
    replaceReport(fixture, { ...fixture.report, slides });
  },
  /report\.slides\[2\]\.judgmentIds must not contain duplicates/,
);
expectFail(
  "report slide densityScore wrong",
  (fixture) => {
    const slides = fixture.report.slides.map((entry, index) =>
      index === 2 ? { ...entry, densityScore: entry.densityScore + 1 } : entry,
    );
    const report = { ...fixture.report, slides };
    reserialize(fixture, { report });
    fixture.approval.smokeReportSha256 = sha256(fixture.reportBytes);
  },
  /report\.slides\[2\]\.densityScore must equal the plan's density score/,
);
expectFail(
  "report slide nativeShapeCount zero",
  (fixture) => {
    const slides = fixture.report.slides.map((entry, index) =>
      index === 2 ? { ...entry, nativeShapeCount: 0 } : entry,
    );
    replaceReport(fixture, { ...fixture.report, slides });
  },
  /report\.slides\[2\]\.nativeShapeCount must be a positive integer/,
);
expectFail(
  "report slide nativeShapeCount fractional",
  (fixture) => {
    const slides = fixture.report.slides.map((entry, index) =>
      index === 2 ? { ...entry, nativeShapeCount: 2.5 } : entry,
    );
    replaceReport(fixture, { ...fixture.report, slides });
  },
  /report\.slides\[2\]\.nativeShapeCount must be a positive integer/,
);
expectFail(
  "report slide nativeTableCount negative",
  (fixture) => {
    const slides = fixture.report.slides.map((entry, index) =>
      index === 2 ? { ...entry, nativeTableCount: -1 } : entry,
    );
    replaceReport(fixture, { ...fixture.report, slides });
  },
  /report\.slides\[2\]\.nativeTableCount must be an integer greater than or equal to 0/,
);
for (const family of ["table", "evaluation"]) {
  const plan = buildTiePlan();
  if (family === "evaluation") {
    plan.slides[2] = {
      ...plan.slides[2],
      family,
      content: { cases: [1, 2] },
    };
  }
  const fixture = buildFixture(plan);
  const slides = fixture.report.slides.map((entry, index) =>
    index === 2 ? { ...entry, nativeTableCount: 0 } : entry,
  );
  replaceReport(fixture, { ...fixture.report, slides });
  const result = validateSmokeApproval({
    planBytes: fixture.planBytes,
    reportBytes: fixture.reportBytes,
    approval: fixture.approval,
  });
  check(
    result.errors.some((error) =>
      /report\.slides\[2\]\.nativeTableCount must be an integer greater than or equal to 1/.test(
        error,
      ),
    ),
    `${family} family must require a native table, got: ${result.errors.join("; ")}`,
  );
}

// --- Slide ID / family mismatch ---
expectFail(
  "report slide id mismatch",
  (fixture) => {
    const slides = fixture.report.slides.map((entry, index) =>
      index === 2 ? { ...entry, id: "different-id" } : entry,
    );
    const report = { ...fixture.report, slides };
    reserialize(fixture, { report });
    fixture.approval.smokeReportSha256 = sha256(fixture.reportBytes);
  },
  /report\.slides\[2\]\.id must equal metrics-a/,
);
expectFail(
  "report slide family mismatch",
  (fixture) => {
    const slides = fixture.report.slides.map((entry, index) =>
      index === 2 ? { ...entry, family: "table" } : entry,
    );
    const report = { ...fixture.report, slides };
    reserialize(fixture, { report });
    fixture.approval.smokeReportSha256 = sha256(fixture.reportBytes);
  },
  /report\.slides\[2\]\.family must equal metrics/,
);

// --- CLI contract: success and failure shapes ---
const temp = await mkdtemp(join(tmpdir(), "fde-readout-pptx-smoke-"));
try {
  const fixture = buildFixture();
  const planPath = join(temp, "plan.json");
  const reportPath = join(temp, "smoke-report.json");
  const approvalPath = join(temp, "approval.json");
  await writeFile(planPath, fixture.planBytes);
  await writeFile(reportPath, fixture.reportBytes);
  await writeFile(approvalPath, JSON.stringify(fixture.approval));

  const success = spawnSync(
    process.execPath,
    [cli, "--approval", approvalPath, "--plan", planPath, "--smoke-report", reportPath],
    { encoding: "utf8" },
  );
  check(success.status === 0, `CLI success case must exit 0, got: ${success.stderr}`);
  let parsed;
  try {
    parsed = JSON.parse(success.stdout);
  } catch (error) {
    failures.push(`CLI success stdout must be JSON: ${error.message}`);
  }
  if (parsed) {
    check(parsed.status === "PASS", "CLI success JSON must report status PASS");
    check(parsed.approver?.name === "Jane Doe", "CLI success JSON must report approver.name");
    check(
      parsed.approver?.role === "Engagement Director",
      "CLI success JSON must report approver.role",
    );
    check(
      Array.isArray(parsed.selectedSlideIds) && parsed.selectedSlideIds.length === 3,
      "CLI success JSON must report 3 selectedSlideIds",
    );
    check(parsed.densestSlideId === "metrics-a", "CLI success JSON must report the densest slide ID");
  }

  const badApproval = { ...fixture.approval, approved: false };
  await writeFile(approvalPath, JSON.stringify(badApproval));
  const failure = spawnSync(
    process.execPath,
    [cli, "--approval", approvalPath, "--plan", planPath, "--smoke-report", reportPath],
    { encoding: "utf8" },
  );
  check(failure.status !== 0, "CLI failure case must exit nonzero");
  check(failure.stdout.trim().length === 0, "CLI failure case must not print success-shaped stdout");
  check(/^1\. /m.test(failure.stderr), "CLI failure case must print numbered errors to stderr");

  function checkCliFailure(label, args) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    check(result.status !== 0, `${label} must exit nonzero`);
    check(result.stdout.length === 0, `${label} must leave stdout empty`);
    check(/^1\. /m.test(result.stderr), `${label} must print numbered errors to stderr`);
  }

  const validArgs = [
    "--approval",
    approvalPath,
    "--plan",
    planPath,
    "--smoke-report",
    reportPath,
  ];
  checkCliFailure("CLI missing required flag", validArgs.slice(0, -2));
  checkCliFailure("CLI unknown flag", [...validArgs, "--wat"]);
  checkCliFailure("CLI unknown positional argument", [...validArgs, "extra"]);
  checkCliFailure("CLI duplicate flag", [...validArgs, "--plan", planPath]);
  checkCliFailure("CLI missing flag value", [
    "--approval",
    "--plan",
    planPath,
    "--smoke-report",
    reportPath,
  ]);
  checkCliFailure("CLI help with another argument", ["--help", "--plan", planPath]);

  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  check(help.status === 0, "CLI --help alone must exit zero");
  check(/^Usage:/.test(help.stdout), "CLI --help alone must print usage to stdout");
  check(help.stderr.length === 0, "CLI --help alone must leave stderr empty");
} finally {
  await rm(temp, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("PowerPoint smoke contract tests failed:");
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log("PowerPoint smoke contract tests passed.");
