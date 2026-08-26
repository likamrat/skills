# Presentation workflow research

This skill independently implements presentation workflows checked against [Anthropic's PPTX skill](https://github.com/anthropics/skills/tree/main/skills/pptx), [SlideSpeak's slide-design skill](https://github.com/SlideSpeak/slide-design-skill), [frontend-slides](https://github.com/zarazhangrui/frontend-slides), [dom-to-pptx](https://github.com/atharva9167j/dom-to-pptx), [Elite PowerPoint Designer](https://github.com/willem4130/claude-code-skills/tree/main/skills/elite-powerpoint-designer), [Hallmark](https://www.usehallmark.com/), and [SlideSpeak's comparison](https://slidespeak.co/blog/agent-skills-presentations-powerpoint-ai). Its editing workflow adapts [Peter Yang's No AI Slop skill](https://github.com/petergyang/no-ai-slop) and [25/50/25 heuristic](https://creatoreconomy.so/p/use-my-no-ai-slop-skill-to-remove-20-ai-slop-patterns).

## Adopted patterns

- one structured content plan before rendering;
- fixed-stage HTML with uniform viewport scaling;
- deterministic slide families and content slots;
- contact-sheet and every-slide visual QA;
- browser and PowerPoint QA as separate gates;
- notes, evidence, brand, and source provenance in the plan;
- no runtime package installation or hosted conversion.
- human-first drafting, minimum effective editing, portability testing, and named-pattern detection.
- small design-token budgets for fonts, text sizes, colors, margins, contrast, and line density.
- structural variety, integrated composition, content-proportional containers, and one restrained accent motif instead of repeated dashboard cards.

## Licensing boundary

[dom-to-pptx](https://github.com/atharva9167j/dom-to-pptx), [SlideSpeak's slide-design skill](https://github.com/SlideSpeak/slide-design-skill), and [frontend-slides](https://github.com/zarazhangrui/frontend-slides) are MIT licensed. This package references their documented workflows but does not vendor or execute their engines.

[Peter Yang's No AI Slop skill](https://github.com/petergyang/no-ai-slop) is MIT licensed. This package adapts its editing concepts and pattern taxonomy with attribution in `THIRD_PARTY_NOTICES.md`.

[Elite PowerPoint Designer](https://github.com/willem4130/claude-code-skills/tree/main/skills/elite-powerpoint-designer) was reviewed for general design-token guidance. No code, templates, MCP server, Python package, animation system, or brand preset from that repository is included or required here.

[Hallmark](https://www.usehallmark.com/) and its locally installed design guidance were reviewed for structural variety, typographic hierarchy, rhythm, and containment discipline. No Hallmark code, copy, fonts, themes, images, or brand assets are included or required here.

[Anthropic's PPTX skill](https://github.com/anthropics/skills/tree/main/skills/pptx) uses a proprietary license that restricts copying and derivative use. No Anthropic code, scripts, or instruction text is included here. The general ideas of package inspection, structured validation, contact sheets, and rendered-slide QA are implemented independently.
