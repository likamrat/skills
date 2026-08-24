#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const validator = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "validate-readout-brief.mjs",
);
const renderer = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "render-readout.mjs",
);

const caseFile = {
  phase: "evaluate",
  gate: {
    status: "blocked",
    reason: "High-risk cohort evidence is incomplete.",
    evidenceIds: ["obs-001"],
  },
  evidence: [
    {
      id: "obs-001",
      statement: "Approval is used for two different authorities.",
      class: "direct_observation",
      source: "Workflow observation",
      observedAt: "2026-08-22",
      confidence: "high",
      disproof: "The operating policy defines one authority.",
      authorized: true,
      sensitivity: "internal",
    },
    {
      id: "internal-001",
      statement: "A reusable approval primitive may reduce repeated delivery.",
      class: "inference",
      source: "Internal FDE review",
      observedAt: "2026-08-23",
      confidence: "medium",
      disproof: "A second engagement requires a different control model.",
      authorized: true,
      sensitivity: "confidential",
    },
    {
      id: "assignment-001",
      statement: "The claims operations lead accepted the policy task for 2026-08-27.",
      class: "stakeholder_report",
      source: "Engagement planning meeting",
      observedAt: "2026-08-23",
      confidence: "high",
      disproof: "The meeting record is corrected.",
      authorized: true,
      sensitivity: "internal",
    },
    {
      id: "internal-assignment-001",
      statement: "The product lead owns the internal signal review for 2026-09-03.",
      class: "stakeholder_report",
      source: "Internal product planning",
      observedAt: "2026-08-23",
      confidence: "high",
      disproof: "The planning record is reassigned.",
      authorized: true,
      sensitivity: "confidential",
    },
  ],
  domainModel: {
    reconciliation: {
      status: "current",
      asOf: "2026-08-23",
      reason: "Reconciled for the readout",
      evidenceIds: ["obs-001"],
    },
    terms: [
      {
        id: "term-approval",
        lifecycle: "active",
        lastVerifiedAt: "2026-08-23",
        lifecycleReason: "Verified against the observed workflow",
        supersededBy: "",
        term: "Approval",
        definition: "A workflow label with two observed authorities",
        avoid: [],
        examples: ["Recommendation", "Authorization"],
        evidenceIds: ["obs-001"],
      },
    ],
    actors: [],
    systems: [],
    boundaries: [],
    relationships: [],
    conflicts: [],
  },
  assignments: [
    {
      id: "assign-claims-policy",
      subject: "Supply authorization policy",
      owner: "Claims operations lead",
      timing: "2026-08-27",
      evidenceIds: ["assignment-001"],
    },
    {
      id: "assign-product-signal",
      subject: "Review reusable approval primitive",
      owner: "Product lead",
      timing: "2026-09-03",
      evidenceIds: ["internal-assignment-001"],
    },
  ],
};

const customerBrief = {
  version: "1.0",
  audience: "customer",
  format: "both",
  engagementName: "Synthetic claims engagement",
  purpose: "Decide whether to begin a supervised pilot",
  asOf: "2026-08-23",
  confidentiality: "Customer confidential",
  caseFilePhase: "evaluate",
  gateStatus: "blocked",
  gateStatusReason: "High-risk cohort evidence is incomplete.",
  audienceGateReason: "High-risk test evidence is incomplete.",
  gateCustomerSafe: true,
  gateEvidenceIds: ["obs-001"],
  includedSections: [
    "executive-summary",
    "outcome-and-scope",
    "current-state",
    "findings",
    "evaluation",
    "risks",
    "decisions",
    "next-steps",
    "evidence-register"
  ],
  sectionContent: {
    "outcome-and-scope": [
      {
        label: "Outcome",
        value: "Clarify approval authority before pilot design",
        evidenceIds: ["obs-001"],
        customerSafe: true,
      },
    ],
    "current-state": [
      {
        label: "Authority language",
        value: "Approval is used for two different authorities",
        evidenceIds: ["obs-001"],
        customerSafe: true,
      },
    ],
    evaluation: [
      {
        label: "Gate evidence",
        value: "High-risk cohort evidence remains incomplete",
        evidenceIds: ["obs-001"],
        customerSafe: true,
      },
    ],
  },
  approvedEvidenceIds: ["obs-001", "assignment-001"],
  findings: [
    {
      id: "finding-1",
      title: "Approval language is ambiguous",
      statement: "The workflow uses approval for two different authorities.",
      consequence: "The agent boundary cannot be set safely.",
      evidenceIds: ["obs-001"],
      confidence: "high",
      customerSafe: true,
    },
  ],
  recommendations: [
    {
      id: "recommendation-1",
      action: "Define recommendation and authorization as separate steps",
      rationale: "The actions carry different authority and risk.",
      evidenceIds: ["obs-001"],
      owner: "Claims operations lead",
      timing: "2026-08-27",
      assignmentId: "assign-claims-policy",
      decisionNeeded: true,
      alternativesConsidered: ["Keep the current overloaded term"],
      changesIf: "Policy evidence proves the actions share one authority",
      customerSafe: true,
    },
  ],
  risks: [
    {
      id: "risk-1",
      risk: "Unauthorized payment action",
      impact: "Financial loss and control breach",
      control: "Recommendation-only scope",
      residualRisk: "Incorrect recommendation still requires reviewer attention",
      owner: "Claims operations lead",
      assignmentId: "assign-claims-policy",
      evidenceIds: ["obs-001"],
      customerSafe: true,
    },
  ],
  decisionsNeeded: [
    {
      decision: "Confirm the payment authorization owner",
      owner: "Claims operations lead",
      due: "2026-08-27",
      assignmentId: "assign-claims-policy",
      options: ["Manager", "Adjuster below threshold"],
      recommendation: "Manager until policy evidence says otherwise",
      evidenceIds: ["obs-001"],
      customerSafe: true
    },
  ],
  nextSteps: [
    {
      action: "Supply the authorization policy",
      owner: "Claims operations lead",
      due: "2026-08-27",
      assignmentId: "assign-claims-policy",
      dependency: "None",
      definitionOfDone: "Policy is linked to the decision-tree node",
      status: "open",
      evidenceIds: ["obs-001"],
      customerSafe: true
    },
  ],
  productSignals: [],
  redactions: ["Removed internal staffing notes"],
  generatedArtifacts: [],
};

const tests = [
  {
    name: "accepts customer report and deck brief",
    mutate: () => {},
    expectedStatus: 0,
    expectedText: "structurally ready for customer both",
  },
  {
    name: "rejects unapproved evidence",
    mutate: (brief) => {
      brief.findings[0].evidenceIds = ["internal-001"];
    },
    expectedStatus: 1,
    expectedText: "not approved",
  },
  {
    name: "rejects internal product signals in customer output",
    mutate: (brief) => {
      brief.productSignals = [
        {
          signal: "Reusable approval primitive",
          engagementRefs: [
            {
              engagementId: "synthetic-claims",
              evidenceIds: ["obs-001"],
            },
          ],
          disposition: "hold",
          owner: "Unassigned",
          assignmentId: "",
          evidenceIds: ["obs-001"],
        },
      ];
    },
    expectedStatus: 1,
    expectedText: "cannot contain productSignals",
  },
  {
    name: "rejects ownerless next step",
    mutate: (brief) => {
      brief.nextSteps[0].owner = "";
    },
    expectedStatus: 1,
    expectedText: "nextSteps[0].owner",
  },
  {
    name: "rejects unresolved placeholders",
    mutate: (brief) => {
      brief.engagementName = "{{ENGAGEMENT}}";
    },
    expectedStatus: 1,
    expectedText: "template placeholders",
  },
  {
    name: "accepts internal product signals for leadership",
    mutate: (brief) => {
      brief.audience = "fde-leadership";
      brief.approvedEvidenceIds.push(
        "internal-001",
        "internal-assignment-001",
      );
      brief.includedSections.push("product-signals");
      brief.productSignals = [
        {
          signal: "Reusable approval primitive",
          engagementRefs: [
            {
              engagementId: "synthetic-claims",
              evidenceIds: ["internal-001"],
            },
          ],
          disposition: "hold",
          owner: "Product lead",
          assignmentId: "assign-product-signal",
          evidenceIds: ["internal-001"],
        },
      ];
    },
    expectedStatus: 0,
    expectedText: "structurally ready for fde-leadership both",
  },
  {
    name: "rejects one-customer productization",
    mutate: (brief) => {
      brief.audience = "fde-leadership";
      brief.approvedEvidenceIds.push(
        "internal-001",
        "internal-assignment-001",
      );
      brief.includedSections.push("product-signals");
      brief.productSignals = [
        {
          signal: "Reusable approval primitive",
          engagementRefs: [
            {
              engagementId: "synthetic-claims",
              evidenceIds: ["internal-001"],
            },
          ],
          disposition: "productize",
          owner: "Product lead",
          assignmentId: "assign-product-signal",
          evidenceIds: ["internal-001"],
        },
      ];
    },
    expectedStatus: 1,
    expectedText: "must be hold with one engagement",
  },
  {
    name: "rejects technical handoff deck",
    mutate: (brief) => {
      brief.audience = "technical-handoff";
      brief.format = "deck";
    },
    expectedStatus: 1,
    expectedText: "supports report format only",
  },
  {
    name: "rejects later phase section",
    mutate: (brief) => {
      brief.includedSections.push("deployment-and-adoption");
      brief.sectionContent["deployment-and-adoption"] = [
        {
          label: "Production status",
          value: "Ready",
          evidenceIds: ["obs-001"],
          customerSafe: true,
        },
      ];
    },
    expectedStatus: 1,
    expectedText: "not available during evaluate",
  },
  {
    name: "rejects a stale domain model",
    mutate: () => {},
    mutateCase: (data) => {
      data.domainModel.terms[0].lifecycle = "stale";
      data.domainModel.terms[0].lifecycleReason =
        "A policy update requires verification";
    },
    expectedStatus: 1,
    expectedText: "cannot remain stale",
  },
  {
    name: "rejects unreconciled report date",
    mutate: () => {},
    mutateCase: (data) => {
      data.domainModel.reconciliation.asOf = "2026-08-22";
    },
    expectedStatus: 1,
    expectedText: "must match the readout as-of date",
  },
  {
    name: "rejects assignment mismatch",
    mutate: (brief) => {
      brief.nextSteps[0].owner = "VP Claims";
    },
    expectedStatus: 1,
    expectedText: "owner must match the case assignment",
  },
  {
    name: "rejects unsafe gate explanation",
    mutate: (brief) => {
      brief.gateCustomerSafe = false;
    },
    expectedStatus: 1,
    expectedText: "customer-safe gate explanation",
  },
  {
    name: "rejects missing next steps section",
    mutate: (brief) => {
      brief.includedSections = brief.includedSections.filter(
        (section) => section !== "next-steps",
      );
    },
    expectedStatus: 1,
    expectedText: "must contain next-steps",
  },
  {
    name: "rejects aliased engagement IDs",
    mutate: (brief) => {
      brief.audience = "fde-leadership";
      brief.approvedEvidenceIds.push(
        "internal-001",
        "internal-assignment-001",
      );
      brief.includedSections.push("product-signals");
      brief.productSignals = [
        {
          signal: "Reusable approval primitive",
          engagementRefs: [
            {
              engagementId: "claims",
              evidenceIds: ["internal-001"],
            },
            {
              engagementId: "claims ",
              evidenceIds: ["internal-001"],
            },
          ],
          disposition: "productize",
          owner: "Product lead",
          assignmentId: "assign-product-signal",
          evidenceIds: ["internal-001"],
        },
      ];
    },
    expectedStatus: 1,
    expectedText: "canonical lowercase kebab-case",
  },
];

const directory = await mkdtemp(join(tmpdir(), "fde-reporting-"));
const casePath = join(directory, "case.json");
let failed = false;

try {
  for (const test of tests) {
    const testCase = structuredClone(caseFile);
    const brief = structuredClone(customerBrief);
    test.mutateCase?.(testCase);
    test.mutate(brief);
    const briefPath = join(
      directory,
      `${test.name.replaceAll(/\W+/g, "-")}.json`,
    );
    await writeFile(casePath, JSON.stringify(testCase));
    await writeFile(briefPath, JSON.stringify(brief));

    const result = spawnSync(
      process.execPath,
      [validator, casePath, briefPath],
      { encoding: "utf8" },
    );
    const output = `${result.stdout}${result.stderr}`;
    const passed =
      result.status === test.expectedStatus &&
      output.includes(test.expectedText);

    console.log(`${passed ? "PASS" : "FAIL"}: ${test.name}`);
    if (!passed) {
      failed = true;
      console.error(output);
    }
  }

  await writeFile(casePath, JSON.stringify(caseFile));
  const renderBriefPath = join(directory, "valid-render-brief.json");
  await writeFile(renderBriefPath, JSON.stringify(customerBrief));
  const renderResult = spawnSync(
    process.execPath,
    [renderer, casePath, renderBriefPath],
    { encoding: "utf8" },
  );
  const renderPassed =
    renderResult.status === 0 &&
    renderResult.stdout.includes("[obs-001]") &&
    renderResult.stdout.includes("# PowerPoint readout outline") &&
    renderResult.stdout.includes(
      "| Supply the authorization policy | Claims operations lead | 2026-08-27 |",
    ) &&
    renderResult.stdout.includes("Keep the current overloaded term") &&
    renderResult.stdout.includes(
      "Policy evidence proves the actions share one authority",
    ) &&
    !renderResult.stdout.includes("## Product signals");

  console.log(
    `${renderPassed ? "PASS" : "FAIL"}: renders deterministic customer output`,
  );
  if (!renderPassed) {
    failed = true;
    console.error(`${renderResult.stdout}${renderResult.stderr}`);
  }

  const deckBrief = structuredClone(customerBrief);
  deckBrief.format = "deck";
  const deckBriefPath = join(directory, "valid-deck-brief.json");
  await writeFile(deckBriefPath, JSON.stringify(deckBrief));
  const deckResult = spawnSync(
    process.execPath,
    [renderer, casePath, deckBriefPath],
    { encoding: "utf8" },
  );
  const deckPassed =
    deckResult.status === 0 &&
    deckResult.stdout.startsWith("# PowerPoint readout outline") &&
    deckResult.stdout.includes(
      "| Action | Owner | Due | Status | Dependency | Definition of done | Evidence |",
    ) &&
    deckResult.stdout.includes("[obs-001]") &&
    !deckResult.stdout.includes("## Product signals");

  console.log(
    `${deckPassed ? "PASS" : "FAIL"}: renders provenance-safe deck outline`,
  );
  if (!deckPassed) {
    failed = true;
    console.error(`${deckResult.stdout}${deckResult.stderr}`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
