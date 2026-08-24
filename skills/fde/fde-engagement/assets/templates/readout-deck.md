# FDE readout deck

> Reference structure only. Generate the final slide outline with `scripts/render-readout.mjs`.

Use 8-12 slides. Remove slides that do not support the decision.

## Slide 1: {{Engagement name}}

{{Customer or internal audience}}

{{As-of date}}

{{Confidentiality}}

## Slide 2: {{Recommended decision in one sentence}}

- Outcome
- Current phase and gate
- Highest-consequence finding `[evidence IDs]`
- Recommendation
- Decision owner and date

## Slide 3: {{Outcome and scope assertion}}

- Baseline, source, and observation period
- Target and time horizon
- Users and accountable owner
- In scope and out of scope

## Slide 4: {{What the current workflow reveals}}

- Current-state workflow
- Exceptions and shadow systems
- Bottleneck and failure cost
- Open unknowns

## Slide 5: {{Three to five evidence-backed findings}}

For each:

- atomic finding `[evidence IDs]`;
- consequence;
- confidence.

## Slide 6: {{How responsibility should change}}

Include only at `design` or later. At `audit`, replace this slide with **What blocks design**.

- Deterministic software
- Model judgment
- Human decisions
- Permissions, escalation, and recovery
- What remains unchanged

## Slide 7: {{What the eval evidence supports}}

Include only at `evaluate` or later. Otherwise state the eval gate and evidence still required.

- Case cohorts
- Results by cohort
- Failure categories
- Severe failures
- Cost, latency, and review burden
- Release recommendation

## Slide 8: {{Current deployment and adoption position}}

Include only at `deploy` or later. Otherwise omit.

- Autonomy stage
- Production cohort
- Monitoring and human controls
- Rollback evidence
- Adoption signal
- Operating owner

## Slide 9: {{Highest risks and controls}}

- Risk, impact, control, residual risk, owner
- Stop or escalation trigger

## Slide 10: {{Decisions and next steps}}

| Action or decision | Recommendation | Owner | Due | Status | Dependency | Definition of done | Evidence |
|---|---|---|---|---|---|---|---|
| {{Action or decision}} | {{Recommendation}} | {{Owner or Unassigned}} | {{Date or Not scheduled}} | {{Status}} | {{Dependency}} | {{Observable result}} | {{Evidence IDs}} |

## Slide 11: Internal product and leadership signals

**INTERNAL ONLY - DELETE FROM CUSTOMER DECK**

- Engagement health
- Product and reuse signals
- Delivery economics and maintenance burden
- Resource or escalation request
- Necessary customer-sensitive context

## Slide 12: Evidence register and appendix

- Evidence ID, source, class, date, confidence, customer-safe status
- Unknowns and deferred decisions
- Method
