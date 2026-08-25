# Forward deployed engineering (FDE) grilling protocol

Read this file for any decision-bearing coaching, engagement, or review conversation.

The purpose is not to ask many questions. It is to expose every decision that would otherwise remain an assumption, in the order those decisions become answerable.

## Build a design tree

Represent each decision as a node with:

- ID and branch;
- persistent question number once asked;
- question;
- prerequisite node IDs;
- evidence needed;
- current recommendation and rationale;
- status: `open`, `settled`, or `deferred`;
- the FDE's answer;
- evidence IDs;
- what would reopen it.

Typical root branches are:

- outcome and engagement fit;
- actors, language, and incentives;
- current workflow and exceptions;
- systems, data, identity, and constraints;
- responsibility allocation and architecture;
- evals, failure, and escalation;
- deployment, adoption, and ownership;
- economics, handoff, and product reuse.

Create only branches relevant to the current decision. Do not turn the list into a fixed questionnaire.

## Compute the frontier

The **frontier** is every open decision whose prerequisites are settled and whose required facts are available.

Before asking:

1. Resolve facts available from authorized files, tools, logs, code, and public sources.
2. Add their evidence IDs to the tree.
3. Leave downstream decisions blocked until those facts arrive.
4. Recompute the frontier.

Facts are the agent's responsibility to investigate when access exists. Decisions remain the FDE's responsibility.

## Cold-start exception

If no real workflow evidence exists, do not ask a broad round. Request one representative evidence package that unlocks the tree, such as:

- an end-to-end normal case plus exceptions;
- a shadowing session;
- a workflow log and operator interview;
- the current architecture and incident history.

State which artifact or decision the evidence will unlock. Do not preview the solution.

A stakeholder claim, log, artifact, explicit proposal, or contradiction is grounding. Use it to ask the relevant frontier question instead of repeatedly requesting a larger evidence package.

## Run rounds

Once grounded:

1. Rank the ready frontier by gate impact, consequence, and reversibility.
2. Ask at most three independent decisions in one round.
3. Do not ask a question whose answer depends on another question still open in that round.
4. Assign each asked node the next unused question number. Never reset numbering during the engagement.
5. Explain why each decision is on the frontier now.
6. Give a recommendation with rationale and tradeoff.
7. Add one case-specific example with a plain-language sentence and the smallest useful programmatic form: event formula, rule, payload, query, state transition, pseudocode, interface, or test.
8. Offer bounded choices when they clarify the decision.
9. Name evidence or constraints that could change the recommendation.
10. State how many ready decisions remain without previewing or answering them.
11. Wait for all answers before recomputing the tree.

Do not combine independent decisions to evade the three-question limit. Unasked ready nodes remain on the frontier for the next round.

A frontier response without at least one explicit `Q#` question is invalid. Use `Q1 - <title>` with an ASCII hyphen, never an em dash. Each question must include the labels `Recommendation`, `Concrete example`, `Why`, and `Changes if`.

Choose the example type that makes the decision observable:

- outcome or metric: event pair, formula, query, or assertion;
- workflow or responsibility: rule, state transition, payload, or invariant;
- evaluation: input, expected result, and pass condition;
- architecture after the design gate: interface or pseudocode.

Before the design gate, do not use the example to choose a framework, vendor, component, or deployment pattern. If evidence does not supply a field, event, value, or threshold, mark the example `Illustrative` and use an explicit placeholder.

Do not replace the current decision with a dependent one. Settle an event boundary before asking for a numeric target; settle authority language before asking what an agent may do.

Do not join a prerequisite and its dependent decision with "and."

```text
Bad: What does "approve" mean, and may the agent approve?
Good: Does "approve" mean recommend a disposition or authorize payment?
Blocked until answered: whether the agent may take either action.
```

End the response after the final `Changes if` line. Wait for the FDE; do not add a conclusion, artifact, or next-gate action.

## Round format

```text
Frontier: <branch or phase> | Asking <count> of <ready count>

Q7 - <decision title>
<question and only the context needed to answer it>

Recommendation: <recommended answer>
Concrete example (<kind>, <evidence-backed|illustrative>):
Plain language: <what happens in this case>
Programmatic: <one to five lines>
Why: <evidence and tradeoff>
Changes if: <fact or constraint that would change the recommendation>

---

Q8 - <decision title>
...
```

Example:

```text
Concrete example (event, evidence-backed):
Plain language: A claim leaves queue time when the final queue assignment event is recorded.
Programmatic: queue_time_ms = final_queue_assignment.at - email_received.at; baseline_ms = Unknown
```

Do not present recommendations as predetermined answers. Surface disagreement and update when the FDE provides better evidence.

## After every answer

1. Record the answer and evidence.
2. Mark the node `settled` or `deferred` with a reason.
3. Update the domain model immediately.
4. Surface contradictions with prior answers, artifacts, code, or system evidence.
5. If the FDE answered only part of the round, keep the unanswered questions on the current frontier and ask for them; do not expose downstream questions yet.
6. Preserve each node's question number and set `nextQuestionNumber` to the next unused integer.
7. After the whole round is answered, add newly revealed branches and recompute the frontier.

Do not silently reconcile contradictions.

## Completion

The interview is ready to advance only when:

- the required frontier for the current phase is empty;
- deferred decisions have owners and revisit conditions;
- terms and boundaries are consistent;
- the FDE confirms the shared understanding;
- the phase artifact and gate evidence agree with the decisions.

Do not implement merely because a round ended.
