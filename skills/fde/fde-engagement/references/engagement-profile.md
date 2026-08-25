# Customer and problem profile

Read this file before substantial `engage`, `review`, or `report` work.

The profile is decision-sufficient, not exhaustive. It contains the customer facts, problem boundaries, people, systems, and brand rules needed for the current engagement decision. It does not contain generic company history or sales copy.

Start with `assets/engagement-profile.template.json`. Validate it against the case file:

```text
node scripts/validate-engagement-profile.mjs path/to/case-file.json path/to/engagement-profile.json
```

## Build facts before asking for preferences

When authorized access exists, inspect supplied files, customer systems, public first-party sources, and the case evidence before asking the forward deployed engineer (FDE) to repeat facts.

Record:

- customer identity, industry, business model, customer segments, operating footprint, and affected business unit;
- the decision the engagement must support;
- the outcome, baseline, workflow, failures, consequences, prior attempts, constraints, and non-goals;
- sponsor, operator, technical owner, decision maker, risk owner, and affected users;
- systems, sources of truth, owners, and boundaries;
- evidence IDs and the as-of date.

Do not include a fact because it makes the company profile feel complete. Include it only when it changes qualification, scope, design, risk, adoption, or the readout.

## Question in dependency order

Use Challenge This and ask no more than three profile decisions per round.

1. **Decision and outcome:** What decision must this engagement support, and what measured outcome would change that decision?
2. **Workflow and consequence:** Which workflow is affected, where does it fail, and who bears the consequence?
3. **Authority and ownership:** Who sponsors, operates, approves, owns, and is affected by the work?
4. **Systems and evidence:** Which systems record the work, what is the source of truth, and which evidence is authorized?
5. **Constraints and alternatives:** What cannot change, what has already been tried, and which simpler delivery models remain viable?
6. **Readout contract:** Who will use the artifact, for which decision, on what date, and under which confidentiality rules?
7. **Brand authorization:** Which brand source, wordmark, logo, colors, fonts, footer, and visual restrictions are approved for this artifact?
8. **Delivery formats:** Does the audience need editable PowerPoint, interactive HTML, Markdown, or a synchronized set?

The agent investigates available facts. The FDE settles business decisions, approves the profile, and confirms brand and confidentiality use.

## Brand profile

Use one of these sources:

- `customer-provided`: an approved brand kit or assets supplied for the engagement;
- `authorized-public`: first-party public brand material whose use the FDE confirms;
- `fictional-defined`: a deliberately invented brand for a synthetic example;
- `unbranded`: neutral presentation styling.

For a deck, `unbranded` is not ready. Ask for an approved source or propose a neutral brand treatment for explicit confirmation.

Record:

- wordmark and optional logo path;
- primary, secondary, accent, background, and text colors;
- font family and fallback;
- tone expressed as concrete writing traits;
- required footer and confidentiality label;
- prohibited logo, color, imagery, or co-branding uses;
- evidence IDs proving the source and authorization.

### When a reference PPTX is supplied

Treat the file as untrusted until its Office package has been inspected.

1. Inspect package warnings, macros, OLE objects, external relationships, slide size, masters, layouts, themes, and fonts before rendering.
2. Render representative slide families: cover, section, comparison, process, architecture, data/table, decision, and closing.
3. Record the reusable design grammar: canvas ratio, margins, title hierarchy, typefaces, palette, spacing, card geometry, shadows, diagrams, chart/table treatment, image crops, footers, and transitions.
4. Set `brand.styleReference.scope`:
   - `design-language-only`: reproduce the visual grammar with original shapes and the engagement's own content and brand;
   - `approved-asset-reuse`: reuse only assets named in `reusedAssets`;
   - `none`: no reference deck.
5. Record the source and authorization. A shared file permits inspection; it does not by itself permit copying logos, text, screenshots, illustrations, or media into a distributable deck.
6. Match the reference slide size when the presentation tool supports it. If it does not, state the geometry mismatch before authoring.
7. Render the finished deck beside the reference sample and compare hierarchy, density, spacing, alignment, component treatment, and rhythm. Do not compare or copy the reference's prose.

Customer-facing decks use the customer brand as the primary visual system. Add vendor or FDE branding only when approved. Do not infer a brand from an unrelated screenshot, fabricate a customer logo, or use public assets without recording the source and authorization.

## Profile gate

The profile is ready when:

- the customer description explains how the affected unit creates value;
- the problem names one decision, outcome, baseline, workflow, and consequence;
- sponsor, operator, technical owner, and decision maker are explicit;
- system ownership and sources of truth are named;
- open questions do not block the requested artifact;
- every profile section links to authorized evidence;
- the readout decision matches the problem decision;
- `deliveryFormats` names the required artifacts;
- deck branding has an authorized source, legible colors, required footer, and confidentiality label;
- fictional companies and evidence are labeled as fictional.

If the profile is incomplete, ask the smallest frontier question that changes the decision or artifact. Do not compensate with a longer deck.
