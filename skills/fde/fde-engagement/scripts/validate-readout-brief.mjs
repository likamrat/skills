#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateDomainModelLifecycle } from "./domain-model-lifecycle.mjs";
import { validateFieldJudgmentContract } from "./field-judgment-contract.mjs";

const audiences = new Set(["customer", "fde-leadership", "technical-handoff"]);
const externalAudiences = new Set(["customer", "technical-handoff"]);
const formats = new Set(["report", "deck", "both"]);
const confidenceLevels = new Set(["high", "medium", "low"]);
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
const sensitivityLevels = new Set([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
const phases = [
  "qualify",
  "audit",
  "design",
  "build",
  "evaluate",
  "deploy",
  "handoff",
];
const gateStatuses = new Set(["open", "blocked", "ready", "passed"]);
const productDispositions = new Set([
  "hold",
  "investigate",
  "productize",
  "reject",
]);
const sectionMinimumPhase = new Map([
  ["executive-summary", "qualify"],
  ["outcome-and-scope", "qualify"],
  ["current-state", "audit"],
  ["findings", "audit"],
  ["target-operating-model", "design"],
  ["implementation", "build"],
  ["evaluation", "evaluate"],
  ["deployment-and-adoption", "deploy"],
  ["handoff", "handoff"],
  ["realized-outcomes", "handoff"],
  ["productization", "handoff"],
  ["product-signals", "audit"],
  ["risks", "qualify"],
  ["decisions", "qualify"],
  ["next-steps", "qualify"],
  ["evidence-register", "qualify"],
]);
const builtInSections = new Set([
  "executive-summary",
  "findings",
  "risks",
  "decisions",
  "next-steps",
  "product-signals",
  "evidence-register",
]);

const [casePath, briefPath] = process.argv.slice(2);

if (!casePath || !briefPath || process.argv.includes("--help")) {
  console.log(
    "Usage: node scripts/validate-readout-brief.mjs <case-file.json> <readout-brief.json>",
  );
  process.exit(casePath && briefPath ? 0 : 2);
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

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    console.error(`Cannot read ${label}: ${error.message}`);
    process.exit(2);
  }
}

function containsPlaceholder(value) {
  if (typeof value === "string") return value.includes("{{");
  if (Array.isArray(value)) return value.some(containsPlaceholder);
  if (value && typeof value === "object") {
    return Object.values(value).some(containsPlaceholder);
  }
  return false;
}

const caseFile = await readJson(casePath, "case file");
const brief = await readJson(briefPath, "readout brief");
const evidenceById = new Map(
  (caseFile.evidence ?? []).map((item) => [item.id, item]),
);
const assignmentById = new Map(
  (caseFile.assignments ?? []).map((item) => [item.id, item]),
);

requireValue(phases.includes(caseFile.phase), "case file has an invalid phase");
requireValue(brief.version === "1.0", 'version must be "1.0"');
requireValue(
  audiences.has(brief.audience),
  `audience must be one of: ${[...audiences].join(", ")}`,
);
requireValue(
  formats.has(brief.format),
  `format must be one of: ${[...formats].join(", ")}`,
);
requireValue(
  !(
    brief.audience === "technical-handoff" &&
    ["deck", "both"].includes(brief.format)
  ),
  "technical-handoff supports report format only",
);
requireValue(nonEmpty(brief.engagementName), "engagementName is required");
requireValue(nonEmpty(brief.purpose), "purpose is required");
requireValue(
  /^\d{4}-\d{2}-\d{2}$/.test(brief.asOf ?? ""),
  "asOf must use YYYY-MM-DD",
);
requireValue(nonEmpty(brief.confidentiality), "confidentiality is required");
requireValue(
  brief.caseFilePhase === caseFile.phase,
  "caseFilePhase must match the case file",
);
requireValue(
  gateStatuses.has(brief.gateStatus),
  `gateStatus must be one of: ${[...gateStatuses].join(", ")}`,
);
requireValue(
  gateStatuses.has(caseFile.gate?.status),
  "case file gate.status is invalid",
);
requireValue(
  brief.gateStatus === caseFile.gate?.status,
  "gateStatus must match the case file gate status",
);
requireValue(
  !containsPlaceholder(brief),
  "readout brief still contains template placeholders",
);
for (const error of validateFieldJudgmentContract(caseFile, {
  externalAudience: externalAudiences.has(brief.audience),
})) {
  errors.push(error);
}
if (
  phases.indexOf(caseFile.phase) >= phases.indexOf("audit")
) {
  for (const error of validateDomainModelLifecycle(
    caseFile.domainModel,
    evidenceById,
    { requiredAsOf: brief.asOf },
  )) {
    errors.push(error);
  }
}

requireValue(
  nonEmpty(brief.gateStatusReason),
  "gateStatusReason is required",
);
requireValue(
  brief.gateStatusReason === caseFile.gate?.reason,
  "gateStatusReason must match the case file gate reason",
);
requireValue(
  nonEmpty(brief.audienceGateReason),
  "audienceGateReason is required",
);
requireValue(
  typeof brief.gateCustomerSafe === "boolean",
  "gateCustomerSafe must be true or false",
);
requireValue(
  stringArray(brief.includedSections),
  "includedSections requires at least one section",
);
requireValue(
  (brief.includedSections ?? []).includes("next-steps"),
  "includedSections must contain next-steps",
);
for (const section of brief.includedSections ?? []) {
  requireValue(
    sectionMinimumPhase.has(section),
    `includedSections contains an unknown section: ${section}`,
  );
  if (sectionMinimumPhase.has(section) && phases.includes(caseFile.phase)) {
    requireValue(
      phases.indexOf(caseFile.phase) >=
        phases.indexOf(sectionMinimumPhase.get(section)),
      `${section} is not available during ${caseFile.phase}`,
    );
  }
}
requireValue(
  brief.sectionContent !== null &&
    typeof brief.sectionContent === "object" &&
    !Array.isArray(brief.sectionContent),
  "sectionContent must be an object",
);

for (const [index, evidence] of (caseFile.evidence ?? []).entries()) {
  const prefix = `caseFile.evidence[${index}]`;
  requireValue(nonEmpty(evidence?.id), `${prefix}.id is required`);
  requireValue(nonEmpty(evidence?.statement), `${prefix}.statement is required`);
  requireValue(
    evidenceClasses.has(evidence?.class),
    `${prefix}.class is invalid`,
  );
  requireValue(nonEmpty(evidence?.source), `${prefix}.source is required`);
  requireValue(nonEmpty(evidence?.observedAt), `${prefix}.observedAt is required`);
  requireValue(
    confidenceLevels.has(evidence?.confidence),
    `${prefix}.confidence is invalid`,
  );
  requireValue(
    sensitivityLevels.has(evidence?.sensitivity),
    `${prefix}.sensitivity is invalid`,
  );
  requireValue(nonEmpty(evidence?.disproof), `${prefix}.disproof is required`);
  requireValue(
    typeof evidence?.authorized === "boolean",
    `${prefix}.authorized must be true or false`,
  );
}
const caseEvidenceIds = (caseFile.evidence ?? []).map((item) => item?.id);
requireValue(
  new Set(caseEvidenceIds).size === caseEvidenceIds.length,
  "case file evidence IDs must be unique",
);
requireValue(
  Array.isArray(caseFile.assignments),
  "case file assignments must be an array",
);
for (const [index, assignment] of (caseFile.assignments ?? []).entries()) {
  const prefix = `caseFile.assignments[${index}]`;
  requireValue(nonEmpty(assignment?.id), `${prefix}.id is required`);
  requireValue(nonEmpty(assignment?.subject), `${prefix}.subject is required`);
  requireValue(nonEmpty(assignment?.owner), `${prefix}.owner is required`);
  requireValue(nonEmpty(assignment?.timing), `${prefix}.timing is required`);
  requireValue(
    stringArray(assignment?.evidenceIds),
    `${prefix}.evidenceIds requires at least one evidence ID`,
  );
  for (const evidenceId of assignment?.evidenceIds ?? []) {
    requireValue(
      evidenceById.has(evidenceId),
      `${prefix}.evidenceIds references unknown evidence: ${evidenceId}`,
    );
    requireValue(
      evidenceById.get(evidenceId)?.authorized === true,
      `${prefix}.evidenceIds references unauthorized evidence: ${evidenceId}`,
    );
  }
}
const caseAssignmentIds = (caseFile.assignments ?? []).map(
  (item) => item?.id,
);
requireValue(
  new Set(caseAssignmentIds).size === caseAssignmentIds.length,
  "case file assignment IDs must be unique",
);

requireValue(
  stringArray(brief.approvedEvidenceIds),
  "approvedEvidenceIds requires at least one evidence ID",
);
for (const evidenceId of brief.approvedEvidenceIds ?? []) {
  const evidence = evidenceById.get(evidenceId);
  requireValue(
    evidenceById.has(evidenceId),
    `approvedEvidenceIds references unknown evidence: ${evidenceId}`,
  );
  requireValue(
    evidence?.authorized === true,
    `approvedEvidenceIds contains unauthorized evidence: ${evidenceId}`,
  );
  if (externalAudiences.has(brief.audience)) {
    requireValue(
      evidence?.sensitivity !== "restricted",
      `customer readout cannot use restricted evidence: ${evidenceId}`,
    );
  }
}
const approvedEvidence = new Set(brief.approvedEvidenceIds ?? []);

function validateEvidenceLinks(ids, prefix) {
  requireValue(
    stringArray(ids),
    `${prefix} requires at least one evidence ID`,
  );
  for (const evidenceId of ids ?? []) {
    requireValue(
      approvedEvidence.has(evidenceId),
      `${prefix} references evidence not approved for this readout: ${evidenceId}`,
    );
  }
}

validateEvidenceLinks(brief.gateEvidenceIds, "gateEvidenceIds");
requireValue(
  stringArray(caseFile.gate?.evidenceIds),
  "case file gate.evidenceIds requires at least one evidence ID",
);
requireValue(
  JSON.stringify([...(brief.gateEvidenceIds ?? [])].sort()) ===
    JSON.stringify([...(caseFile.gate?.evidenceIds ?? [])].sort()),
  "gateEvidenceIds must match the case file gate evidence",
);

function weakestConfidence(ids) {
  const ranks = { low: 0, medium: 1, high: 2 };
  return (ids ?? [])
    .map((id) => evidenceById.get(id)?.confidence)
    .filter((value) => Object.hasOwn(ranks, value))
    .sort((left, right) => ranks[left] - ranks[right])[0];
}

function validateAssignment(
  owner,
  timing,
  assignmentId,
  prefix,
) {
  requireValue(nonEmpty(owner), `${prefix}.owner is required`);
  requireValue(nonEmpty(timing), `${prefix}.timing is required`);

  const usesSentinel =
    owner === "Unassigned" && timing === "Not scheduled";
  if (!usesSentinel) {
    requireValue(nonEmpty(assignmentId), `${prefix}.assignmentId is required`);
    const assignment = assignmentById.get(assignmentId);
    requireValue(
      assignment !== undefined,
      `${prefix}.assignmentId references an unknown case assignment`,
    );
    requireValue(
      assignment?.owner === owner,
      `${prefix}.owner must match the case assignment`,
    );
    requireValue(
      assignment?.timing === timing,
      `${prefix}.timing must match the case assignment`,
    );
    for (const evidenceId of assignment?.evidenceIds ?? []) {
      requireValue(
        approvedEvidence.has(evidenceId),
        `${prefix}.assignmentId uses evidence not approved for this readout: ${evidenceId}`,
      );
    }
  } else {
    requireValue(
      !assignmentId,
      `${prefix}.assignmentId must be empty when assignment is unassigned`,
    );
  }
}

function validateOwner(owner, assignmentId, prefix) {
  requireValue(nonEmpty(owner), `${prefix}.owner is required`);
  if (owner === "Unassigned") {
    requireValue(
      !assignmentId,
      `${prefix}.assignmentId must be empty when owner is unassigned`,
    );
    return;
  }

  requireValue(nonEmpty(assignmentId), `${prefix}.assignmentId is required`);
  const assignment = assignmentById.get(assignmentId);
  requireValue(
    assignment !== undefined,
    `${prefix}.assignmentId references an unknown case assignment`,
  );
  requireValue(
    assignment?.owner === owner,
    `${prefix}.owner must match the case assignment`,
  );
  for (const evidenceId of assignment?.evidenceIds ?? []) {
    requireValue(
      approvedEvidence.has(evidenceId),
      `${prefix}.assignmentId uses evidence not approved for this readout: ${evidenceId}`,
    );
  }
}

requireValue(
  objectArray(
    brief.findings,
    phases.indexOf(caseFile.phase) < phases.indexOf("audit") &&
      !(brief.includedSections ?? []).includes("findings"),
  ),
  phases.indexOf(caseFile.phase) < phases.indexOf("audit")
    ? "findings must be an array"
    : "findings requires at least one item",
);
for (const [index, finding] of (brief.findings ?? []).entries()) {
  const prefix = `findings[${index}]`;
  requireValue(nonEmpty(finding.id), `${prefix}.id is required`);
  requireValue(nonEmpty(finding.title), `${prefix}.title is required`);
  requireValue(nonEmpty(finding.statement), `${prefix}.statement is required`);
  requireValue(nonEmpty(finding.consequence), `${prefix}.consequence is required`);
  requireValue(
    confidenceLevels.has(finding.confidence),
    `${prefix}.confidence must be high, medium, or low`,
  );
  requireValue(
    typeof finding.customerSafe === "boolean",
    `${prefix}.customerSafe must be true or false`,
  );
  validateEvidenceLinks(finding.evidenceIds, `${prefix}.evidenceIds`);
  requireValue(
    finding.confidence === weakestConfidence(finding.evidenceIds),
    `${prefix}.confidence must equal the weakest linked evidence confidence`,
  );
}

requireValue(
  objectArray(brief.recommendations),
  "recommendations requires at least one item",
);
for (const [index, recommendation] of (
  brief.recommendations ?? []
).entries()) {
  const prefix = `recommendations[${index}]`;
  requireValue(nonEmpty(recommendation.id), `${prefix}.id is required`);
  requireValue(nonEmpty(recommendation.action), `${prefix}.action is required`);
  requireValue(
    nonEmpty(recommendation.rationale),
    `${prefix}.rationale is required`,
  );
  validateAssignment(
    recommendation.owner,
    recommendation.timing,
    recommendation.assignmentId,
    prefix,
  );
  requireValue(
    typeof recommendation.decisionNeeded === "boolean",
    `${prefix}.decisionNeeded must be true or false`,
  );
  requireValue(
    stringArray(recommendation.alternativesConsidered, true),
    `${prefix}.alternativesConsidered must contain only non-empty strings`,
  );
  requireValue(
    nonEmpty(recommendation.changesIf),
    `${prefix}.changesIf is required`,
  );
  requireValue(
    typeof recommendation.customerSafe === "boolean",
    `${prefix}.customerSafe must be true or false`,
  );
  validateEvidenceLinks(
    recommendation.evidenceIds,
    `${prefix}.evidenceIds`,
  );
}

requireValue(objectArray(brief.risks), "risks requires at least one item");
for (const [index, risk] of (brief.risks ?? []).entries()) {
  const prefix = `risks[${index}]`;
  requireValue(nonEmpty(risk.id), `${prefix}.id is required`);
  requireValue(nonEmpty(risk.risk), `${prefix}.risk is required`);
  requireValue(nonEmpty(risk.impact), `${prefix}.impact is required`);
  requireValue(nonEmpty(risk.control), `${prefix}.control is required`);
  requireValue(nonEmpty(risk.residualRisk), `${prefix}.residualRisk is required`);
  validateOwner(risk.owner, risk.assignmentId, prefix);
  requireValue(
    typeof risk.customerSafe === "boolean",
    `${prefix}.customerSafe must be true or false`,
  );
  validateEvidenceLinks(risk.evidenceIds, `${prefix}.evidenceIds`);
}

requireValue(
  objectArray(brief.decisionsNeeded, true),
  "decisionsNeeded must be an array of objects",
);
if ((brief.includedSections ?? []).includes("decisions")) {
  requireValue(
    (brief.decisionsNeeded ?? []).length > 0,
    "included decisions section requires at least one decision",
  );
}
for (const [index, decision] of (brief.decisionsNeeded ?? []).entries()) {
  const prefix = `decisionsNeeded[${index}]`;
  requireValue(nonEmpty(decision.decision), `${prefix}.decision is required`);
  validateAssignment(
    decision.owner,
    decision.due,
    decision.assignmentId,
    prefix,
  );
  requireValue(
    stringArray(decision.options),
    `${prefix}.options requires at least one option`,
  );
  requireValue(
    nonEmpty(decision.recommendation),
    `${prefix}.recommendation is required`,
  );
  requireValue(
    typeof decision.customerSafe === "boolean",
    `${prefix}.customerSafe must be true or false`,
  );
  validateEvidenceLinks(decision.evidenceIds, `${prefix}.evidenceIds`);
}

requireValue(
  objectArray(brief.nextSteps),
  "nextSteps requires at least one item",
);
for (const [index, step] of (brief.nextSteps ?? []).entries()) {
  const prefix = `nextSteps[${index}]`;
  requireValue(nonEmpty(step.action), `${prefix}.action is required`);
  validateAssignment(
    step.owner,
    step.due,
    step.assignmentId,
    prefix,
  );
  requireValue(nonEmpty(step.dependency), `${prefix}.dependency is required`);
  requireValue(
    nonEmpty(step.definitionOfDone),
    `${prefix}.definitionOfDone is required`,
  );
  requireValue(nonEmpty(step.status), `${prefix}.status is required`);
  requireValue(
    typeof step.customerSafe === "boolean",
    `${prefix}.customerSafe must be true or false`,
  );
  validateEvidenceLinks(step.evidenceIds, `${prefix}.evidenceIds`);
}

requireValue(
  objectArray(brief.productSignals, true),
  "productSignals must be an array of objects",
);
if ((brief.includedSections ?? []).includes("product-signals")) {
  requireValue(
    (brief.productSignals ?? []).length > 0,
    "included product-signals section requires at least one signal",
  );
}
for (const [index, signal] of (brief.productSignals ?? []).entries()) {
  const prefix = `productSignals[${index}]`;
  requireValue(nonEmpty(signal.signal), `${prefix}.signal is required`);
  requireValue(
    objectArray(signal.engagementRefs),
    `${prefix}.engagementRefs requires at least one engagement`,
  );
  const engagementIds = new Set();
  for (const [referenceIndex, reference] of (
    signal.engagementRefs ?? []
  ).entries()) {
    const referencePrefix = `${prefix}.engagementRefs[${referenceIndex}]`;
    requireValue(
      nonEmpty(reference.engagementId),
      `${referencePrefix}.engagementId is required`,
    );
    requireValue(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(reference.engagementId ?? ""),
      `${referencePrefix}.engagementId must use canonical lowercase kebab-case`,
    );
    validateEvidenceLinks(
      reference.evidenceIds,
      `${referencePrefix}.evidenceIds`,
    );
    engagementIds.add(reference.engagementId.trim());
  }
  requireValue(
    engagementIds.size === (signal.engagementRefs ?? []).length,
    `${prefix}.engagementRefs must use distinct engagement IDs`,
  );
  requireValue(
    productDispositions.has(signal.disposition),
    `${prefix}.disposition must be one of: ${[...productDispositions].join(", ")}`,
  );
  if (engagementIds.size === 1) {
    requireValue(
      signal.disposition === "hold",
      `${prefix}.disposition must be hold with one engagement`,
    );
  }
  validateOwner(signal.owner, signal.assignmentId, prefix);
  validateEvidenceLinks(signal.evidenceIds, `${prefix}.evidenceIds`);
}

for (const section of brief.includedSections ?? []) {
  if (builtInSections.has(section)) continue;

  const items = brief.sectionContent?.[section];
  requireValue(
    objectArray(items),
    `sectionContent.${section} requires at least one item`,
  );
  for (const [index, item] of (items ?? []).entries()) {
    const prefix = `sectionContent.${section}[${index}]`;
    requireValue(nonEmpty(item.label), `${prefix}.label is required`);
    requireValue(nonEmpty(item.value), `${prefix}.value is required`);
    requireValue(
      typeof item.customerSafe === "boolean",
      `${prefix}.customerSafe must be true or false`,
    );
    validateEvidenceLinks(item.evidenceIds, `${prefix}.evidenceIds`);
  }
}

requireValue(
  stringArray(brief.redactions, true),
  "redactions must contain only non-empty strings",
);
requireValue(
  stringArray(brief.generatedArtifacts, true),
  "generatedArtifacts must contain only non-empty strings",
);

if (externalAudiences.has(brief.audience)) {
  requireValue(
    brief.gateCustomerSafe === true,
    "external readout requires a customer-safe gate explanation",
  );
  requireValue(
    (brief.findings ?? []).every((item) => item.customerSafe === true),
    "external readout requires every finding to be customerSafe",
  );
  requireValue(
    (brief.recommendations ?? []).every(
      (item) => item.customerSafe === true,
    ),
    "external readout requires every recommendation to be customerSafe",
  );
  requireValue(
    (brief.risks ?? []).every((item) => item.customerSafe === true),
    "external readout requires every risk to be customerSafe",
  );
  requireValue(
    (brief.decisionsNeeded ?? []).every(
      (item) => item.customerSafe === true,
    ),
    "external readout requires every decision to be customerSafe",
  );
  requireValue(
    (brief.nextSteps ?? []).every((item) => item.customerSafe === true),
    "external readout requires every next step to be customerSafe",
  );
  for (const section of brief.includedSections ?? []) {
    if (builtInSections.has(section)) continue;
    requireValue(
      (brief.sectionContent?.[section] ?? []).every(
        (item) => item.customerSafe === true,
      ),
      `external readout requires every ${section} item to be customerSafe`,
    );
  }
  requireValue(
    (brief.productSignals ?? []).length === 0,
    "external readout cannot contain productSignals",
  );
  requireValue(
    !(brief.includedSections ?? []).includes("product-signals"),
    "external readout cannot include the product-signals section",
  );
}

if (errors.length > 0) {
  console.error("Readout brief is not ready:");
  errors.forEach((error, index) => console.error(`${index + 1}. ${error}`));
  process.exit(1);
}

console.log(
  `Readout brief is structurally ready for ${brief.audience} ${brief.format}.`,
);
