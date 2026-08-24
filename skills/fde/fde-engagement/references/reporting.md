# Forward deployed engineering (FDE) reporting and readouts

Read this file in `report` mode.

The purpose of a readout is to support a decision. It is not a success story, activity log, or dump of the case file.

## Choose the output contract

Confirm:

- validated engagement profile;
- audience;
- decision or action the artifact must support;
- as-of date;
- current engagement phase and gate status;
- confidentiality;
- requested format.

If the decision is unclear, ask one question before drafting.

## Audience profiles

### Customer

Include:

- agreed outcome, baseline, and scope;
- current-state findings;
- evidence-backed recommendation;
- target operating model;
- eval or pilot evidence;
- risks and controls;
- decisions required from the customer;
- next steps with owners and dates.

Exclude:

- internal account strategy;
- margin, staffing, or utilization analysis;
- unapproved product-roadmap discussion;
- candid stakeholder or political assessments;
- other customers' information;
- internal confidence debates not ready for customer review.

### FDE leadership

Include:

- engagement health and current gate;
- customer outcome and realized versus projected value;
- strongest evidence and unresolved uncertainty;
- stakeholder alignment and adoption risk;
- delivery health, staffing, and escalation needs;
- bespoke maintenance burden;
- repeated product signals and reuse evidence;
- commercial or strategic implications when authorized;
- decisions leadership must make;
- next two-week plan.

Do not turn activity volume into progress.

### Technical handoff

Include:

- system boundary and architecture;
- data lineage, identity, and permissions;
- responsibility allocation;
- eval suite and known failure modes;
- monitoring, alerts, incident path, and rollback;
- operating limits and human controls;
- maintenance, upgrade, and support ownership;
- training and acceptance status.

The standard technical handoff output is a report. Do not select deck or both unless a dedicated technical-handoff deck template has been supplied.

## Standard artifacts

| Output | Template | Typical length |
|---|---|---|
| Customer findings report | `assets/templates/customer-findings-report.md` | 3-6 pages |
| FDE leadership update | `assets/templates/fde-leadership-update.md` | 1-2 pages |
| Technical handoff report | `assets/templates/technical-handoff-report.md` | As needed |
| Customer or leadership deck | `assets/templates/readout-deck.md` | 8-12 slides |
| Native PowerPoint template | `assets/fde-readout-template.pptx` | 12 slides |

Delete sections that do not support the audience's decision. Do not fill space.

## Reporting workflow

1. Create and validate `assets/engagement-profile.template.json` against the case file.
2. Snapshot the case file and state its phase.
3. Select only evidence authorized for this audience.
4. Create a readout brief from `assets/readout-brief.template.json`.
5. Link every finding, recommendation, and risk to evidence IDs.
6. Separate projected value from realized value.
7. Record open decisions and blocked claims.
8. Validate the profile and brief:

```text
cd <skill-directory>
node scripts/validate-engagement-profile.mjs path/to/case-file.json path/to/engagement-profile.json
node scripts/validate-readout-brief.mjs path/to/case-file.json path/to/readout-brief.json
```

9. Render the matching report or deck template.
10. Run the audience, evidence, brand, and visual checks below.
11. Obtain the accountable FDE's approval before external delivery.

For deterministic Markdown output:

```text
node scripts/render-readout.mjs path/to/case-file.json path/to/readout-brief.json path/to/readout.md
```

The renderer validates the brief before rendering and emits the evidence IDs and owner/date table required by the templates. Do not replace it with a free-form rewrite.

The brief also declares `includedSections`. The validator rejects sections that belong to phases later than the case-file phase.

Every readout requires the `next-steps` section. A readout without accountable follow-through is incomplete.

The named case file and explicitly attached evidence form a closed source set. Do not browse or borrow `evals/`, examples, other case files, or prior customer narratives to make the report feel complete.

The readout brief must copy `caseFilePhase`, `gateStatus`, `gateStatusReason`, and `gateEvidenceIds` from the case file. It may not improve or reinterpret the gate status. `audienceGateReason` is the approved audience-safe rendering; customer and handoff outputs require `gateCustomerSafe: true`.

## Phase fidelity

Only report artifacts that exist at or before the current phase.

| Current phase | May report | Must not imply |
|---|---|---|
| Qualify | Outcome, fit, baseline, sponsor, constraints | Observed workflow or selected design |
| Audit | Current workflow, domain model, findings, unknowns | Approved future state or tested architecture |
| Design | Responsibility boundaries, controls, proposed architecture | Working implementation or eval performance |
| Build | Implemented slice, traces, recovery design | Evaluation or rollout readiness without results |
| Evaluate | Results, failures, release recommendation | Production adoption or realized value |
| Deploy | Rollout evidence, controls, adoption signals | Completed handoff or productization |
| Handoff | Realized outcomes, ownership, product disposition | Unsupported expansion |

If a template contains a later-phase section, delete it or label it `Not yet available: blocked by <gate>`. Never populate it from a typical workflow.

In particular, an audit readout must not invent responsibility allocation, architecture, eval performance, autonomy, monitoring, or rollback. Show the design-gate blockers instead.

For each non-standard section in `includedSections`, add evidence-linked entries under `sectionContent.<section>` with `label`, `value`, `evidenceIds`, and `customerSafe`.

## Findings standard

A finding contains:

- one atomic statement;
- evidence IDs;
- evidence class and confidence inherited from the case file;
- consequence for outcome, risk, or decision;
- customer-safe flag.

The statement must be a faithful paraphrase of the linked evidence. An evidence ID is not a license to add nearby facts.

Display literal case-file IDs beside every consequential finding, for example `[log-014]`. Source names without IDs are insufficient for traceability.

The brief shape also includes `id`, `title`, `consequence`, the weakest linked evidence `confidence`, and `customerSafe`.

Avoid findings such as "the process is inefficient." Prefer a measured or directly observed statement such as "three operators re-key the same identifier into two systems, creating an unvalidated source-of-truth change."

## Recommendations standard

A recommendation contains:

- action;
- rationale;
- supporting evidence;
- alternatives considered;
- owner;
- timing;
- decision required;
- what would change the recommendation.
- customer-safe flag;
- assignment ID for any named owner or timing.

Do not disguise an assumption as a recommendation.

The assignment ID must point to a case-file assignment whose exact owner and timing match the output. Decisions use the same discipline: decision, options, recommendation, evidence IDs, owner, due date, assignment ID, and customer-safe flag.

## Next-steps standard

Every next step needs:

- one accountable owner;
- due date or event;
- dependency;
- observable definition of done;
- status.
- evidence IDs supporting the action;
- assignment ID supporting any named owner or date;
- customer-safe flag.

Avoid owners such as "team" or "customer."

If no owner or date exists in the case file, write `Unassigned` or `Not scheduled` and add assignment as a decision. Do not invent a plausible role or deadline. Sponsor, operator, and operating-owner fields describe engagement roles; they do not assign every report decision or action.

One customer observation may be recorded as an **unproven product hypothesis** with disposition `hold`. Product signals record distinct `engagementRefs`, each with an engagement ID and approved evidence IDs, plus disposition (`hold`, `investigate`, `productize`, or `reject`), owner assignment, and evidence IDs. Productization requires evidence from multiple distinct engagements; never upgrade a one-customer pattern to a reusable capability in a report.

Do not convert a settled decision into a next step. Reopen it only when the decision-tree node's `reopenIf` condition is evidenced.

## Deck rules

- One decision or message per slide.
- Use assertion titles, not topic labels.
- Put the recommendation on the executive-summary slide.
- Show current state before future state.
- Show evidence by cohort, not only aggregate metrics.
- Keep severe risks out of the appendix.
- Put decisions and next steps before supporting detail.
- Put evidence IDs in speaker notes or the appendix.
- Label projected, pilot, and production metrics visibly.
- Delete the internal leadership slide from customer decks.

## Brand rules

The engagement profile is the source of truth for presentation branding.

- Customer-facing decks use the approved customer wordmark, palette, typeface, footer, and confidentiality label.
- Leadership decks may use the FDE organization's brand only when the profile approves it.
- `customer-provided` brand material takes precedence over public material.
- `authorized-public` material requires the FDE to confirm that use is allowed for the artifact.
- `fictional-defined` branding must label the company, metrics, and deck as fictional.
- `unbranded` is acceptable for reports and slide outlines, not for a requested branded `.pptx`.
- Keep text/background contrast at or above 4.5:1.
- Use the accent color to show decisions or emphasis and the risk color only for risk.
- Do not add decorative stock imagery, invented logos, gradients, or visual claims absent from evidence.
- Record the brand source and approval in speaker notes or the profile evidence register.
- When a reference PPTX is supplied, record whether it is design-language-only or approved for named asset reuse.
- Match slide size, title hierarchy, spacing, and recurring component geometry before decorative details.
- Recreate design-language-only references with original shapes; do not carry over text, logos, screenshots, media, or hidden content.

When a PowerPoint tool is available:

1. copy `assets/fde-readout-template.pptx`;
2. preserve the canonical template;
3. apply the validated profile's brand treatment;
4. replace placeholders using the validated brief;
5. add diagrams only from case-file evidence;
6. add the required footer and confidentiality label to every slide;
7. record evidence and brand provenance in speaker notes;
8. inspect all slide notes for internal content;
9. render every slide and inspect overflow, hierarchy, contrast, and brand consistency before delivery.

When no PowerPoint tool is available, produce the Markdown slide outline and say that it is not a `.pptx`.

When synchronized interactive HTML and editable PowerPoint are requested, use `fde-readout` when installed. This reporting workflow remains self-contained for Markdown and the generic PowerPoint template.

## Final audience check

### Every output

- as-of date and current gate are visible;
- every consequential claim traces to approved evidence;
- unknowns and blocked claims remain visible;
- recommendations are distinguishable from facts;
- next steps have owners and dates;
- next steps are rendered in a table and use `Unassigned` / `Not scheduled` when the source set has no owner or date;
- no unsupported precision or success language appears.
- no workflow step, metric, owner, date, or product signal appears unless it is present in the closed source set or clearly marked unknown;
- brand use matches the validated profile;
- every slide carries the required footer and confidentiality label;
- fictional examples are labeled on the cover, footer, and evidence register;

### Customer output

- every finding, recommendation, and risk is marked customer-safe;
- no internal product, staffing, margin, commercial, or stakeholder analysis remains;
- restricted or unapproved evidence is absent;
- the customer can identify decisions they own.

### Leadership output

- engagement health reflects outcomes and gates, not activity;
- product signals include repetition evidence;
- resource requests state the decision and consequence;
- customer-sensitive judgments are necessary, factual, and appropriately restricted.
