const collections = [
  "terms",
  "actors",
  "systems",
  "boundaries",
  "relationships",
];

const lifecycles = new Set(["active", "stale", "superseded"]);
const realEvidenceClasses = new Set([
  "direct_observation",
  "system_record",
  "stakeholder_report",
]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function dateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? "");
}

function evidenceReferences(
  ids,
  prefix,
  evidenceById,
  requireAuthorizedReal,
  errors,
) {
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.some((id) => !nonEmpty(id))
  ) {
    errors.push(`${prefix} requires supporting evidence IDs`);
    return;
  }

  for (const id of ids) {
    const evidence = evidenceById.get(id);
    if (!evidence) {
      errors.push(`${prefix} references unknown evidence: ${id}`);
    } else if (
      requireAuthorizedReal &&
      !(
        evidence.authorized === true &&
        realEvidenceClasses.has(evidence.class)
      )
    ) {
      errors.push(`${prefix} requires authorized real evidence: ${id}`);
    }
  }
}

export function validateDomainModelLifecycle(
  domainModel,
  evidenceById,
  { requireAuthorizedReal = false, requiredAsOf = null } = {},
) {
  const errors = [];
  const entries = [];

  for (const collection of collections) {
    if (!Array.isArray(domainModel?.[collection])) {
      errors.push(`domainModel.${collection} must be an array`);
      continue;
    }

    for (const [index, entry] of domainModel[collection].entries()) {
      const prefix = `domainModel.${collection}[${index}]`;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry?.id ?? "")) {
        errors.push(`${prefix}.id must use lowercase kebab-case`);
      }
      if (!lifecycles.has(entry?.lifecycle)) {
        errors.push(
          `${prefix}.lifecycle must be active, stale, or superseded`,
        );
      }
      if (!dateOnly(entry?.lastVerifiedAt)) {
        errors.push(`${prefix}.lastVerifiedAt must use YYYY-MM-DD`);
      }
      if (!nonEmpty(entry?.lifecycleReason)) {
        errors.push(`${prefix}.lifecycleReason is required`);
      }
      if (entry?.lifecycle === "superseded") {
        if (!nonEmpty(entry?.supersededBy)) {
          errors.push(`${prefix}.supersededBy is required`);
        }
      } else if (entry?.supersededBy !== "") {
        errors.push(
          `${prefix}.supersededBy must be empty unless lifecycle is superseded`,
        );
      }
      evidenceReferences(
        entry?.evidenceIds,
        `${prefix}.evidenceIds`,
        evidenceById,
        requireAuthorizedReal,
        errors,
      );
      entries.push(entry);
    }
  }

  const ids = entries.map((entry) => entry?.id);
  if (new Set(ids).size !== ids.length) {
    errors.push("domain model entry IDs must be unique");
  }

  const entryById = new Map(entries.map((entry) => [entry?.id, entry]));
  for (const entry of entries) {
    if (entry?.lifecycle === "stale") {
      errors.push(`domain model entry cannot remain stale: ${entry.id}`);
    }
    if (entry?.lifecycle === "superseded") {
      const replacement = entryById.get(entry.supersededBy);
      if (!replacement) {
        errors.push(
          `domain model entry ${entry.id} references unknown replacement: ${entry.supersededBy}`,
        );
      } else if (replacement.lifecycle !== "active") {
        errors.push(
          `domain model replacement must be active: ${entry.supersededBy}`,
        );
      }
    }
  }

  const reconciliation = domainModel?.reconciliation;
  if (reconciliation?.status !== "current") {
    errors.push("domainModel.reconciliation.status must be current");
  }
  if (!dateOnly(reconciliation?.asOf)) {
    errors.push("domainModel.reconciliation.asOf must use YYYY-MM-DD");
  }
  if (requiredAsOf && reconciliation?.asOf !== requiredAsOf) {
    errors.push(
      `domainModel.reconciliation.asOf must match the readout as-of date: ${requiredAsOf}`,
    );
  }
  if (!nonEmpty(reconciliation?.reason)) {
    errors.push("domainModel.reconciliation.reason is required");
  }
  if (dateOnly(reconciliation?.asOf)) {
    for (const entry of entries) {
      if (
        dateOnly(entry?.lastVerifiedAt) &&
        entry.lastVerifiedAt > reconciliation.asOf
      ) {
        errors.push(
          `domain model entry ${entry.id} was verified after the recorded reconciliation`,
        );
      }
    }
  }
  evidenceReferences(
    reconciliation?.evidenceIds,
    "domainModel.reconciliation.evidenceIds",
    evidenceById,
    requireAuthorizedReal,
    errors,
  );

  return errors;
}
