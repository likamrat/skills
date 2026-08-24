# PowerPoint delivery

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

## Optional HTML conversion

Use `dom-to-pptx` only after approval. The converter measures final DOM geometry, but browser fidelity does not guarantee PowerPoint fidelity.

Known review points:

- relative or file images may not export;
- external fonts may fail embedding;
- unsupported transforms can no-op;
- some CSS effects rasterize and lose editability;
- SVG may require manual conversion to editable shapes;
- animations and transitions are whitelist-bound.

## No available renderer

Do not claim that a PPTX was created. Deliver the plan and HTML, name the missing renderer, and provide the approved conversion command if useful.
