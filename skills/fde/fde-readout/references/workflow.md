# Readout workflow

## 1. Brief

Confirm the audience, decision, as-of date, confidentiality, density, approved sources, human context, recommendation, owners, brand, and delivery formats.

Choose an evidence-bound brand treatment. `customer-provided`, `authorized-public`, and `fictional-defined` require approval and an explicit wordmark. `unbranded` requires explicit approval, an empty wordmark, and a neutral original design with no logo, pseudo-brand, or reused brand assets. Do not fabricate identity when approved brand assets are unavailable.

Density is:

- `speaker-led`: short on-slide copy, explanation in notes;
- `reading-first`: enough context to understand without a presenter.

Ask related decisions together, no more than three per round.

## 2. ReadoutPlan

Build `assets/readout-intent.template.json`. Preflight the source and authorization files separately, then copy `assets/readout-input-receipt.template.json`. The receipt binds each exact input hash to its verified manifest hash, names each matching `review` entry by input type and source ID, records decision `approve`, and limits its scope to `compile-readout-plan-only`. A receipt never overrides `block`.

```text
node scripts/compile-readout-intent.mjs --source path/to/source.json --source-manifest path/to/source-manifest.json --authorization path/to/authorization.json --authorization-manifest path/to/authorization-manifest.json --receipt path/to/readout-input-receipt.json --intent path/to/intent.json --output path/to/readout-plan.json
```

The compiler reads and hashes raw input bytes before parsing JSON. It verifies both manifest body hashes, requires one byte-length and SHA-256 match per input, and checks the receipt against those exact matches. Intent cannot supply or override provenance, receipt, approval, or authorization-scope fields. A failed provenance check leaves the output unchanged and creates no partial output.

Receipt authenticity, its author, and caller identity remain external and unauthenticated by the compiler. The caller or host must establish them before invocation. The compiler selects exact records in source order, supplies missing `sourceId` values from originating record IDs, and takes brand defaults and brand evidence only from authorization. It performs no source-directed action or network access. Existing callers that already materialize `assets/readout-plan.template.json` may continue to validate that plan manually.

The plan is the only narrative source used by renderers. Do not copy the case file into slides and then maintain a second HTML/PPTX story by hand.

The plan keeps evidence and human context separate. Every entry in both ledgers requires a non-empty `sourceId` that preserves its exact source provenance; external IDs and JSON pointers are valid. The agent must not create missing observations, opinions, failures, disagreements, quotes, or rationale during rendering.

Customer and technical-handoff plans require every slide and each human-context entry referenced by a slide to be marked customer-safe. Forward deployed engineering (FDE) leadership plans may reference internal entries.

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
- source provenance on every evidence and human-context entry;
- customer-safe slides and referenced human context for customer and technical-handoff plans;
- unique slide and workflow-node IDs;
- brand color and text contrast;
- brand-treatment authorization, wordmark mode, and evidence;
- notes and evidence on every slide;
- cover/decision/evidence order;
- required delivery formats.

## 5. Render and inspect

Render HTML first when precise layout is the primary requirement. Use approved native PowerPoint authoring when PowerPoint editability or a template is primary. Do not install a conversion toolchain at runtime.

Each renderer has its own QA. Never approve one format because the other looks correct.
