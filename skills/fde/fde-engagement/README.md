# Forward deployed engineering (FDE) engagement skill

Use this Agent Skill to practice FDE judgment, conduct a customer engagement, review FDE work, or produce a decision-focused readout.

The skill first determines whether FDE is the right delivery model. For qualified work, it reconstructs the workflow from authorized evidence, questions decisions in dependency order, and blocks production recommendations until the applicable gates pass.

## Modes and scope

The skill supports four modes:

| Mode | Use it for |
|---|---|
| `coach` | Practice FDE judgment through scenarios, feedback, and revision |
| `engage` | Work through a real customer outcome using authorized evidence |
| `review` | Stress-test an engagement plan, artifact, architecture, or release |
| `report` | Create an evidence-bound customer, leadership, or handoff artifact |

It covers:

1. qualification and problem ledger;
2. workflow audit;
3. responsibility and system design;
4. production-shaped implementation;
5. evals and failure analysis;
6. deployment and adoption;
7. handoff, productization, and improvement.

## Concrete examples

Every decision question pairs a plain-language case sentence with a programmatic event, rule, payload, query, state transition, pseudocode fragment, interface, or test. Examples use case evidence or explicit placeholders; they do not invent metrics or choose architecture before the design gate.

## Human judgment is source material

Good writing requires more than the removal of AI tells. Removing em dashes, stock transitions, or tidy phrasing can improve hygiene while leaving the underlying artifact empty.

A human must contribute something the model could not infer:

- a firsthand observation;
- an operator detail that changed the diagnosis;
- a failed attempt;
- a surprise or disagreement;
- a consequential decision rationale;
- evidence that changed someone's mind.

AI can help with the blank page; the FDE supplies the opinion, experience, failure, and accountability.

| Agent responsibility | FDE responsibility |
|---|---|
| Retrieve authorized facts | Supply firsthand observations |
| Challenge contradictions | State interpretations and disagreements |
| Ask what is missing | Explain failed attempts and surprises |
| Organize supplied material | Own decision rationale |
| Test for generic claims | Approve customer-safe judgment |

Before a durable artifact, the agent records these contributions in `fieldJudgment`. Evidence and judgment remain separate: evidence describes what the sources support; judgment records what a named role concluded and why.

The agent must never invent a personal story, operator quote, disagreement, opinion, or changed mind to make writing feel human. If the human source material is missing, it asks for it before drafting.

Read [`references/human-judgment.md`](references/human-judgment.md) for the questions, ledger kinds, and artifact gate.

### Use a human-first editing loop

Peter Yang's [25/50/25 heuristic](https://creatoreconomy.so/p/use-my-no-ai-slop-skill-to-remove-20-ai-slop-patterns) gives the writing process a useful division of responsibility:

1. The FDE starts with rough observations, failed attempts, surprises, disagreement, and opinion.
2. The agent organizes the middle, checks evidence, tests alternatives, and drafts from approved source material.
3. The FDE verifies facts, restores natural voice, sharpens the opinion, and approves the result.

The percentages are a sequencing heuristic, not a word-count formula. The editing standard is the minimum effective change: protect specific facts and preserve the author's vocabulary, cadence, bluntness, humor, and uncertainty. See the [anti-slop writing standard](references/style-and-quality.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

## Install

Use the repository's canonical [30-second setup](../../../README.md#installation-30-second-setup).

The installed package must keep `SKILL.md`, `references/`, `assets/`, `scripts/`, and `evals/` together.

Customer-authored sources pass through `scripts/preflight-sources.mjs` before the agent reads them. The manifest reports hashes, line numbers, and rule IDs without echoing source text.

## Invoke

Agents may load the skill automatically from the request, or expose an explicit skill command. Invocation syntax varies by agent.

### Coach an FDE

```text
Teach me how to run FDE discovery. Give me a realistic exercise,
make me attempt it first, and critique my reasoning.
```

```text
Coach me through deciding what should be deterministic software,
model judgment, or a human decision in this workflow.
```

### Run an engagement

```text
Help me qualify whether this customer problem needs FDE.
I have attached the operator interview, workflow logs, and baseline metrics.
```

```text
Use the FDE skill to turn these observations into a current-state
operating map. Do not infer missing steps.
```

### Review work

```text
Review this FDE release decision. Test the eval evidence, autonomy level,
monitoring, human controls, rollback, and adoption plan.
```

```text
Stress-test this customer architecture for snowflakes, hero dependency,
and missing product-learning loops.
```

### Produce a report or presentation

```text
Create a customer findings report and PowerPoint readout from this FDE
case file. The decision is whether to begin a supervised pilot.
```

```text
Create the weekly FDE leadership update. Include engagement health,
product signals, delivery risks, decisions needed, and the next two weeks.
```

Report mode uses an evidence-approved readout brief, then renders one of the standard Markdown templates or a copy of `assets/fde-readout-template.pptx`. Customer and internal leadership content are filtered separately.

The renderer rejects named stock phrases and evidence-free claims. The deck procedure also requires visual inspection before delivery.

Before creating a deck, the skill builds an evidence-linked engagement profile covering the company, problem, stakeholders, systems, readout decision, and authorized brand treatment. Missing profile decisions enter the same three-question frontier used for the engagement.

## Presentation delivery

This skill produces the engagement profile, case evidence, readout brief, Markdown report, slide outline, and generic PowerPoint template.

Use the standalone `fde-readout` skill for synchronized interactive HTML and editable PowerPoint, reference-deck adaptation, deterministic slide-family planning, and presentation QA. `fde-engagement` does not require it and remains usable when it is not installed.

## Conversation protocol

The skill uses Challenge This with active domain modeling.

At a cold start, it asks for one decisive evidence package rather than presenting a long questionnaire. Once grounded, it builds a decision tree and asks at most three currently answerable **frontier** decisions per round.

Each decision question includes:

```text
Q7 - Decision title
Question

Recommendation: ...
Why: ...
Changes if: ...
```

Question numbers continue across rounds and are stored with their decision nodes. The agent states how many ready decisions remain, then waits for the FDE's answers. It records decisions, sharpens terminology, updates actors/systems/boundaries, checks contradictions, and recomputes the next frontier.

Dependent questions are delayed. For example, the meaning of “approve” must be settled before deciding whether an agent may approve.

## Behavior requirements

The skill should:

- ask before assuming;
- investigate facts available in files, code, logs, and tools;
- leave business decisions to the FDE;
- distinguish observations, reports, inferences, and synthetic examples;
- recommend a simpler operating model when FDE does not fit;
- block architecture until workflow evidence exists;
- block autonomy until eval, control, monitoring, and rollback evidence exists;
- separate customer-specific work from reusable product learning.

It should not:

- invent customer facts or metrics;
- turn a desired AI feature into proof that AI fits;
- issue a long intake questionnaire at the beginning;
- ask downstream questions before prerequisites are settled;
- treat an aggregate pass rate as production readiness;
- guarantee career readiness, compensation, or hiring.

## Use a case file

For substantial engagements, copy:

```text
assets/engagement-profile.template.json
assets/case-file.template.json
```

Use the copy as the shared record for:

- evidence and provenance;
- human observations, failures, surprises, disagreements, and rationale;
- customer, problem, stakeholder, system, and brand context;
- outcome contract;
- decision tree and current frontier;
- domain terms, actors, systems, boundaries, relationships, lifecycle state, and reconciliation;
- current and future workflows;
- architecture and controls;
- eval cases and results;
- deployment, adoption, and rollback;
- handoff and productization.

From the skill directory, validate the case file with Node.js 18 or newer:

```text
node scripts/validate-engagement-profile.mjs path/to/case-file.json path/to/engagement-profile.json
node scripts/validate-case-file.mjs path/to/case-file.json
```

A failed validation identifies incomplete structural gates. A pass does **not** prove that evidence is true, sufficient, or that the business decision is correct.

Node.js is optional for using the Markdown skill. It is needed only for deterministic case-file and package validation.

For reports and decks, also copy:

```text
assets/readout-brief.template.json
```

Validate the audience, evidence links, findings, recommendations, risks, and next steps:

```text
node scripts/validate-readout-brief.mjs path/to/case-file.json path/to/readout-brief.json
```

Render a standard Markdown report and/or slide outline:

```text
node scripts/render-readout.mjs path/to/case-file.json path/to/readout-brief.json path/to/readout.md
```

## Anti-slop checks

The renderer rejects stock AI phrasing, chatbot residue, rhetorical filler, punctuation theatrics, and unsupported superlatives. Run the same check directly:

```text
node scripts/lint-readout.mjs --profile report path/to/readout.md
```

`node scripts/test-package.mjs` also scans the skill's own Markdown with the documentation profile. The complete writing and visual standard is in `references/style-and-quality.md`.

## Data and safety

- Use only customer evidence you are authorized to access.
- Do not place customer data, credentials, or proprietary cases in this skill directory.
- Redact sensitive data from case files and learning artifacts.
- Do not send restricted data to an unapproved model or service.
- Keep consequential actions human-controlled until evidence supports bounded autonomy.
- Preserve auditability, recovery, rollback, and an accountable operating owner.

## Package structure

```text
fde-engagement/
├── SKILL.md
├── README.md
├── LICENSE
├── assets/
│   ├── case-file.template.json
│   ├── engagement-profile.template.json
│   ├── readout-brief.template.json
│   ├── fde-readout-template.pptx
│   └── templates/
├── evals/
│   ├── evals.json
│   ├── trigger-cases.json
│   └── files/
├── references/
│   ├── artifacts.md
│   ├── coaching-playbook.md
│   ├── domain-modeling.md
│   ├── engagement-profile.md
│   ├── human-judgment.md
│   ├── engagement-playbook.md
│   ├── evidence-and-safety.md
│   ├── challenge-this.md
│   ├── operating-model.md
│   ├── reporting.md
│   └── style-and-quality.md
└── scripts/
    ├── test-reporting.mjs
    ├── test-style.mjs
    ├── test-package.mjs
    ├── test-profile.mjs
    ├── test-validator.mjs
    ├── lint-readout.mjs
    ├── domain-model-lifecycle.mjs
    ├── readout-style.mjs
    ├── render-readout.mjs
    ├── validate-readout-brief.mjs
    ├── validate-engagement-profile.mjs
    └── validate-case-file.mjs
```

## Develop and evaluate

Run local package and validator checks:

```text
node scripts/test-package.mjs
```

Behavior evals live in `evals/evals.json`. Trigger and near-miss fixtures live in `evals/trigger-cases.json`; run them through each target agent because activation differs across models and harnesses.

## License

MIT. See [`LICENSE`](LICENSE).
