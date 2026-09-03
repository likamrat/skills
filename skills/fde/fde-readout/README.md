# Forward deployed engineering (FDE) readout

Create evidence-bound customer, technical-handoff, and leadership readouts as interactive HTML, editable PowerPoint, or both.

The skill uses one validated `ReadoutPlan` for content, evidence, slide structure, speaker notes, brand, and delivery requirements. HTML and PPTX render the same narrative from one plan.

The plan may use approved branding or an explicitly authorized unbranded neutral original design. Unbranded readouts keep an empty wordmark and do not fabricate a logo, pseudo-brand, or reusable identity.

## Human context

The plan keeps two source types separate:

- **Evidence IDs** support facts, metrics, findings, risks, and timelines.
- **Human-context IDs** identify supplied observation, failure, surprise, disagreement, changed mind, and decision rationale.

Each entry must be human-provided or human-confirmed. The agent may challenge and organize this material. It may not invent a personal take, operator quote, anecdote, or rationale to make a deck feel human.

Decision slides require a human rationale. Findings slides require firsthand human context. If those inputs are absent, rendering stops.

Customer and technical-handoff plans reject slides and referenced human-context entries marked `customerSafe: false`. FDE leadership plans may retain internal slides and human context.

Use a human-first 25/50/25 editing loop: the FDE supplies rough source notes, the agent organizes and drafts the middle from approved material, and the FDE verifies facts, restores natural voice, and approves the deck. Treat the percentages as a sequencing heuristic. Apply the minimum effective edit, protect names and numbers, and reject any sentence that could move unchanged to an unrelated customer. This approach adapts Peter Yang's MIT-licensed No AI Slop skill; see [third-party notices](THIRD_PARTY_NOTICES.md).

## Install

Use the repository's canonical [30-second setup](../../../README.md#installation-30-second-setup) and select `fde-readout`.

Customer-authored sources pass through `scripts/preflight-sources.mjs` before the agent reads them. The manifest reports hashes, line numbers, rule IDs, and active limits without echoing source text. The scanner rejects an input directory outside the approved root before traversal and stops after 32 directory levels or 1,000 discovered entries.

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

Compile a plan from preflighted source, authorization, and intent:

```text
node scripts/compile-readout-intent.mjs --source path/to/source.json --source-manifest path/to/source-manifest.json --authorization path/to/authorization.json --authorization-manifest path/to/authorization-manifest.json --receipt path/to/readout-input-receipt.json --intent path/to/intent.json --output path/to/readout-plan.json
```

Create the receipt from [`assets/readout-input-receipt.template.json`](assets/readout-input-receipt.template.json). It binds the exact source and authorization bytes to their verified preflight manifests, names every approved `review` entry, and limits the decision to `compile-readout-plan-only`. It never overrides `block`.

The compiler verifies receipt structure and consistency. Receipt authenticity, its author, and caller identity remain external and unauthenticated by this tool. A caller or host must establish them before running the command. Intent cannot supply provenance, receipt, or authorization decisions.

Validate a plan:

```text
node scripts/validate-readout-plan.mjs path/to/readout-plan.json
```

Render dependency-free HTML:

```text
node scripts/render-html.mjs path/to/readout-plan.json path/to/output-directory
```

Create a clean native PowerPoint slide-and-notes skeleton on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/create-powerpoint-skeleton.ps1 -Plan path/to/readout-plan.json -Output path/to/readout.pptx
```

Inspect a local PPTX package without Office or third-party packages:

```text
node scripts/pptx-package-qa.mjs --pretty path/to/readout.pptx
```

The command emits deterministic JSON with the package hash, ordered slides and notes, part hashes, counts, and findings. It exits nonzero for malformed ZIP or OOXML, unsafe content, external relationships, hidden slides, page-size drift, and slide-to-notes graph failures.

The package policy forbids slide media and embedded workbooks. PowerPoint charts and diagrams must use editable shapes and connectors rather than media-backed SVG or workbook-backed chart parts.

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
│   ├── readout-input-receipt.template.json
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

- Customer and technical-handoff outputs enforce external-audience safety. FDE leadership remains internal.
- Every consequential claim requires evidence IDs.
- Narrative slides require supplied human-context IDs.
- HTML playback has no remote runtime dependency.
- Runtime converters and hosted services are not used.
- PPTX package QA is read-only, dependency-free, and bounded against ZIP bombs.
- Reference-deck asset reuse requires named authorization.
- Rendered-slide review remains required after plan and Office-package validation.

## License

MIT. See [`LICENSE`](LICENSE).
