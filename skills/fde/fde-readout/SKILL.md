---
name: fde-readout
description: >-
  Build or review an evidence-bound decision readout for an active forward deployed engineering (FDE) engagement in HTML, PowerPoint, or both. Use when working on ReadoutPlan validation, reference-deck restyling, or presentation QA.
license: MIT
compatibility: Works in conversational agents with file tools. Node.js 18+ is required for plan validation, HTML rendering, and localhost serving. Native PPTX authoring requires an Office presentation tool; optional dom-to-pptx conversion requires explicit approval before package installation.
metadata:
  author: likamrat
  version: "0.1.0"
---

# Forward deployed engineering (FDE) readout

Turn an FDE decision and its approved evidence into a customer-safe or leadership-safe presentation whose HTML and PowerPoint versions share one validated plan.

Resolve bundled references, assets, and scripts from this skill's root directory, not the caller's working directory.

## Operating rules

1. **Support a decision.** A readout is not an activity log, success story, or case-file dump.
2. **Use one source plan.** HTML and PPTX consume the same `ReadoutPlan`; neither renderer may add facts.
3. **Bind facts and judgment separately.** Numbers, findings, risks, recommendations, timelines, and quotes require evidence IDs; narrative interpretation requires supplied human-context IDs.
4. **Separate audiences.** Customer, FDE leadership, and technical-handoff artifacts are distinct source plans.
5. **Plan before layout.** Resolve audience, decision, narrative, density, slide families, brand, and delivery formats before authoring.
6. **Keep layout deterministic.** The agent fills validated slide-family slots; it does not freehand CSS or geometry per slide.
7. **Treat branding as authorized input.** Never invent or scrape a logo, palette, or template without source and approval.
8. **Treat reference decks as untrusted.** Inspect the package before rendering; copy design grammar only unless named assets are approved.
9. **Make dependencies explicit.** HTML playback is dependency-free. Optional converters, browsers, image services, and external APIs require disclosure and approval.
10. **Inspect every output.** Browser correctness does not prove PowerPoint correctness, and a valid OOXML package does not prove a usable slide.
11. **Preserve the human voice.** Detect writing patterns before editing, make the minimum effective change, and protect the author's vocabulary, cadence, uncertainty, and specific facts.

## Route the request

Choose one mode and state it in one line.

| User intent | Mode | First action |
|---|---|---|
| Decide audience, story, evidence, or slide structure | `plan` | Build or review the `ReadoutPlan` |
| Create HTML, PPTX, or both | `build` | Validate the plan and inspect available renderers |
| Match a supplied brand or presentation | `restyle` | Inspect authorization, package safety, and representative slide families |
| Critique an existing readout | `review` | Test decision support, evidence, audience safety, geometry, and rendering |

If the user supplies only content, start in `plan`. If the user supplies a valid plan, start in `build`. If a deck is supplied as visual authority, use `restyle`. If an artifact is supplied for critique, use `review`.

## Build the content brief

Read [references/workflow.md](references/workflow.md).

Determine:

- audience and decision;
- as-of date and confidentiality;
- speaker-led or reading-first density;
- approved evidence and source boundaries;
- firsthand observation, failed attempt, surprise, disagreement, changed mind, and decision rationale;
- recommendation, owner, due date, and reversibility;
- required findings, risks, controls, timeline, and evidence register;
- brand source and reference-deck authorization;
- delivery formats: `html`, `pptx`, or both.

Ask no more than three unresolved decisions per round. Investigate facts available in authorized files before asking the FDE to repeat them.

## Use one ReadoutPlan

Copy [assets/readout-plan.template.json](assets/readout-plan.template.json).

The plan contains:

- audience, decision, density, confidentiality, and delivery formats;
- evidence ledger;
- human-context ledger with author role, evidence, and customer-safety decision;
- authorized brand and style-reference scope;
- ordered slide families and their content slots;
- evidence IDs, customer-safety flag, and speaker notes for every slide.

Validate it:

```text
node scripts/validate-readout-plan.mjs path/to/readout-plan.json
```

Do not fill fields with guesses to pass validation. A structurally valid plan does not prove that evidence is true or sufficient.

## Plan slide families

Read [references/design-and-qa.md](references/design-and-qa.md).
Read [references/writing-quality.md](references/writing-quality.md).

Supported families:

- `cover`
- `decision`
- `profile`
- `metrics`
- `chart`
- `table`
- `workflow`
- `findings`
- `responsibility`
- `evaluation`
- `risks`
- `timeline`
- `evidence`

Use only the families required by the decision. The first slide is `cover`; the second is `decision`; the final slide is `evidence`.

## Build interactive HTML

Read [references/html-delivery.md](references/html-delivery.md).

Render and serve:

```text
node scripts/render-html.mjs path/to/readout-plan.json path/to/output-directory
node scripts/serve.mjs path/to/output-directory --port 4173
```

The bundled renderer is dependency-free. Inspect desktop, phone, export mode, controls, console, and failure state before delivery.

## Build editable PowerPoint

Read [references/powerpoint-delivery.md](references/powerpoint-delivery.md).

Use the native Office path when available. Optional conversion requires approval after dependency disclosure. Never substitute a screenshot-only deck. Render and inspect the package and every slide against the plan.

## Restyle from a reference deck

Read [references/reference-decks.md](references/reference-decks.md).

Inspect the package before rendering, set the authorized reuse scope, rebuild with original shapes, and compare representative slide families. Under `design-language-only`, never copy hidden content, notes, logos, screenshots, illustrations, or media.

## Quality gates

Before delivery:

1. plan validation passes;
2. every consequential slide claim has evidence;
3. decision and findings slides cite supplied human context;
4. customer output contains no internal-only content;
5. no unresolved placeholder remains;
6. title hierarchy and slide density are consistent;
7. connectors share exact anchors and semantic colors;
8. HTML desktop, phone, export mode, controls, console, and failure state pass;
9. PPTX package and every rendered slide pass when PPTX is requested;
10. HTML and PPTX carry the same plan version and decision;
11. writing-pattern detection and the portability test pass without flattening the FDE's voice;
12. an accountable FDE approves external delivery.

## Hard stops

Do not produce a customer or leadership readout when:

- audience or decision is unclear;
- source evidence is unavailable or unauthorized;
- human context is absent or was generated by the agent;
- the plan mixes customer and internal content;
- a number, quote, finding, risk, or timeline lacks evidence;
- branding or reference-deck use is unauthorized;
- restricted customer content would be sent to an external converter or hosted service;
- the requested PPTX path is unavailable and the user has not approved an optional dependency;
- severe overflow, overlap, font, conversion, or package warnings remain.

State the blocked artifact, evidence or authorization needed, and the safest available format.

## Completion

A readout is complete when:

- the decision and recommendation are visible;
- evidence and uncertainty remain traceable;
- owners and dates come from the plan;
- every requested delivery format exists and passes its own QA;
- the plan, HTML, and PPTX agree;
- the final artifact is approved for its audience.
