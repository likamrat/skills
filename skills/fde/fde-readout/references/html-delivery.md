# HTML delivery

The HTML renderer emits one self-contained file from a validated `ReadoutPlan`.

## Requirements

- fixed 1600×900 slide roots;
- no CDN, analytics, external font, or remote runtime asset;
- uniform stage scaling rather than mobile reflow;
- stable slide IDs and accessible labels;
- keyboard, touch, fullscreen, notes, hash, print, and export modes;
- visible fictional/confidentiality footer;
- embedded plan version and source hash;
- explicit initialization failure.

## Render

```text
node scripts/render-html.mjs plan.json output-directory
```

## Serve

```text
node scripts/serve.mjs output-directory --port 4173
```

The server binds to `127.0.0.1`.

## PowerPoint boundary

Do not install or execute an HTML-to-PPTX package at runtime. Deliver the HTML and validated plan when an approved native Office renderer is unavailable.
