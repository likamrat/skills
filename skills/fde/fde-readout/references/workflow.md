# Readout workflow

## 1. Brief

Confirm the audience, decision, as-of date, confidentiality, density, approved sources, human context, recommendation, owners, brand, and delivery formats.

Density is:

- `speaker-led`: short on-slide copy, explanation in notes;
- `reading-first`: enough context to understand without a presenter.

Ask related decisions together, no more than three per round.

## 2. ReadoutPlan

Build `assets/readout-plan.template.json`.

The plan is the only narrative source used by renderers. Do not copy the case file into slides and then maintain a second HTML/PPTX story by hand.

The plan keeps evidence and human context separate. The agent must not create missing observations, opinions, failures, disagreements, quotes, or rationale during rendering.

## 3. Narrative order

Default order:

1. cover;
2. decision;
3. customer or engagement context;
4. measured current state;
5. workflow or system evidence;
6. findings;
7. target responsibility model;
8. evaluation;
9. risks and controls;
10. decision timeline;
11. evidence register.

Delete families that do not support the decision. Do not add a closing vision slide by habit.

## 4. Validate

Validation checks:

- known slide families and required slots;
- evidence existence and authorization;
- customer-safe content;
- unique slide and workflow-node IDs;
- brand color and text contrast;
- notes and evidence on every slide;
- cover/decision/evidence order;
- required delivery formats.

## 5. Render and inspect

Render HTML first when precise layout is the primary requirement. Use approved native PowerPoint authoring when PowerPoint editability or a template is primary. Do not install a conversion toolchain at runtime.

Each renderer has its own QA. Never approve one format because the other looks correct.
