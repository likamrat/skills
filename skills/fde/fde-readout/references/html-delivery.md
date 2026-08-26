# HTML delivery

The HTML renderer emits one self-contained file from a validated `ReadoutPlan`.

## Requirements

- fixed 1600×900 slide roots;
- no CDN, analytics, external font, or remote runtime asset;
- deterministic stage scaling rather than mobile reflow;
- stable slide IDs and accessible labels;
- keyboard, touch, fullscreen, notes, hash, print, and export modes;
- visible fictional/confidentiality footer;
- embedded plan version and source hash;
- explicit initialization failure.

Uniform scaling is an implementation property, not a phone QA pass condition. At the delivery phone width and default zoom, slide content must remain readable and controls must remain visible, tappable, and usable. No overflow alone does not pass.

## Render

```text
node scripts/render-html.mjs plan.json output-directory
```

## Serve

```text
node scripts/serve.mjs output-directory --port 4173
```

The server binds to `127.0.0.1`.

## Final HTML gate

Finish authoring before final QA:

1. freeze the validated `ReadoutPlan` and record its SHA-256 hash;
2. render the final self-contained HTML, freeze its bytes, and record its SHA-256 hash;
3. collect one synchronized QA set bound to both hashes;
4. invalidate the complete QA set after any later write to the plan or HTML, then repeat from step 1.

The synchronized set must show:

- the HTML opens and its embedded plan hash matches the frozen plan;
- every final slide was captured and reviewed at desktop width;
- every final slide was captured and reviewed at phone width for readable content and usable controls;
- every final slide was independently reviewed in export mode;
- previous/next controls, keyboard, touch, and hash navigation pass;
- notes and fullscreen pass;
- final page and console errors were captured and are clean;
- intentional source or initialization faults were tested only in a disposable hidden context;
- the fault context was closed and the primary review context was restored;
- no external browser window was opened or left visible by fault testing.

Do not combine screenshots or observations from different plan or HTML hashes. A desktop contact sheet can establish desktop quality only; it cannot waive phone, export, interaction, console, fault-isolation, or hash-binding failures.

## PowerPoint boundary

Do not install or execute an HTML-to-PPTX package at runtime. Deliver the HTML and validated plan when an approved native Office renderer is unavailable.
