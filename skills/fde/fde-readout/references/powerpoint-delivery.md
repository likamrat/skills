# PowerPoint delivery

## Start from the clean seed

Every new editable deck starts from a copy of [`../assets/powerpoint-16x9-seed.pptx`](../assets/powerpoint-16x9-seed.pptx). Keep the bundled asset unchanged. A reference deck supplies design grammar only and must never become the mutable output base.

Use this authoring order:

1. canonical-validate the complete plan once;
2. copy the clean seed to a disposable smoke output path;
3. on Windows with PowerPoint installed, create the three-slide native smoke skeleton from the complete plan with:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/create-powerpoint-skeleton.ps1 -Plan plan.json -Output readout-smoke.pptx -SmokeSlideIds cover,pilot-decision,pilot-risks
   ```

4. author and render the three selected slides, then obtain coordinator or accountable-human approval;
5. discard the smoke deck and copy a fresh seed to the full-deck output path;
6. invoke the helper without `-SmokeSlideIds` against the same complete plan;
7. save and close the native deck, then run `node scripts/pptx-package-qa.mjs readout.pptx`;
8. require a zero exit and confirm that the active slide count equals the unique notes-relationship and notes-part counts in its deterministic JSON report;
9. reopen the deck and only after that check open it in the Office canvas to build the planned native shapes, tables, charts, and diagrams;
10. do not add, delete, reorder, or assign notes to slides in the canvas after either native skeleton passes.

If the script cannot run, use another approved native PowerPoint host for the same smoke-first sequence. Assign each selected slide's original notes before creating the next slide.

The seed establishes a clean package foundation. It does not prove that a full deck can be authored safely, so the smoke gate still applies.

## Three-slide smoke gate

Canonical-validate the complete `ReadoutPlan` once. Do not create or validate a derivative three-slide plan. Before full-deck authoring, select these IDs from that validated complete plan:

1. the cover;
2. the decision slide;
3. the densest requested slide family.

The third slide must exercise its native structure, such as the largest table or chart. Pass the three full-plan IDs to the native helper; argument order does not change full-plan order:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/create-powerpoint-skeleton.ps1 -Plan plan.json -Output readout-smoke.pptx -SmokeSlideIds cover,pilot-decision,pilot-risks
```

The helper requires exactly three unique IDs, including the complete plan's first cover and second decision IDs. It creates only those native slides with their original notes, evidence IDs, and human-context IDs, then reports the source full-plan SHA-256 plus selected IDs and families. Save, close, reopen, and confirm three unique notes parts before opening the Office canvas. The canvas package serializer may point every added slide at one notes part even when slide-and-notes writes are separate; do not use it to create the skeleton.

Author and render those three slides as one contact sheet, then pause for coordinator or accountable-human approval. Treat the smoke deck as disposable. After approval, discard it, copy a fresh seed, and invoke the helper without `-SmokeSlideIds` against the same complete plan before full canvas authoring. Visual approval permits full authoring; it does not waive evidence, notes, package, or efficiency gates.

Stop the PowerPoint path immediately when:

- two actions of the same structural class fail;
- replacement content overlaps undeleted legacy content;
- each active slide cannot be assigned a unique notes relationship and notes part;
- customer-content slide or notes parts exist outside the three active slides;
- the densest slide is unreadable at presentation size.

Do not work around these stops with more retries, a screenshot deck, or direct ZIP, XML, or OPC editing.

## Native authoring

When an Office presentation tool is available:

1. inspect any supplied template or reference package without using it as the output base;
2. verify the copied seed's slide size before content;
3. create and verify the complete slide-and-notes skeleton in the native PowerPoint host;
4. map plan families to layouts without changing slide structure in the canvas;
5. build `table` families as native PowerPoint tables; build chart and diagram families with editable PowerPoint shapes and connectors so the package contains no embedded workbook or media parts;
6. use exact coordinates for connectors and repeated geometry;
7. preserve the plan's evidence IDs and footer;
8. inspect package and render every slide.

Structural slide changes happen before content formatting. Template slot counts must match plan items; delete unused placeholder groups rather than leaving blank labels or images.

## Smoke evidence

Capture one final, hash-bound evidence record after the contact-sheet render. It must include:

- plan hash, candidate hash, active slide IDs, and contact-sheet hash;
- per-slide plan ID, family, shape count, native table count, expected evidence IDs, evidence IDs found in notes, and notes relationship/part;
- active and package slide/notes part counts plus orphan counts;
- legacy-content and dense-slide readability results;
- `invoke_canvas_action` calls, batch-member actions, canvas failures, elapsed time, model calls, and input tokens;
- the human contact-sheet decision.

Count only `invoke_canvas_action` calls against the temporary 10-call canvas budget. Record `get_model` inspections and batch-member actions separately. Package facts must come from the deterministic JSON emitted by `scripts/pptx-package-qa.mjs`; visual and native-object facts still come from the Office canvas. The package inspector is read-only and must never edit ZIP, XML, OOXML, or OPC content. Do not add a live PowerPoint evaluator; Hill 0 consumes sanitized frozen replay evidence only.

## Conversion boundary

Do not install or execute an HTML-to-PPTX converter at runtime. Use an approved native Office renderer or deliver HTML with the validated plan.

## No available renderer

Do not claim that a PPTX was created. Deliver the plan and HTML and name the missing native renderer.
