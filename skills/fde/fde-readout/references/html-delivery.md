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

## Optional conversion

`dom-to-pptx` is MIT licensed and can convert the fixed DOM geometry to editable PowerPoint shapes. Its headless exporter downloads/uses Puppeteer and PptxGenJS, so disclose that dependency and obtain approval before running:

```text
npx --yes dom-to-pptx-exporter@2.1.1 \
  "http://127.0.0.1:4173/deck/?export=1" \
  --selector ".slide" \
  --output readout.pptx
```

Local images must be data URIs or otherwise export-safe. Unsupported transforms, gradients, filters, and animation classes may silently degrade. Validate the resulting PPTX separately.
