# Human judgment as source material

Read this file during audit, design, review, retrospective, and before any durable report or readout.

The goal is not to make AI output look less detectable. It is to preserve the human contribution that makes a forward deployed engineering (FDE) artifact worth reading and acting on.

## Two different source types

Keep these separate:

- **Evidence:** what was observed, recorded, reported, or measured.
- **Human judgment:** what a named role noticed, expected, tried, disagreed with, concluded, or changed their mind about.

Human judgment does not become fact because it is vivid. It still links to evidence and carries an author role, context, consequence, and customer-safety decision.

## Capture before drafting

Before asking AI to write a finding, recommendation, retrospective, or customer narrative, ask:

1. What did you see firsthand?
2. Which operator detail changed your understanding?
3. What did the team try that did not work?
4. What surprised you?
5. Where did credible people disagree?
6. Why did you choose this boundary or recommendation?
7. What evidence changed your mind?
8. Which part could only come from this engagement?

Do not ask all eight at once. Add unresolved questions to the decision frontier and ask no more than three per round.

## Ledger kinds

- `firsthand-observation`
- `operator-quote`
- `failed-attempt`
- `surprise`
- `disagreement`
- `decision-rationale`
- `changed-mind`

Each entry records:

- stable ID;
- kind;
- author role;
- origin: `human-provided` or `human-confirmed`;
- statement;
- observation or decision context;
- why it matters;
- evidence IDs;
- customer-safe flag.

## Responsibility split

The agent may:

- retrieve facts from authorized sources;
- challenge contradictions;
- ask for missing experience or rationale;
- organize supplied material;
- test whether an artifact could fit an unrelated engagement unchanged.

The agent must not:

- invent an anecdote, failure, opinion, disagreement, quote, or changed mind;
- imitate quirks to simulate a human voice;
- polish a generic draft and call it personal;
- convert one person's take into organizational fact;
- hide disagreement to make the story cleaner.

The FDE owns:

- firsthand observations;
- interpretations and opinions;
- rationale for consequential decisions;
- what changed after failure or new evidence;
- approval of customer-safe judgment.

## Artifact gate

Before a durable artifact:

- audit work has a firsthand observation or operator quote;
- design work has a decision rationale;
- a retrospective is captured or explicitly records that no material surprise was observed;
- evidence and judgment are labeled separately;
- customer output includes only customer-safe judgment;
- the artifact contains at least one detail that would not survive a customer-name swap.

Lexical linting remains useful hygiene. It cannot prove that a human contributed substance.
