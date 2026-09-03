# PowerPoint delivery

## Start from the clean seed

Every new editable deck starts from a copy of [`../assets/powerpoint-16x9-seed.pptx`](../assets/powerpoint-16x9-seed.pptx). Keep the bundled asset unchanged. A reference deck supplies design grammar only and must never become the mutable output base.

Use the dependency-free coordinator for the complete native lifecycle on Windows. The output parent must already exist and each output directory must be new. Publication uses a same-volume Windows directory rename, which fails rather than replacing an existing output.

```powershell
node scripts\powerpoint-native-coordinator.mjs --mode smoke --plan plan.json --output readout-smoke-bundle
```

The smoke command canonical-validates the complete plan, selects the cover, decision, and densest requested family through the shared smoke contract, creates a native skeleton from the clean seed, runs the native-shape worker, runs package QA, and atomically publishes one smoke bundle. It does not create a derivative plan.

Review `readout-smoke-bundle\native-render\contact-sheet.png` and the smoke deck. When a human is satisfied with that output, run full mode explicitly with `--approve-smoke`. The flag records only that the caller chose to proceed after review; it does not record an identity or provide an attestation. No administrator setup is required.

```powershell
node scripts\powerpoint-native-coordinator.mjs --mode full --plan plan.json --smoke-bundle readout-smoke-bundle --approve-smoke --output readout-final-bundle
```

Full mode verifies the exact plan hash, production coordinator and profile, selected slide IDs and families, smoke report, PPTX and contact-sheet hashes, worker and package hashes, fresh package QA, and publication seal before any native child starts. It then restarts from the bundled clean seed, creates a fresh full skeleton, invokes the worker, verifies exact slide and notes counts, and atomically publishes one final bundle. It never reuses the smoke skeleton or smoke deck.

Both native helpers run sequentially and retain their shared `Local\FdeReadoutPowerPointAutomation` mutex, zero-PowerPoint baseline, process ownership, cleanup, contamination, and COM release checks. Each native child has a bounded coordinator watchdog. Immediately after exact HWND-to-PID, start-time, and executable-path validation, the helper atomically persists an ownership receipt. At the deadline, the watchdog validates that exact receipt, cleans only that owned process, terminates the exact child, and waits for exit. If the first receipt read was absent, it rereads after exact child termination and cleans a newly published exact owner. It never kills by process name or baseline difference. A missing, ambiguous, mismatched, contaminated, or failed ownership cleanup preserves the receipt and staging evidence and fails closed with retained-path diagnostics. Any child exit, stderr on success, malformed report, hash mismatch, stale input, unsupported package part, release error, contamination, output collision, or unexpected bundle file fails closed. Production children use absolute Node and System32 Windows PowerShell executables with a minimal trusted environment; caller `PATH`, `FDE_*` hooks, and process-injection variables are not inherited.

Failed staging is deleted by default. To preserve local diagnostics, provide one new explicit path:

```powershell
node scripts\powerpoint-native-coordinator.mjs --mode smoke --plan plan.json --output readout-smoke-bundle --diagnostic-output local-diagnostics
```

The diagnostic path must not exist and must not alias the output, plan, or smoke bundle. The coordinator performs no network access or customer external writes.

The seed establishes a clean package foundation. It does not prove that a full deck can be authored safely, so the smoke gate still applies.

## Three-slide smoke gate

Canonical-validate the complete `ReadoutPlan` once. Do not create or validate a derivative three-slide plan. Before full-deck authoring, the coordinator selects these IDs from the validated complete plan:

1. the cover;
2. the decision slide;
3. the densest requested slide family.

The third slide exercises the highest family-specific native complexity. Table and evaluation scores include cell grids, headers, and insight/release content. Chart scores distinguish bar leaves from line segments plus markers, then include categories, series, axes, legend, and data-grid leaves. A valid 12-category, 3-series line chart therefore outranks a 12-category, 4-series bar chart when it creates more editable objects. Workflow scores weight routed edges in addition to nodes. Other supported families use stable slot-specific weights. Selection is deterministic and preserves the earlier slide on an exact score tie. The coordinator passes exactly those three IDs to the skeleton helper, preserves their original notes and evidence, and verifies the helper, worker, package, and rendered artifact receipts before publishing.

The smoke bundle contains only `readout.pptx`, `worker-report.json`, `package-qa.json`, `smoke-report.json`, `coordinator-report.json`, and `native-render` with three slide PNGs plus one contact sheet. Treat it as disposable evidence, not as the full-deck base. Visual approval permits full authoring; it does not waive evidence, notes, package, cleanup, or native-object gates.

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
5. build `table` families as native PowerPoint tables; build chart and other diagram families with editable PowerPoint shapes so the package contains no embedded workbook or media parts;
6. build workflow routes as ordered native straight-connector segments, then validate exact connector names, endpoints, shared anchors, semantic styles, arrow termination, and z-order before save and after reopen;
7. preserve the plan's evidence IDs and footer;
8. inspect package and render every slide.

Structural slide changes happen before content formatting. Template slot counts must match plan items; delete unused placeholder groups rather than leaving blank labels or images.

## Smoke evidence

The smoke bundle separates three receipts:

- `smoke-report.json` binds the production coordinator ID and execution profile, plan, candidate PPTX, contact sheet, ordered slide IDs and families, per-slide evidence and native-object counts, overflow and notes verification, package summary, legacy-content removal, and dense-slide readability.
- `package-qa.json` records the package hash, exact slide and unique notes parts, relationships, all package parts, and zero findings.
- `coordinator-report.json` records the plan/spec/skeleton and artifact hashes, ordered selection, explicit approval state, worker cleanup state, package-QA result, unsupported-part count, atomic publication strategy, and the complete payload file/hash manifest. Smoke reports `{requiredForFull:true, approved:false, method:"explicit-full-mode-flag"}`; full reports the same fields with `approved:true`. Immediately before the same-parent rename, the coordinator recomputes the complete file set and SHA-256 seal; it recomputes the same seal at the destination before reporting success. A post-rename mismatch is quarantined only to the explicit diagnostic path or removed. If quarantine rename fails, verified recursive removal is the fallback; a failed fallback reports both `retainedPublishedPath` and `cleanupError`.

The human contact-sheet decision is expressed by adding `--approve-smoke` to the full-mode command. Package facts come from the deterministic JSON emitted by `scripts/pptx-package-qa.mjs`; the package inspector is read-only and never edits ZIP, XML, OOXML, or OPC content. The published `worker-report.json` is normalized only after its stdout and staged copy match exactly: final artifact paths are bundle-relative, ephemeral spec and skeleton paths are null, and all verified hashes and cleanup facts are preserved. Failures emit one machine-readable `COORDINATOR_ERROR` JSON object on stderr and no success-shaped stdout.

## Conversion boundary

Do not install or execute an HTML-to-PPTX converter at runtime. Use an approved native Office renderer or deliver HTML with the validated plan.

## No available renderer

Do not claim that a PPTX was created. Deliver the plan and HTML and name the missing native renderer.
