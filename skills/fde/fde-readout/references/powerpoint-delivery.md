# PowerPoint delivery

## Start from the clean seed

Every new editable deck starts from a copy of [`../assets/powerpoint-16x9-seed.pptx`](../assets/powerpoint-16x9-seed.pptx). Keep the bundled asset unchanged. A reference deck supplies design grammar only and must never become the mutable output base.

Use this authoring order:

1. copy the clean seed to the output path;
2. on Windows with PowerPoint installed, create the native slide-and-notes skeleton with:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/create-powerpoint-skeleton.ps1 -Plan plan.json -Output readout.pptx
   ```

3. otherwise, use the native PowerPoint host to assign the starter notes, add each planned slide, and assign its notes before creating the next slide;
4. save, close, and reopen the native deck, then confirm that the active slide count equals the unique notes-relationship and notes-part counts;
5. only after that check, open the deck in the Office canvas and build the planned native shapes, tables, charts, and diagrams;
6. do not add, delete, reorder, or assign notes to slides in the canvas after the native skeleton passes.

The seed establishes a clean package foundation. It does not prove that a full deck can be authored safely, so the smoke gate still applies.

## Three-slide smoke gate

Before full-deck authoring, copy the seed, add two slides, and use the native Office presentation canvas to build only:

1. the cover;
2. the decision slide;
3. the densest requested slide family.

The third slide must exercise its native structure, such as the largest table or chart. Build the three-slide and three-notes skeleton in the native PowerPoint host, save it, close it, reopen it, and confirm three unique notes parts before opening the Office canvas. The canvas package serializer may point every added slide at one notes part even when slide-and-notes writes are separate; do not use it to create the skeleton. Render all three slides as one contact sheet and pause for coordinator or accountable-human approval. Treat the smoke deck as disposable. After approval, repeat the same native skeleton creation from a fresh seed before canvas content authoring. Visual approval permits full authoring; it does not waive evidence, notes, package, or efficiency gates.

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
5. build `table` and `chart` families as native PowerPoint tables and charts; build other families with editable text, shapes, and SVG diagrams;
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

Count only `invoke_canvas_action` calls against the temporary 10-call canvas budget. Record `get_model` inspections and batch-member actions separately. Package facts must come from the native Office canvas. Do not add a custom PPTX, ZIP, XML, or OPC parser, and do not add a live PowerPoint evaluator; Hill 0 consumes sanitized frozen replay evidence only.

## Conversion boundary

Do not install or execute an HTML-to-PPTX converter at runtime. Use an approved native Office renderer or deliver HTML with the validated plan.

## No available renderer

Do not claim that a PPTX was created. Deliver the plan and HTML and name the missing native renderer.
