# PowerPoint delivery

## Three-slide smoke gate

Before full-deck authoring, use the native Office presentation canvas to build only:

1. the cover;
2. the decision slide;
3. the densest requested slide family.

The third slide must exercise its native structure, such as the largest table or chart. Delete legacy source content before placing replacement content. Render all three slides as one contact sheet and pause for coordinator or accountable-human approval. Visual approval permits full authoring; it does not waive evidence, notes, package, or efficiency gates.

Stop the PowerPoint path immediately when:

- two actions of the same structural class fail;
- replacement content overlaps undeleted legacy content;
- each active slide cannot be assigned a unique notes relationship and notes part;
- customer-content slide or notes parts exist outside the three active slides;
- the densest slide is unreadable at presentation size.

Do not work around these stops with more retries, a screenshot deck, or direct ZIP, XML, or OPC editing.

## Native authoring

When an Office presentation tool is available:

1. inspect any supplied template or reference package;
2. set slide size before content;
3. map plan families to layouts;
4. build `table` and `chart` families as native PowerPoint tables and charts; build other families with editable text, shapes, SVG diagrams, and notes;
5. use exact coordinates for connectors and repeated geometry;
6. preserve the plan's evidence IDs and footer;
7. inspect package and render every slide.

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
