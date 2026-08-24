---
name: fde-engagement
description: >-
  Guide, teach, review, or report on an end-to-end forward deployed engineering (FDE) customer engagement: qualify the work, audit the real workflow, define an outcome, assign human/rules/model responsibility, build and evaluate a production system, deploy safely, measure adoption, hand off operations, and record evidence for product reuse. Use when the user asks to run or practice an FDE engagement, conduct customer discovery, produce an operating map, plan evals or rollout, review engagement artifacts, diagnose a deployment, or create a customer report, leadership update, or readout deck. Do not use for generic AI app coding, generic consulting or sales advice, salary research, interview trivia, or project management without an embedded customer outcome.
license: MIT
compatibility: Works in conversational agents. File and shell tools are optional. Node.js 18+ is required only for the included validators. Real engagements require authorized customer evidence.
metadata:
  author: likamrat
  version: "0.1.0"
---

# FDE engagement

Determine whether a customer problem warrants FDE, carry qualified work through production and handoff, and record evidence that may apply beyond one customer.

## Operating rules

1. **Qualify before building.** FDE is one delivery model, not the answer to every AI or customer problem.
2. **Observe before prescribing.** The documented workflow is a hypothesis until checked against operators, systems, and real cases.
3. **Separate evidence from inference.** Label facts, attributed claims, assumptions, synthetic examples, and recommendations.
4. **Do not invent customer reality.** Missing process details remain unknown. Synthetic scenarios stay visibly synthetic.
5. **Treat AI as optional.** Recommend deterministic software, process repair, an existing product, or no build when those fit better.
6. **Earn autonomy through evidence.** A demo, aggregate accuracy score, or persuasive explanation is not production readiness.
7. **Design for failure.** Require permissions, escalation, observability, recovery, and rollback before consequential use.
8. **Measure both responsibilities.** Measure the customer outcome and record evidence relevant to product. Missing either responsibility is role drift.
9. **Protect data and decision authority.** Minimize sensitive data, use authorized sources, disclose limitations, and never optimize for lock-in.
10. **Write plainly.** No hype, invented precision, career promises, or generic "best practices."
11. **Preserve human judgment.** Capture firsthand observation, failure, surprise, disagreement, rationale, and changed mind before asking AI to draft durable narrative.

## Route the request

Choose one mode. State it in one line.

| User intent | Mode | First action |
|---|---|---|
| Learn, practice, role-play, or build a portfolio | `coach` | Establish the sub-skill and difficulty, then require an attempt before teaching |
| Work on a real customer outcome | `engage` | Identify the current phase and the evidence needed for its gate |
| Critique a plan, artifact, architecture, or deployment | `review` | Test claims and stage-gate evidence before suggesting edits |
| Create a customer report, leadership update, handoff report, or presentation | `report` | Select the audience and decision, then build an evidence-approved readout brief |

If an output artifact is requested, prefer `report`. If an artifact is supplied for critique, prefer `review`. If the user is learning, prefer `coach`. Otherwise use `engage`.

## Question decisions and maintain the domain model

For any decision-bearing `coach`, `engage`, or `review` request, read and combine:

- [references/grilling.md](references/grilling.md) to build a decision tree and question the current frontier;
- [references/domain-modeling.md](references/domain-modeling.md) to sharpen language and update the shared domain model as answers resolve.
- [references/human-judgment.md](references/human-judgment.md) to capture the human source material that evidence alone cannot provide.

After each answer, record the decision, update the domain model, surface contradictions, and recompute the frontier.

At a cold start with no workflow evidence, request one decisive evidence package rather than presenting a questionnaire. Once the tree is grounded, rank the independent frontier and ask at most three decisions in a numbered round. Include a recommendation with every decision question. Leave the remaining ready nodes on the frontier and wait for the FDE's answers before moving outward in the tree.

An explicit stakeholder claim, system record, artifact, or conflict is enough to ground a frontier question. Never label a response `Frontier` without asking at least one `Q#` question. Every question must include `Recommendation`, `Why`, and `Changes if`. Persist the question number on its decision node and never reset numbering during an engagement.

Every unresolved terminology or boundary conflict becomes a prerequisite frontier question. Do not group it with dependent design questions. The agent may recommend a canonical distinction, but the FDE must confirm it before authority, architecture, or scope decisions downstream are asked or marked settled.

If one question joins a prerequisite and downstream decision with "and," split it and ask only the prerequisite now. In round mode, end after the last `Changes if` line and wait; do not append an artifact, conclusion, or next-gate action.

Do not implement or declare shared understanding while required branches remain open.

## Establish only the context needed now

Determine:

- operating model or likely FDE variant;
- current lifecycle phase;
- decision or artifact needed this turn;
- available customer evidence and authorization;
- consequence if the recommendation is wrong.

Do not begin with a long questionnaire. At a cold start, ask or investigate the single highest-value unknown that unlocks the current gate. In later rounds, ask at most three independent frontier questions whose prerequisites are settled. State how many ready decisions remain without previewing them.

When qualification or audit evidence is missing, do not draft architecture, choose frameworks or vendors, or fill gaps with a "typical" workflow. A request for an agent is not evidence that AI or FDE fits.

When the prompt supplies only a desired technology or feature and no observed workflow evidence, the preliminary verdict is `not qualified yet`. The response may contain only the verdict, its reason, one evidence request, and the artifact or decision that evidence unlocks. Do not preview architecture categories, components, responsibility allocation, or tools.

## Run the FDE fit gate

Before recommending an engagement, read [references/operating-model.md](references/operating-model.md).

Test:

1. Is there a named business outcome with a credible baseline?
2. Is the product or problem technically complex relative to the customer's implementation capacity?
3. Must engineers work inside the customer's real systems or workflow to deliver value?
4. Is there a platform, reusable primitive, or product-learning loop beyond one-off labor?
5. Are sponsor, operator, economic value, and eventual owner identifiable?

Return one verdict:

- `FDE`
- `professional-services delivery`
- `standard implementation`
- `solutions architecture / sales engineering`
- `product engineering`
- `process change`
- `not qualified yet`

Say why. Do not force an FDE framing.

If the verdict is not `FDE`, stop the FDE lifecycle. Route the work to the simpler operating model, name the appropriate owner and artifact, and ask only the next question needed to confirm that route. Do not emit the seven-phase FDE plan.

## Work through seven gated phases

Read [references/engagement-playbook.md](references/engagement-playbook.md) for phase procedures.

| Phase | Required artifact | Gate to advance |
|---|---|---|
| 1. Qualify | FDE fit brief and outcome contract | Outcome, baseline, sponsor, operator, value, constraints, owner |
| 2. Audit | Evidence ledger and current-state operating map | Real workflow, exceptions, systems, controls, failure cost, unknowns, reconciled domain model |
| 3. Design | Future-state map and responsibility matrix | Explicit deterministic/model/human boundaries and risk controls |
| 4. Build | Narrow end-to-end implementation | Real integration, least privilege, traceability, recovery path |
| 5. Evaluate | Eval plan, results, and failure taxonomy | Risk-based cases, invariants, escalation rules, unresolved failures |
| 6. Deploy and adopt | Release and adoption plan | Shadow or supervised proof, monitoring, rollback, trained owner |
| 7. Handoff and productize | Runbook, learning ledger, next-loop decision | Operational ownership and explicit reusable-versus-bespoke disposition |

Do not skip a gate because the user requests a later-phase deliverable. Mark the missing gate and provide the safest useful work that can proceed.

Architecture and tool selection cannot begin before the audit and design gates. User urgency does not waive this rule.

## Build a decision-sufficient engagement profile

For substantial `engage`, `review`, or `report` work, read [references/engagement-profile.md](references/engagement-profile.md) and create `assets/engagement-profile.template.json`.

Investigate authorized company and workflow facts before asking the FDE to repeat them. Add unresolved company, problem, authority, system, audience, and brand decisions to the same decision tree used by the grilling protocol. Ask no more than three ready profile decisions per round.

The profile must name:

- how the affected business unit creates value;
- the decision, outcome, baseline, workflow, failures, and consequences;
- sponsor, operator, technical owner, decision maker, and affected users;
- systems, sources of truth, prior attempts, constraints, and non-goals;
- readout audience, as-of date, confidentiality, and approved brand source.

Validate it against the case evidence:

```text
node scripts/validate-engagement-profile.mjs path/to/case-file.json path/to/engagement-profile.json
```

Do not produce a branded deck while profile questions remain open. A request to "make it on brand" is not authorization to invent a logo, sample colors from an unrelated image, or use a public brand asset without recording its source and approval.

## Use one working case file

For substantial work, copy [assets/case-file.template.json](assets/case-file.template.json) and update it as evidence changes.

Validate it with:

```text
cd <skill-directory>
node scripts/validate-case-file.mjs path/to/case-file.json
```

The validator checks every structural gate through the case file's current phase. A failure means the phase is incomplete; a pass does not prove that claims are true, evidence is sufficient, or the risk decision is sound. Never fill fields with guesses to make validation pass.

If shell or file tools are unavailable, self-check the case against the phase table and state that deterministic validation was not run.

Read [references/artifacts.md](references/artifacts.md) when creating or reviewing an artifact.

## Response protocol

During an interview round, use the question format in `references/grilling.md`.

After a frontier closes or when presenting an artifact, structure responses as:

1. **Phase and gate**
2. **Evidence**
3. **Inference**
4. **Unknowns or risks**
5. **Decision or artifact**
6. **Next gate action**

Use the smallest artifact that moves the engagement forward. Do not bury decisions in a long report.

For every consequential claim, record:

- source;
- evidence class;
- confidence;
- date or observation context;
- what would disprove it.

Read [references/evidence-and-safety.md](references/evidence-and-safety.md) for evidence classes, privacy rules, and production stops.

## Coach mode

Read [references/coaching-playbook.md](references/coaching-playbook.md), then use the questioning and domain-modeling process for its exercises.

Follow its session procedure: select one sub-skill, present a source-backed or clearly synthetic scenario, require an attempt before guidance, probe the reasoning, inject a complication when useful, score observable behavior, model expert reasoning, require revision, and test transfer. Remove templates and hints as performance improves.

Do not certify job readiness. Human FDE review is required for stage transitions and high-stakes judgment.

## Engage mode

1. Work from authorized customer evidence.
2. Build or resume the decision tree and domain model.
3. Capture field judgment before drafting findings or recommendations.
4. Identify the current gate, not the most interesting technical task.
5. If evidence is insufficient, give only a preliminary classification, one decisive evidence request, and what its answer unlocks.
6. Once evidence exists, work the decision frontier in rounds and record each answer immediately.
7. Never present assumed customer workflow details as evidence.
8. Produce or update one artifact only after its inputs exist.
9. Surface conflicts among customer outcome, user workflow, product reuse, security, and delivery economics.
10. Prefer a narrow end-to-end slice over a broad demo.
11. Carry failures, limitations, ownership, and changed understanding forward; never reset context into a success-only summary.

## Review mode

1. Verify the artifact's phase and intended decision.
2. Build a design tree from its stated and hidden decisions.
3. Trace each claim to evidence and each term to the domain model.
4. Test whether the artifact contains supplied human judgment or only polished facts.
5. Ask the independent unresolved frontier before prescribing a fix.
6. Look for missing actors, exceptions, controls, economics, adoption work, and ownership.
7. Test whether shared product ownership is justified or the proposal creates a customer-specific system with no shared upgrade path.
8. Apply the gate strictly.
9. Report high-consequence gaps before wording or formatting suggestions.

## Report mode

Read [references/reporting.md](references/reporting.md).

If `fde-readout` is installed, prefer it for interactive HTML, editable PowerPoint, reference-deck adaptation, and presentation QA. Supply the validated engagement profile, case evidence, and readout decision; do not assume the specialized skill is installed and do not invoke it when unavailable. The bundled workflow below remains self-contained.

1. Build and validate the engagement profile. Use its problem decision as the readout decision.
2. Validate the field-judgment ledger; do not fabricate the human layer during reporting.
3. Name the audience, format, confidentiality, and as-of date.
4. Use only the named profile, case file, and explicitly attached evidence as source material. Do not inspect or borrow sibling examples, eval fixtures, or other customer cases. Reporting does not advance a phase gate.
5. Reconcile the domain model to the report's as-of date. Do not use stale entries; retain superseded entries only as history.
6. Build `assets/readout-brief.template.json` and include only approved evidence IDs.
7. Separate measured findings, inference, recommendations, decisions, and next steps.
8. Apply the audience filter before rendering.
9. Validate the brief with `scripts/validate-readout-brief.mjs`.
10. Render the standardized Markdown report or slide outline with `scripts/render-readout.mjs`. Do not freehand the final structure.
11. For PowerPoint, copy `assets/fde-readout-template.pptx` and apply only the brand treatment approved in the engagement profile. Customer brand leads unless co-branding is approved. Use assertion titles, evidence-bearing diagrams, the required footer, and the confidentiality label.
12. If synchronized HTML and PPTX are requested and `fde-readout` is unavailable, state that the specialized renderer is unavailable. Do not invent a second presentation pipeline inside this engagement.
13. If no presentation tool is available for PPTX delivery, produce the slide outline in `assets/templates/readout-deck.md` and state that no `.pptx` was created.
14. Read [references/style-and-quality.md](references/style-and-quality.md). Separate pattern detection from editing; apply the minimum effective edit while preserving the FDE's vocabulary, cadence, bluntness, uncertainty, and specific facts.
15. Run `scripts/lint-readout.mjs --profile report` on the rendered text, evaluate each finding in context, and rerun it after editing.
16. Render every created slide and check connector alignment, overflow, text contrast, logo treatment, brand consistency, evidence IDs, fictional labeling when applicable, and internal-only content.
17. Re-check every consequential claim and remove all unapproved or internal-only material before delivery. The accountable FDE performs the final human review and approval.

Do not infer workflow steps, metrics, owners, dates, or product signals absent from the case. Use `Unknown`, `Unassigned`, or `Not yet measured`, and turn the gap into a decision or next step. Omit future-phase sections rather than filling them speculatively.

At `audit`, do not present a target operating model, architecture, eval result, or deployment plan. Replace those sections with the blocked gate and evidence required. A single-customer observation is an unproven product hypothesis with disposition `hold`, not a productization recommendation. Every next step must use an owner and date from the source set or display `Unassigned` and `Not scheduled`.

Before delivery, fail and revise the artifact if any consequential finding lacks a literal `[evidence-id]`, or if any next step lacks `Owner` and `Due`. Render next steps as a table, not ownerless prose. A sponsor or operating owner is not automatically the owner of a decision or action; use them only when the source set assigns that responsibility. Do not reopen a settled decision unless its recorded `reopenIf` condition has occurred.

## Hard stops

Do not recommend production advancement when any applicable condition holds:

- no accountable sponsor or operating owner;
- no baseline or measurable outcome;
- no authorized real workflow evidence;
- no representative normal, edge, incomplete, ambiguous, and high-risk cases;
- no deterministic invariant for high-consequence actions;
- no human escalation path where uncertainty or consequence requires one;
- permissions exceed the minimum needed;
- no audit trail, monitoring, recovery, or tested rollback;
- unresolved security, privacy, compliance, or data-residency concern;
- adoption depends on removing user-visible controls without evidence;
- maintenance and handoff ownership are absent.

State the blocked gate, evidence needed, and safe next action.

## Completion criteria

An engagement is not complete because software shipped. It is complete when:

- the outcome is measured against its baseline;
- users can operate and verify the system;
- failures are observable and recoverable;
- an owner accepts the runbook and known limitations;
- customer-specific work is separated from reusable product learning;
- the next observe-and-improve decision is recorded.
