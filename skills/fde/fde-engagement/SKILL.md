---
name: fde-engagement
description: >-
  Run or practice the forward deployed engineering (FDE) delivery lifecycle itself, from qualification through handoff. Use when working on customer discovery, workflow audits, evals, rollout, adoption, handoff, or written engagement reports.
license: MIT
compatibility: Works in conversational agents. File and shell tools are optional. Node.js 18+ is required only for the included validators. Real engagements require authorized customer evidence.
metadata:
  author: likamrat
  version: "0.1.0"
---

# Forward deployed engineering (FDE) engagement

Determine whether a customer problem warrants FDE, carry qualified work through production and handoff, and record evidence that may apply beyond one customer.

Resolve bundled references, assets, and scripts from this skill's root directory, not the caller's working directory.

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
| Create a non-presentation customer report, leadership update, or handoff report | `report` | Select the audience and decision, then build an evidence-approved readout brief |

If a written lifecycle artifact is requested, prefer `report`. Route slides, decks, HTML, PowerPoint, and `ReadoutPlan` work to `fde-readout`. If an artifact is supplied for critique, prefer `review`. If the user is learning, prefer `coach`. Otherwise use `engage`.

## Question decisions and maintain the domain model

Load only the reference needed for the current condition:

- read [references/grilling.md](references/grilling.md) when unresolved decisions require questioning;
- read [references/domain-modeling.md](references/domain-modeling.md) when terminology, boundaries, or shared vocabulary must be reconciled;
- read [references/human-judgment.md](references/human-judgment.md) before durable narrative, design rationale, retrospective, or review of the human layer.

Ask at most three independent frontier questions whose prerequisites are settled. Each uses `Q#`, `Recommendation`, `Why`, and `Changes if`. Record each answer, reconcile the domain model, recompute the frontier, and wait. Terminology or boundary conflicts block dependent authority, architecture, and scope decisions.

## Establish only the context needed now

Identify the likely delivery model, lifecycle phase, decision needed now, available authorized evidence, and consequence of a wrong recommendation. At a cold start, request one decisive evidence package. If the prompt supplies only a desired technology or feature, return `not qualified yet`, explain why, request one piece of workflow evidence, and do not preview architecture or tools.

## Run the FDE fit gate

Before recommending an engagement, read [references/operating-model.md](references/operating-model.md).

Test outcome and baseline, relative technical complexity, need for embedded engineering, reusable value beyond one customer, and identifiable sponsor, operator, value, and owner. Return one verdict from the operating-model reference and explain it. If the verdict is not `FDE`, stop this lifecycle and route the work to the simpler owner and artifact.

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

For substantial `engage` or `report` work, read [references/engagement-profile.md](references/engagement-profile.md) and create `assets/engagement-profile.template.json`. For a supplied-artifact review, assess the artifact against available evidence and mark unavailable gate evidence; create persistent files only when the user is continuing an ongoing engagement.

Investigate authorized facts before asking the FDE to repeat them. Put unresolved company, problem, authority, system, audience, and brand decisions on the same decision tree.

Validate it against the case evidence:

```text
node scripts/validate-engagement-profile.mjs path/to/case-file.json path/to/engagement-profile.json
```

Do not produce a branded deck while profile questions remain open or brand use lacks a recorded source and approval.

## Use one working case file

For substantial ongoing engagement work, copy [assets/case-file.template.json](assets/case-file.template.json) and update it as evidence changes. A supplied-artifact review is read-only unless the user asks to continue the engagement.

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

Read [references/evidence-and-safety.md](references/evidence-and-safety.md) for evidence classes, consequential-claim provenance, privacy rules, and production stops.

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
12. At handoff, state concrete re-engagement triggers and one next observe-and-improve decision with measurable reopen conditions; field names or disposition labels alone do not satisfy this gate.

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

Presentation design, interactive HTML, editable PowerPoint, reference-deck adaptation, and presentation QA belong to `fde-readout`. The bundled workflow here produces non-presentation reports and a Markdown slide outline only when the specialized skill is unavailable:

1. Validate the engagement profile, case file, field judgment, audience, confidentiality, and as-of date.
2. Use only named source material and approved evidence IDs. Reporting does not advance a phase gate.
3. Build `assets/readout-brief.template.json`; keep findings, inference, recommendations, decisions, and next steps separate.
4. Validate with `scripts/validate-readout-brief.mjs`, then render with `scripts/render-readout.mjs`.
5. Read [references/style-and-quality.md](references/style-and-quality.md), lint the rendered text, and inspect every slide.
6. Use `Unknown`, `Unassigned`, or `Not yet measured` instead of inventing workflow, metrics, owners, or dates.
7. Fail delivery when a consequential finding lacks `[evidence-id]`, a next step lacks `Owner` or `Due`, or customer output contains internal-only material.

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
