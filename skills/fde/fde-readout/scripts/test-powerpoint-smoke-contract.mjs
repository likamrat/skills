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
  densityScore,
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
    nativeShapeCount: densityScore(slide),
  };
}

function buildFixture() {
  const plan = buildPlan();
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
    approver: "Jane Doe",
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

// --- Success ---
expectPass("baseline success");

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
  /selectedSlideIds must contain (exactly 3|unique)/,
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

// --- Generic approvers ---
for (const approver of ["agent", "AI", " None ", "N/A", "System", "Automation", "unknown"]) {
  expectFail(
    `generic approver: ${approver}`,
    (fixture) => {
      fixture.approval.approver = approver;
    },
    /must name an accountable human/,
  );
}

// --- Invalid / no-zone timestamp ---
expectFail(
  "timestamp without zone",
  (fixture) => {
    fixture.approval.approvedAt = "2026-01-15T09:30:00";
  },
  /approvedAt must be an ISO-8601 timestamp/,
);
expectFail(
  "timestamp not a real date",
  (fixture) => {
    fixture.approval.approvedAt = "2026-99-99T09:30:00Z";
  },
  /approvedAt must be/,
);
expectPass("timestamp with numeric offset", (fixture) => {
  fixture.approval.approvedAt = "2026-01-15T09:30:00+02:00";
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
  /report\.slides\[2\]\.evidenceIds must include every plan evidence ID/,
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
  /report\.slides\[2\]\.judgmentIds must include every plan judgment ID/,
);
expectFail(
  "report slide nativeShapeCount wrong",
  (fixture) => {
    const slides = fixture.report.slides.map((entry, index) =>
      index === 2 ? { ...entry, nativeShapeCount: entry.nativeShapeCount + 1 } : entry,
    );
    const report = { ...fixture.report, slides };
    reserialize(fixture, { report });
    fixture.approval.smokeReportSha256 = sha256(fixture.reportBytes);
  },
  /report\.slides\[2\]\.nativeShapeCount must equal the plan's density score/,
);

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
} finally {
  await rm(temp, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("PowerPoint smoke contract tests failed:");
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log("PowerPoint smoke contract tests passed.");
