#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { validateDomainModelLifecycle } from "./domain-model-lifecycle.mjs";

const phases = [
  "qualify",
  "audit",
  "design",
  "build",
  "evaluate",
  "deploy",
  "handoff",
];

const assignments = new Set(["deterministic", "model", "human", "hybrid"]);
const decisionStatuses = new Set(["open", "settled", "deferred"]);
const roundStatuses = new Set(["active", "answered"]);
const gateStatuses = new Set(["open", "blocked", "ready", "passed"]);
const sourceIntakeStatuses = new Set(["clear", "reviewed"]);
const verdicts = new Set([
  "FDE",
  "professional-services delivery",
  "standard implementation",
  "solutions architecture / sales engineering",
  "product engineering",
  "process change",
  "not qualified yet",
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
const realEvidenceClasses = new Set([
  "direct_observation",
  "system_record",
  "stakeholder_report",
]);
const evalCohorts = new Set([
  "normal",
  "edge",
  "incomplete",
  "ambiguous",
  "high-risk",
]);
const evalOutcomes = new Set(["pass", "fail", "escalated"]);
const productizationClasses = new Set([
  "existing shared primitive",
  "new reusable primitive",
  "customer configuration",
  "customer-only customization",
  "product candidate",
  "rejected generalization",
]);
const nextLoopDecisions = new Set([
  "improve",
  "expand",
  "productize",
  "hold",
  "reduce-autonomy",
  "retire",
]);
const deploymentStages = new Set([
  "offline",
  "shadow",
  "recommendation",
  "supervised",
  "bounded-autonomy",
  "production",
]);
const fieldJudgmentKinds = new Set([
  "firsthand-observation",
  "operator-quote",
  "failed-attempt",
  "surprise",
  "disagreement",
  "decision-rationale",
  "changed-mind",
]);
const retrospectiveStatuses = new Set([
  "pending",
  "captured",
  "none-observed",
]);
const humanOrigins = new Set(["human-provided", "human-confirmed"]);

const path = process.argv[2];

if (!path || process.argv.includes("--help")) {
  console.log("Usage: node scripts/validate-case-file.mjs <case-file.json>");
  process.exit(path ? 0 : 2);
}

const errors = [];

function requireValue(condition, message) {
  if (!condition) errors.push(message);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function nonEmptyArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        nonEmpty(item) ||
        (item !== null &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          Object.keys(item).length > 0),
    )
  );
}

function nonEmptyStringArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => nonEmpty(item))
  );
}

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => nonEmpty(item));
}

function validateEvidenceReferences(
  ids,
  prefix,
  evidenceById,
  requireAuthorizedReal = false,
) {
  requireValue(
    nonEmptyStringArray(ids),
    `${prefix} requires supporting evidence IDs`,
  );

  for (const evidenceId of ids ?? []) {
    const evidence = evidenceById.get(evidenceId);
    requireValue(
      evidenceById.has(evidenceId),
      `${prefix} references unknown evidence: ${evidenceId}`,
    );
    if (requireAuthorizedReal) {
      requireValue(
        evidence?.authorized === true &&
          realEvidenceClasses.has(evidence?.class),
        `${prefix} requires authorized real evidence: ${evidenceId}`,
      );
    }
  }
}

function validateEvidence(evidence) {
  requireValue(Array.isArray(evidence), "evidence must be an array");
  if (!Array.isArray(evidence)) return;

  for (const [index, item] of evidence.entries()) {
    const prefix = `evidence[${index}]`;
    requireValue(nonEmpty(item?.id), `${prefix}.id is required`);
    requireValue(nonEmpty(item?.statement), `${prefix}.statement is required`);
    requireValue(
      evidenceClasses.has(item?.class),
      `${prefix}.class must be one of: ${[...evidenceClasses].join(", ")}`,
    );
    requireValue(nonEmpty(item?.source), `${prefix}.source is required`);
    requireValue(nonEmpty(item?.observedAt), `${prefix}.observedAt is required`);
    requireValue(
      confidenceLevels.has(item?.confidence),
      `${prefix}.confidence must be high, medium, or low`,
    );
    requireValue(nonEmpty(item?.disproof), `${prefix}.disproof is required`);
    requireValue(
      sensitivityLevels.has(item?.sensitivity),
      `${prefix}.sensitivity must be public, internal, confidential, or restricted`,
    );
    requireValue(
      typeof item?.authorized === "boolean",
      `${prefix}.authorized must be true or false`,
    );
  }

  const ids = evidence.map((item) => item?.id);
  requireValue(
    new Set(ids).size === ids.length,
    "evidence IDs must be unique",
  );
}

function insideRoot(root, path) {
  const candidate = relative(root, path);
  return (
    candidate === "" ||
    (!candidate.startsWith("..") &&
      !candidate.startsWith("/") &&
      !candidate.includes(":"))
  );
}

async function validateSourceIntake(data) {
  const intake = data.sourceIntake;
  requireValue(
    intake && typeof intake === "object",
    "sourceIntake is required from audit onward",
  );
  if (!intake || typeof intake !== "object") return;
  requireValue(
    nonEmpty(intake.approvedRoot),
    "sourceIntake.approvedRoot is required",
  );
  requireValue(
    nonEmpty(intake.manifestPath),
    "sourceIntake.manifestPath is required",
  );
  requireValue(
    /^[a-f0-9]{64}$/.test(intake.manifestSha256 ?? ""),
    "sourceIntake.manifestSha256 must be a SHA-256 digest",
  );
  requireValue(
    sourceIntakeStatuses.has(intake.status),
    "sourceIntake.status must be clear or reviewed",
  );
  requireValue(
    nonEmpty(intake.screenedAt),
    "sourceIntake.screenedAt is required",
  );
  if (intake.status === "reviewed") {
    requireValue(
      nonEmpty(intake.reviewedBy),
      "sourceIntake.reviewedBy is required after review",
    );
  }

  const caseDirectory = dirname(resolve(path));
  const approvedRoot = resolve(caseDirectory, intake.approvedRoot ?? "");
  const manifestPath = resolve(caseDirectory, intake.manifestPath ?? "");
  requireValue(
    insideRoot(caseDirectory, approvedRoot),
    "sourceIntake.approvedRoot must stay inside the case directory",
  );
  requireValue(
    insideRoot(caseDirectory, manifestPath),
    "sourceIntake.manifestPath must stay inside the case directory",
  );
  if (
    !insideRoot(caseDirectory, approvedRoot) ||
    !insideRoot(caseDirectory, manifestPath)
  ) {
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    requireValue(false, `sourceIntake manifest cannot be read: ${error.message}`);
    return;
  }

  const { manifestSha256, ...manifestBody } = manifest;
  const computedManifestSha256 = createHash("sha256")
    .update(JSON.stringify(manifestBody))
    .digest("hex");
  requireValue(
    manifestSha256 === computedManifestSha256,
    "sourceIntake manifest self-hash is invalid",
  );
  requireValue(
    intake.manifestSha256 === computedManifestSha256,
    "sourceIntake.manifestSha256 does not match the manifest",
  );
  requireValue(
    intake.status === manifest.status,
    "sourceIntake.status does not match the manifest",
  );
  requireValue(
    intake.screenedAt === manifest.generatedAt,
    "sourceIntake.screenedAt does not match the manifest",
  );

  const manifestSources = new Map(
    (manifest.sources ?? []).map((source) => [source.sourceId, source]),
  );
  const mappings = intake.sources;
  requireValue(
    Array.isArray(mappings) && mappings.length === manifestSources.size,
    "sourceIntake.sources must map every manifest source",
  );
  if (!Array.isArray(mappings)) return;

  const mappedIds = new Set();
  for (const [index, mapping] of mappings.entries()) {
    const prefix = `sourceIntake.sources[${index}]`;
    requireValue(nonEmpty(mapping?.sourceId), `${prefix}.sourceId is required`);
    requireValue(nonEmpty(mapping?.path), `${prefix}.path is required`);
    const source = manifestSources.get(mapping?.sourceId);
    requireValue(Boolean(source), `${prefix}.sourceId is absent from the manifest`);
    const sourcePath = resolve(approvedRoot, mapping?.path ?? "");
    requireValue(
      insideRoot(approvedRoot, sourcePath),
      `${prefix}.path must stay inside sourceIntake.approvedRoot`,
    );
    if (!source || !insideRoot(approvedRoot, sourcePath)) continue;

    try {
      const bytes = await readFile(sourcePath);
      const currentSha256 = createHash("sha256").update(bytes).digest("hex");
      requireValue(
        source.sha256 === currentSha256,
        `${prefix}.path no longer matches its preflight hash`,
      );
    } catch (error) {
      requireValue(false, `${prefix}.path cannot be read: ${error.message}`);
    }
    mappedIds.add(mapping.sourceId);
  }
  requireValue(
    mappedIds.size === mappings.length,
    "sourceIntake.sources contains duplicate source IDs",
  );
}

function validateFieldJudgment(data, { requireObservation = false } = {}) {
  const evidenceById = new Map(
    (data.evidence ?? []).map((item) => [item.id, item]),
  );
  const entries = data.fieldJudgment?.entries;
  requireValue(
    nonEmptyArray(entries),
    "fieldJudgment.entries requires human source material",
  );
  const ids = new Set();
  for (const [index, entry] of (entries ?? []).entries()) {
    const prefix = `fieldJudgment.entries[${index}]`;
    requireValue(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry?.id ?? ""),
      `${prefix}.id must use lowercase kebab-case`,
    );
    requireValue(
      fieldJudgmentKinds.has(entry?.kind),
      `${prefix}.kind must be one of: ${[...fieldJudgmentKinds].join(", ")}`,
    );
    requireValue(
      nonEmpty(entry?.authorRole),
      `${prefix}.authorRole is required`,
    );
    requireValue(
      humanOrigins.has(entry?.origin),
      `${prefix}.origin must be human-provided or human-confirmed`,
    );
    requireValue(nonEmpty(entry?.statement), `${prefix}.statement is required`);
    requireValue(nonEmpty(entry?.context), `${prefix}.context is required`);
    requireValue(
      nonEmpty(entry?.whyItMatters),
      `${prefix}.whyItMatters is required`,
    );
    requireValue(
      typeof entry?.customerSafe === "boolean",
      `${prefix}.customerSafe must be true or false`,
    );
    validateEvidenceReferences(
      entry?.evidenceIds,
      `${prefix}.evidenceIds`,
      evidenceById,
      data.mode === "engage",
    );
    ids.add(entry?.id);
  }
  requireValue(
    ids.size === (entries ?? []).length,
    "fieldJudgment entry IDs must be unique",
  );
  if (requireObservation) {
    requireValue(
      (entries ?? []).some((entry) =>
        ["firsthand-observation", "operator-quote"].includes(entry.kind),
      ),
      "fieldJudgment requires a firsthand observation or operator quote",
    );
  }

  const retrospective = data.fieldJudgment?.retrospective;
  requireValue(
    retrospectiveStatuses.has(retrospective?.status),
    `fieldJudgment.retrospective.status must be one of: ${[
      ...retrospectiveStatuses,
    ].join(", ")}`,
  );
  requireValue(
    stringArray(retrospective?.evidenceIds),
    "fieldJudgment.retrospective.evidenceIds must contain only non-empty strings",
  );
}

function validateQualify(data) {
  const evidenceById = new Map(
    (data.evidence ?? []).map((item) => [item.id, item]),
  );
  requireValue(
    verdicts.has(data.classification?.verdict),
    `classification.verdict must be one of: ${[...verdicts].join(", ")}`,
  );
  requireValue(nonEmpty(data.classification?.reason), "classification.reason is required");
  requireValue(nonEmpty(data.outcomeContract?.outcome), "outcomeContract.outcome is required");
  requireValue(nonEmpty(data.outcomeContract?.baseline?.value), "outcomeContract.baseline.value is required");
  requireValue(nonEmpty(data.outcomeContract?.baseline?.source), "outcomeContract.baseline.source is required");
  requireValue(nonEmpty(data.outcomeContract?.target), "outcomeContract.target is required");
  requireValue(nonEmpty(data.outcomeContract?.sponsor), "outcomeContract.sponsor is required");
  requireValue(nonEmpty(data.outcomeContract?.operator), "outcomeContract.operator is required");
  requireValue(nonEmpty(data.outcomeContract?.operatingOwner), "outcomeContract.operatingOwner is required");
  requireValue(nonEmpty(data.outcomeContract?.valueMechanism), "outcomeContract.valueMechanism is required");
  requireValue(nonEmptyArray(data.evidence), "at least one evidence record is required");
  requireValue(
    data.classification?.verdict !== "not qualified yet",
    'classification.verdict "not qualified yet" cannot satisfy the qualification gate',
  );

  if (data.mode === "engage") {
    requireValue(
      data.evidence?.some(
        (item) =>
          item?.authorized === true && realEvidenceClasses.has(item?.class),
      ),
      "engage mode requires authorized direct observation, system record, or stakeholder evidence",
    );
  }

  requireValue(
    nonEmptyArray(data.decisionTree?.nodes),
    "decisionTree.nodes requires at least one qualification decision",
  );
  requireValue(
    stringArray(data.decisionTree?.frontier),
    "decisionTree.frontier must contain only non-empty node IDs",
  );
  requireValue(
    positiveInteger(data.decisionTree?.nextQuestionNumber),
    "decisionTree.nextQuestionNumber must be a positive integer",
  );
  requireValue(
    Array.isArray(data.decisionTree?.rounds),
    "decisionTree.rounds must be an array",
  );

  const nodeIds = new Set();
  const questionNumbers = [];
  for (const [index, node] of (data.decisionTree?.nodes ?? []).entries()) {
    const prefix = `decisionTree.nodes[${index}]`;
    requireValue(nonEmpty(node?.id), `${prefix}.id is required`);
    requireValue(nonEmpty(node?.branch), `${prefix}.branch is required`);
    requireValue(
      node?.questionNumber === null || positiveInteger(node?.questionNumber),
      `${prefix}.questionNumber must be null or a positive integer`,
    );
    requireValue(nonEmpty(node?.question), `${prefix}.question is required`);
    requireValue(
      stringArray(node?.prerequisites),
      `${prefix}.prerequisites must contain only non-empty strings`,
    );
    requireValue(
      stringArray(node?.evidenceNeeded),
      `${prefix}.evidenceNeeded must contain only non-empty strings`,
    );
    requireValue(
      typeof node?.evidenceReady === "boolean",
      `${prefix}.evidenceReady must be true or false`,
    );
    requireValue(
      nonEmpty(node?.recommendation),
      `${prefix}.recommendation is required`,
    );
    requireValue(
      decisionStatuses.has(node?.status),
      `${prefix}.status must be open, settled, or deferred`,
    );
    if (node?.status === "settled") {
      requireValue(
        positiveInteger(node?.questionNumber),
        `${prefix}.questionNumber is required when settled`,
      );
      requireValue(nonEmpty(node?.answer), `${prefix}.answer is required`);
      requireValue(
        node?.evidenceReady === true,
        `${prefix}.evidenceReady must be true when settled`,
      );
    }
    if (node?.status === "deferred") {
      requireValue(
        positiveInteger(node?.questionNumber),
        `${prefix}.questionNumber is required when deferred`,
      );
      requireValue(
        nonEmpty(node?.deferredReason),
        `${prefix}.deferredReason is required`,
      );
      requireValue(
        nonEmpty(node?.deferredOwner),
        `${prefix}.deferredOwner is required`,
      );
    }
    requireValue(nonEmpty(node?.reopenIf), `${prefix}.reopenIf is required`);
    validateEvidenceReferences(
      node?.evidenceIds,
      `${prefix}.evidenceIds`,
      evidenceById,
      data.mode === "engage",
    );
    nodeIds.add(node?.id);
    if (positiveInteger(node?.questionNumber)) {
      questionNumbers.push(node.questionNumber);
    }
  }

  requireValue(
    nodeIds.size === (data.decisionTree?.nodes ?? []).length,
    "decisionTree node IDs must be unique",
  );
  requireValue(
    new Set(questionNumbers).size === questionNumbers.length,
    "decisionTree question numbers must be unique",
  );
  const sortedQuestionNumbers = [...questionNumbers].sort(
    (left, right) => left - right,
  );
  requireValue(
    sortedQuestionNumbers.every(
      (number, index) => number === index + 1,
    ),
    "decisionTree question numbers must form a continuous sequence from 1",
  );
  const expectedNextQuestionNumber =
    questionNumbers.length + 1;
  requireValue(
    data.decisionTree?.nextQuestionNumber === expectedNextQuestionNumber,
    `decisionTree.nextQuestionNumber must be ${expectedNextQuestionNumber}`,
  );

  const nodeById = new Map(
    (data.decisionTree?.nodes ?? []).map((node) => [node.id, node]),
  );
  for (const [index, node] of (data.decisionTree?.nodes ?? []).entries()) {
    for (const prerequisite of node?.prerequisites ?? []) {
      requireValue(
        nodeIds.has(prerequisite),
        `decisionTree.nodes[${index}].prerequisites references unknown node: ${prerequisite}`,
      );
      requireValue(
        prerequisite !== node?.id,
        `decisionTree.nodes[${index}] cannot depend on itself`,
      );
      if (node?.status === "settled" && nodeById.has(prerequisite)) {
        requireValue(
          nodeById.get(prerequisite)?.status === "settled",
          `decisionTree.nodes[${index}] cannot settle before prerequisite ${prerequisite}`,
        );
      }
    }
  }

  const roundIds = new Set();
  const roundedNodeIds = new Set();
  let activeRoundCount = 0;
  let previousQuestionNumber = 0;
  for (const [index, round] of (
    data.decisionTree?.rounds ?? []
  ).entries()) {
    const prefix = `decisionTree.rounds[${index}]`;
    requireValue(nonEmpty(round?.id), `${prefix}.id is required`);
    requireValue(
      roundStatuses.has(round?.status),
      `${prefix}.status must be active or answered`,
    );
    requireValue(
      Array.isArray(round?.nodeIds) &&
        round.nodeIds.length >= 1 &&
        round.nodeIds.length <= 3 &&
        round.nodeIds.every((nodeId) => nonEmpty(nodeId)),
      `${prefix}.nodeIds requires one to three node IDs`,
    );
    requireValue(
      new Set(round?.nodeIds ?? []).size === (round?.nodeIds ?? []).length,
      `${prefix}.nodeIds must be unique`,
    );

    const roundNodes = (round?.nodeIds ?? [])
      .map((nodeId) => nodeById.get(nodeId))
      .filter(Boolean);
    for (const nodeId of round?.nodeIds ?? []) {
      requireValue(
        nodeById.has(nodeId),
        `${prefix}.nodeIds references unknown node: ${nodeId}`,
      );
      requireValue(
        !roundedNodeIds.has(nodeId),
        `${prefix}.nodeIds repeats a node from an earlier round: ${nodeId}`,
      );
      roundedNodeIds.add(nodeId);
    }

    const roundQuestionNumbers = roundNodes.map(
      (node) => node.questionNumber,
    );
    requireValue(
      roundQuestionNumbers.every(positiveInteger),
      `${prefix}.nodeIds must reference numbered questions`,
    );
    requireValue(
      roundQuestionNumbers.every(
        (number, numberIndex) =>
          numberIndex === 0 ||
          number > roundQuestionNumbers[numberIndex - 1],
      ),
      `${prefix}.nodeIds must follow ascending question numbers`,
    );
    requireValue(
      roundQuestionNumbers.every(
        (number) => number > previousQuestionNumber,
      ),
      `${prefix} cannot reset or reuse question numbers`,
    );
    if (roundQuestionNumbers.length > 0) {
      previousQuestionNumber = Math.max(...roundQuestionNumbers);
    }

    if (round?.status === "active") {
      activeRoundCount += 1;
      requireValue(
        index === (data.decisionTree?.rounds ?? []).length - 1,
        `${prefix} must be the final round while active`,
      );
      requireValue(
        roundNodes.some((node) => node.status === "open"),
        `${prefix} must contain an open node while active`,
      );
    }
    if (round?.status === "answered") {
      requireValue(
        roundNodes.every((node) => node.status !== "open"),
        `${prefix} cannot contain open nodes when answered`,
      );
    }
    roundIds.add(round?.id);
  }
  requireValue(
    roundIds.size === (data.decisionTree?.rounds ?? []).length,
    "decisionTree round IDs must be unique",
  );
  requireValue(
    activeRoundCount <= 1,
    "decisionTree can contain at most one active round",
  );
  for (const node of data.decisionTree?.nodes ?? []) {
    if (positiveInteger(node.questionNumber)) {
      requireValue(
        roundedNodeIds.has(node.id),
        `numbered decision-tree node must belong to a round: ${node.id}`,
      );
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(nodeId) {
    if (visiting.has(nodeId)) {
      errors.push(`decisionTree contains a dependency cycle at ${nodeId}`);
      return;
    }
    if (visited.has(nodeId)) return;

    visiting.add(nodeId);
    for (const prerequisite of nodeById.get(nodeId)?.prerequisites ?? []) {
      if (nodeById.has(prerequisite)) visit(prerequisite);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  }
  for (const nodeId of nodeIds) visit(nodeId);

  const derivedFrontier = (data.decisionTree?.nodes ?? [])
    .filter(
      (node) =>
        node.status === "open" &&
        node.evidenceReady === true &&
        (node.prerequisites ?? []).every(
          (prerequisite) => nodeById.get(prerequisite)?.status === "settled",
        ),
    )
    .map((node) => node.id)
    .sort();
  const declaredFrontier = [...(data.decisionTree?.frontier ?? [])].sort();

  requireValue(
    JSON.stringify(derivedFrontier) === JSON.stringify(declaredFrontier),
    `decisionTree.frontier must equal the derived frontier: ${derivedFrontier.join(", ") || "(empty)"}`,
  );
  requireValue(
    !(data.decisionTree?.nodes ?? []).some((node) => node.status === "open"),
    "decisionTree cannot contain open nodes when the qualification gate passes",
  );
}

function validateAudit(data) {
  const evidenceById = new Map(
    (data.evidence ?? []).map((item) => [item.id, item]),
  );
  const requireReal = data.mode === "engage";

  validateFieldJudgment(data, { requireObservation: true });

  for (const error of validateDomainModelLifecycle(
    data.domainModel,
    evidenceById,
    { requireAuthorizedReal: requireReal },
  )) {
    errors.push(error);
  }

  requireValue(
    nonEmptyArray(data.domainModel?.actors),
    "domainModel.actors requires at least one actor",
  );
  for (const [index, actor] of (data.domainModel?.actors ?? []).entries()) {
    const prefix = `domainModel.actors[${index}]`;
    requireValue(nonEmpty(actor?.name), `${prefix}.name is required`);
    requireValue(
      nonEmpty(actor?.responsibility),
      `${prefix}.responsibility is required`,
    );
    requireValue(nonEmpty(actor?.authority), `${prefix}.authority is required`);
    requireValue(
      nonEmpty(actor?.incentivesAndRisks),
      `${prefix}.incentivesAndRisks is required`,
    );
    requireValue(
      nonEmpty(actor?.workflowParticipation),
      `${prefix}.workflowParticipation is required`,
    );
    validateEvidenceReferences(
      actor?.evidenceIds,
      `${prefix}.evidenceIds`,
      evidenceById,
      requireReal,
    );
  }

  requireValue(
    nonEmptyArray(data.domainModel?.systems),
    "domainModel.systems requires at least one system",
  );
  for (const [index, system] of (data.domainModel?.systems ?? []).entries()) {
    const prefix = `domainModel.systems[${index}]`;
    requireValue(nonEmpty(system?.name), `${prefix}.name is required`);
    requireValue(nonEmpty(system?.role), `${prefix}.role is required`);
    requireValue(
      typeof system?.sourceOfTruth === "boolean",
      `${prefix}.sourceOfTruth must be true or false`,
    );
    requireValue(nonEmpty(system?.owner), `${prefix}.owner is required`);
    requireValue(
      stringArray(system?.dataRead),
      `${prefix}.dataRead must contain only non-empty strings`,
    );
    requireValue(
      stringArray(system?.dataWritten),
      `${prefix}.dataWritten must contain only non-empty strings`,
    );
    requireValue(
      stringArray(system?.knownDrift),
      `${prefix}.knownDrift must contain only non-empty strings`,
    );
    validateEvidenceReferences(
      system?.evidenceIds,
      `${prefix}.evidenceIds`,
      evidenceById,
      requireReal,
    );
  }

  requireValue(
    nonEmptyArray(data.domainModel?.boundaries),
    "domainModel.boundaries requires at least one boundary",
  );
  for (const [index, boundary] of (
    data.domainModel?.boundaries ?? []
  ).entries()) {
    const prefix = `domainModel.boundaries[${index}]`;
    requireValue(nonEmpty(boundary?.name), `${prefix}.name is required`);
    requireValue(nonEmpty(boundary?.inside), `${prefix}.inside is required`);
    requireValue(nonEmpty(boundary?.outside), `${prefix}.outside is required`);
    requireValue(nonEmpty(boundary?.owner), `${prefix}.owner is required`);
    requireValue(
      nonEmpty(boundary?.crossingMechanism),
      `${prefix}.crossingMechanism is required`,
    );
    validateEvidenceReferences(
      boundary?.evidenceIds,
      `${prefix}.evidenceIds`,
      evidenceById,
      requireReal,
    );
  }

  requireValue(
    nonEmptyArray(data.domainModel?.relationships),
    "domainModel.relationships requires at least one relationship",
  );
  for (const [index, relationship] of (
    data.domainModel?.relationships ?? []
  ).entries()) {
    const prefix = `domainModel.relationships[${index}]`;
    requireValue(nonEmpty(relationship?.subject), `${prefix}.subject is required`);
    requireValue(nonEmpty(relationship?.verb), `${prefix}.verb is required`);
    requireValue(nonEmpty(relationship?.object), `${prefix}.object is required`);
    validateEvidenceReferences(
      relationship?.evidenceIds,
      `${prefix}.evidenceIds`,
      evidenceById,
      requireReal,
    );
  }

  for (const [index, term] of (data.domainModel?.terms ?? []).entries()) {
    const prefix = `domainModel.terms[${index}]`;
    requireValue(nonEmpty(term?.term), `${prefix}.term is required`);
    requireValue(nonEmpty(term?.definition), `${prefix}.definition is required`);
    requireValue(stringArray(term?.avoid), `${prefix}.avoid must contain only non-empty strings`);
    requireValue(stringArray(term?.examples), `${prefix}.examples must contain only non-empty strings`);
    validateEvidenceReferences(
      term?.evidenceIds,
      `${prefix}.evidenceIds`,
      evidenceById,
      requireReal,
    );
  }
  requireValue(
    Array.isArray(data.domainModel?.conflicts),
    "domainModel.conflicts must be an array",
  );
  for (const [index, conflict] of (
    data.domainModel?.conflicts ?? []
  ).entries()) {
    const prefix = `domainModel.conflicts[${index}]`;
    requireValue(
      nonEmpty(conflict?.description),
      `${prefix}.description is required`,
    );
    requireValue(
      ["resolved", "deferred"].includes(conflict?.status),
      `${prefix}.status must be resolved or deferred`,
    );
    validateEvidenceReferences(
      conflict?.evidenceIds,
      `${prefix}.evidenceIds`,
      evidenceById,
      requireReal,
    );
    if (conflict?.status === "resolved") {
      requireValue(
        nonEmpty(conflict?.resolution),
        `${prefix}.resolution is required`,
      );
    }
    if (conflict?.status === "deferred") {
      requireValue(nonEmpty(conflict?.owner), `${prefix}.owner is required`);
      requireValue(
        nonEmpty(conflict?.revisitWhen),
        `${prefix}.revisitWhen is required`,
      );
    }
  }

  requireValue(nonEmptyArray(data.operatingMap?.steps), "operatingMap.steps requires at least one observed step");
  for (const [index, step] of (data.operatingMap?.steps ?? []).entries()) {
    const prefix = `operatingMap.steps[${index}]`;
    requireValue(nonEmpty(step?.name), `${prefix}.name is required`);
    requireValue(nonEmpty(step?.actor), `${prefix}.actor is required`);
    requireValue(nonEmpty(step?.trigger), `${prefix}.trigger is required`);
    requireValue(nonEmpty(step?.system), `${prefix}.system is required`);
    requireValue(stringArray(step?.exceptions), `${prefix}.exceptions must contain only non-empty strings`);
    requireValue(stringArray(step?.failures), `${prefix}.failures must contain only non-empty strings`);
    validateEvidenceReferences(
      step?.evidenceIds,
      `${prefix}.evidenceIds`,
      evidenceById,
      requireReal,
    );
  }
}

function validateDesign(data) {
  requireValue(
    (data.fieldJudgment?.entries ?? []).some(
      (entry) => entry.kind === "decision-rationale",
    ),
    "fieldJudgment requires a decision-rationale before design",
  );
  requireValue(nonEmptyArray(data.allocationMatrix?.steps), "allocationMatrix.steps requires at least one future-state step");
  for (const [index, step] of (data.allocationMatrix?.steps ?? []).entries()) {
    const prefix = `allocationMatrix.steps[${index}]`;
    requireValue(nonEmpty(step?.name), `${prefix}.name is required`);
    requireValue(assignments.has(step?.assignment), `${prefix}.assignment must be deterministic, model, human, or hybrid`);
    requireValue(nonEmpty(step?.reason), `${prefix}.reason is required`);
    requireValue(nonEmptyArray(step?.failureModes), `${prefix}.failureModes requires at least one failure`);
    requireValue(nonEmpty(step?.recovery), `${prefix}.recovery is required`);
    requireValue(nonEmpty(step?.owner), `${prefix}.owner is required`);
  }
}

function validateBuild(data) {
  requireValue(nonEmptyStringArray(data.architecture?.integrations), "architecture.integrations requires at least one real boundary");
  requireValue(nonEmptyStringArray(data.architecture?.identityAndPermissions), "architecture.identityAndPermissions is required");
  requireValue(nonEmptyStringArray(data.architecture?.securityControls), "architecture.securityControls is required");
  requireValue(nonEmptyStringArray(data.architecture?.observability), "architecture.observability is required");
  requireValue(nonEmptyStringArray(data.architecture?.recovery), "architecture.recovery is required");
  requireValue(nonEmptyStringArray(data.architecture?.rollback), "architecture.rollback is required");
}

function validateEvaluate(data) {
  const evidenceIds = new Set(
    (data.evidence ?? []).map((item) => item.id),
  );
  requireValue(nonEmpty(data.evalPlan?.riskBasis), "evalPlan.riskBasis is required");
  requireValue(nonEmptyArray(data.evalPlan?.cases), "evalPlan.cases requires risk-based cases");
  requireValue(nonEmptyStringArray(data.evalPlan?.passCriteria), "evalPlan.passCriteria is required");
  requireValue(nonEmptyStringArray(data.evalPlan?.invariants), "evalPlan.invariants is required");
  requireValue(nonEmptyStringArray(data.evalPlan?.failureCategories), "evalPlan.failureCategories is required");
  requireValue(nonEmptyStringArray(data.evalPlan?.escalationRules), "evalPlan.escalationRules is required");

  const caseIds = new Set();
  const cohorts = new Set();
  for (const [index, item] of (data.evalPlan?.cases ?? []).entries()) {
    const prefix = `evalPlan.cases[${index}]`;
    requireValue(nonEmpty(item?.id), `${prefix}.id is required`);
    requireValue(
      evalCohorts.has(item?.cohort),
      `${prefix}.cohort must be one of: ${[...evalCohorts].join(", ")}`,
    );
    requireValue(nonEmpty(item?.expectedBehavior), `${prefix}.expectedBehavior is required`);
    requireValue(nonEmpty(item?.consequence), `${prefix}.consequence is required`);
    requireValue(nonEmptyStringArray(item?.evidenceIds), `${prefix}.evidenceIds is required`);
    for (const evidenceId of item?.evidenceIds ?? []) {
      requireValue(
        evidenceIds.has(evidenceId),
        `${prefix}.evidenceIds references unknown evidence: ${evidenceId}`,
      );
    }
    caseIds.add(item?.id);
    cohorts.add(item?.cohort);
  }
  requireValue(
    caseIds.size === (data.evalPlan?.cases ?? []).length,
    "evalPlan case IDs must be unique",
  );
  for (const cohort of evalCohorts) {
    requireValue(
      cohorts.has(cohort),
      `evalPlan.cases requires a ${cohort} cohort`,
    );
  }

  requireValue(nonEmptyArray(data.evalPlan?.results), "evalPlan.results requires executed evaluation evidence");
  const resultCaseIds = new Set();
  for (const [index, result] of (data.evalPlan?.results ?? []).entries()) {
    const prefix = `evalPlan.results[${index}]`;
    requireValue(
      caseIds.has(result?.caseId),
      `${prefix}.caseId must reference an eval case`,
    );
    requireValue(
      evalOutcomes.has(result?.outcome),
      `${prefix}.outcome must be pass, fail, or escalated`,
    );
    requireValue(nonEmpty(result?.evidence), `${prefix}.evidence is required`);
    resultCaseIds.add(result?.caseId);
  }
  for (const caseId of caseIds) {
    requireValue(
      resultCaseIds.has(caseId),
      `evalPlan.results requires a result for case ${caseId}`,
    );
  }
  requireValue(
    Array.isArray(data.evalPlan?.unresolvedSevereFailures),
    "evalPlan.unresolvedSevereFailures must be an array",
  );
  requireValue(
    data.evalPlan?.unresolvedSevereFailures?.length === 0,
    "evalPlan.unresolvedSevereFailures must be empty before deployment",
  );
  requireValue(nonEmpty(data.evalPlan?.releaseRecommendation), "evalPlan.releaseRecommendation is required");
}

function validateDeploy(data) {
  const evidenceById = new Map(
    (data.evidence ?? []).map((item) => [item.id, item]),
  );
  requireValue(deploymentStages.has(data.deployment?.stage), "deployment.stage is invalid");
  requireValue(data.deployment?.stage !== "offline", "deployment.stage cannot remain offline at the deploy gate");
  requireValue(nonEmptyStringArray(data.deployment?.stageEvidenceIds), "deployment.stageEvidenceIds requires rollout evidence");
  for (const evidenceId of data.deployment?.stageEvidenceIds ?? []) {
    const evidence = evidenceById.get(evidenceId);
    requireValue(
      evidence?.authorized === true &&
        realEvidenceClasses.has(evidence?.class),
      `deployment.stageEvidenceIds requires authorized real evidence: ${evidenceId}`,
    );
  }
  requireValue(nonEmpty(data.deployment?.owner), "deployment.owner is required");
  requireValue(nonEmptyStringArray(data.deployment?.monitoring), "deployment.monitoring is required");
  requireValue(nonEmptyStringArray(data.deployment?.humanReview), "deployment.humanReview is required");
  requireValue(data.deployment?.rollbackTested === true, "deployment.rollbackTested must be true");
  requireValue(nonEmptyStringArray(data.deployment?.adoptionMeasures), "deployment.adoptionMeasures is required");
}

function validateHandoff(data) {
  const retrospective = data.fieldJudgment?.retrospective;
  requireValue(
    ["captured", "none-observed"].includes(retrospective?.status),
    "fieldJudgment.retrospective must be captured or none-observed at handoff",
  );
  requireValue(
    nonEmpty(retrospective?.reason),
    "fieldJudgment.retrospective.reason is required at handoff",
  );
  if (retrospective?.status === "captured") {
    requireValue(
      (data.fieldJudgment?.entries ?? []).some((entry) =>
        [
          "failed-attempt",
          "surprise",
          "disagreement",
          "changed-mind",
        ].includes(entry.kind),
      ),
      "captured retrospective requires a failed attempt, surprise, disagreement, or changed mind",
    );
    validateEvidenceReferences(
      retrospective?.evidenceIds,
      "fieldJudgment.retrospective.evidenceIds",
      new Map((data.evidence ?? []).map((item) => [item.id, item])),
      data.mode === "engage",
    );
  }
  requireValue(nonEmpty(data.handoff?.owner), "handoff.owner is required");
  requireValue(nonEmpty(data.handoff?.runbook), "handoff.runbook is required");
  requireValue(nonEmptyStringArray(data.handoff?.training), "handoff.training is required");
  requireValue(stringArray(data.handoff?.knownLimitations), "handoff.knownLimitations must contain only non-empty strings");
  requireValue(nonEmptyStringArray(data.handoff?.realizedOutcomes), "handoff.realizedOutcomes is required");
  requireValue(
    nextLoopDecisions.has(data.handoff?.nextLoopDecision),
    `handoff.nextLoopDecision must be one of: ${[...nextLoopDecisions].join(", ")}`,
  );
  requireValue(data.handoff?.accepted === true, "handoff.accepted must be true");
  requireValue(data.productization?.reviewed === true, "productization.reviewed must be true");
  requireValue(nonEmptyArray(data.productization?.items), "productization.items requires an explicit disposition");
  for (const [index, item] of (data.productization?.items ?? []).entries()) {
    const prefix = `productization.items[${index}]`;
    requireValue(nonEmpty(item?.component), `${prefix}.component is required`);
    requireValue(
      productizationClasses.has(item?.classification),
      `${prefix}.classification must be one of: ${[...productizationClasses].join(", ")}`,
    );
    requireValue(nonEmpty(item?.decision), `${prefix}.decision is required`);
  }
}

let data;
try {
  data = JSON.parse(await readFile(resolve(path), "utf8"));
} catch (error) {
  console.error(`Cannot read case file: ${error.message}`);
  process.exit(2);
}

requireValue(data.version === "1.0", 'version must be "1.0"');
requireValue(["coach", "engage", "review"].includes(data.mode), "mode must be coach, engage, or review");
requireValue(phases.includes(data.phase), `phase must be one of: ${phases.join(", ")}`);
validateEvidence(data.evidence);
requireValue(
  gateStatuses.has(data.gate?.status),
  `gate.status must be one of: ${[...gateStatuses].join(", ")}`,
);
requireValue(nonEmpty(data.gate?.reason), "gate.reason is required");
requireValue(
  data.gate?.status === "passed",
  `gate.status must be passed to satisfy the ${data.phase ?? "current"} gate`,
);
validateEvidenceReferences(
  data.gate?.evidenceIds,
  "gate.evidenceIds",
  new Map((data.evidence ?? []).map((item) => [item.id, item])),
  data.mode === "engage",
);
requireValue(Array.isArray(data.assignments), "assignments must be an array");
const assignmentIds = new Set();
const assignmentEvidenceById = new Map(
  (data.evidence ?? []).map((item) => [item.id, item]),
);
for (const [index, assignment] of (data.assignments ?? []).entries()) {
  const prefix = `assignments[${index}]`;
  requireValue(nonEmpty(assignment?.id), `${prefix}.id is required`);
  requireValue(nonEmpty(assignment?.subject), `${prefix}.subject is required`);
  requireValue(nonEmpty(assignment?.owner), `${prefix}.owner is required`);
  requireValue(nonEmpty(assignment?.timing), `${prefix}.timing is required`);
  validateEvidenceReferences(
    assignment?.evidenceIds,
    `${prefix}.evidenceIds`,
    assignmentEvidenceById,
    data.mode === "engage",
  );
  assignmentIds.add(assignment?.id);
}
requireValue(
  assignmentIds.size === (data.assignments ?? []).length,
  "assignment IDs must be unique",
);

const validators = [
  validateQualify,
  validateAudit,
  validateDesign,
  validateBuild,
  validateEvaluate,
  validateDeploy,
  validateHandoff,
];
const phaseIndex = phases.indexOf(data.phase);

if (phaseIndex > 0) {
  requireValue(
    data.classification?.verdict === "FDE",
    "only an FDE verdict can advance beyond qualification",
  );
  await validateSourceIntake(data);
}

for (const validator of validators.slice(0, phaseIndex + 1)) {
  validator(data);
}

if (errors.length > 0) {
  console.error(`Case file is not ready for the "${data.phase}" gate:`);
  errors.forEach((error, index) => console.error(`${index + 1}. ${error}`));
  process.exit(1);
}

console.log(`Case file satisfies every gate through "${data.phase}".`);
