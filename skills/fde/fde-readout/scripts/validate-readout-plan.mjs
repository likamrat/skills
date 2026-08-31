#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const audiences = new Set(["customer", "fde-leadership", "technical-handoff"]);
const densities = new Set(["speaker-led", "reading-first"]);
const deliveries = new Set(["html", "pptx"]);
const brandSources = new Set([
  "customer-provided",
  "authorized-public",
  "fictional-defined",
  "unbranded",
]);
const styleReferenceScopes = new Set([
  "none",
  "design-language-only",
  "approved-asset-reuse",
]);
const evidenceClasses = new Set([
  "direct_observation",
  "system_record",
  "stakeholder_report",
  "first_party_public",
  "secondhand",
  "inference",
  "synthetic",
  "recommendation",
]);
const confidenceLevels = new Set(["high", "medium", "low"]);
const sensitivityLevels = new Set([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
const slideFamilies = new Set([
  "cover",
  "decision",
  "profile",
  "metrics",
  "chart",
  "table",
  "workflow",
  "findings",
  "responsibility",
  "evaluation",
  "risks",
  "timeline",
  "evidence",
]);
const responsibilityTypes = new Set([
  "deterministic",
  "model",
  "human",
  "hybrid",
]);
const workflowEdgeKinds = new Set(["system", "decision"]);
const evalResults = new Set(["pass", "escalate", "fail"]);
const externalAudiences = new Set(["customer", "technical-handoff"]);
const humanContextKinds = new Set([
  "firsthand-observation",
  "operator-quote",
  "failed-attempt",
  "surprise",
  "disagreement",
  "decision-rationale",
  "changed-mind",
]);
const experientialKinds = new Set([
  "firsthand-observation",
  "operator-quote",
  "failed-attempt",
  "surprise",
  "disagreement",
  "changed-mind",
]);
const humanOrigins = new Set(["human-provided", "human-confirmed"]);

const path = process.argv[2];

if (!path || process.argv.includes("--help")) {
  console.log("Usage: node scripts/validate-readout-plan.mjs <readout-plan.json>");
  process.exit(path ? 0 : 2);
}

const errors = [];

function requireValue(condition, message) {
  if (!condition) errors.push(message);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function kebab(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value ?? "");
}

function dateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? "");
}

function hexColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value ?? "");
}

function stringArray(value, { min = 0, max = Infinity } = {}) {
  return (
    Array.isArray(value) &&
    value.length >= min &&
    value.length <= max &&
    value.every(nonEmpty)
  );
}

function objectArray(value, { min = 0, max = Infinity } = {}) {
  return (
    Array.isArray(value) &&
    value.length >= min &&
    value.length <= max &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item),
    )
  );
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

let plan;
try {
  plan = JSON.parse(await readFile(resolve(path), "utf8"));
} catch (error) {
  console.error(`Cannot read ReadoutPlan: ${error.message}`);
  process.exit(2);
}

requireValue(plan.version === "1.0", 'version must be "1.0"');
requireValue(kebab(plan.id), "id must use lowercase kebab-case");
requireValue(nonEmpty(plan.title), "title is required");
requireValue(typeof plan.fictional === "boolean", "fictional must be true or false");
requireValue(dateOnly(plan.asOf), "asOf must use YYYY-MM-DD");
requireValue(
  audiences.has(plan.audience),
  `audience must be one of: ${[...audiences].join(", ")}`,
);
requireValue(nonEmpty(plan.purpose), "purpose is required");
requireValue(nonEmpty(plan.confidentiality), "confidentiality is required");
requireValue(
  densities.has(plan.density),
  `density must be one of: ${[...densities].join(", ")}`,
);
requireValue(
  stringArray(plan.delivery, { min: 1, max: 2 }),
  "delivery requires html, pptx, or both",
);
requireValue(
  (plan.delivery ?? []).every((item) => deliveries.has(item)),
  `delivery must use: ${[...deliveries].join(", ")}`,
);
requireValue(
  new Set(plan.delivery ?? []).size === (plan.delivery ?? []).length,
  "delivery entries must be unique",
);
requireValue(
  !containsPlaceholder(plan),
  "ReadoutPlan still contains template placeholders",
);

requireValue(
  brandSources.has(plan.brand?.source),
  `brand.source must be one of: ${[...brandSources].join(", ")}`,
);
requireValue(
  typeof plan.brand?.authorized === "boolean",
  "brand.authorized must be true or false",
);
requireValue(nonEmpty(plan.brand?.fontFamily), "brand.fontFamily is required");
requireValue(
  nonEmpty(plan.brand?.requiredFooter),
  "brand.requiredFooter is required",
);
requireValue(
  plan.brand?.authorized === true,
  "HTML or PPTX delivery requires an authorized brand treatment",
);
if (plan.brand?.source === "unbranded") {
  requireValue(
    plan.brand?.wordmark === "",
    "unbranded treatment requires brand.wordmark to be an empty string",
  );
  requireValue(
    plan.brand?.logo === undefined || plan.brand.logo === "",
    "unbranded treatment cannot define a logo",
  );
  requireValue(
    (plan.brand?.styleReference?.reusedAssets ?? []).length === 0,
    "unbranded treatment cannot list reused assets",
  );
} else if (brandSources.has(plan.brand?.source)) {
  requireValue(
    nonEmpty(plan.brand?.wordmark),
    `${plan.brand.source} treatment requires brand.wordmark`,
  );
}
if (plan.fictional) {
  requireValue(
    ["fictional-defined", "unbranded"].includes(plan.brand?.source),
    "fictional plans must use brand.source fictional-defined or unbranded",
  );
}

const colorKeys = [
  "ink",
  "system",
  "decision",
  "risk",
  "paper",
  "muted",
  "line",
];
const colors = colorKeys.map((key) => plan.brand?.colors?.[key]);
for (const [index, color] of colors.entries()) {
  requireValue(hexColor(color), `brand.colors.${colorKeys[index]} is invalid`);
}
requireValue(
  new Set(colors.map((color) => color?.toLowerCase())).size === colors.length,
  "brand colors must be distinct",
);
if (hexColor(plan.brand?.colors?.ink) && hexColor(plan.brand?.colors?.paper)) {
  requireValue(
    contrastRatio(plan.brand.colors.ink, plan.brand.colors.paper) >= 4.5,
    "brand ink and paper colors require at least 4.5:1 contrast",
  );
}
requireValue(
  stringArray(plan.brand?.evidenceIds, { min: 1 }),
  "brand.evidenceIds requires at least one evidence ID",
);
requireValue(
  styleReferenceScopes.has(plan.brand?.styleReference?.scope),
  `brand.styleReference.scope must be one of: ${[
    ...styleReferenceScopes,
  ].join(", ")}`,
);
requireValue(
  typeof plan.brand?.styleReference?.authorized === "boolean",
  "brand.styleReference.authorized must be true or false",
);
requireValue(
  stringArray(plan.brand?.styleReference?.reusedAssets, { min: 0 }),
  "brand.styleReference.reusedAssets must contain only non-empty strings",
);
if (plan.brand?.styleReference?.scope !== "none") {
  requireValue(
    nonEmpty(plan.brand?.styleReference?.source),
    "brand.styleReference.source is required",
  );
  requireValue(
    plan.brand?.styleReference?.authorized === true,
    "brand.styleReference requires authorization",
  );
}
if (plan.brand?.styleReference?.scope === "design-language-only") {
  requireValue(
    (plan.brand?.styleReference?.reusedAssets ?? []).length === 0,
    "design-language-only reference cannot list reused assets",
  );
}

requireValue(
  objectArray(plan.evidence, { min: 1 }),
  "evidence requires at least one record",
);
const evidenceById = new Map();
for (const [index, item] of (plan.evidence ?? []).entries()) {
  const prefix = `evidence[${index}]`;
  requireValue(kebab(item?.id), `${prefix}.id must use lowercase kebab-case`);
  requireValue(
    nonEmpty(item?.sourceId),
    `${prefix}.sourceId must be a non-empty string`,
  );
  requireValue(nonEmpty(item?.statement), `${prefix}.statement is required`);
  requireValue(
    evidenceClasses.has(item?.class),
    `${prefix}.class is invalid`,
  );
  requireValue(nonEmpty(item?.source), `${prefix}.source is required`);
  requireValue(
    confidenceLevels.has(item?.confidence),
    `${prefix}.confidence is invalid`,
  );
  requireValue(
    sensitivityLevels.has(item?.sensitivity),
    `${prefix}.sensitivity is invalid`,
  );
  requireValue(
    typeof item?.authorized === "boolean",
    `${prefix}.authorized must be true or false`,
  );
  if (!plan.fictional && externalAudiences.has(plan.audience)) {
    requireValue(
      item?.class !== "synthetic",
      `${prefix} cannot be synthetic for a real external readout`,
    );
  }
  evidenceById.set(item?.id, item);
}
requireValue(
  evidenceById.size === (plan.evidence ?? []).length,
  "evidence IDs must be unique",
);

function validateEvidenceIds(ids, prefix) {
  requireValue(
    stringArray(ids, { min: 1 }),
    `${prefix} requires at least one evidence ID`,
  );
  for (const id of ids ?? []) {
    const evidence = evidenceById.get(id);
    requireValue(evidence !== undefined, `${prefix} references unknown evidence: ${id}`);
    requireValue(
      evidence?.authorized === true,
      `${prefix} references unauthorized evidence: ${id}`,
    );
    if (externalAudiences.has(plan.audience)) {
      requireValue(
        evidence?.sensitivity !== "restricted",
        `${prefix} references restricted evidence: ${id}`,
      );
    }
  }
}

validateEvidenceIds(plan.brand?.evidenceIds, "brand.evidenceIds");

requireValue(
  objectArray(plan.humanContext, { min: 2 }),
  "humanContext requires firsthand perspective and decision rationale",
);
const humanContextById = new Map();
for (const [index, item] of (plan.humanContext ?? []).entries()) {
  const prefix = `humanContext[${index}]`;
  requireValue(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item?.id ?? ""),
    `${prefix}.id must use lowercase kebab-case`,
  );
  requireValue(
    nonEmpty(item?.sourceId),
    `${prefix}.sourceId must be a non-empty string`,
  );
  requireValue(
    humanContextKinds.has(item?.kind),
    `${prefix}.kind must be one of: ${[...humanContextKinds].join(", ")}`,
  );
  requireValue(
    nonEmpty(item?.authorRole),
    `${prefix}.authorRole is required`,
  );
  requireValue(
    humanOrigins.has(item?.origin),
    `${prefix}.origin must be human-provided or human-confirmed`,
  );
  requireValue(nonEmpty(item?.statement), `${prefix}.statement is required`);
  requireValue(
    nonEmpty(item?.whyItMatters),
    `${prefix}.whyItMatters is required`,
  );
  requireValue(
    typeof item?.customerSafe === "boolean",
    `${prefix}.customerSafe must be true or false`,
  );
  validateEvidenceIds(item?.evidenceIds, `${prefix}.evidenceIds`);
  humanContextById.set(item?.id, item);
}
requireValue(
  humanContextById.size === (plan.humanContext ?? []).length,
  "humanContext IDs must be unique",
);
requireValue(
  (plan.humanContext ?? []).some((item) => experientialKinds.has(item.kind)),
  "humanContext requires firsthand observation, failure, surprise, disagreement, quote, or changed mind",
);
requireValue(
  (plan.humanContext ?? []).some(
    (item) => item.kind === "decision-rationale",
  ),
  "humanContext requires a decision-rationale",
);

requireValue(
  objectArray(plan.slides, { min: 5, max: 15 }),
  "slides requires 5-15 slide objects",
);
const slideIds = new Set();
const families = [];

function validateClaim(item, prefix) {
  requireValue(
    item !== null && typeof item === "object" && !Array.isArray(item),
    `${prefix} must be an object`,
  );
  requireValue(nonEmpty(item?.statement), `${prefix}.statement is required`);
  validateEvidenceIds(item?.evidenceIds, `${prefix}.evidenceIds`);
}

function validateFacts(items, prefix, min, max) {
  requireValue(
    objectArray(items, { min, max }),
    `${prefix} requires ${min}-${max} items`,
  );
  for (const [index, item] of (items ?? []).entries()) {
    requireValue(nonEmpty(item?.label), `${prefix}[${index}].label is required`);
    requireValue(nonEmpty(item?.value), `${prefix}[${index}].value is required`);
    validateEvidenceIds(
      item?.evidenceIds,
      `${prefix}[${index}].evidenceIds`,
    );
  }
}

for (const [index, slide] of (plan.slides ?? []).entries()) {
  const prefix = `slides[${index}]`;
  requireValue(kebab(slide?.id), `${prefix}.id must use lowercase kebab-case`);
  requireValue(
    slideFamilies.has(slide?.family),
    `${prefix}.family is invalid`,
  );
  requireValue(nonEmpty(slide?.title), `${prefix}.title is required`);
  requireValue(
    typeof slide?.customerSafe === "boolean",
    `${prefix}.customerSafe must be true or false`,
  );
  if (plan.audience === "customer") {
    requireValue(
      slide?.customerSafe === true,
      `${prefix} must be customerSafe`,
    );
  }
  requireValue(nonEmpty(slide?.notes), `${prefix}.notes is required`);
  validateEvidenceIds(slide?.evidenceIds, `${prefix}.evidenceIds`);
  requireValue(
    Array.isArray(slide?.judgmentIds) &&
      slide.judgmentIds.every(nonEmpty),
    `${prefix}.judgmentIds must be an array of IDs`,
  );
  for (const judgmentId of slide?.judgmentIds ?? []) {
    const judgment = humanContextById.get(judgmentId);
    requireValue(
      judgment !== undefined,
      `${prefix}.judgmentIds references unknown human context: ${judgmentId}`,
    );
    if (plan.audience === "customer") {
      requireValue(
        judgment?.customerSafe === true,
        `${prefix}.judgmentIds references internal-only human context: ${judgmentId}`,
      );
    }
  }
  requireValue(
    slide?.content !== null &&
      typeof slide?.content === "object" &&
      !Array.isArray(slide?.content),
    `${prefix}.content must be an object`,
  );

  const content = slide?.content ?? {};
  switch (slide?.family) {
    case "cover":
      requireValue(nonEmpty(content.subtitle), `${prefix}.content.subtitle is required`);
      requireValue(nonEmpty(content.decision), `${prefix}.content.decision is required`);
      break;
    case "decision":
      requireValue(
        nonEmpty(content.recommendation),
        `${prefix}.content.recommendation is required`,
      );
      requireValue(
        stringArray(content.bullets, { min: 1, max: 4 }),
        `${prefix}.content.bullets requires 1-4 items`,
      );
      validateFacts(content.facts, `${prefix}.content.facts`, 1, 3);
      break;
    case "profile":
      requireValue(nonEmpty(content.company), `${prefix}.content.company is required`);
      requireValue(
        nonEmpty(content.businessModel),
        `${prefix}.content.businessModel is required`,
      );
      validateFacts(content.facts, `${prefix}.content.facts`, 2, 6);
      validateClaim(
        content.valueStatement,
        `${prefix}.content.valueStatement`,
      );
      requireValue(
        stringArray(content.contexts, { min: 1, max: 5 }),
        `${prefix}.content.contexts requires 1-5 items`,
      );
      break;
    case "metrics":
      validateFacts(content.metrics, `${prefix}.content.metrics`, 2, 4);
      validateClaim(content.outcome, `${prefix}.content.outcome`);
      break;
    case "chart":
      requireValue(
        ["bar", "line"].includes(content.chartType),
        `${prefix}.content.chartType must be bar or line`,
      );
      requireValue(
        stringArray(content.categories, { min: 2, max: 12 }),
        `${prefix}.content.categories requires 2-12 items`,
      );
      requireValue(
        objectArray(content.series, { min: 1, max: 4 }),
        `${prefix}.content.series requires 1-4 items`,
      );
      requireValue(nonEmpty(content.unit), `${prefix}.content.unit is required`);
      for (const [seriesIndex, series] of (content.series ?? []).entries()) {
        const seriesPrefix = `${prefix}.content.series[${seriesIndex}]`;
        requireValue(nonEmpty(series?.name), `${seriesPrefix}.name is required`);
        requireValue(
          Array.isArray(series?.values) &&
            series.values.length === (content.categories ?? []).length &&
            series.values.every(
              (value) => typeof value === "number" && Number.isFinite(value),
            ),
          `${seriesPrefix}.values must match categories and contain finite numbers`,
        );
        validateEvidenceIds(series?.evidenceIds, `${seriesPrefix}.evidenceIds`);
      }
      validateClaim(content.insight, `${prefix}.content.insight`);
      break;
    case "table":
      requireValue(
        stringArray(content.columns, { min: 2, max: 6 }),
        `${prefix}.content.columns requires 2-6 items`,
      );
      requireValue(
        objectArray(content.rows, { min: 1, max: 10 }),
        `${prefix}.content.rows requires 1-10 items`,
      );
      for (const [rowIndex, row] of (content.rows ?? []).entries()) {
        const rowPrefix = `${prefix}.content.rows[${rowIndex}]`;
        requireValue(
          stringArray(row?.cells, {
            min: (content.columns ?? []).length,
            max: (content.columns ?? []).length,
          }),
          `${rowPrefix}.cells must match columns`,
        );
        validateEvidenceIds(row?.evidenceIds, `${rowPrefix}.evidenceIds`);
      }
      validateClaim(content.insight, `${prefix}.content.insight`);
      break;
    case "workflow": {
      requireValue(
        objectArray(content.nodes, { min: 3, max: 8 }),
        `${prefix}.content.nodes requires 3-8 items`,
      );
      const nodeIds = new Set();
      for (const [nodeIndex, node] of (content.nodes ?? []).entries()) {
        const nodePrefix = `${prefix}.content.nodes[${nodeIndex}]`;
        requireValue(kebab(node?.id), `${nodePrefix}.id must use kebab-case`);
        requireValue(nonEmpty(node?.label), `${nodePrefix}.label is required`);
        requireValue(nonEmpty(node?.detail), `${nodePrefix}.detail is required`);
        requireValue(
          ["source", "actor", "decision", "system"].includes(node?.role),
          `${nodePrefix}.role is invalid`,
        );
        nodeIds.add(node?.id);
      }
      requireValue(
        nodeIds.size === (content.nodes ?? []).length,
        `${prefix}.content node IDs must be unique`,
      );
      requireValue(
        objectArray(content.edges, { min: 2, max: 10 }),
        `${prefix}.content.edges requires 2-10 items`,
      );
      for (const [edgeIndex, edge] of (content.edges ?? []).entries()) {
        const edgePrefix = `${prefix}.content.edges[${edgeIndex}]`;
        requireValue(nodeIds.has(edge?.from), `${edgePrefix}.from is unknown`);
        requireValue(nodeIds.has(edge?.to), `${edgePrefix}.to is unknown`);
        requireValue(
          workflowEdgeKinds.has(edge?.kind),
          `${edgePrefix}.kind is invalid`,
        );
      }
      requireValue(
        (content.edges ?? []).some((edge) => edge.kind === "decision"),
        `${prefix}.content.edges requires a decision edge`,
      );
      break;
    }
    case "findings":
      requireValue(
        objectArray(content.items, { min: 2, max: 5 }),
        `${prefix}.content.items requires 2-5 findings`,
      );
      for (const [itemIndex, item] of (content.items ?? []).entries()) {
        const itemPrefix = `${prefix}.content.items[${itemIndex}]`;
        requireValue(nonEmpty(item?.title), `${itemPrefix}.title is required`);
        requireValue(nonEmpty(item?.statement), `${itemPrefix}.statement is required`);
        requireValue(
          nonEmpty(item?.consequence),
          `${itemPrefix}.consequence is required`,
        );
        validateEvidenceIds(item?.evidenceIds, `${itemPrefix}.evidenceIds`);
      }
      break;
    case "responsibility":
      requireValue(
        objectArray(content.steps, { min: 3, max: 5 }),
        `${prefix}.content.steps requires 3-5 items`,
      );
      for (const [stepIndex, step] of (content.steps ?? []).entries()) {
        const stepPrefix = `${prefix}.content.steps[${stepIndex}]`;
        requireValue(
          responsibilityTypes.has(step?.type),
          `${stepPrefix}.type is invalid`,
        );
        requireValue(nonEmpty(step?.statement), `${stepPrefix}.statement is required`);
        validateEvidenceIds(step?.evidenceIds, `${stepPrefix}.evidenceIds`);
      }
      validateClaim(
        content.excludedAuthority,
        `${prefix}.content.excludedAuthority`,
      );
      break;
    case "evaluation":
      requireValue(
        objectArray(content.cases, { min: 3, max: 8 }),
        `${prefix}.content.cases requires 3-8 items`,
      );
      for (const [caseIndex, item] of (content.cases ?? []).entries()) {
        const casePrefix = `${prefix}.content.cases[${caseIndex}]`;
        requireValue(nonEmpty(item?.cohort), `${casePrefix}.cohort is required`);
        requireValue(nonEmpty(item?.expected), `${casePrefix}.expected is required`);
        requireValue(
          evalResults.has(item?.result),
          `${casePrefix}.result is invalid`,
        );
        validateEvidenceIds(item?.evidenceIds, `${casePrefix}.evidenceIds`);
      }
      validateClaim(
        content.releaseImplication,
        `${prefix}.content.releaseImplication`,
      );
      break;
    case "risks":
      requireValue(
        objectArray(content.items, { min: 1, max: 4 }),
        `${prefix}.content.items requires 1-4 risks`,
      );
      for (const [riskIndex, item] of (content.items ?? []).entries()) {
        const riskPrefix = `${prefix}.content.items[${riskIndex}]`;
        for (const field of ["risk", "impact", "control", "residualRisk"]) {
          requireValue(
            nonEmpty(item?.[field]),
            `${riskPrefix}.${field} is required`,
          );
        }
        validateEvidenceIds(item?.evidenceIds, `${riskPrefix}.evidenceIds`);
      }
      validateClaim(
        content.stopCondition,
        `${prefix}.content.stopCondition`,
      );
      break;
    case "timeline":
      requireValue(
        content.decision !== null &&
          typeof content.decision === "object" &&
          !Array.isArray(content.decision),
        `${prefix}.content.decision must be an object`,
      );
      for (const field of ["statement", "owner", "due"]) {
        requireValue(
          nonEmpty(content.decision?.[field]),
          `${prefix}.content.decision.${field} is required`,
        );
      }
      validateEvidenceIds(
        content.decision?.evidenceIds,
        `${prefix}.content.decision.evidenceIds`,
      );
      requireValue(
        objectArray(content.milestones, { min: 2, max: 6 }),
        `${prefix}.content.milestones requires 2-6 items`,
      );
      for (const [milestoneIndex, item] of (
        content.milestones ?? []
      ).entries()) {
        const milestonePrefix = `${prefix}.content.milestones[${milestoneIndex}]`;
        for (const field of ["label", "owner", "due", "outcome"]) {
          requireValue(
            nonEmpty(item?.[field]),
            `${milestonePrefix}.${field} is required`,
          );
        }
        validateEvidenceIds(item?.evidenceIds, `${milestonePrefix}.evidenceIds`);
      }
      break;
    case "evidence":
      requireValue(
        objectArray(content.groups, { min: 2, max: 5 }),
        `${prefix}.content.groups requires 2-5 items`,
      );
      for (const [groupIndex, group] of (content.groups ?? []).entries()) {
        const groupPrefix = `${prefix}.content.groups[${groupIndex}]`;
        requireValue(nonEmpty(group?.label), `${groupPrefix}.label is required`);
        requireValue(
          stringArray(group?.items, { min: 1 }),
          `${groupPrefix}.items requires at least one item`,
        );
        validateEvidenceIds(group?.evidenceIds, `${groupPrefix}.evidenceIds`);
      }
      requireValue(
        stringArray(content.controls, { min: 1 }),
        `${prefix}.content.controls requires at least one item`,
      );
      break;
  }

  slideIds.add(slide?.id);
  families.push(slide?.family);
}

requireValue(
  slideIds.size === (plan.slides ?? []).length,
  "slide IDs must be unique",
);
requireValue(families[0] === "cover", "first slide must use family cover");
requireValue(families[1] === "decision", "second slide must use family decision");
requireValue(
  families.at(-1) === "evidence",
  "final slide must use family evidence",
);
for (const required of ["cover", "decision", "evidence"]) {
  requireValue(families.includes(required), `slides requires family ${required}`);
}
requireValue(
  families.some((family) =>
    ["metrics", "chart", "table", "workflow", "findings"].includes(family),
  ),
  "slides requires measured or observed current-state evidence",
);
for (let index = 2; index < families.length; index += 1) {
  requireValue(
    !(
      families[index] === families[index - 1] &&
      families[index] === families[index - 2]
    ),
    `slides cannot repeat family ${families[index]} three times`,
  );
}

const usedEvidence = new Set([
  ...(plan.brand?.evidenceIds ?? []),
  ...(plan.slides ?? []).flatMap((slide) => slide.evidenceIds ?? []),
]);
for (const evidenceId of evidenceById.keys()) {
  requireValue(
    usedEvidence.has(evidenceId),
    `evidence record is unused: ${evidenceId}`,
  );
}

const usedHumanContext = new Set(
  (plan.slides ?? []).flatMap((slide) => slide.judgmentIds ?? []),
);
for (const judgmentId of humanContextById.keys()) {
  requireValue(
    usedHumanContext.has(judgmentId),
    `humanContext entry is unused: ${judgmentId}`,
  );
}
const decisionSlide = (plan.slides ?? []).find(
  (slide) => slide.family === "decision",
);
requireValue(
  (decisionSlide?.judgmentIds ?? []).some(
    (id) => humanContextById.get(id)?.kind === "decision-rationale",
  ),
  "decision slide requires a decision-rationale judgment ID",
);
const findingSlides = (plan.slides ?? []).filter(
  (slide) => slide.family === "findings",
);
for (const slide of findingSlides) {
  requireValue(
    (slide.judgmentIds ?? []).some((id) =>
      experientialKinds.has(humanContextById.get(id)?.kind),
    ),
    `findings slide ${slide.id} requires firsthand human context`,
  );
}

if (errors.length > 0) {
  console.error("ReadoutPlan is not ready:");
  errors.forEach((error, index) => console.error(`${index + 1}. ${error}`));
  process.exit(1);
}

console.log(
  `ReadoutPlan is ready: ${plan.slides.length} slides; ${plan.delivery.join(" + ")}.`,
);
