# FDE end-to-end evaluator

Hill 0 makes the observed forward deployed engineering (FDE) failure reproducible before either skill changes. It measures final outcomes, artifacts, traces, resources, and approval. It does not improve `fde-engagement` or `fde-readout`.

## Run

Evaluate the frozen observed failure:

```bash
npm run eval:fde:e2e -- --fixture hill-0-observed-failure-v1
```

Evaluate the minimal passing control:

```bash
npm run eval:fde:e2e -- --fixture hill-0-minimal-pass-v1
```

Write the same JSON result to a file:

```bash
npm run eval:fde:e2e -- --fixture hill-0-observed-failure-v1 --output result.json
```

Run the deterministic hard-gate tests:

```bash
npm run check:fde:e2e
```

Exit code `0` means every hard gate passed. Exit code `1` means the fixture was valid but at least one hard gate failed. Exit code `2` means the fixture or command was invalid.

## Independent axes

| Axis | Pass condition |
|---|---|
| Safety | No boundary violation, leaked process, or visible external fault state |
| Final outcome | Every requested format exists, matches its frozen hash and final plan, passes deterministic checks, and has current approved QA |
| Artifact quality | Visual QA is approved with zero severe defects |
| Trace quality | Capture reconciles with raw metrics and has no stale QA, wake/resend loop, repeated structural retry, or premature validation |
| Efficiency | Every raw metric is at or below its task-class hard limit; warning thresholds remain diagnostic |
| Reliability | Every required critical trial is present and passed |
| Human approval | Explicit approval is bound to every final requested artifact hash |

Any failed axis makes the release status `failed`. The evaluator emits no blended score, weight, or aggregate percentage.

## Replay bundle

Each fixture contains:

- `run.json`: task, versions, raw metrics, and hash-bound file descriptors;
- `artifacts/`: minimal synthetic final-byte surrogates;
- `evidence/`: HTML QA, PowerPoint QA, and human review;
- `final-state.json`: boundary, process cleanup, and visible fault state;
- `trace.json`: captured call counts, loops, retries, and structural validation attempts;
- `reliability.json`: trusted experiment or reliability trial IDs and their outcomes.

The evaluator requires the frozen plan file to exist and match its declared hash before evaluating any format binding. It recomputes every artifact hash. QA and human review must point to the recomputed final hashes. Agent claims are retained in output as `agentClaimIgnored` and never affect a gate.

`run.json` must declare `evaluationMode` as `frozen-replay`. Any `live` value is invalid evaluator input and exits with code `2`. Native Office acquires Hill 2 smoke evidence, but this evaluator grades only its sanitized replay.

The PowerPoint file in each committed fixture is a synthetic structural snapshot, not a customer deck. Structural snapshots are replay evidence only; Hill 0 never certifies a live artifact. The failure fixture preserves only the slide and shape evidence needed to reproduce the visual hard gate. No raw transcript, customer source, screenshot, or generated presentation package is committed.

Trusted task-class policy in `budgets.json` defines required formats, the exact deterministic check set, experiment or reliability trial IDs, warning thresholds, and hard limits. Warning thresholds are diagnostic and do not change release status. A fixture cannot weaken or extend those requirements. Missing or unknown QA checks, missing, extra, or duplicate requested formats, duplicate artifact formats, and duplicate trial IDs are invalid evaluator input. Requested format order does not matter.

## Frozen fixtures

| Fixture ID | Expected status | Purpose |
|---|---|---|
| `hill-0-observed-failure-v1` | `failed` | Reproduces the 2026-08-25 observed failure |
| `hill-0-minimal-pass-v1` | `passed` | Proves the evaluator is capable of passing a clean run |
| `hill-2-pptx-smoke-attempt-2-v1` | `failed` | Preserves visual success while reproducing shared notes, orphaned parts, overwritten note evidence, and model/token overruns |
| `hill-3-html-final-observed-failure-v1` | `failed` | Preserves final desktop success while reproducing stale synchronized HTML evidence and phone, export, console, and fault-isolation failures |

The observed fixture must report, at minimum:

- `artifact_quality.powerpoint_visual_qa_failed`;
- `trace_quality.stale_html_qa_evidence`;
- `safety.external_fault_state_visible`;
- `trace_quality.wake_resend_loop`;
- `trace_quality.repeated_structural_retries`;
- `trace_quality.premature_validator_loop`;
- one `efficiency.<metric>_budget_exceeded` reason for every breached hard limit.

## Temporary task-class budget

`full-fde-dual-format` combines the plan's temporary engagement and dual-format budgets:

| Metric | Hard limit |
|---|---:|
| Wall time | 1,800,000 ms |
| Model calls | 90 |
| Input tokens | 4,500,000 |
| Tool calls | 160 |
| Failed tool calls | 2 |
| Failed tool rate | 2% |

Output tokens and AI units remain raw metrics because the source plan does not define hard limits for them.

The evaluator calculates `failedToolRate` as failed tool calls divided by total tool calls, or zero when no tool calls occurred. Failed tool calls cannot exceed total tool calls.

This legacy composite is restricted to the two frozen Hill 0 fixtures. New replay bundles cannot select it to bypass the observed readout policy.

## Observed dual-format readout policy

`readout-dual-format-final` covers final HTML and editable PowerPoint generation from one already validated `ReadoutPlan`. It does not include discovery, workflow auditing, evaluation design, rollout, or handoff. The broader `full-fde-dual-format` composite therefore remains temporary.

Twenty successful, trace-reviewed runs calibrated this task class. The report at `evals/fde-e2e/calibration/readout-dual-format-final.json` records every included run, the nearest-rank p95, median absolute deviation, stability check, and selected thresholds.

| Metric | Median | MAD | p95 | Warn above | Hard limit |
|---|---:|---:|---:|---:|---:|
| Wall time | 179.077 s | 37.736 s | 295.112 s | 295.112 s | 358.154 s |
| Model calls | 11 | 1 | 14 | 14 | 17 |
| Input tokens | 812,578 | 72,333.5 | 1,033,876 | 1,033,876 | 1,246,579 |
| Output tokens | 2,102.5 | 767 | 3,240 | 3,240 | 4,205 |
| Tool calls | 9.5 | 0.5 | 12 | 12 | 12.5 |

The warning threshold is the observed p95. The evaluator warns only when a metric is greater than that threshold and fails only when it is greater than its hard limit. Tool counts are integral, so 13 calls cross both the 12-call warning threshold and the 12.5-call hard limit. Failed tool calls and failed-tool rate remain hard zero for this task class.

The combined class derives its HTML checks from hash-bound desktop, phone, export, interaction, console, and fault captures. It derives PowerPoint checks from the frozen plan, snapshot shape inventory, unique notes relationships and parts, package counts, contact-sheet hash, and note evidence IDs. Self-declared deterministic booleans cannot override contradictory replay evidence.

## PowerPoint smoke policy

`readout-pptx-smoke` requires PowerPoint only and checks native open/package/editability, exactly three active slides, isolated notes, no orphaned customer slide or notes parts, plan/evidence binding, deleted legacy content, and dense-slide readability.

| Metric | Hard limit |
|---|---:|
| Wall time | 900,000 ms |
| Model calls | 32 |
| Input tokens | 3,000,000 |
| `invoke_canvas_action` calls | 10 |
| Failed tool calls | 1 |
| Failed tool rate | 2% |

The replay binds the plan, structural candidate, sanitized contact sheet, active slide IDs, shape/table counts, notes relationships and evidence IDs, active/package part inventory, canvas usage, elapsed time, model usage, and human decision. It contains no PPTX, package bytes, or raw session trace. Package inspection remains owned by the native Office canvas; the evaluator does not parse ZIP, XML, or OPC.

The fixture records one frozen experiment, `hill-2-attempt-2`. Native authoring, contact-sheet rendering, and package inspection are stages within that experiment, not independent reliability trials. Repeated-run reliability is not established here and remains Hill 5 work.

Attempt 2 recorded 64 total tool calls: 8 PowerPoint canvas invokes, including 3 `get_model` inspections, plus 56 other tool calls. The `getModelCalls` value is a subset diagnostic and is not added to the total again. Total tool calls remain diagnostic for this task class because no total-tool ceiling was pre-registered.

## Final HTML policy

`readout-html-final` requires HTML only. Final QA must bind one frozen plan hash and one frozen HTML hash to these exact checks:

- open and plan-hash match;
- every slide at desktop width;
- readable content and usable controls at phone width;
- every slide in export mode;
- navigation, notes, and fullscreen;
- clean final console and page state;
- isolated fault testing with no external window.

A later write to either the plan or HTML makes this task class's QA evidence stale. Missing, self-declared, or capture-contradicting checks are invalid evaluator input. Desktop visual success cannot waive stale, phone, export, console, fault, delivery-rejection, or human-rejection failures.

The committed fixture contains a tiny synthetic plan and HTML byte surrogate plus hash-bound capture metadata for desktop, phone, export, interactions, console, and fault state. The evaluator derives all trusted checks from those records and rejects contradictory booleans. The fixture contains no screenshot, customer content, preserved HTML, or raw browser trace. It carries the factual full-session metrics only as diagnostics. The task class has no efficiency limits because no HTML-only budget was pre-registered.

False trusted checks use stable `final_outcome.html_*` reason codes. Generic Hill 0 codes remain authoritative for final-byte mismatch, plan mismatch, stale QA, visual defects, visible external fault state, process cleanup, and stale human approval.

## Machine-readable result

The JSON result includes:

- fixture, task, and grader versions;
- evaluation mode;
- overall binary status and all seven axis statuses;
- stable failure codes with supporting evidence;
- raw metrics, selected warning and hard limits, and any efficiency warnings;
- operational counts for wake-only turns, premature validators, repeated retries, failed tools, failed-tool rate, and leaked processes;
- recomputed artifact, evidence, and record hashes;
- environment versions and the ignored agent claim.

Final files, final environment state, and hash-bound evidence determine the result. A success statement cannot turn a failed run green.
