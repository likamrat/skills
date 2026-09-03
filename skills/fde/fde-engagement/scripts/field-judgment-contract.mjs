const phases = [
  "qualify",
  "audit",
  "design",
  "build",
  "evaluate",
  "deploy",
  "handoff",
];

const fieldJudgmentKinds = new Set([
  "firsthand-observation",
  "operator-quote",
  "failed-attempt",
  "surprise",
  "disagreement",
  "decision-rationale",
  "changed-mind",
]);
const observationKinds = new Set([
  "firsthand-observation",
  "operator-quote",
]);
const retrospectiveKinds = new Set([
  "failed-attempt",
  "surprise",
  "disagreement",
  "changed-mind",
]);
const retrospectiveStatuses = new Set([
  "pending",
  "captured",
  "none-observed",
]);
const humanOrigins = new Set(["human-provided", "human-confirmed"]);
const realEvidenceClasses = new Set([
  "direct_observation",
  "system_record",
  "stakeholder_report",
]);

export function isAuthorizedRealEvidence(evidence) {
  return (
    evidence?.authorized === true &&
    realEvidenceClasses.has(evidence?.class)
  );
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
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

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => nonEmpty(item));
}

function phaseAtLeast(phase, minimum) {
  return phases.indexOf(phase) >= phases.indexOf(minimum);
}

export function validateFieldJudgmentContract(
  data,
  { externalAudience = false } = {},
) {
  const errors = [];
  const requireValue = (condition, message) => {
    if (!condition) errors.push(message);
  };

  if (!phaseAtLeast(data?.phase, "audit")) return errors;

  const evidenceById = new Map(
    (data?.evidence ?? []).map((item) => [item.id, item]),
  );
  const requireAuthorizedReal = data?.mode === "engage";

  function validateEvidenceReferences(ids, prefix) {
    requireValue(
      Array.isArray(ids) && ids.length > 0 && ids.every(nonEmpty),
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
          isAuthorizedRealEvidence(evidence),
          `${prefix} requires authorized real evidence: ${evidenceId}`,
        );
      }
    }
  }

  const entries = data?.fieldJudgment?.entries;
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
    validateEvidenceReferences(entry?.evidenceIds, `${prefix}.evidenceIds`);
    ids.add(entry?.id);
  }
  requireValue(
    ids.size === (entries ?? []).length,
    "fieldJudgment entry IDs must be unique",
  );

  const observationEntries = (entries ?? []).filter((entry) =>
    observationKinds.has(entry?.kind),
  );
  requireValue(
    observationEntries.length > 0,
    "fieldJudgment requires a firsthand observation or operator quote",
  );
  if (externalAudience) {
    requireValue(
      observationEntries.some((entry) => entry.customerSafe === true),
      "external readout requires a customer-safe firsthand observation or operator quote",
    );
  }

  if (phaseAtLeast(data.phase, "design")) {
    const rationaleEntries = (entries ?? []).filter(
      (entry) => entry?.kind === "decision-rationale",
    );
    requireValue(
      rationaleEntries.length > 0,
      "fieldJudgment requires a decision-rationale before design",
    );
    if (externalAudience) {
      requireValue(
        rationaleEntries.some((entry) => entry.customerSafe === true),
        "external readout requires a customer-safe decision-rationale",
      );
    }
  }

  const retrospective = data?.fieldJudgment?.retrospective;
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

  if (phaseAtLeast(data.phase, "handoff")) {
    requireValue(
      ["captured", "none-observed"].includes(retrospective?.status),
      "fieldJudgment.retrospective must be captured or none-observed at handoff",
    );
    requireValue(
      nonEmpty(retrospective?.reason),
      "fieldJudgment.retrospective.reason is required at handoff",
    );
    if (retrospective?.status === "captured") {
      const reflectionEntries = (entries ?? []).filter((entry) =>
        retrospectiveKinds.has(entry?.kind),
      );
      requireValue(
        reflectionEntries.length > 0,
        "captured retrospective requires a failed attempt, surprise, disagreement, or changed mind",
      );
      if (externalAudience) {
        requireValue(
          reflectionEntries.some((entry) => entry.customerSafe === true),
          "external readout requires customer-safe retrospective field judgment",
        );
      }
      validateEvidenceReferences(
        retrospective?.evidenceIds,
        "fieldJudgment.retrospective.evidenceIds",
      );
    }
  }

  return errors;
}
