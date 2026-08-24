# Presentation design and QA

## Design contract

Before authoring, record:

- decision and audience;
- physical use scene: room, screen, ambient light, and presenter;
- density;
- slide size and safe margins;
- type hierarchy;
- color roles;
- slide-family geometry;
- notes, evidence, footer, and confidentiality treatment.
- human-context provenance for decision and findings slides.

Use color by meaning:

- one system/data color;
- one decision/emphasis color;
- one risk color;
- neutral support surfaces.

Connectors use shared anchors and one semantic direction. Do not place independent arrows by eye.

## Layout rules

- Use one fixed 16:9 stage.
- Use consistent margins and baseline rhythm.
- Assertion titles state the slide's conclusion.
- Keep body text readable in a room.
- Use validated table slots for comparison, deterministic SVG charts for HTML, native charts for PowerPoint, and SVG for exact diagrams.
- Do not use nested decorative cards as the composition.
- Do not add stock imagery when evidence-bearing diagrams or tables can carry the decision.
- Do not infer visual precision from template validity.

## Browser QA

Check:

- presentation viewport;
- phone viewport with uniform stage scaling;
- all slides in export mode;
- keyboard, touch, fullscreen, notes, hash navigation, print;
- console and page errors;
- loading and source failure;
- overlap and overflow using rendered geometry.

## PowerPoint QA

Check:

- package warnings, content types, relationships, macros, OLE, and external links;
- slide size, masters, layouts, themes, notes, and hidden slides;
- every rendered slide;
- text overflow and font substitution;
- chart, table, SVG, image, connector, and z-order fidelity;
- leftover placeholders;
- equality with the plan version and decision.

## Bounded review

Use one batched visual pass, fix every defect found, then perform one confirmation pass. Do not polish indefinitely.

Writing review follows [writing quality](writing-quality.md). Visual polish cannot rescue portable prose, hidden sourcing, or invented human judgment.
