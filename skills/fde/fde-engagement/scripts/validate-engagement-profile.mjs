#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const audiences = new Set(["customer", "fde-leadership", "technical-handoff"]);
const formats = new Set(["report", "deck", "both"]);
const deliveryFormats = new Set(["markdown", "pptx", "html"]);
const brandSources = new Set([
  "customer-provided",
  "authorized-public",
  "fictional-defined",
  "unbranded",
]);
const stakeholderKinds = new Set([
  "sponsor",
  "operator",
  "technical-owner",
  "decision-maker",
  "risk-owner",
  "affected-user",
]);
const styleReferenceScopes = new Set([
  "none",
  "design-language-only",
  "approved-asset-reuse",
]);
const requiredStakeholders = new Set([
  "sponsor",
  "operator",
  "technical-owner",
  "decision-maker",
]);
const realEvidenceClasses = new Set([
  "direct_observation",
  "system_record",
  "stakeholder_report",
  "first_party_public",
]);

const [casePath, profilePath] = process.argv.slice(2);

if (!casePath || !profilePath || process.argv.includes("--help")) {
  console.log(
    "Usage: node scripts/validate-engagement-profile.mjs <case-file.json> <engagement-profile.json>",
  );
  process.exit(casePath && profilePath ? 0 : 2);
}

const errors = [];

function requireValue(condition, message) {
  if (!condition) errors.push(message);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value, allowEmpty = false) {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every((item) => nonEmpty(item))
  );
}

function objectArray(value, allowEmpty = false) {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item),
    )
  );
}

function dateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? "");
}

function hexColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value ?? "");
}

function containsPlaceholder(value) {
  if (typeof value === "string") return value.includes("{{");
  if (Array.isArray(value)) return value.some(containsPlaceholder);
  if (value && typeof value === "object") {
    return Object.values(value).some(containsPlaceholder);
  }
  return false;
}

function relativeLuminance(color) {
  const channels = color
    .slice(1)
    .match(/.{2}/g)
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.03928
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return (
    0.2126 * channels[0] +
    0.7152 * channels[1] +
    0.0722 * channels[2]
  );
}

function contrastRatio(left, right) {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    console.error(`Cannot read ${label}: ${error.message}`);
    process.exit(2);
  }
}

const caseFile = await readJson(casePath, "case file");
const profile = await readJson(profilePath, "engagement profile");
const evidenceById = new Map(
  (caseFile.evidence ?? []).map((item) => [item.id, item]),
);

function validateEvidenceIds(ids, prefix, requireReal = false) {
  requireValue(
    stringArray(ids),
    `${prefix} requires at least one evidence ID`,
  );
  for (const id of ids ?? []) {
    const evidence = evidenceById.get(id);
    requireValue(
      evidence !== undefined,
      `${prefix} references unknown evidence: ${id}`,
    );
    requireValue(
      evidence?.authorized === true,
      `${prefix} references unauthorized evidence: ${id}`,
    );
    if (requireReal) {
      requireValue(
        realEvidenceClasses.has(evidence?.class),
        `${prefix} requires real evidence: ${id}`,
      );
    }
  }
}

requireValue(profile.version === "1.0", 'version must be "1.0"');
requireValue(
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.engagementId ?? ""),
  "engagementId must use lowercase kebab-case",
);
requireValue(
  typeof profile.fictional === "boolean",
  "fictional must be true or false",
);
requireValue(dateOnly(profile.asOf), "asOf must use YYYY-MM-DD");
requireValue(
  !containsPlaceholder(profile),
  "engagement profile still contains template placeholders",
);

const customerFields = [
  "displayName",
  "legalName",
  "industry",
  "businessModel",
  "businessUnit",
];
for (const field of customerFields) {
  requireValue(
    nonEmpty(profile.customer?.[field]),
    `customer.${field} is required`,
  );
}
requireValue(
  stringArray(profile.customer?.customerSegments),
  "customer.customerSegments requires at least one segment",
);
requireValue(
  stringArray(profile.customer?.operatingFootprint),
  "customer.operatingFootprint requires at least one item",
);
if (nonEmpty(profile.customer?.website)) {
  requireValue(
    /^https?:\/\//i.test(profile.customer.website),
    "customer.website must be an absolute HTTP(S) URL",
  );
}
validateEvidenceIds(
  profile.customer?.evidenceIds,
  "customer.evidenceIds",
  profile.fictional === false,
);

const problemFields = [
  "title",
  "decision",
  "outcome",
  "baseline",
  "affectedWorkflow",
  "fitHypothesis",
];
for (const field of problemFields) {
  requireValue(
    nonEmpty(profile.problem?.[field]),
    `problem.${field} is required`,
  );
}
for (const field of [
  "failureModes",
  "consequences",
  "priorAttempts",
  "constraints",
  "nonGoals",
  "alternativesConsidered",
]) {
  requireValue(
    stringArray(profile.problem?.[field]),
    `problem.${field} requires at least one item`,
  );
}
validateEvidenceIds(
  profile.problem?.evidenceIds,
  "problem.evidenceIds",
  profile.fictional === false,
);

requireValue(
  objectArray(profile.stakeholders),
  "stakeholders requires at least one stakeholder",
);
const observedStakeholderKinds = new Set();
for (const [index, stakeholder] of (profile.stakeholders ?? []).entries()) {
  const prefix = `stakeholders[${index}]`;
  requireValue(
    stakeholderKinds.has(stakeholder?.kind),
    `${prefix}.kind is invalid`,
  );
  requireValue(nonEmpty(stakeholder?.role), `${prefix}.role is required`);
  requireValue(
    nonEmpty(stakeholder?.responsibility),
    `${prefix}.responsibility is required`,
  );
  requireValue(
    nonEmpty(stakeholder?.decisionAuthority),
    `${prefix}.decisionAuthority is required`,
  );
  requireValue(
    nonEmpty(stakeholder?.incentivesAndRisks),
    `${prefix}.incentivesAndRisks is required`,
  );
  validateEvidenceIds(
    stakeholder?.evidenceIds,
    `${prefix}.evidenceIds`,
    profile.fictional === false,
  );
  observedStakeholderKinds.add(stakeholder?.kind);
}
for (const kind of requiredStakeholders) {
  requireValue(
    observedStakeholderKinds.has(kind),
    `stakeholders requires kind: ${kind}`,
  );
}

requireValue(
  objectArray(profile.systems),
  "systems requires at least one system",
);
for (const [index, system] of (profile.systems ?? []).entries()) {
  const prefix = `systems[${index}]`;
  requireValue(nonEmpty(system?.name), `${prefix}.name is required`);
  requireValue(nonEmpty(system?.role), `${prefix}.role is required`);
  requireValue(
    typeof system?.sourceOfTruth === "boolean",
    `${prefix}.sourceOfTruth must be true or false`,
  );
  requireValue(nonEmpty(system?.owner), `${prefix}.owner is required`);
  validateEvidenceIds(
    system?.evidenceIds,
    `${prefix}.evidenceIds`,
    profile.fictional === false,
  );
}

requireValue(
  brandSources.has(profile.brand?.source),
  `brand.source must be one of: ${[...brandSources].join(", ")}`,
);
requireValue(
  typeof profile.brand?.authorized === "boolean",
  "brand.authorized must be true or false",
);
const requiresBrand = (profile.readout?.deliveryFormats ?? []).some((format) =>
  ["pptx", "html"].includes(format),
);
if (requiresBrand) {
  requireValue(
    profile.brand?.source !== "unbranded",
    "deck output requires an approved brand source",
  );
  requireValue(
    profile.brand?.authorized === true,
    "deck output requires authorized branding",
  );
}
if (profile.fictional === true) {
  requireValue(
    profile.brand?.source === "fictional-defined",
    "fictional profiles must use brand.source fictional-defined",
  );
}
for (const field of [
  "wordmark",
  "primaryColor",
  "secondaryColor",
  "accentColor",
  "riskColor",
  "backgroundColor",
  "textColor",
  "fontFamily",
  "requiredFooter",
  "confidentialityLabel",
]) {
  if (requiresBrand) {
    requireValue(nonEmpty(profile.brand?.[field]), `brand.${field} is required`);
  }
}
for (const field of [
  "primaryColor",
  "secondaryColor",
  "accentColor",
  "riskColor",
  "backgroundColor",
  "textColor",
]) {
  if (nonEmpty(profile.brand?.[field])) {
    requireValue(hexColor(profile.brand[field]), `brand.${field} is invalid`);
  }
}
const brandColors = [
  profile.brand?.primaryColor,
  profile.brand?.secondaryColor,
  profile.brand?.accentColor,
  profile.brand?.riskColor,
  profile.brand?.backgroundColor,
  profile.brand?.textColor,
].filter(hexColor);
requireValue(
  new Set(brandColors.map((color) => color.toLowerCase())).size ===
    brandColors.length,
  "brand colors must be distinct",
);
if (
  hexColor(profile.brand?.backgroundColor) &&
  hexColor(profile.brand?.textColor)
) {
  requireValue(
    contrastRatio(profile.brand.backgroundColor, profile.brand.textColor) >= 4.5,
    "brand text and background colors require at least 4.5:1 contrast",
  );
}
requireValue(
  stringArray(profile.brand?.tone, !requiresBrand),
  "brand.tone must contain only non-empty strings",
);
requireValue(
  stringArray(profile.brand?.prohibitedUses, true),
  "brand.prohibitedUses must contain only non-empty strings",
);
if (nonEmpty(profile.brand?.logoPath)) {
  requireValue(
    [".svg", ".png", ".jpg", ".jpeg"].includes(
      extname(profile.brand.logoPath).toLowerCase(),
    ),
    "brand.logoPath must point to an SVG, PNG, or JPEG",
  );
}
validateEvidenceIds(
  profile.brand?.evidenceIds,
  "brand.evidenceIds",
  false,
);
requireValue(
  profile.brand?.styleReference !== null &&
    typeof profile.brand?.styleReference === "object" &&
    !Array.isArray(profile.brand?.styleReference),
  "brand.styleReference must be an object",
);
requireValue(
  styleReferenceScopes.has(profile.brand?.styleReference?.scope),
  `brand.styleReference.scope must be one of: ${[
    ...styleReferenceScopes,
  ].join(", ")}`,
);
requireValue(
  typeof profile.brand?.styleReference?.authorized === "boolean",
  "brand.styleReference.authorized must be true or false",
);
requireValue(
  stringArray(profile.brand?.styleReference?.reusedAssets, true),
  "brand.styleReference.reusedAssets must contain only non-empty strings",
);
if (profile.brand?.styleReference?.scope !== "none") {
  requireValue(
    nonEmpty(profile.brand?.styleReference?.source),
    "brand.styleReference.source is required",
  );
  requireValue(
    profile.brand?.styleReference?.authorized === true,
    "brand.styleReference requires authorization",
  );
}
if (profile.brand?.styleReference?.scope === "design-language-only") {
  requireValue(
    (profile.brand?.styleReference?.reusedAssets ?? []).length === 0,
    "design-language-only reference cannot list reused assets",
  );
}

requireValue(
  audiences.has(profile.readout?.audience),
  `readout.audience must be one of: ${[...audiences].join(", ")}`,
);
requireValue(
  formats.has(profile.readout?.format),
  `readout.format must be one of: ${[...formats].join(", ")}`,
);
requireValue(
  stringArray(profile.readout?.deliveryFormats),
  "readout.deliveryFormats requires at least one format",
);
requireValue(
  (profile.readout?.deliveryFormats ?? []).every((format) =>
    deliveryFormats.has(format),
  ),
  `readout.deliveryFormats must use: ${[...deliveryFormats].join(", ")}`,
);
requireValue(
  new Set(profile.readout?.deliveryFormats ?? []).size ===
    (profile.readout?.deliveryFormats ?? []).length,
  "readout.deliveryFormats must be unique",
);
if (profile.readout?.format === "report") {
  requireValue(
    (profile.readout?.deliveryFormats ?? []).includes("markdown"),
    "report format requires markdown delivery",
  );
}
if (profile.readout?.format === "deck") {
  requireValue(
    (profile.readout?.deliveryFormats ?? []).some((format) =>
      ["pptx", "html"].includes(format),
    ),
    "deck format requires pptx or html delivery",
  );
}
requireValue(
  nonEmpty(profile.readout?.decision),
  "readout.decision is required",
);
requireValue(
  profile.readout?.decision === profile.problem?.decision,
  "readout.decision must match problem.decision",
);
requireValue(
  profile.readout?.asOf === profile.asOf,
  "readout.asOf must match profile.asOf",
);
requireValue(
  nonEmpty(profile.readout?.confidentiality),
  "readout.confidentiality is required",
);
requireValue(
  stringArray(profile.openQuestions, true),
  "openQuestions must contain only non-empty strings",
);
requireValue(
  (profile.openQuestions ?? []).length === 0,
  "openQuestions must be empty before producing the requested artifact",
);

validateEvidenceIds(
  profile.profileEvidenceIds,
  "profileEvidenceIds",
  profile.fictional === false,
);
const approvedProfileEvidence = new Set(profile.profileEvidenceIds ?? []);
const nestedEvidenceIds = [
  ...(profile.customer?.evidenceIds ?? []),
  ...(profile.problem?.evidenceIds ?? []),
  ...(profile.brand?.evidenceIds ?? []),
  ...(profile.stakeholders ?? []).flatMap((item) => item.evidenceIds ?? []),
  ...(profile.systems ?? []).flatMap((item) => item.evidenceIds ?? []),
];
for (const id of nestedEvidenceIds) {
  requireValue(
    approvedProfileEvidence.has(id),
    `profileEvidenceIds must include referenced evidence: ${id}`,
  );
}

if (errors.length > 0) {
  console.error("Engagement profile is not ready:");
  errors.forEach((error, index) => console.error(`${index + 1}. ${error}`));
  process.exit(1);
}

console.log(
  `Engagement profile is ready for ${profile.readout.audience} ${profile.readout.format}.`,
);
