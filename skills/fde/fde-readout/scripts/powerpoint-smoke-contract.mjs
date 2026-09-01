#!/usr/bin/env node

// Pure, reusable functions for the cross-platform PowerPoint smoke contract.
// This module performs no I/O, network access, or external tool calls.

import { createHash } from "node:crypto";

export const EXCLUDED_SMOKE_FAMILIES = Object.freeze([
  "cover",
  "decision",
  "evidence",
]);
const excludedSmokeFamilyLookup = new Set(EXCLUDED_SMOKE_FAMILIES);

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

export const BLOCKED_IDENTITY_TERMS = Object.freeze([
  "agent",
  "ai",
  "artificial intelligence",
  "anonymous",
  "automation",
  "bot",
  "chatgpt",
  "ci",
  "copilot",
  "gpt",
  "model",
  "none",
  "pipeline",
  "service principal",
  "system",
  "tool",
  "unknown",
  "n a",
]);
const blockedIdentityTermLookup = new Set(BLOCKED_IDENTITY_TERMS);

export const APPROVAL_ALLOWED_KEYS = Object.freeze([
  "schemaVersion",
  "approved",
  "approver",
  "approvedAt",
  "planSha256",
  "smokeReportSha256",
  "smokePptxSha256",
  "contactSheetSha256",
  "selectedSlideIds",
]);
const approvalAllowedKeyLookup = new Set(APPROVAL_ALLOWED_KEYS);
const approverAllowedKeyLookup = new Set(["name", "role"]);
const reportAllowedKeyLookup = new Set([
  "schemaVersion",
  "status",
  "selectionMode",
  "sourcePlanSha256",
  "selectedSlideIds",
  "selectedSlideFamilies",
  "pptxSha256",
  "contactSheetSha256",
  "slides",
  "package",
]);
const reportSlideAllowedKeyLookup = new Set([
  "id",
  "family",
  "overflow",
  "notesVerified",
  "evidenceIds",
  "judgmentIds",
  "densityScore",
  "nativeShapeCount",
  "nativeTableCount",
]);
const reportPackageAllowedKeyLookup = new Set([
  "slides",
  "notesParts",
  "uniqueNotesRelationships",
  "macroFree",
  "externalRelationships",
  "orphanSlides",
  "orphanNotes",
]);

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;
const PERSONAL_NAME =
  /^[\p{L}][\p{L}\p{M}'\u2019.-]*(?:\s+[\p{L}][\p{L}\p{M}'\u2019.-]*)+$/u;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function isDenseArray(value) {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!hasOwn(value, index)) return false;
  }
  return true;
}

function checkExactKeys(value, allowedKeys, label, errors) {
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    errors.push(`${label} has unexpected keys: ${unexpected.join(", ")}`);
  }
}

function requireOwnKeys(value, keys, label, errors) {
  for (const key of keys) {
    if (!hasOwn(value, key)) errors.push(`${label}.${key} must be an own property`);
  }
}

function normalizeIdentityText(value) {
  return typeof value === "string"
    ? value
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .replace(/\s+/g, " ")
    : "";
}

export function containsBlockedIdentityTerm(value) {
  const normalized = normalizeIdentityText(value);
  if (!normalized) return false;
  const padded = ` ${normalized} `;
  for (const term of blockedIdentityTermLookup) {
    if (padded.includes(` ${term} `)) return true;
  }
  return false;
}

function looksLikePersonalName(value) {
  if (!isNonEmptyString(value)) return false;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!PERSONAL_NAME.test(normalized)) return false;
  return normalized.split(" ").every((word) => (word.match(/\p{L}/gu) ?? []).length >= 2);
}

function isValidIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]) return false;

  if (match[8] !== "Z") {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      return false;
    }
  }
  return true;
}

function validateStringArray(value, label, errors, { length, unique = true } = {}) {
  if (!isDenseArray(value)) {
    errors.push(`${label} must be a dense array`);
    return false;
  }
  if (length !== undefined && value.length !== length) {
    errors.push(`${label} must contain exactly ${length} entries`);
    return false;
  }
  if (!value.every(isNonEmptyString)) {
    errors.push(`${label} must contain non-empty strings`);
    return false;
  }
  if (unique && new Set(value).size !== value.length) {
    errors.push(`${label} must not contain duplicates`);
    return false;
  }
  return true;
}

export function densityScore(slide) {
  if (!isPlainObject(slide) || !hasOwn(slide, "family")) {
    throw new TypeError("slide must be a plain object with an own family property");
  }
  const fields = FAMILY_DENSITY_FIELDS[slide.family];
  if (!fields) return 0;
  if (!hasOwn(slide, "content") || !isPlainObject(slide.content)) {
    throw new TypeError("slide.content must be an own plain object");
  }

  let score = 0;
  for (const field of fields) {
    if (!hasOwn(slide.content, field)) continue;
    const value = slide.content[field];
    if (!isDenseArray(value)) {
      throw new TypeError(`slide.content.${field} must be a dense array`);
    }
    score += value.length;
  }
  return score;
}

export function selectSmokeSlides(plan) {
  if (!isPlainObject(plan) || !hasOwn(plan, "slides") || !isDenseArray(plan.slides)) {
    throw new Error("plan must be a plain object with an own dense slides array");
  }
  const slides = plan.slides;
  if (slides.length < 2) {
    throw new Error("plan requires at least a cover slide and a decision slide");
  }
  slides.forEach((slide, index) => {
    if (
      !isPlainObject(slide) ||
      !hasOwn(slide, "id") ||
      !isNonEmptyString(slide.id) ||
      !hasOwn(slide, "family") ||
      !isNonEmptyString(slide.family)
    ) {
      throw new Error(`plan.slides[${index}] must have own non-empty id and family properties`);
    }
  });

  const cover = slides[0];
  const decision = slides[1];
  if (cover.family !== "cover") throw new Error("plan's first slide must use family cover");
  if (decision.family !== "decision") {
    throw new Error("plan's second slide must use family decision");
  }

  let bestIndex = -1;
  let bestScore = -Infinity;
  for (let index = 2; index < slides.length; index += 1) {
    const slide = slides[index];
    if (excludedSmokeFamilyLookup.has(slide.family)) continue;
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

function validateApprovalShape(approval, errors) {
  if (!isPlainObject(approval)) {
    errors.push("approval must be a plain object");
    return;
  }

  checkExactKeys(approval, approvalAllowedKeyLookup, "approval", errors);
  requireOwnKeys(approval, APPROVAL_ALLOWED_KEYS, "approval", errors);
  if (!hasOwn(approval, "schemaVersion") || approval.schemaVersion !== 1) {
    errors.push("approval.schemaVersion must equal 1");
  }
  if (!hasOwn(approval, "approved") || approval.approved !== true) {
    errors.push("approval.approved must equal true");
  }

  if (!hasOwn(approval, "approver") || !isPlainObject(approval.approver)) {
    errors.push("approval.approver must be a plain object");
  } else {
    checkExactKeys(approval.approver, approverAllowedKeyLookup, "approval.approver", errors);
    requireOwnKeys(approval.approver, ["name", "role"], "approval.approver", errors);
    if (!hasOwn(approval.approver, "name") || !looksLikePersonalName(approval.approver.name)) {
      errors.push("approval.approver.name must contain at least two nontrivial name words");
    } else if (containsBlockedIdentityTerm(approval.approver.name)) {
      errors.push("approval.approver.name must identify a human, not a machine or anonymous actor");
    }
    if (
      !hasOwn(approval.approver, "role") ||
      !isNonEmptyString(approval.approver.role) ||
      !/\p{L}/u.test(approval.approver.role)
    ) {
      errors.push("approval.approver.role must name an accountable role");
    } else if (containsBlockedIdentityTerm(approval.approver.role)) {
      errors.push("approval.approver.role must identify an accountable human role");
    }
  }

  if (!hasOwn(approval, "approvedAt") || !isValidIsoTimestamp(approval.approvedAt)) {
    errors.push(
      "approval.approvedAt must be a real ISO-8601 calendar timestamp with a Z or valid numeric offset",
    );
  }
  for (const field of [
    "planSha256",
    "smokeReportSha256",
    "smokePptxSha256",
    "contactSheetSha256",
  ]) {
    if (
      !hasOwn(approval, field) ||
      !isNonEmptyString(approval[field]) ||
      !HEX64.test(approval[field])
    ) {
      errors.push(`approval.${field} must be a lowercase 64-character SHA-256 hex digest`);
    }
  }
  if (hasOwn(approval, "selectedSlideIds")) {
    validateStringArray(approval.selectedSlideIds, "approval.selectedSlideIds", errors, {
      length: 3,
    });
  }
}

function arraysEqual(actual, expected) {
  return (
    isDenseArray(actual) &&
    isDenseArray(expected) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function parseJsonBytes(bytes, label, errors) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error.message}`);
    return undefined;
  }
}

export function validateSmokeApproval({ planBytes, reportBytes, approval }) {
  const errors = [];
  validateApprovalShape(approval, errors);
  if (planBytes === undefined || planBytes === null) errors.push("planBytes is required");
  if (reportBytes === undefined || reportBytes === null) errors.push("reportBytes is required");
  if (errors.length > 0) return { errors };

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
  if (plan === undefined || report === undefined) return { errors };

  let selection;
  try {
    selection = selectSmokeSlides(plan);
  } catch (error) {
    errors.push(`plan selection failed: ${error.message}`);
    return { errors };
  }
  const expectedIds = selection.map((slide) => slide.id);
  const expectedFamilies = selection.map((slide) => slide.family);
  selection.forEach((slide, index) => {
    const prefix = `plan smoke selection[${index}]`;
    if (!hasOwn(slide, "evidenceIds")) {
      errors.push(`${prefix}.evidenceIds must be an own property`);
    } else {
      validateStringArray(slide.evidenceIds, `${prefix}.evidenceIds`, errors);
    }
    if (!hasOwn(slide, "judgmentIds")) {
      errors.push(`${prefix}.judgmentIds must be an own property`);
    } else {
      validateStringArray(slide.judgmentIds, `${prefix}.judgmentIds`, errors);
    }
  });
  if (!arraysEqual(approval.selectedSlideIds, expectedIds)) {
    errors.push(
      `approval.selectedSlideIds must equal selectSmokeSlides order: ${expectedIds.join(", ")}`,
    );
  }

  if (!isPlainObject(report)) {
    errors.push("smoke report must be a plain object");
    return { errors };
  }
  checkExactKeys(report, reportAllowedKeyLookup, "report", errors);
  requireOwnKeys(report, [...reportAllowedKeyLookup], "report", errors);
  if (!hasOwn(report, "schemaVersion") || report.schemaVersion !== 1) {
    errors.push("report.schemaVersion must equal 1");
  }
  if (!hasOwn(report, "status") || report.status !== "PASS") {
    errors.push("report.status must equal PASS");
  }
  if (!hasOwn(report, "selectionMode") || report.selectionMode !== "smoke") {
    errors.push("report.selectionMode must equal smoke");
  }
  if (
    !hasOwn(report, "sourcePlanSha256") ||
    typeof report.sourcePlanSha256 !== "string" ||
    !HEX64.test(report.sourcePlanSha256) ||
    report.sourcePlanSha256 !== actualPlanSha256
  ) {
    errors.push("report.sourcePlanSha256 must equal the plan's actual SHA-256");
  }

  const validSelectedSlideIds =
    hasOwn(report, "selectedSlideIds") &&
    validateStringArray(report.selectedSlideIds, "report.selectedSlideIds", errors, {
      length: 3,
    });
  if (!validSelectedSlideIds || !arraysEqual(report.selectedSlideIds, expectedIds)) {
    errors.push("report.selectedSlideIds must equal the expected smoke selection");
  }
  const validSelectedFamilies =
    hasOwn(report, "selectedSlideFamilies") &&
    validateStringArray(
      report.selectedSlideFamilies,
      "report.selectedSlideFamilies",
      errors,
      { length: 3, unique: false },
    );
  if (!validSelectedFamilies || !arraysEqual(report.selectedSlideFamilies, expectedFamilies)) {
    errors.push("report.selectedSlideFamilies must equal the plan's actual slide families");
  }

  if (
    !hasOwn(report, "pptxSha256") ||
    typeof report.pptxSha256 !== "string" ||
    !HEX64.test(report.pptxSha256) ||
    report.pptxSha256 !== approval.smokePptxSha256
  ) {
    errors.push("report.pptxSha256 must equal approval.smokePptxSha256");
  }
  if (
    !hasOwn(report, "contactSheetSha256") ||
    typeof report.contactSheetSha256 !== "string" ||
    !HEX64.test(report.contactSheetSha256) ||
    report.contactSheetSha256 !== approval.contactSheetSha256
  ) {
    errors.push("report.contactSheetSha256 must equal approval.contactSheetSha256");
  }

  if (!hasOwn(report, "slides") || !isDenseArray(report.slides) || report.slides.length !== 3) {
    errors.push("report.slides must contain exactly 3 dense entries");
  } else {
    selection.forEach((planSlide, index) => {
      const entry = report.slides[index];
      const prefix = `report.slides[${index}]`;
      if (!isPlainObject(entry)) {
        errors.push(`${prefix} must be a plain object`);
        return;
      }
      checkExactKeys(entry, reportSlideAllowedKeyLookup, prefix, errors);
      requireOwnKeys(entry, [...reportSlideAllowedKeyLookup], prefix, errors);
      if (!hasOwn(entry, "id") || entry.id !== planSlide.id) {
        errors.push(`${prefix}.id must equal ${planSlide.id}`);
      }
      if (!hasOwn(entry, "family") || entry.family !== planSlide.family) {
        errors.push(`${prefix}.family must equal ${planSlide.family}`);
      }
      if (!hasOwn(entry, "overflow") || entry.overflow !== false) {
        errors.push(`${prefix}.overflow must equal false`);
      }
      if (!hasOwn(entry, "notesVerified") || entry.notesVerified !== true) {
        errors.push(`${prefix}.notesVerified must equal true`);
      }

      const validEvidenceIds =
        hasOwn(entry, "evidenceIds") &&
        validateStringArray(entry.evidenceIds, `${prefix}.evidenceIds`, errors);
      if (!validEvidenceIds || !arraysEqual(entry.evidenceIds, planSlide.evidenceIds)) {
        errors.push(`${prefix}.evidenceIds must exactly equal the plan evidence IDs`);
      }
      const validJudgmentIds =
        hasOwn(entry, "judgmentIds") &&
        validateStringArray(entry.judgmentIds, `${prefix}.judgmentIds`, errors);
      if (!validJudgmentIds || !arraysEqual(entry.judgmentIds, planSlide.judgmentIds)) {
        errors.push(`${prefix}.judgmentIds must exactly equal the plan judgment IDs`);
      }

      const expectedDensityScore = densityScore(planSlide);
      if (
        !hasOwn(entry, "densityScore") ||
        !Number.isInteger(entry.densityScore) ||
        entry.densityScore < 0 ||
        entry.densityScore !== expectedDensityScore
      ) {
        errors.push(
          `${prefix}.densityScore must equal the plan's density score (${expectedDensityScore})`,
        );
      }
      if (
        !hasOwn(entry, "nativeShapeCount") ||
        !Number.isInteger(entry.nativeShapeCount) ||
        entry.nativeShapeCount <= 0
      ) {
        errors.push(`${prefix}.nativeShapeCount must be a positive integer`);
      }
      const minimumTableCount = ["table", "evaluation"].includes(planSlide.family) ? 1 : 0;
      if (
        !hasOwn(entry, "nativeTableCount") ||
        !Number.isInteger(entry.nativeTableCount) ||
        entry.nativeTableCount < minimumTableCount
      ) {
        errors.push(
          `${prefix}.nativeTableCount must be an integer greater than or equal to ${minimumTableCount}`,
        );
      }
    });
  }

  const pkg = report.package;
  if (!hasOwn(report, "package") || !isPlainObject(pkg)) {
    errors.push("report.package must be a plain object");
  } else {
    checkExactKeys(pkg, reportPackageAllowedKeyLookup, "report.package", errors);
    requireOwnKeys(pkg, [...reportPackageAllowedKeyLookup], "report.package", errors);
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
      const validType =
        typeof expected === "boolean"
          ? typeof pkg[field] === "boolean"
          : Number.isInteger(pkg[field]) && Number.isFinite(pkg[field]);
      if (!hasOwn(pkg, field) || !validType || pkg[field] !== expected) {
        errors.push(`report.package.${field} must equal ${JSON.stringify(expected)}`);
      }
    }
  }

  if (errors.length > 0) return { errors };
  return {
    errors,
    status: report.status,
    approver: {
      name: approval.approver.name,
      role: approval.approver.role,
    },
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
