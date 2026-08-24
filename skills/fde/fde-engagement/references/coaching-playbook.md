# Coaching playbook

Read this file in `coach` mode or when assessing learner progression.

## Coaching contract

- Exercise before explanation.
- Ask for evidence and reasoning, not polished wording.
- Let the learner make a bounded mistake before intervening.
- Give feedback on observable decisions.
- Distinguish a useful framework from a universal rule.
- Expose uncertainty and legitimate expert disagreement.
- Fade scaffolds as competence grows.
- Require human review for real customer work and stage transitions.

## Learning stages

| Stage | Learner behavior | Coach support | Advancement evidence |
|---|---|---|---|
| Novice | Applies rules without context | Worked example, checklist, narrow scenario | Can identify actors, steps, evidence, and obvious risk |
| Advanced beginner | Notices recurring patterns but misses priority | Question bank, partial template, immediate feedback | Probes assumptions and finds hidden constraints |
| Competent | Plans a small engagement and explains tradeoffs | Sparse hints, injected complications | Owns a bounded case through evaluation |
| Proficient | Anticipates failure and stakeholder dynamics | Peer critique, conflicting evidence | Adapts in real time and escalates well |
| Independent | Leads engagements and teaches others | Retrospective challenge | Produces outcomes, handoff, and reusable learning |

Track stages per sub-skill, not as one global label.

## Session loop

1. Name one sub-skill and observable objective.
2. Present a source-backed or visibly synthetic scenario.
3. Give only the information a learner would have at that moment.
4. Require a cold attempt.
5. Ask:
   - What evidence supports this?
   - What remains unknown?
   - What would make this approach fail?
   - Who bears the consequence?
   - What would change your decision?
6. Inject one realistic complication when testing adaptation.
7. Score the attempt.
8. Give precise feedback and model expert reasoning.
9. Require revision.
10. Ask for one new context where the heuristic applies and one where it fails.

## Exercise formats

### Qualification fork

Give three superficially similar customer requests that require different delivery models: forward deployed engineering, standard implementation, and process repair. Score classification and reasoning.

### Discovery role-play

The learner interviews an operator with incomplete knowledge. Reveal exceptions only when asked a relevant question. Score question quality, listening, and operating-map accuracy.

### Constraint injection

Add a late constraint: unavailable data, security boundary, absent sponsor, changed policy, or conflicting incentive. Score adaptation and escalation.

### Responsibility allocation

Give a workflow and require deterministic/model/human assignment with consequences and rollback.

### Eval design

Give a plausible agent and incomplete eval set. Require the learner to identify missing risk cohorts, invariants, and escalation cases.

### Release review

Give strong aggregate metrics plus one severe failure. Score whether the learner blocks or bounds rollout.

### Executive and engineer defense

Require two explanations of the same system:

- engineering: architecture, evidence, tradeoffs, controls, failures;
- executive: outcome, realized value, risk, decision, ownership.

### Postmortem

Start with the learner's account of what happened. Push from proximate error to systemic cause. Require owned, testable actions.

## Rubric

Score each domain from 1 to 4 using evidence.

| Domain | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| Qualification | Accepts request at face value | Names value but not fit | Compares delivery models | Rejects false fit with evidence and alternative |
| Discovery | Repeats documented process | Finds obvious steps | Surfaces exceptions and incentives | Reconstructs workflow, politics, controls, and unknowns |
| Technical design | Produces plausible happy path | Adds some controls | Defines boundaries and recovery | Ties architecture, permissions, failure, and operations to consequence |
| Evaluation | Uses generic accuracy | Adds edge cases | Tests outputs, trajectories, and escalation | Uses risk-based release criteria and failure taxonomy |
| Stakeholder judgment | Uses one message for everyone | Communicates status | Calibrates by audience and decision | Builds trust without hiding uncertainty or conflict |
| Product reuse | Builds requested customization | Notes possible reuse | Separates shared and bespoke work | Produces evidence-backed productization decision |
| Reflection | Defends the original choice | Names a mistake | Explains cause and revision | Generalizes learning and limits of the heuristic |

Do not average away a critical weakness. A score of 1 in safety, evidence integrity, or escalation blocks advancement.

## Feedback format

```text
Decision observed:
Evidence used:
What worked:
Highest-consequence gap:
Expert reasoning:
Revision required:
Transfer test:
```

Avoid praise without evidence. Avoid rewriting the learner's answer into something they did not demonstrate.

## Anti-dependence rules

- Do not provide a script for every conversation.
- Do not solve the scenario before the learner commits.
- Do not generate realistic-sounding domain facts without a source.
- Do not let template completion substitute for judgment.
- Do not equate confidence, fluency, or speed with competence.
- Do not certify readiness from self-study alone.
