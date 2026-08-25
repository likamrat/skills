# Engagement playbook

Read this file when running or reviewing a real engagement. Each phase produces evidence for the next. Missing evidence blocks advancement.

## Phase 1: Qualify

### Purpose

Determine whether the outcome warrants embedded engineering and whether forward deployed engineering (FDE) is the right operating model.

### Actions

1. Name the business decision or workflow that must improve.
2. Record the requested solution separately from the observed problem, workaround, consequence, and first occurrence.
3. Record the current baseline, source, and observation period.
4. Identify the executive sponsor, daily operator, technical owner, and affected users.
5. Estimate value as revenue, cost, risk, time, quality, or mission impact.
6. Identify technical complexity, customer implementation capacity, and platform reuse.
7. List security, privacy, compliance, procurement, and timeline constraints.
8. Compare FDE with standard implementation, services, product work, process repair, and no build.

### Gate

Advance only when outcome, baseline, sponsor, operator, value, constraints, and likely owner are concrete enough to test.

### Common failure

Treating executive excitement, a model demo, or a large budget as qualification.

## Phase 2: Audit

### Purpose

Reconstruct the real workflow.

### Evidence order

Prefer:

1. direct observation and screen-sharing;
2. real resolved cases and system records;
3. operator interviews;
4. logs, emails, spreadsheets, tickets, and approvals;
5. SOPs and policy documents.

Documents describe intended work. Operators and systems reveal actual work.

Add each independently observed occurrence to the problem ledger. Do not convert one request into a project merely because its requester is vocal.

### Map every step

For each step capture:

- trigger and actor;
- input, output, and system of record;
- transformation or decision;
- deterministic rule;
- judgment or tacit knowledge;
- exception and workaround;
- approval and permission;
- wait time and queue;
- failure mode and consequence;
- evidence source and confidence.

Also record shadow systems, duplicate records, stale copies, manual re-keying, and personal tools.

### Required sampling

Inspect multiple:

- normal cases;
- edge cases;
- incomplete-input cases;
- ambiguous cases;
- high-consequence cases;
- known failures.

Do not infer the workflow from one polished example.

### Gate

Advance when operators agree the current-state map is recognizable, material exceptions are represented, and unknowns are explicit.

## Phase 3: Design

### Purpose

Choose what should change and assign responsibility safely.

### Responsibility allocation

For each future-state step choose:

- `deterministic`: stable rules, calculation, validation, routing, or transaction;
- `model`: unstructured interpretation or probabilistic judgment;
- `human`: accountability, high-consequence decision, novel exception, or relationship work;
- `hybrid`: model proposes; deterministic checks and a person approves.

Record why, expected error, reversibility, permission, escalation, and audit event.

### Design sequence

1. Remove unnecessary steps before automating them.
2. Preserve systems of record unless replacement has a justified migration plan.
3. Build the smallest end-to-end outcome slice.
4. Define schemas and deterministic business invariants.
5. Bound tools, data access, memory, and action authority.
6. Design failure, timeout, duplicate, partial-completion, and recovery paths.
7. Define user-visible verification and override.
8. Separate existing platform primitives, new reusable primitives, and customer-only work.

### Gate

Advance when every consequential action has an owner, control, failure path, and rollback strategy.

## Phase 4: Build

### Purpose

Build a narrow end-to-end implementation against real or representative interfaces.

### Required characteristics

- real interface or representative contract at each boundary;
- least-privilege identity and permissions;
- idempotency or duplicate protection where needed;
- structured inputs and outputs;
- complete trace of prompts, model responses, tool calls, decisions, errors, and latency;
- explicit timeout, retry, compensation, and resume behavior;
- feature flag, kill switch, or isolation boundary;
- testable rollback;
- named maintenance owner.

Use deterministic code for fixed operations. Use models only where probabilistic capability earns its cost and risk.

### Gate

Advance when the slice can fail visibly, recover safely, and run against authorized representative data.

## Phase 5: Evaluate

### Purpose

Collect the evidence needed for a release decision.

### Build the eval set

Derive cases from authorized, resolved work. Size the set by workflow diversity, consequence, and desired confidence; never use a universal case-count rule.

Include:

- common cases;
- rare but costly cases;
- incomplete and conflicting inputs;
- adversarial or abusive inputs where relevant;
- permission and tool failures;
- timeout, retry, and duplicate scenarios;
- policy and business-rule boundaries;
- cases that must escalate.

### Evaluate more than the final answer

Test:

- correct source data;
- required and forbidden steps;
- deterministic invariants;
- expert agreement or rubric;
- tool selection and permissions;
- citations or evidence;
- safe-to-act decision;
- escalation behavior;
- latency, cost, and human-review burden;
- regression against prior versions.

### Report failures

For every failure record:

- category;
- severity and consequence;
- affected cohort;
- reproducibility;
- likely cause;
- mitigation;
- owner;
- release impact.

An aggregate pass rate never overrides a severe unresolved failure.

### Gate

Advance when release criteria are tied to risk, failure categories are understood, and escalation contains residual uncertainty.

## Phase 6: Deploy and adopt

### Purpose

Make the system reliable and usable inside the business.

### Autonomy ladder

1. offline replay;
2. shadow mode;
3. recommendation with human decision;
4. supervised action;
5. bounded autonomous action;
6. broader autonomy only after measured evidence.

### Release requirements

- production identity, data boundaries, and access review;
- dashboards for outcome, quality, cost, latency, errors, and escalations;
- alert routing and incident owner;
- tested rollback and recovery;
- human override and user-visible evidence;
- support path and operational hours;
- training for operators and reviewers;
- adoption hypothesis and measurement;
- staged cohort and go/no-go owner.

Technical success does not imply adoption. Observe whether the design changes user workload, trust, incentives, and accountability.

### Gate

Advance when the operating owner accepts the controls, users can verify the system, and production evidence supports the current autonomy level.

## Phase 7: Handoff and productize

### Purpose

Transfer operations and decide which field work remains customer-specific, can be reused, or should be proposed to product.

### Handoff package

- architecture and data-flow map;
- deployment and rollback procedure;
- dashboards, alerts, and incident path;
- permissions and credential ownership;
- eval suite and known failure modes;
- operating limits and escalation rules;
- maintenance and upgrade plan;
- user and owner training;
- open risks and decisions;
- support and re-engagement conditions with observable triggers, responsible owner, and response;
- next observe-and-improve decision with measurable reopen conditions.

### Reuse review

Classify each component:

- existing shared primitive;
- new reusable primitive;
- customer-specific configuration;
- customer-only customization;
- candidate product capability;
- rejected generalization.

For each candidate, record repetition evidence, expected maintenance or delivery benefit, product owner, migration path, and decision date.

Do not generalize from one implementation. Require evidence from distinct engagements before naming a reusable interface or capability.

Treat a common shape as a hypothesis. Record at least one counterexample that would show the problems need different solutions.

Pressure-test each retained problem and choose one disposition: `observe`, `act-now`, `prototype`, `invest`, `park`, or `stop`. Record uncertainty, consequence, reversibility, repeated demand, and rationale.

### Observe and improve

Compare realized outcomes with baseline and projection. Record adoption, failures, operating cost, maintenance burden, and user work displaced or created. Decide:

- improve the current system;
- expand to a related workflow;
- productize;
- hold;
- reduce autonomy;
- retire.

Record the decision and reopen the relevant phase when more work is approved.
