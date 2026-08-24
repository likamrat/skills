# Contributing

This repository contains installable Agent Skills that describe how specific work should be carried out with AI.

## Layout

Place each skill under the role or practice it supports:

```text
skills/
└── <category>/
    └── <skill-name>/
        └── SKILL.md
```

Use a short, recognizable category name. Forward deployed engineering (FDE) skills belong under `skills/fde/` and use names such as `fde-engagement`, `fde-readout`, or `fde-evals`. Keep unrelated work in a sibling category instead of placing it under FDE.

## Drafts

Keep experimental packages under:

```text
drafts/
└── <category>/
    └── <skill-name>/
        └── SKILL.draft.md
```

Do not place a file named `SKILL.md` under `drafts/`. The official CLI discovers that filename recursively.

## Evaluate changes

Use the [skill evolution guide](docs/skill-evolution.md) for trigger tests, output comparisons, human review, and release gates.

Run the static readiness scorecard:

```bash
npm run score:skills
```

Run trigger trials in fresh Copilot sessions:

```bash
npm run eval:triggers -- --skill fde-readout --runs 3 --model gpt-5.6-sol
```

A draft can move under `skills/` after its trigger cases, behavior evals, package checks, and human documentation are complete. Rename `SKILL.draft.md` to `SKILL.md`, then register the package in `package.json` and the root catalog.

## Add a skill

1. Create `skills/<category>/<skill-name>/SKILL.md`.
2. Make the frontmatter `name` exactly match the directory.
3. Keep the description under 400 characters: say what the skill does and which user intent should load it. Put adjacent boundaries in the body and near-miss tests instead of stuffing negative keywords into the listing.
4. Keep the main instructions concise. Put conditional detail in `references/`.
5. Add deterministic scripts only for repeatable checks or fragile operations.
6. Add behavior evals and near-miss trigger fixtures.
7. Add the skill path to the root `package.json` `skills` array.
8. Add the skill to the root README catalog.
9. Link the skill README to the root [30-second setup](README.md#installation-30-second-setup). Do not duplicate end-user install commands.
10. Run `npm run check`.

## Authoring contract

- Encode procedures, defaults, gates, and stop conditions.
- Do not restate general knowledge the model already has.
- Do not invent commands, APIs, domain facts, customer evidence, or metrics.
- Keep examples synthetic or cite their public source.
- Never commit customer data, credentials, or proprietary artifacts.
- Distinguish observation, stakeholder report, inference, and recommendation.
- Define observable completion criteria.
- Describe what exists and what it does. Do not position a skill as the first, new, or part of a promised catalog.
- Replace branding metaphors with the actor, evidence, action, control, or consequence they stand for.
- Keep human-facing documentation direct and free of stock AI language.

## Release checklist

1. Update the skill version in `SKILL.md` metadata.
2. Update the repository version when publishing a repository release.
3. Run:

   ```bash
   npm run check
   npm run check:cli
   npm run check:links
   npx skills@latest add . --list
   ```

4. Confirm the expected skill names and descriptions appear.
5. Test installation from a clean temporary project.
6. Push or merge to the public default branch.
7. Verify:

   ```bash
   npx skills@latest add likamrat/skills --list
   ```

8. Install the public source once and check [`skills.sh/likamrat/skills`](https://skills.sh/likamrat/skills).

The skills.sh listing is install-driven; there is no separate publish command documented by skills.sh.
