#!/usr/bin/env node

// Pure, reusable functions for the cross-platform PowerPoint smoke contract.
// This module performs no I/O, network access, or external tool calls.

import { createHash } from "node:crypto";

export const PRODUCTION_COORDINATOR_ID = "fde-powerpoint-native-coordinator/1.0";
export const PRODUCTION_EXECUTION_PROFILE = "production";

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

const reportAllowedKeyLookup = new Set([
  "schemaVersion",
  "status",
  "coordinator",
  "executionProfile",
  "selectionMode",
  "sourcePlanSha256",
  "selectedSlideIds",
  "selectedSlideFamilies",
  "pptxSha256",
  "contactSheetSha256",
  "densestSlideReadable",
  "legacyContentRemoved",
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
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalizeJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (!isDenseArray(value)) throw new TypeError("canonical JSON rejects sparse arrays");
    const expectedKeys = new Set(["length", ...value.map((_, index) => String(index))]);
    if (Reflect.ownKeys(value).some((key) => !expectedKeys.has(key))) {
      throw new TypeError("canonical JSON rejects non-JSON array properties");
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!hasOwn(Object.getOwnPropertyDescriptor(value, String(index)), "value")) {
        throw new TypeError("canonical JSON rejects accessor properties");
      }
    }
    return `[${value.map((entry) => canonicalizeJson(entry)).join(",")}]`;
  }
  if (!isPlainObject(value)) {
    throw new TypeError(`canonical JSON rejects unsupported value type: ${typeof value}`);
  }

  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== "string") ||
    ownKeys.some((key) => !Object.prototype.propertyIsEnumerable.call(value, key)) ||
    ownKeys.some((key) => !hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))
  ) {
    throw new TypeError("canonical JSON requires enumerable string-keyed data properties");
  }
  return `{${ownKeys
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`)
    .join(",")}}`;
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
  const unexpected = Reflect.ownKeys(value).filter(
    (key) => typeof key !== "string" || !allowedKeys.has(key),
  );
  if (unexpected.length > 0) {
    errors.push(`${label} has unexpected keys: ${unexpected.map(String).join(", ")}`);
  }
}

function requireOwnKeys(value, keys, label, errors) {
  for (const key of keys) {
    if (!hasOwn(value, key)) errors.push(`${label}.${key} must be an own property`);
  }
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
  if (!FAMILY_DENSITY_FIELDS[slide.family]) return 0;
  if (!hasOwn(slide, "content") || !isPlainObject(slide.content)) {
    throw new TypeError("slide.content must be an own plain object");
  }

  const length = (field) => {
    if (!hasOwn(slide.content, field)) return 0;
    const value = slide.content[field];
    if (!isDenseArray(value)) {
      throw new TypeError(`slide.content.${field} must be a dense array`);
    }
    return value.length;
  };
  const claim = (field) => {
    if (!hasOwn(slide.content, field)) return 0;
    if (!isPlainObject(slide.content[field])) {
      throw new TypeError(`slide.content.${field} must be a plain object`);
    }
    return 1;
  };

  switch (slide.family) {
    case "profile":
      return length("facts") + length("contexts");
    case "metrics":
      return length("metrics");
    case "chart": {
      const categories = length("categories");
      const series = length("series");
      const chartType = slide.content.chartType;
      if (!["bar", "line"].includes(chartType)) {
        throw new TypeError("slide.content.chartType must be bar or line");
      }
      const marks =
        chartType === "line"
          ? series * Math.max(0, 2 * categories - 1)
          : series * categories;
      const axes = 2;
      const legend = series * 2;
      const dataGrid = series * (categories + 1);
      return (
        marks +
        categories +
        series +
        axes +
        legend +
        dataGrid +
        claim("insight")
      );
    }
    case "table": {
      const columns = length("columns");
      const rows = length("rows");
      return rows * columns + columns + claim("insight");
    }
    case "workflow":
      return length("nodes") + length("edges") * 2;
    case "findings":
    case "risks":
      return length("items") * 3;
    case "responsibility":
      return length("steps") * 2;
    case "evaluation":
      return length("cases") * 3 + 3 + claim("releaseImplication");
    case "timeline":
      return length("milestones") * 2;
    default:
      return 0;
  }
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

export function validateSmokeReport({
  planBytes,
  reportBytes,
  expectedCoordinator = PRODUCTION_COORDINATOR_ID,
  expectedExecutionProfile = PRODUCTION_EXECUTION_PROFILE,
}) {
  const errors = [];
  if (planBytes === undefined || planBytes === null) errors.push("planBytes is required");
  if (reportBytes === undefined || reportBytes === null) errors.push("reportBytes is required");
  if (errors.length > 0) return { errors };

  const actualPlanSha256 = sha256Hex(planBytes);
  const actualReportSha256 = sha256Hex(reportBytes);

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
  if (
    !hasOwn(report, "coordinator") ||
    report.coordinator !== expectedCoordinator
  ) {
    errors.push(`report.coordinator must equal ${expectedCoordinator}`);
  }
  if (
    !hasOwn(report, "executionProfile") ||
    report.executionProfile !== expectedExecutionProfile
  ) {
    errors.push(
      `report.executionProfile must equal ${expectedExecutionProfile}`,
    );
  }
  if (!hasOwn(report, "selectionMode") || report.selectionMode !== "smoke") {
    errors.push("report.selectionMode must equal smoke");
  }
  if (!hasOwn(report, "densestSlideReadable") || report.densestSlideReadable !== true) {
    errors.push("report.densestSlideReadable must equal true");
  }
  if (!hasOwn(report, "legacyContentRemoved") || report.legacyContentRemoved !== true) {
    errors.push("report.legacyContentRemoved must equal true");
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
    !HEX64.test(report.pptxSha256)
  ) {
    errors.push("report.pptxSha256 must be a lowercase SHA-256");
  }
  if (
    !hasOwn(report, "contactSheetSha256") ||
    typeof report.contactSheetSha256 !== "string" ||
    !HEX64.test(report.contactSheetSha256)
  ) {
    errors.push("report.contactSheetSha256 must be a lowercase SHA-256");
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
    provenance: {
      coordinator: report.coordinator,
      executionProfile: report.executionProfile,
    },
    hashes: {
      planSha256: actualPlanSha256,
      smokeReportSha256: actualReportSha256,
      smokePptxSha256: report.pptxSha256,
      contactSheetSha256: report.contactSheetSha256,
    },
    selectedSlideIds: expectedIds,
    selectedSlideFamilies: expectedFamilies,
    densestSlideId: expectedIds[2],
  };
}
