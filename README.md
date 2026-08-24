# Skills To Do Work

[![skills.sh](https://skills.sh/b/likamrat/skills?v=1)](https://skills.sh/likamrat/skills)

I am building the Agent Skills I want beside me when a decision has an owner, a customer, and a cost of failure.

I have little use for output that only looks finished. A polished report can still hide a guessed workflow, missing evidence, unclear authority, and a system nobody knows how to operate.

These skills make the agent show its work: inspect source material, ask unresolved questions, keep judgment separate from evidence, test failure cases, and produce artifacts tied to a decision. I can read every instruction, disagree with it, and change it.

Use them, challenge them, and adapt them to your work. Keep the person making the decision accountable.

## Installation (30-second setup)

Install a named skill with the open [`skills`](https://github.com/vercel-labs/skills) CLI. This example installs `fde-engagement`:

```bash
npx skills@latest add likamrat/skills --skill fde-engagement
```

The installer detects your supported agents and asks where to install the skill.

For a non-interactive GitHub Copilot project install:

```bash
npx skills@latest add likamrat/skills --skill fde-engagement --agent github-copilot -y
```

Then ask your agent:

```text
Use fde-engagement to qualify this customer problem.
Start by asking for the smallest evidence package that unlocks the decision.
```

No additional project setup is required.

Installation commands live in this section. Skill READMEs link here instead of copying commands that can drift.

## Why these skills exist

### The agent starts building before the workflow is understood

A plausible architecture is easy to produce from a clean problem statement. Customer work rarely arrives that way. Operators disagree, systems record only part of the process, exceptions carry the risk, and the requested solution may solve the wrong problem.

[`fde-engagement`](skills/fde/fde-engagement/README.md) starts with fit, outcome, baseline, operators, evidence, and constraints. It blocks architecture work until the current workflow and responsibility boundaries are explicit.

### Polished prose fills gaps that a person should answer

An agent can make weak evidence sound settled. It can also invent the opinion, rationale, or confidence that gives a report its voice.

The forward deployed engineering (FDE) skills keep evidence and human judgment separate. Missing owners, dates, metrics, and decisions remain visible instead of being smoothed into a finished-looking artifact.

### HTML and PowerPoint become different stories

Separate presentation workflows drift. Numbers change, recommendations move, and one format receives fixes that the other never gets.

[`fde-readout`](skills/fde/fde-readout/README.md) uses one validated plan for both formats. The plan carries the decision, evidence, human context, brand, slide structure, and speaker notes; each renderer still receives its own visual and package review.

## Skills

### Forward deployed engineering (FDE)

| Skill | Use it for |
|---|---|
| [`fde-engagement`](skills/fde/fde-engagement/README.md) | Run, teach, review, or report on an end-to-end FDE engagement |
| [`fde-readout`](skills/fde/fde-readout/README.md) | Build evidence-bound FDE readouts as HTML, PowerPoint, or both |

## How skills are tested

Each change is checked for package validity, activation accuracy, output behavior, regressions, and instruction cost. Static readiness and actual effectiveness are reported separately.

See [how skills are evaluated and evolved](docs/skill-evolution.md) for the scorecard, fresh-session test loop, and release gates.

## More install options

Preview the repository without installing:

```bash
npx skills@latest add likamrat/skills --list
```

Select every skill, then choose the target agents:

```bash
npx skills@latest add likamrat/skills --skill '*' --agent github-copilot -y
```

Install to a user-level directory:

```bash
npx skills@latest add likamrat/skills --skill fde-engagement --global --agent github-copilot -y
```

Use the skill for one session without installing it:

```bash
npx skills@latest use likamrat/skills --skill fde-engagement
```

Update installed skills:

```bash
npx skills@latest update --project -y
```

## Repository structure

```text
.
├── drafts/
│   └── README.md
└── skills/
    └── fde/
        ├── fde-engagement/
        │   ├── SKILL.md
        │   ├── README.md
        │   ├── assets/
        │   ├── evals/
        │   ├── references/
        │   └── scripts/
        └── fde-readout/
            ├── SKILL.md
            ├── README.md
            ├── assets/
            ├── evals/
            ├── references/
            └── scripts/
```

Each installable skill has a `SKILL.md` whose `name` matches its directory. Categories may contain multiple skills.

`skills/` contains installable packages. Work in `drafts/` uses `SKILL.draft.md` so the installer does not discover it.

## skills.sh

This repository follows the [Agent Skills specification](https://agentskills.io/specification.md) and is discoverable by the `skills` CLI.

`skills.sh` builds its listings and rankings from anonymous CLI install telemetry. Direct CLI discovery reads the public GitHub repository, while the catalog page and badge depend on a separate asynchronous index.

Verify the repository directly with `npx skills@latest add likamrat/skills --list`. The catalog and badge use [`skills.sh/likamrat/skills`](https://skills.sh/likamrat/skills).

## Quality and safety

Every skill must:

- use concise trigger language and realistic near-miss cases;
- keep core instructions concise and disclose references only when needed;
- include behavior and near-miss evals;
- validate any deterministic artifact or gate it creates;
- keep end-user installation commands in this README only;
- describe present behavior and inventory instead of promised additions or launch language;
- name actors, evidence, actions, controls, and consequences instead of using branding metaphors;
- expand domain-specific acronyms on first use;
- use periods, commas, colons, or parentheses instead of em dashes;
- avoid customer data, credentials, and proprietary examples;
- distinguish observed evidence from inference and recommendation;
- pass the repository validation command.

Run:

```bash
npm run check
```

`npm run check` validates local paths and heading anchors. Run `npm run check:links` before release to check external URLs.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the category layout, authoring contract, and release checklist.

## License

MIT. See [`LICENSE`](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
