# Forward deployed engineering (FDE) readout

Create evidence-bound customer and leadership readouts as interactive HTML, editable PowerPoint, or both.

The skill uses one validated `ReadoutPlan` for content, evidence, slide structure, speaker notes, brand, and delivery requirements. HTML and PPTX render the same narrative from one plan.

## Human context

The plan keeps two source types separate:

- **Evidence IDs** support facts, metrics, findings, risks, and timelines.
- **Human-context IDs** identify supplied observation, failure, surprise, disagreement, changed mind, and decision rationale.

Each entry must be human-provided or human-confirmed. The agent may challenge and organize this material. It may not invent a personal take, operator quote, anecdote, or rationale to make a deck feel human.

Decision slides require a human rationale. Findings slides require firsthand human context. If those inputs are absent, rendering stops.

Use a human-first 25/50/25 editing loop: the FDE supplies rough source notes, the agent organizes and drafts the middle from approved material, and the FDE verifies facts, restores natural voice, and approves the deck. Treat the percentages as a sequencing heuristic. Apply the minimum effective edit, protect names and numbers, and reject any sentence that could move unchanged to an unrelated customer. This approach adapts Peter Yang's MIT-licensed No AI Slop skill; see [third-party notices](THIRD_PARTY_NOTICES.md).

## Install

Use the repository's canonical [30-second setup](../../../README.md#installation-30-second-setup) and select `fde-readout`.

Customer-authored sources pass through `scripts/preflight-sources.mjs` before the agent reads them. The manifest reports hashes, line numbers, and rule IDs without echoing source text.

## Use

### Plan a customer readout

```text
Use fde-readout to plan a customer decision deck from these approved findings.
Ask for unresolved audience or decision choices before designing slides.
```

### Build HTML and PowerPoint

```text
Create synchronized interactive HTML and editable PowerPoint readouts from
this ReadoutPlan. Validate and inspect each format independently.
```

### Restyle from a reference deck

```text
Use this PPTX as design-language-only reference. Extract its slide families,
grid, type, color roles, diagrams, tables, and footer treatment. Do not copy
its text, logos, screenshots, media, or hidden content.
```

### Review a deck

```text
Review this FDE customer deck for decision support, evidence, audience safety,
alignment, overflow, connector geometry, and HTML/PPTX drift.
```

## Commands

Validate a plan:

```text
node scripts/validate-readout-plan.mjs path/to/readout-plan.json
```

Render dependency-free HTML:

```text
node scripts/render-html.mjs path/to/readout-plan.json path/to/output-directory
```

Run the HTML deck on localhost:

```text
node scripts/serve.mjs path/to/output-directory --port 4173
```

The HTML deck supports keyboard and touch navigation, fullscreen, speaker notes, hash links, print, and `?export=1`.

## Example

The bundled Lattice Harbor example is fictional and contains:

- a validated [ReadoutPlan](assets/examples/lattice-harbor-readout-plan.json);
- an [interactive HTML deck](assets/examples/lattice-harbor-html/index.html);
- an [editable PowerPoint](assets/examples/lattice-harbor-readout.pptx);
- a [four-slide preview](assets/examples/lattice-harbor-readout.png).

![Four-slide preview of the fictional Lattice Harbor readout](assets/examples/lattice-harbor-readout.png)

No real company, customer, system, person, or metric is represented.

## Output paths

```text
fde-readout/
├── SKILL.md
├── README.md
├── assets/
│   ├── readout-plan.template.json
│   └── examples/
│       ├── lattice-harbor-readout-plan.json
│       ├── lattice-harbor-readout.pptx
│       ├── lattice-harbor-readout.png
│       └── lattice-harbor-html/
├── evals/
├── references/
└── scripts/
```

## Safety

- Customer and leadership outputs are separate.
- Every consequential claim requires evidence IDs.
- Narrative slides require supplied human-context IDs.
- HTML playback has no remote runtime dependency.
- Runtime converters and hosted services are not used.
- Reference-deck asset reuse requires named authorization.
- Rendered-slide review remains required after plan and Office-package validation.

## License

MIT. See [`LICENSE`](LICENSE).
