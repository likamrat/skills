# Artifact guide

Read this file when creating, reviewing, or validating an engagement artifact.

## Engagement profile

Use `assets/engagement-profile.template.json` to record the minimum customer, problem, stakeholder, system, readout, and brand context needed for the engagement decision.

The profile references evidence in the case file. Validate the pair:

```text
node scripts/validate-engagement-profile.mjs path/to/case-file.json path/to/engagement-profile.json
```

Do not use the profile as a company encyclopedia. Every field must affect qualification, scope, design, risk, adoption, or the requested artifact.

## Case file

Use one case file as the engagement index. It links evidence, decisions, artifacts, gates, and unknowns. It is not a substitute for detailed source material.

Start with `assets/case-file.template.json`.

## Source intake

Before audit, record the approved source root, preflight manifest path and SHA-256, screening status, date, and human reviewer when review was required. The audit gate accepts only `clear` or `reviewed`; `pending` and `block` cannot advance.

The manifest is an index, not trusted content. It does not authorize network access, package installation, uploads, credentials, permission changes, production actions, or writes outside the engagement workspace.

## Problem ledger

Keep requests and problems separate in `problemLedger.entries`. This adapts Lalit Maganti's distinction between [problems and requested solutions](https://lalitm.com/post/find-problems-staff-engineer/).

| Field | Purpose |
|---|---|
| `requestedSolution` | What someone asked to build |
| `observedProblem` | What the evidence shows is difficult or costly |
| `affectedWorkflow` | Where the problem occurs |
| `workaround` | What people do today |
| `consequence` | Cost, delay, risk, quality, or user impact |
| `occurrences` | Independent contexts and evidence IDs |
| `commonShapeHypothesis` | Optional shared problem shape |
| `counterexample` | Evidence that would split the shape |
| `uncertainty`, `consequenceLevel`, `reversibility` | Pressure-test inputs |
| `disposition` | `observe`, `act-now`, `prototype`, `invest`, `park`, or `stop` |
| `rationale` | Why that disposition fits now |

One request is enough to record a problem, not enough to generalize it. A common-shape hypothesis requires at least two occurrences and a counterexample.

## Field judgment

Evidence records what a source supports. Field judgment records the human contribution built from that evidence.

```json
{
  "id": "judgment-rationale-001",
  "kind": "decision-rationale",
  "authorRole": "FDE",
  "origin": "human-confirmed",
  "statement": "The pilot remains recommendation-only because the evidence does not support transferring queue authority.",
  "context": "Responsibility allocation review",
  "whyItMatters": "The design follows the observed authority boundary.",
  "evidenceIds": ["policy-007", "eval-014"],
  "customerSafe": true
}
```

Do not turn the ledger into marketing color. Capture only supplied observation, experience, and rationale. See `references/human-judgment.md`.

## Gate snapshot

The case file records the current phase gate:

```json
{
  "status": "blocked",
  "reason": "The written authorization policy is unavailable",
  "evidenceIds": ["policy-request-004"]
}
```

Status is `open`, `blocked`, `ready`, or `passed`. Reports must copy this snapshot rather than inventing a more favorable status.

`validate-case-file.mjs` succeeds only when the current gate is `passed`. A blocked case is still a valid reporting source, but it is not ready to advance.

## Assignments

Named owners and dates in reports must come from a case-file assignment:

```json
{
  "id": "assign-policy",
  "subject": "Supply the written authorization policy",
  "owner": "Claims operations lead",
  "timing": "2026-08-27",
  "evidenceIds": ["meeting-009"]
}
```

If no assignment exists, reports use `Unassigned` and `Not scheduled`.

## Evidence ledger

Each record needs:

| Field | Meaning |
|---|---|
| ID | Stable reference |
| Statement | Atomic observation or claim |
| Class | `direct_observation`, `system_record`, `stakeholder_report`, `first_party_public`, `secondhand`, `inference`, `synthetic`, or `recommendation` |
| Source | Person, system, file, URL, or session |
| Observed at | Date and context |
| Confidence | `high`, `medium`, or `low` |
| Disproof | Evidence that would overturn it |
| Sensitivity | Public, internal, confidential, restricted |
| Authorized | Whether this evidence may be used for the stated engagement |

Never merge several claims with different provenance into one record.

## Outcome contract

```text
Business outcome:
Decision or workflow affected:
Baseline and source:
Target and time horizon:
Executive sponsor:
Daily operator:
Technical/operating owner:
Users affected:
Value mechanism:
Non-goals:
Constraints:
Stop conditions:
```

Separate projected value from realized value.

## Decision tree

The tree records the decisions surfaced through Challenge This.

```json
{
  "id": "qualify-fit",
  "branch": "engagement-fit",
  "questionNumber": 1,
  "question": "Does this outcome require embedded engineering?",
  "prerequisites": [],
  "evidenceNeeded": ["Observed policy exceptions"],
  "evidenceReady": true,
  "recommendation": "Use standard implementation unless hidden workflow complexity is evidenced",
  "exampleKind": "rule",
  "exampleStatus": "evidence-backed",
  "concreteExample": "Plain language: Standard implementation fits when operators use no undocumented policy exceptions. Programmatic: if undocumented_policy_exceptions == 0 then route = standard_implementation",
  "status": "settled",
  "answer": "FDE is required because policy decisions exist only in operator practice",
  "deferredReason": "",
  "deferredOwner": "",
  "evidenceIds": ["obs-014", "log-022"],
  "reopenIf": "The undocumented policy rules are removed from the workflow"
}
```

`status` is `open`, `settled`, or `deferred`. `questionNumber` is assigned when the question is first asked and never reused. `nextQuestionNumber` is the next unused integer. Asked nodes also record `exampleKind`, `exampleStatus`, and `concreteExample`. The example contains labeled `Plain language` and `Programmatic` forms. Illustrative examples use placeholders and remain visibly illustrative.

The `frontier` array contains every currently answerable node, including nodes held for a later round. A round records one to three asked nodes:

```json
{
  "id": "round-1",
  "status": "answered",
  "nodeIds": ["qualify-fit"]
}
```

Round status is `active` or `answered`. A node with a question number appears in exactly one round. A phase gate requires its frontier to be empty; deferred nodes need a reason and revisit condition.

## Domain model

The active domain model prevents the interview from building on ambiguous language.

### Actor

```json
{
  "id": "actor-claims-adjuster",
  "lifecycle": "active",
  "lastVerifiedAt": "2026-08-23",
  "lifecycleReason": "Verified against the observed workflow",
  "supersededBy": "",
  "name": "Claims adjuster",
  "responsibility": "Recommends claim disposition",
  "authority": "Cannot authorize payments above the threshold",
  "incentivesAndRisks": "Balances resolution time against loss risk",
  "workflowParticipation": "Reviews evidence and recommends a disposition",
  "evidenceIds": ["interview-003"]
}
```

### System

```json
{
  "id": "system-claims-ledger",
  "lifecycle": "active",
  "lastVerifiedAt": "2026-08-23",
  "lifecycleReason": "Verified against the current schema",
  "supersededBy": "",
  "name": "Claims ledger",
  "role": "Records final claim disposition",
  "sourceOfTruth": true,
  "owner": "Claims operations",
  "dataRead": ["Claim evidence"],
  "dataWritten": ["Final disposition"],
  "knownDrift": ["A personal queue export may be stale"],
  "evidenceIds": ["schema-002"]
}
```

### Boundary

```json
{
  "id": "boundary-payment-authorization",
  "lifecycle": "active",
  "lastVerifiedAt": "2026-08-23",
  "lifecycleReason": "Verified against the authorization policy",
  "supersededBy": "",
  "name": "Payment authorization",
  "inside": "Recommendation and evidence assembly",
  "outside": "Final transfer execution",
  "owner": "Finance controller",
  "crossingMechanism": "Signed payment instruction",
  "evidenceIds": ["policy-007"]
}
```

### Relationship

```json
{
  "id": "relationship-adjuster-recommends-disposition",
  "lifecycle": "active",
  "lastVerifiedAt": "2026-08-23",
  "lifecycleReason": "Verified against workflow events",
  "supersededBy": "",
  "subject": "Claims adjuster",
  "verb": "recommends",
  "object": "Claim disposition",
  "evidenceIds": ["interview-003"]
}
```

Terms use the same lifecycle fields plus `term`, `definition`, `avoid`, `examples`, and `evidenceIds`. Conflicts remain explicit until resolved; do not silently normalize them.

The model records its last complete reconciliation:

```json
{
  "status": "current",
  "asOf": "2026-08-23",
  "reason": "Reconciled after the authorization policy review",
  "evidenceIds": ["policy-007"]
}
```

Entries use lifecycle `active`, `stale`, or `superseded`. A superseded entry remains in history and points to an active replacement through `supersededBy`. Design gates and reports fail while any entry is stale or reconciliation is not current.

A conflict uses:

```json
{
  "description": "The interview says adjusters approve; the ledger records manager authorization",
  "status": "deferred",
  "evidenceIds": ["interview-003", "ledger-014"],
  "resolution": "",
  "owner": "Claims operations lead",
  "revisitWhen": "The authorization policy is supplied"
}
```

## Operating map

For each current-state step:

```text
Step:
Actor:
Trigger:
Inputs:
Systems and source of truth:
Action or decision:
Deterministic rules:
Tacit judgment:
Exceptions and workarounds:
Approval or permission:
Wait time:
Failure and consequence:
Evidence IDs:
Unknowns:
```

Include shadow systems, manual copies, re-keying, queues, and informal approvals.

The case-file JSON shape is:

```json
{
  "name": "Validate supplier record",
  "actor": "Accounts-payable analyst",
  "trigger": "New invoice is received",
  "system": "ERP and supplier registry",
  "exceptions": ["Supplier name does not match the registry"],
  "failures": ["Payment is sent to the wrong entity"],
  "evidenceIds": ["obs-014", "log-022"]
}
```

## Future-state responsibility matrix

| Step | Assignment | Owner | Why | Inputs | Output schema | Tools/permission | Invariants | Human control | Failure modes | Recovery | Audit event |
|---|---|---|---|---|---|---|---|---|---|---|---|

Assignment is `deterministic`, `model`, `human`, or `hybrid`.

The case-file JSON shape is:

```json
{
  "name": "Extract invoice fields",
  "assignment": "hybrid",
  "owner": "Accounts-payable lead",
  "reason": "Formats vary, but payment authority remains human",
  "failureModes": ["Wrong supplier", "Missing tax amount"],
  "recovery": "Block submission and route the source document to review"
}
```

## Architecture and control plan

```text
System boundary:
Existing systems retained:
Integrations:
Identity and least privilege:
Data classification and residency:
Model and deterministic components:
State and memory:
Observability:
Timeout/retry/idempotency:
Escalation:
Rollback/kill switch:
Operating owner:
```

## Eval plan and report

### Plan

```text
Decision the eval supports:
Risk basis:
Case cohorts:
Source and labeling process:
Output rubric:
Trajectory checks:
Deterministic invariants:
Permission/tool checks:
Escalation cases:
Cost/latency limits:
Release criteria:
```

The case-file JSON uses structured cases:

```json
{
  "id": "case-high-risk-01",
  "cohort": "high-risk",
  "expectedBehavior": "Block the action and route it to an authorized reviewer",
  "consequence": "An incorrect action could release funds",
  "evidenceIds": ["record-041"]
}
```

Required cohorts are `normal`, `edge`, `incomplete`, `ambiguous`, and `high-risk`. Add adversarial, permission, outage, and affected-population cohorts when the risk requires them.

### Report

```text
Version and environment:
Cases run:
Results by cohort:
Failure categories:
Severe failures:
Regressions:
Human-review burden:
Cost and latency:
Residual risk:
Release recommendation:
Evidence gaps:
```

Each case needs a result with `caseId`, an `outcome` of `pass`, `fail`, or `escalated`, and the observed evidence. Record unresolved severe failures separately; deployment is blocked until that list is empty or the scope is changed so the failure is no longer reachable.

Never report only an aggregate pass rate.

## Deployment and adoption plan

```text
Current autonomy stage:
Stage evidence IDs:
Production cohort:
Go/no-go owner:
Identity and permissions review:
Monitoring and alerts:
Human review/override:
Rollback test:
Incident path:
Operator training:
Adoption hypothesis:
Adoption and outcome measures:
Support window:
Expansion condition:
```

## Handoff package

```text
Operating owner acceptance:
Runbook:
Architecture/data-flow map:
Eval suite:
Known limitations:
Permissions/credentials:
Dashboards/alerts:
Incident and escalation path:
Rollback/recovery:
Maintenance and upgrade plan:
Training completed:
Realized outcomes:
Next-loop decision:
Open risks:
Re-engagement criteria:
```

Next-loop decisions are `improve`, `expand`, `productize`, `hold`, `reduce-autonomy`, or `retire`.

## Reusable-learning ledger

| Component or learning | Classification | Customer evidence | Repetition evidence | Maintenance owner | Product owner | Decision |
|---|---|---|---|---|---|---|

Classifications:

- existing shared primitive;
- new reusable primitive;
- customer configuration;
- customer-only customization;
- product candidate;
- rejected generalization.

## Case study

A credible case study includes:

1. problem and baseline;
2. real current-state workflow;
3. qualification and alternatives;
4. selected scope and non-goals;
5. responsibility allocation;
6. architecture and controls;
7. eval evidence and failures;
8. rollout and adoption;
9. realized outcome and operating cost;
10. handoff;
11. reusable learning;
12. unknowns and what the team would change.

Do not write a success narrative that erases failures or unmeasured claims.
