# Active FDE domain modeling

Read this file alongside `grilling.md`. The domain model is updated during the conversation, not reconstructed after it.

## Purpose

Ambiguous customer language can hide different concepts, responsibilities, systems, or incentives. Build a shared model precise enough that operators, engineers, and executives use each consequential term consistently.

The case file is the canonical record.

## Model five things

### Terms

For each domain-specific term record:

- stable ID;
- canonical term;
- one- or two-sentence definition;
- avoided synonyms or overloaded words;
- boundary examples and counterexamples;
- evidence IDs.

Do not add generic technical vocabulary.

### Actors

Record:

- stable ID;
- name or role;
- responsibility and decision authority;
- incentives and risks;
- workflow participation;
- evidence IDs.

Distinguish sponsor, operator, reviewer, approver, system owner, and affected user.

### Systems

Record:

- stable ID;
- system name;
- role in the workflow;
- source-of-truth status;
- owner;
- data read and written;
- known drift or shadow copies;
- evidence IDs.

### Boundaries

Record:

- stable ID;
- what is inside and outside the engagement;
- data, permission, policy, and organizational boundary;
- boundary owner;
- crossing mechanism;
- evidence IDs.

### Relationships

Give each relationship a stable ID. Record how terms, actors, systems, and boundaries interact. Prefer explicit verbs:

- Adjuster **recommends** a payment.
- Manager **authorizes** payments above the threshold.
- Claims ledger **records** the final decision.

Avoid vague links such as "handles" or "is involved with."

## Maintain lifecycle state

Every term, actor, system, boundary, and relationship has a lifecycle:

- `active`: checked against current evidence and eligible for decisions;
- `stale`: a change trigger occurred and the entry needs verification;
- `superseded`: retained for history but replaced by another active entry.

Record `lastVerifiedAt`, evidence IDs, and the reason for the lifecycle state. A superseded entry also names `supersededBy`. Do not overwrite history to make the model look consistent.

Mark affected entries stale when:

- new evidence conflicts with an entry;
- policy, schema, code, workflow, authority, or ownership changes;
- an eval exposes a missing boundary;
- the engagement moves from audit to design;
- a report is requested with a later as-of date.

Before design or reporting:

1. identify evidence added since the last reconciliation;
2. mark affected entries stale before resolving them;
3. verify, revise, or supersede each affected entry;
4. confirm every superseded entry points to an active replacement;
5. record the reconciliation date, reason, and evidence IDs;
6. mark reconciliation `current` only when no stale entry remains.

Freshness is change-triggered and evidence-backed, not a claim that recent text must be correct.

## Challenge language in real time

When the FDE uses a vague or conflicting term:

1. quote the conflicting meanings;
2. propose a canonical distinction;
3. give a concrete edge case where the distinction matters;
4. ask the FDE to settle it;
5. update the model immediately.

The proposed canonical term is a recommendation, not a resolution. Add the conflict as its own decision-tree node. Do not group it with dependent authority, architecture, or scope questions; block those until the FDE confirms or defers the meaning.

Examples:

- Does "customer" mean the contracted organization, the operator, or the person affected by the decision?
- Is "approval" a recommendation, authorization, or execution?
- Is the spreadsheet a report, queue, database, workflow engine, or all four?
- Does "automated" mean drafted, recommended, executed, or executed without review?

## Cross-check the model

Compare statements with:

- workflow observations;
- system records and schemas;
- code and API behavior;
- policies and contracts;
- prior decisions;
- eval cases.

Surface disagreement directly. Do not prefer the cleanest story.

## Stress-test with scenarios

Use concrete cases to expose missing boundaries:

- normal case;
- exception;
- missing information;
- conflicting records;
- absent approver;
- policy change;
- high-consequence action;
- system outage;
- customer-specific requirement that may or may not generalize.

Ask which actor decides, which system records the result, and what happens next.

## Decision discipline

Record decisions in the design tree when they:

- select among real alternatives;
- define a boundary or owner;
- change risk, scope, or product reuse;
- are hard to reverse or surprising without context.

Do not turn every clarification into a permanent decision.

## Track conflicts

Do not store conflicts as loose notes. Record:

- description;
- status: `resolved` or `deferred`;
- supporting evidence IDs;
- resolution, when resolved;
- owner and revisit condition, when deferred.

An unresolved conflict cannot disappear merely because the interview moves to another branch.

## Completion check

Before advancing a phase:

- canonical terms have one meaning;
- actors' authority is explicit;
- sources of truth and shadow systems are named;
- engagement and permission boundaries are visible;
- important relationships use precise verbs;
- contradictions are resolved or deliberately deferred;
- no entry needed by the next gate is stale;
- the domain model reconciliation is current;
- each model entry traces to evidence.
