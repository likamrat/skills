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
- external-audience safety for every slide and referenced human-context entry in customer and technical-handoff plans; forward deployed engineering (FDE) leadership remains internal.

Use color by meaning:

- one system/data color;
- one decision/emphasis color;
- one risk color;
- neutral support surfaces.

Connectors use shared anchors and one semantic direction. Compute each endpoint from the target shape bounds: side entries land at the vertical midpoint and top or bottom entries land at the horizontal midpoint. Use restrained 1-2 px rails, round line caps, narrow open arrowheads, and muted semantic color. Do not place independent arrows by eye, use filled triangular heads, or separate steps with oversized arrow glyphs.

## Layout rules

- Use one fixed 16:9 stage.
- Use consistent margins and baseline rhythm.
- Assertion titles state the slide's conclusion.
- Keep body text readable in a room.
- Use validated table slots for comparison, deterministic SVG charts for HTML, editable shape-based charts for PowerPoint, and native shapes and connectors for exact diagrams.
- Do not use nested decorative cards as the composition.
- Do not add stock imagery when evidence-bearing diagrams or tables can carry the decision.
- Do not infer visual precision from template validity.

Keep the design-token budget small:

- use at most two font families and four semantic text sizes per deck;
- use at most four color roles per slide and maintain 4.5:1 contrast for body text;
- keep safe margins between 5 and 7.5 percent of the stage width;
- keep titles to two lines and any body block to six lines;
- keep body measures wide enough for phrases rather than one-word-per-line wrapping;
- reserve saturated brand colors for small accents; prefer soft blue, sage, stone, and warm-neutral surfaces, and do not use pink panel backgrounds unless the user requests them;
- keep evidence text on dark surfaces at WCAG AA contrast instead of reusing saturated link blue;
- size containers from their content and intended reading measure; a short sentence does not justify a tall empty card;
- present single-sentence guardrails as compact ruled notes instead of full-width filled panels;
- compose related facts into one integrated matrix, rail, or open row before reaching for repeated detached cards;
- use one restrained signature accent per slide, such as a thin blue-to-violet rail, rather than making every container compete;
- establish one original abstract motif for the opening and repeat only a small fragment elsewhere; do not imitate another brand's logo, illustration, or product constellation;
- give each slide one primary visual assertion;
- split content instead of shrinking text or stacking decorative containers.

## Browser QA

Freeze the plan and HTML first. Bind the complete QA set to both hashes, and repeat the complete set after any later write.

Check:

- every slide at the presentation viewport;
- every slide at the phone viewport, with readable content at default zoom and visible, tappable controls;
- every slide independently in export mode;
- previous/next controls, keyboard, touch, fullscreen, notes, hash navigation, and print;
- final console and page errors;
- loading and source failure in a disposable hidden context that is closed before restoring the primary review context;
- overlap and overflow using rendered geometry.

Uniform scaling, absence of overflow, or desktop success does not prove phone usability. Clipped controls or text that becomes too small to read fails phone QA.

## PowerPoint QA

Check:

- the three-slide smoke contact sheet before full-deck authoring;
- package warnings, content types, relationships, macros, OLE, and external links;
- slide size, masters, layouts, themes, notes, and hidden slides;
- every rendered slide;
- text overflow and font substitution;
- chart, table, SVG, image, connector, and z-order fidelity;
- leftover placeholders;
- equality with the plan version and decision.

For the smoke gate, visual approval requires readable cover and decision hierarchy plus a readable densest-family slide at presentation size. Structural approval separately requires exactly three active slides, one notes relationship and part per slide, no orphaned customer slide or notes parts, no retained legacy content beneath replacements, and evidence IDs in notes that match the plan.

## Bounded review

Use one batched visual pass, fix every defect found, then perform one confirmation pass. Do not polish indefinitely.

Writing review follows [writing quality](writing-quality.md). Visual polish cannot rescue portable prose, hidden sourcing, or invented human judgment.
