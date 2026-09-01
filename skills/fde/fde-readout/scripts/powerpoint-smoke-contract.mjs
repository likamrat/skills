#!/usr/bin/env node

// Pure, reusable functions for the cross-platform PowerPoint smoke contract.
// This module performs no I/O, no network access, and no external tool calls.
// It never invokes full ReadoutPlan validation; it only reads the fields it
// needs from an already-parsed plan or report object.

import { createHash } from "node:crypto";

// Slide families that can never be the smoke deck's third slide. The cover
// and decision slides are mandatory picks by position; the evidence slide is
// the plan's appendix and carries no standalone narrative density.
export const EXCLUDED_SMOKE_FAMILIES = Object.freeze(
  new Set(["cover", "decision", "evidence"]),
);

// Density scoring is a sum of named content-array lengths per slide family.
// Keeping the field list in a constant (rather than describing it in prose)
// makes the score reproducible: any slide's score is the sum of the lengths
// of the arrays named here for that slide's family.
export const FAMILY_DENSITY_FIELDS = Object.freeze({
  profile: Object.freeze(["facts", "contexts"]),
  metrics: Object.freeze(["metrics"]),
  chart: Object.freeze(["categories", "series"]),
  table: Object.freeze(["columns", "rows"]),
  workflow: Object.freeze(["nodes", "edges"]),
  findings: Object.freeze(["items"]),
  responsibility: Object.freeze(["steps"]),
  evaluation: Object.freeze(["cases"]),
  risks: Object.freeze(["items"]),
  timeline: Object.freeze(["milestones"]),
});

// Approvers that name a non-human or non-accountable actor. Compared after
// normalizeApprover() collapses case and whitespace.
export const GENERIC_APPROVERS = Object.freeze(
  new Set(["agent", "ai", "model", "system", "automation", "unknown", "none", "n/a"]),
);

export const APPROVAL_ALLOWED_KEYS = Object.freeze(
  new Set([
    "schemaVersion",
    "approved",
    "approver",
    "approvedAt",
    "planSha256",
    "smokeReportSha256",
    "smokePptxSha256",
    "contactSheetSha256",
    "selectedSlideIds",
  ]),
);

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveArray(value) {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Sum of the density-field array lengths declared for a slide's family in
 * FAMILY_DENSITY_FIELDS. Families with no declared fields (including cover,
 * decision, and evidence) always score 0.
 */
export function densityScore(slide) {
  const fields = FAMILY_DENSITY_FIELDS[slide?.family];
  if (!fields) return 0;
  const content = isPlainObject(slide?.content) ? slide.content : {};
  let score = 0;
  for (const field of fields) {
    const value = content[field];
    if (Array.isArray(value)) score += value.length;
  }
  return score;
}

/**
 * Selects the three-slide smoke deck from a full ReadoutPlan in complete-plan
 * order: the first slide (cover), the second slide (decision), and the
 * densest eligible slide found afterward, excluding cover, decision, and
 * evidence families. Ties keep the earlier slide. Throws if the plan does
 * not have a cover-first, decision-second shape or lacks an eligible third
 * slide.
 */
export function selectSmokeSlides(plan) {
  const slides = Array.isArray(plan?.slides) ? plan.slides : [];
  if (slides.length < 2) {
    throw new Error("plan requires at least a cover slide and a decision slide");
  }

  const cover = slides[0];
  const decision = slides[1];
  if (cover?.family !== "cover") {
    throw new Error("plan's first slide must use family cover");
  }
  if (decision?.family !== "decision") {
    throw new Error("plan's second slide must use family decision");
  }

  let bestIndex = -1;
  let bestScore = -Infinity;
  for (let index = 2; index < slides.length; index += 1) {
    const slide = slides[index];
    if (EXCLUDED_SMOKE_FAMILIES.has(slide?.family)) continue;
    const score = densityScore(slide);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  if (bestIndex === -1) {
    throw new Error(
      "plan has no eligible third slide for a smoke selection (excludes cover, decision, evidence)",
    );
  }

  return [cover, decision, slides[bestIndex]];
}

export function normalizeApprover(value) {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/\s+/g, " ")
    : "";
}

export function isGenericApprover(value) {
  return GENERIC_APPROVERS.has(normalizeApprover(value));
}

function validateApprovalShape(approval, errors) {
  if (!isPlainObject(approval)) {
    errors.push("approval must be a JSON object");
    return;
  }

  const keys = Object.keys(approval);
  const unexpected = keys.filter((key) => !APPROVAL_ALLOWED_KEYS.has(key));
  if (unexpected.length > 0) {
    errors.push(`approval has unexpected keys: ${unexpected.join(", ")}`);
  }

  if (approval.schemaVersion !== 1) {
    errors.push("approval.schemaVersion must equal 1");
  }
  if (approval.approved !== true) {
    errors.push("approval.approved must equal true");
  }
  if (!isNonEmptyString(approval.approver)) {
    errors.push("approval.approver is required");
  } else if (isGenericApprover(approval.approver)) {
    errors.push(
      `approval.approver must name an accountable human, not a generic actor: ${approval.approver}`,
    );
  }
  if (!isNonEmptyString(approval.approvedAt) || !ISO_TIMESTAMP.test(approval.approvedAt)) {
    errors.push(
      "approval.approvedAt must be an ISO-8601 timestamp with a Z or numeric offset",
    );
  } else if (Number.isNaN(Date.parse(approval.approvedAt))) {
    errors.push("approval.approvedAt must be a valid timestamp");
  }
  for (const field of [
    "planSha256",
    "smokeReportSha256",
    "smokePptxSha256",
    "contactSheetSha256",
  ]) {
    if (!isNonEmptyString(approval[field]) || !HEX64.test(approval[field])) {
      errors.push(`approval.${field} must be a lowercase 64-character SHA-256 hex digest`);
    }
  }
  if (!isPositiveArray(approval.selectedSlideIds) || approval.selectedSlideIds.length !== 3) {
    errors.push("approval.selectedSlideIds must contain exactly 3 slide IDs");
  } else if (!approval.selectedSlideIds.every(isNonEmptyString)) {
    errors.push("approval.selectedSlideIds must contain non-empty slide IDs");
  } else if (new Set(approval.selectedSlideIds).size !== approval.selectedSlideIds.length) {
    errors.push("approval.selectedSlideIds must contain unique slide IDs");
  }
}

function arraysEqual(actual, expected) {
  return (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function containsAll(actual, expected) {
  if (!Array.isArray(actual)) return (expected ?? []).length === 0;
  const actualSet = new Set(actual);
  return (expected ?? []).every((value) => actualSet.has(value));
}

function parseJsonBytes(bytes, label, errors) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error.message}`);
    return undefined;
  }
}

/**
 * Validates a smoke approval record against the raw plan and smoke-report
 * bytes it references. Reads bytes only to hash and to parse the fields this
 * contract checks; never runs full ReadoutPlan validation, network access,
 * or external tools.
 *
 * Returns { errors, status, approver, approvedAt, hashes, selectedSlideIds,
 * densestSlideId }. When errors is empty, the approval is valid and the
 * remaining fields describe the approved smoke selection.
 */
export function validateSmokeApproval({ planBytes, reportBytes, approval }) {
  const errors = [];
  validateApprovalShape(approval, errors);

  if (planBytes === undefined || planBytes === null) {
    errors.push("planBytes is required");
  }
  if (reportBytes === undefined || reportBytes === null) {
    errors.push("reportBytes is required");
  }
  if (errors.length > 0) {
    return { errors };
  }

  const actualPlanSha256 = sha256Hex(planBytes);
  const actualReportSha256 = sha256Hex(reportBytes);

  if (approval.planSha256 !== actualPlanSha256) {
    errors.push(
      `approval.planSha256 must equal the plan's actual SHA-256 (${actualPlanSha256})`,
    );
  }
  if (approval.smokeReportSha256 !== actualReportSha256) {
    errors.push(
      `approval.smokeReportSha256 must equal the report's actual SHA-256 (${actualReportSha256})`,
    );
  }

  const plan = parseJsonBytes(planBytes, "plan", errors);
  const report = parseJsonBytes(reportBytes, "smoke report", errors);
  if (plan === undefined || report === undefined) {
    return { errors };
  }

  let selection;
  try {
    selection = selectSmokeSlides(plan);
  } catch (error) {
    errors.push(`plan selection failed: ${error.message}`);
    return { errors };
  }

  const expectedIds = selection.map((slide) => slide.id);
  const expectedFamilies = selection.map((slide) => slide.family);

  if (!arraysEqual(approval.selectedSlideIds, expectedIds)) {
    errors.push(
      `approval.selectedSlideIds must equal selectSmokeSlides order: ${expectedIds.join(", ")}`,
    );
  }

  if (!isPlainObject(report)) {
    errors.push("smoke report must be a JSON object");
    return { errors };
  }

  if (report.schemaVersion !== 1) {
    errors.push("report.schemaVersion must equal 1");
  }
  if (report.status !== "PASS") {
    errors.push("report.status must equal PASS");
  }
  if (report.selectionMode !== "smoke") {
    errors.push("report.selectionMode must equal smoke");
  }
  if (report.sourcePlanSha256 !== actualPlanSha256) {
    errors.push("report.sourcePlanSha256 must equal the plan's actual SHA-256");
  }
  if (!arraysEqual(report.selectedSlideIds, expectedIds)) {
    errors.push("report.selectedSlideIds must equal the expected smoke selection");
  }
  if (!arraysEqual(report.selectedSlideFamilies, expectedFamilies)) {
    errors.push("report.selectedSlideFamilies must equal the plan's actual slide families");
  }
  // This contract only takes the raw plan and report bytes as input, so it
  // can independently hash and verify planSha256 and smokeReportSha256
  // against real bytes above. It cannot independently verify smokePptxSha256
  // or contactSheetSha256 the same way; it only asserts the report and
  // approval agree on those two hashes. Independently hashing the actual
  // .pptx and contact-sheet artifacts is the renderer layer's job.
  if (report.pptxSha256 !== approval.smokePptxSha256) {
    errors.push("report.pptxSha256 must equal approval.smokePptxSha256");
  }
  if (report.contactSheetSha256 !== approval.contactSheetSha256) {
    errors.push("report.contactSheetSha256 must equal approval.contactSheetSha256");
  }

  if (!Array.isArray(report.slides) || report.slides.length !== 3) {
    errors.push("report.slides must contain exactly 3 entries");
  } else {
    selection.forEach((planSlide, index) => {
      const entry = report.slides[index];
      const prefix = `report.slides[${index}]`;
      if (!isPlainObject(entry)) {
        errors.push(`${prefix} must be an object`);
        return;
      }
      if (entry.id !== planSlide.id) {
        errors.push(`${prefix}.id must equal ${planSlide.id}`);
      }
      if (entry.family !== planSlide.family) {
        errors.push(`${prefix}.family must equal ${planSlide.family}`);
      }
      if (entry.overflow !== false) {
        errors.push(`${prefix}.overflow must equal false`);
      }
      if (entry.notesVerified !== true) {
        errors.push(`${prefix}.notesVerified must equal true`);
      }
      if (!containsAll(entry.evidenceIds, planSlide.evidenceIds)) {
        errors.push(`${prefix}.evidenceIds must include every plan evidence ID`);
      }
      if (!containsAll(entry.judgmentIds, planSlide.judgmentIds)) {
        errors.push(`${prefix}.judgmentIds must include every plan judgment ID`);
      }
      const expectedShapeCount = densityScore(planSlide);
      if (entry.nativeShapeCount !== expectedShapeCount) {
        errors.push(
          `${prefix}.nativeShapeCount must equal the plan's density score (${expectedShapeCount})`,
        );
      }
    });
  }

  const pkg = report.package;
  if (!isPlainObject(pkg)) {
    errors.push("report.package must be an object");
  } else {
    const expectedPackage = {
      slides: 3,
      notesParts: 3,
      uniqueNotesRelationships: 3,
      macroFree: true,
      externalRelationships: 0,
      orphanSlides: 0,
      orphanNotes: 0,
    };
    for (const [field, expected] of Object.entries(expectedPackage)) {
      if (pkg[field] !== expected) {
        errors.push(`report.package.${field} must equal ${JSON.stringify(expected)}`);
      }
    }
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    errors,
    status: report.status,
    approver: approval.approver,
    approvedAt: approval.approvedAt,
    hashes: {
      planSha256: approval.planSha256,
      smokeReportSha256: approval.smokeReportSha256,
      smokePptxSha256: approval.smokePptxSha256,
      contactSheetSha256: approval.contactSheetSha256,
    },
    selectedSlideIds: expectedIds,
    densestSlideId: expectedIds[2],
  };
}
