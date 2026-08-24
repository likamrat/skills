# Evaluating and evolving skills

A skill can be valid, concise, and well tested on disk while still failing to improve an agent. This repository keeps readiness and effectiveness separate.

## Two different scorecards

| Scorecard | Question | Output |
|---|---|---|
| Static readiness | Is the skill packaged, scoped, testable, and economical to load? | `0-100` from `npm run score:skills` |
| Empirical effectiveness | Does the skill activate correctly and improve real task outcomes? | Trigger rates, assertion deltas, human preference, consistency, time, and tokens |

Never present the readiness score as proof that a skill works. Effectiveness requires fresh agent runs.

## Static readiness

The readiness score is deterministic:

| Dimension | Weight | What it checks |
|---|---:|---|
| Specification and package | 15 | Frontmatter, license, README, package test, and eval files |
| Activation readiness | 20 | Imperative description, explicit boundary, and balanced trigger cases |
| Behavior eval readiness | 20 | Realistic prompts, expected outputs, unique IDs, and verifiable assertions |
| Deterministic verification | 15 | Package tests, validators, and regression scripts |
| Progressive disclosure | 20 | Core token cost, line count, focused references, and valid contextual links |
| Evolution evidence | 10 | Version, trigger set, behavior set, benchmark, and recorded history |

Run:

```bash
npm run score:skills
```

The token count is an approximation based on UTF-8 bytes. Use it to spot large changes, not as a billing estimate.

## Trigger evaluation

Trigger tests answer whether the skill loads for the right request.

1. Keep about 20 realistic cases with a balanced mix of positive cases and near-miss negatives.
2. Run each case in a fresh session with only the target skill available.
3. Use three trials per case because activation is nondeterministic.
4. A positive case passes when its trigger rate is above `0.5`.
5. A negative case passes when its trigger rate is below `0.5`.
6. Use targeted cases while editing the description, then rerun the full fixed set.
7. Keep some cases out of the editing loop when optimizing a description so wording does not overfit the known prompts.

Run a one-trial smoke check:

```bash
npm run eval:triggers -- --skill fde-readout --runs 1 --model gpt-5.6-sol
```

Run the three-trial benchmark:

```bash
npm run eval:triggers -- --skill fde-readout --runs 3 --model gpt-5.6-sol --output skills/fde/fde-readout/evals/history/trigger-iteration-N.json
```

The runner creates an isolated project and home directory, installs only the target project skill, restricts tools to skill loading, disables unrelated Model Context Protocol (MCP) servers, records JSON traces, and removes the workspace afterward.

## Output evaluation

Activation is necessary but insufficient. Test the work produced after activation:

1. Run each behavior case with the candidate skill in a fresh session.
2. Run the same case with the previous skill version or with no skill.
3. Use at least three trials for behavior that varies materially.
4. Grade mechanical assertions with scripts.
5. Use a model grader only for a written rubric that cannot be checked deterministically.
6. Review candidate and baseline outputs blind when presentation, writing, or judgment quality matters.
7. Record concrete evidence for every pass or failure.
8. Capture tokens, duration, tool calls, and final artifacts.

Report these measures separately:

- assertion pass-rate delta versus the baseline;
- safety and hard-stop regressions;
- human preference;
- `pass@k` when one successful attempt is enough;
- `pass^k` when every attempt must succeed;
- token and duration delta;
- unresolved qualitative feedback.

A single weighted number would hide these tradeoffs, so the empirical scorecard remains a vector.

## Evolution loop

1. Record one failure or improvement hypothesis.
2. Keep the current Git commit as the baseline.
3. Run the relevant trigger and behavior cases before editing.
4. Make one coherent change.
5. Run the failed cases first for fast feedback.
6. Run the complete trigger and behavior regression sets.
7. Compare candidate and baseline outputs, cost, and consistency.
8. Ask a human to review the cases where judgment or visual quality matters.
9. Accept the change only when it fixes the target failure without a safety or regression loss.
10. Record the summary under `evals/history/`, update the skill version, and commit the change.

Keep raw customer inputs, full transcripts, and sensitive artifacts outside the repository. Commit only synthetic fixtures and safe summary results.

## Release gates

A skill change can ship when:

- repository and package checks pass;
- every regression trigger case passes its rate threshold;
- behavior assertions do not regress;
- no safety, evidence, privacy, or authorization rule regresses;
- any extra token or time cost buys a visible quality improvement;
- human review has no blocking feedback;
- the skill still installs and runs as a self-contained package.

## Current baseline

| Skill | Readiness | Empirical evidence | Core size | Trigger cases | Behavior cases |
|---|---:|---|---|---:|---:|
| `fde-engagement` | 94 | Not measured | 205 lines, about 3,364 tokens | 12 positive, 9 negative | 21 cases, 108 assertions |
| `fde-readout` | 98 | Activation only | 205 lines, about 2,450 tokens | 10 positive, 10 negative | 5 cases, 19 assertions |

The engagement core was reduced from about 4,900 to 3,364 tokens by removing detail already available through contextual references. The readout trigger set was expanded from 10 to 20 cases before description tuning.

## Sources

- [Agent Skills specification](https://agentskills.io/specification.md)
- [Best practices for skill creators](https://agentskills.io/skill-creation/best-practices.md)
- [Optimizing skill descriptions](https://agentskills.io/skill-creation/optimizing-descriptions.md)
- [Evaluating skill output quality](https://agentskills.io/skill-creation/evaluating-skills.md)
- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
