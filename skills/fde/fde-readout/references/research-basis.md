# Presentation workflow research

This skill independently implements presentation workflows checked against [Anthropic's PPTX skill](https://github.com/anthropics/skills/tree/main/skills/pptx), [SlideSpeak's slide-design skill](https://github.com/SlideSpeak/slide-design-skill), [frontend-slides](https://github.com/zarazhangrui/frontend-slides), [dom-to-pptx](https://github.com/atharva9167j/dom-to-pptx), and [SlideSpeak's comparison](https://slidespeak.co/blog/agent-skills-presentations-powerpoint-ai). Its editing workflow adapts [Peter Yang's No AI Slop skill](https://github.com/petergyang/no-ai-slop) and [25/50/25 heuristic](https://creatoreconomy.so/p/use-my-no-ai-slop-skill-to-remove-20-ai-slop-patterns).

## Adopted patterns

- one structured content plan before rendering;
- fixed-stage HTML with uniform viewport scaling;
- deterministic slide families and content slots;
- contact-sheet and every-slide visual QA;
- browser and PowerPoint QA as separate gates;
- optional HTML-to-PPTX conversion;
- notes, evidence, brand, and source provenance in the plan;
- external dependency and hosting approval.
- human-first drafting, minimum effective editing, portability testing, and named-pattern detection.

## Licensing boundary

[dom-to-pptx](https://github.com/atharva9167j/dom-to-pptx), [SlideSpeak's slide-design skill](https://github.com/SlideSpeak/slide-design-skill), and [frontend-slides](https://github.com/zarazhangrui/frontend-slides) are MIT licensed. This package references their documented workflows but does not vendor their engines.

[Peter Yang's No AI Slop skill](https://github.com/petergyang/no-ai-slop) is MIT licensed. This package adapts its editing concepts and pattern taxonomy with attribution in `THIRD_PARTY_NOTICES.md`.

The optional npm conversion command is pinned to `dom-to-pptx-exporter@2.1.1`, the version whose MIT license and dependency metadata were checked on 2026-08-23.

[Anthropic's PPTX skill](https://github.com/anthropics/skills/tree/main/skills/pptx) uses a proprietary license that restricts copying and derivative use. No Anthropic code, scripts, or instruction text is included here. The general ideas of package inspection, structured validation, contact sheets, and rendered-slide QA are implemented independently.
