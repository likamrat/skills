#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const validator = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "validate-case-file.mjs",
);
const sourcePreflight = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "preflight-sources.mjs",
);

const completeCase = {
  version: "1.0",
  mode: "engage",
  phase: "deploy",
  gate: {
    status: "passed",
    reason: "Supervised rollout evidence satisfies the deploy gate.",
    evidenceIds: ["pilot-001"],
  },
  classification: {
    verdict: "FDE",
    reason: "The outcome requires embedded engineering and can create reusable primitives.",
    alternativesConsidered: ["standard implementation"],
  },
  sourceIntake: {
    approvedRoot: ".",
    manifestPath: "source-manifest.json",
    manifestSha256: "",
    status: "clear",
    screenedAt: "",
    reviewedBy: "eval fixture author",
    sources: [{ sourceId: "source-001", path: "source.txt" }],
  },
  evidence: [
    {
      id: "obs-001",
      statement: "Operators manually reconcile failed records.",
      class: "direct_observation",
      source: "Observed workflow session",
      observedAt: "2026-08-23 during operator shadowing",
      confidence: "high",
      disproof: "System records show automated reconciliation",
      sensitivity: "internal",
      authorized: true,
    },
    {
      id: "pilot-001",
      statement: "Five analysts completed a supervised one-week pilot.",
      class: "system_record",
      source: "Pilot telemetry",
      observedAt: "2026-08-23 after pilot completion",
      confidence: "high",
      disproof: "Pilot telemetry cannot be reproduced",
      sensitivity: "internal",
      authorized: true,
    },
  ],
  outcomeContract: {
    outcome: "Reduce failed-record resolution time",
    baseline: { value: "8 hours median", source: "Incident records" },
    target: "2 hours median",
    sponsor: "Operations VP",
    operator: "Operations analyst",
    operatingOwner: "Operations engineering lead",
    valueMechanism: "Lower incident cost",
    constraints: [],
    nonGoals: [],
    stopConditions: [],
  },
  decisionTree: {
    nextQuestionNumber: 3,
    nodes: [
      {
        id: "qualify-fit",
        branch: "engagement-fit",
        questionNumber: 1,
        question: "Does this outcome require embedded engineering?",
        prerequisites: [],
        evidenceNeeded: ["Observed operator policy exceptions"],
        evidenceReady: true,
        recommendation: "Use FDE because the policy logic is embedded in operator practice",
        exampleKind: "rule",
        exampleStatus: "evidence-backed",
        concreteExample:
          "Plain language: Embedded delivery fits when policy exceptions require operator judgment. Programmatic: if policy_exception_requires_operator_judgment then delivery = FDE",
        status: "settled",
        answer: "FDE",
        deferredReason: "",
        deferredOwner: "",
        evidenceIds: ["obs-001"],
        reopenIf: "The workflow becomes a standard product configuration",
      },
      {
        id: "qualify-outcome",
        branch: "outcome",
        questionNumber: 2,
        question: "Which measured outcome defines success?",
        prerequisites: ["qualify-fit"],
        evidenceNeeded: ["Incident resolution baseline"],
        evidenceReady: true,
        recommendation: "Use median resolution time",
        exampleKind: "query",
        exampleStatus: "evidence-backed",
        concreteExample:
          "Plain language: Measure the middle incident's elapsed resolution time. Programmatic: median_resolution_hours = median(resolved_at - opened_at)",
        status: "settled",
        answer: "Reduce median resolution time from 8 hours to 2 hours",
        deferredReason: "",
        deferredOwner: "",
        evidenceIds: ["obs-001"],
        reopenIf: "Incident cost becomes the primary business objective",
      },
    ],
    frontier: [],
    rounds: [
      {
        id: "round-1",
        status: "answered",
        nodeIds: ["qualify-fit", "qualify-outcome"],
      },
    ],
  },
  domainModel: {
    reconciliation: {
      status: "current",
      asOf: "2026-08-23",
      reason: "Reconciled after the supervised pilot review",
      evidenceIds: ["obs-001", "pilot-001"],
    },
    terms: [
      {
        id: "term-failure-category",
        lifecycle: "active",
        lastVerifiedAt: "2026-08-23",
        lifecycleReason: "Verified against the observed workflow",
        supersededBy: "",
        term: "Failure category",
        definition: "The operational reason a record cannot complete processing",
        avoid: ["Error type"],
        examples: ["Missing supplier record"],
        evidenceIds: ["obs-001"],
      },
    ],
    actors: [
      {
        id: "actor-operations-analyst",
        lifecycle: "active",
        lastVerifiedAt: "2026-08-23",
        lifecycleReason: "Verified during operator shadowing",
        supersededBy: "",
        name: "Operations analyst",
        responsibility: "Investigates and resolves failed records",
        authority: "May change a failure category but not queue ownership",
        incentivesAndRisks: "Balances resolution time against misrouting risk",
        workflowParticipation: "Investigates records and selects a resolution",
        evidenceIds: ["obs-001"],
      },
    ],
    systems: [
      {
        id: "system-operations-console",
        lifecycle: "active",
        lastVerifiedAt: "2026-08-23",
        lifecycleReason: "Verified against pilot telemetry",
        supersededBy: "",
        name: "Operations console",
        role: "Displays the failure queue and records resolution",
        sourceOfTruth: true,
        owner: "Operations engineering",
        dataRead: ["Failed record"],
        dataWritten: ["Resolution"],
        knownDrift: [],
        evidenceIds: ["obs-001"],
      },
    ],
    boundaries: [
      {
        id: "boundary-queue-ownership",
        lifecycle: "active",
        lastVerifiedAt: "2026-08-23",
        lifecycleReason: "Verified against the supervised pilot scope",
        supersededBy: "",
        name: "Queue ownership",
        inside: "Category recommendation",
        outside: "Changing the queue owner",
        owner: "Operations lead",
        crossingMechanism: "Manual queue reassignment",
        evidenceIds: ["obs-001"],
      },
    ],
    relationships: [
      {
        id: "relationship-analyst-resolves-record",
        lifecycle: "active",
        lastVerifiedAt: "2026-08-23",
        lifecycleReason: "Verified during operator shadowing",
        supersededBy: "",
        subject: "Operations analyst",
        verb: "resolves",
        object: "Failed record",
        evidenceIds: ["obs-001"],
      },
    ],
    conflicts: [],
  },
  fieldJudgment: {
    entries: [
      {
        id: "judgment-observation-001",
        kind: "firsthand-observation",
        authorRole: "FDE",
        origin: "human-confirmed",
        statement:
          "Operators kept the console open but used local context to interpret failure categories.",
        context: "Operator shadowing during workflow audit",
        whyItMatters:
          "The routing decision depends on practice that is absent from the system record.",
        evidenceIds: ["obs-001"],
        customerSafe: true,
      },
      {
        id: "judgment-rationale-001",
        kind: "decision-rationale",
        authorRole: "FDE",
        origin: "human-confirmed",
        statement:
          "The design limits the model to category recommendation because queue ownership remains human authority.",
        context: "Responsibility allocation review",
        whyItMatters:
          "The boundary prevents the pilot from changing operational ownership.",
        evidenceIds: ["obs-001"],
        customerSafe: true,
      },
      {
        id: "judgment-surprise-001",
        kind: "surprise",
        authorRole: "FDE",
        origin: "human-confirmed",
        statement:
          "The dominant failure was missing operational context rather than an inaccurate category rule.",
        context: "Supervised pilot retrospective",
        whyItMatters:
          "The next iteration should improve context retrieval before increasing model complexity.",
        evidenceIds: ["pilot-001"],
        customerSafe: true,
      },
    ],
    retrospective: {
      status: "captured",
      reason:
        "The supervised pilot changed the team's diagnosis of the dominant failure.",
      evidenceIds: ["pilot-001"],
    },
  },
  operatingMap: {
    steps: [
      {
        name: "Classify failed record",
        actor: "Operations analyst",
        trigger: "A record enters the failure queue",
        system: "Operations console",
        exceptions: ["Unknown failure code"],
        failures: ["Wrong queue assignment"],
        evidenceIds: ["obs-001"],
      },
    ],
    unknowns: [],
  },
  allocationMatrix: {
    steps: [
      {
        name: "Recommend failure category",
        assignment: "hybrid",
        reason: "Text varies, while final ownership remains human",
        failureModes: ["Wrong category"],
        recovery: "Route to manual triage",
        owner: "Operations lead",
      },
    ],
  },
  architecture: {
    integrations: ["Operations console API"],
    identityAndPermissions: ["Read failures; write recommendations only"],
    securityControls: ["Tenant isolation"],
    observability: ["Decision and tool-call trace"],
    recovery: ["Resume from queue item"],
    rollback: ["Disable recommendation feature flag"],
  },
  evalPlan: {
    riskBasis: "Incorrect routing delays incident recovery",
    cases: [
      {
        id: "normal-1",
        cohort: "normal",
        expectedBehavior: "Recommend the known category",
        consequence: "Low",
        evidenceIds: ["obs-001"],
      },
      {
        id: "edge-1",
        cohort: "edge",
        expectedBehavior: "Preserve an uncommon but valid category",
        consequence: "Medium",
        evidenceIds: ["obs-001"],
      },
      {
        id: "incomplete-1",
        cohort: "incomplete",
        expectedBehavior: "Request missing information",
        consequence: "Medium",
        evidenceIds: ["obs-001"],
      },
      {
        id: "ambiguous-1",
        cohort: "ambiguous",
        expectedBehavior: "Escalate conflicting evidence",
        consequence: "Medium",
        evidenceIds: ["obs-001"],
      },
      {
        id: "high-risk-1",
        cohort: "high-risk",
        expectedBehavior: "Block autonomous reassignment",
        consequence: "High",
        evidenceIds: ["obs-001"],
      },
    ],
    passCriteria: ["No autonomous reassignment", "All unknowns escalate"],
    invariants: ["The system never changes queue ownership"],
    failureCategories: ["Wrong category", "Missing escalation"],
    escalationRules: ["Unknown codes route to analyst"],
    results: [
      { caseId: "normal-1", outcome: "pass", evidence: "Expected category returned" },
      { caseId: "edge-1", outcome: "pass", evidence: "Rare category preserved" },
      { caseId: "incomplete-1", outcome: "pass", evidence: "Missing field requested" },
      { caseId: "ambiguous-1", outcome: "escalated", evidence: "Conflict routed to analyst" },
      { caseId: "high-risk-1", outcome: "escalated", evidence: "Reassignment blocked" },
    ],
    unresolvedSevereFailures: [],
    releaseRecommendation: "Proceed to supervised pilot",
  },
  deployment: {
    stage: "supervised",
    stageEvidenceIds: ["pilot-001"],
    owner: "Operations engineering lead",
    monitoring: ["Routing quality", "Escalation rate"],
    humanReview: ["Analyst approves every recommendation"],
    rollbackTested: true,
    adoptionMeasures: ["Weekly active analysts"],
  },
  handoff: {
    owner: "Operations engineering lead",
    runbook: "runbooks/failure-triage.md",
    training: ["Analyst training completed"],
    knownLimitations: [],
    realizedOutcomes: ["Median resolution time fell from 8 hours to 3 hours"],
    nextLoopDecision: "improve",
    accepted: true,
  },
  productization: {
    reviewed: true,
    items: [
      {
        component: "Failure-category recommendation",
        classification: "product candidate",
        decision: "Repeat with a second customer before generalizing",
      },
    ],
  },
  assignments: [],
  decisions: [],
  unknowns: [],
};

const tests = [
  {
    name: "accepts complete supervised deploy case",
    mutate: () => {},
    expectedStatus: 0,
    expectedText: 'satisfies every gate through "deploy"',
  },
  {
    name: "rejects deploy without eval results",
    mutate: (data) => {
      data.evalPlan.results = [];
    },
    expectedStatus: 1,
    expectedText: "evalPlan.results",
  },
  {
    name: "rejects offline deploy stage",
    mutate: (data) => {
      data.deployment.stage = "offline";
    },
    expectedStatus: 1,
    expectedText: "cannot remain offline",
  },
  {
    name: "rejects unresolved severe failures",
    mutate: (data) => {
      data.evalPlan.unresolvedSevereFailures = ["Incorrect payment approval"];
    },
    expectedStatus: 1,
    expectedText: "unresolvedSevereFailures",
  },
  {
    name: "rejects invalid evidence vocabulary",
    mutate: (data) => {
      data.evidence[0].class = "banana";
      data.evidence[0].confidence = "sky-high";
    },
    expectedStatus: 1,
    expectedText: "must be one of",
  },
  {
    name: "rejects null gate evidence",
    mutate: (data) => {
      data.architecture.observability = [null];
      data.deployment.monitoring = [null];
    },
    expectedStatus: 1,
    expectedText: "architecture.observability",
  },
  {
    name: "rejects non-FDE advancement",
    mutate: (data) => {
      data.classification.verdict = "not qualified yet";
    },
    expectedStatus: 1,
    expectedText: "only an FDE verdict",
  },
  {
    name: "rejects a blocked human gate",
    mutate: (data) => {
      data.gate.status = "blocked";
      data.gate.reason = "The accountable owner has not approved rollout.";
    },
    expectedStatus: 1,
    expectedText: "gate.status must be passed",
  },
  {
    name: "rejects an open decision frontier",
    mutate: (data) => {
      data.decisionTree.nodes[0].status = "open";
      data.decisionTree.nodes[0].answer = "";
      data.decisionTree.frontier = ["qualify-fit"];
    },
    expectedStatus: 1,
    expectedText: "cannot contain open nodes",
  },
  {
    name: "rejects more than three questions in a round",
    mutate: (data) => {
      for (const number of [3, 4]) {
        const node = structuredClone(data.decisionTree.nodes[1]);
        node.id = `qualify-extra-${number}`;
        node.questionNumber = number;
        node.question = `Which additional decision ${number} is required?`;
        node.prerequisites = [];
        data.decisionTree.nodes.push(node);
        data.decisionTree.rounds[0].nodeIds.push(node.id);
      }
      data.decisionTree.nextQuestionNumber = 5;
    },
    expectedStatus: 1,
    expectedText: "requires one to three node IDs",
  },
  {
    name: "rejects reused question numbers",
    mutate: (data) => {
      data.decisionTree.nodes[1].questionNumber = 1;
      data.decisionTree.nextQuestionNumber = 2;
    },
    expectedStatus: 1,
    expectedText: "question numbers must be unique",
  },
  {
    name: "rejects skipped question numbers",
    mutate: (data) => {
      data.decisionTree.nodes[1].questionNumber = 3;
      data.decisionTree.nextQuestionNumber = 3;
    },
    expectedStatus: 1,
    expectedText: "continuous sequence from 1",
  },
  {
    name: "rejects an asked question without a concrete example",
    mutate: (data) => {
      delete data.decisionTree.nodes[0].concreteExample;
    },
    expectedStatus: 1,
    expectedText: "concreteExample is required",
  },
  {
    name: "rejects a concrete example without both forms",
    mutate: (data) => {
      data.decisionTree.nodes[0].concreteExample =
        "Programmatic: if exception then delivery = FDE";
    },
    expectedStatus: 1,
    expectedText: "must include Plain language and Programmatic",
  },
  {
    name: "rejects an incomplete domain model",
    mutate: (data) => {
      data.domainModel.actors = [];
    },
    expectedStatus: 1,
    expectedText: "domainModel.actors",
  },
  {
    name: "rejects audit without firsthand human source material",
    mutate: (data) => {
      data.fieldJudgment.entries = data.fieldJudgment.entries.filter(
        (entry) => entry.kind !== "firsthand-observation",
      );
    },
    expectedStatus: 1,
    expectedText: "firsthand observation or operator quote",
  },
  {
    name: "rejects agent-generated field judgment",
    mutate: (data) => {
      data.fieldJudgment.entries[0].origin = "agent-generated";
    },
    expectedStatus: 1,
    expectedText: "origin must be human-provided or human-confirmed",
  },
  {
    name: "rejects design without a recorded decision rationale",
    mutate: (data) => {
      data.fieldJudgment.entries = data.fieldJudgment.entries.filter(
        (entry) => entry.kind !== "decision-rationale",
      );
    },
    expectedStatus: 1,
    expectedText: "decision-rationale before design",
  },
  {
    name: "rejects a stale domain entry",
    mutate: (data) => {
      data.domainModel.terms[0].lifecycle = "stale";
      data.domainModel.terms[0].lifecycleReason =
        "A policy update requires verification";
    },
    expectedStatus: 1,
    expectedText: "cannot remain stale",
  },
  {
    name: "accepts a superseded domain entry with active replacement",
    mutate: (data) => {
      const replacement = structuredClone(data.domainModel.terms[0]);
      replacement.id = "term-failure-reason";
      replacement.term = "Failure reason";
      replacement.definition =
        "The current operational reason a record cannot complete processing";
      replacement.lifecycleReason =
        "Replaced the ambiguous failure-category term";
      data.domainModel.terms[0].lifecycle = "superseded";
      data.domainModel.terms[0].lifecycleReason =
        "Replaced after the pilot terminology review";
      data.domainModel.terms[0].supersededBy = replacement.id;
      data.domainModel.terms.push(replacement);
    },
    expectedStatus: 0,
    expectedText: 'satisfies every gate through "deploy"',
  },
  {
    name: "rejects a cyclic decision tree",
    mutate: (data) => {
      data.decisionTree.nodes[0].prerequisites = ["qualify-outcome"];
    },
    expectedStatus: 1,
    expectedText: "dependency cycle",
  },
  {
    name: "rejects an unresolved domain conflict",
    mutate: (data) => {
      data.domainModel.conflicts = [
        {
          description: "Approval has two meanings",
          status: "deferred",
          evidenceIds: ["obs-001"],
          resolution: "",
          owner: "",
          revisitWhen: "",
        },
      ];
    },
    expectedStatus: 1,
    expectedText: "domainModel.conflicts[0].owner",
  },
  {
    name: "rejects audit without source preflight",
    mutate: (data) => {
      data.phase = "audit";
      delete data.sourceIntake;
    },
    expectedStatus: 1,
    expectedText: "sourceIntake is required",
  },
  {
    name: "rejects fabricated source manifest hash",
    mutate: (data) => {
      data.phase = "audit";
      data.sourceIntake.manifestSha256 = "a".repeat(64);
    },
    expectedStatus: 1,
    expectedText: "does not match the manifest",
  },
  {
    name: "rejects missing preflight source mapping",
    mutate: (data) => {
      data.phase = "audit";
      data.sourceIntake.sources = [];
    },
    expectedStatus: 1,
    expectedText: "must map every manifest source",
  },
  {
    name: "rejects missing preflighted source file",
    mutate: (data) => {
      data.phase = "audit";
      data.sourceIntake.sources[0].path = "missing-source.txt";
    },
    expectedStatus: 1,
    expectedText: "cannot be read",
  },
  {
    name: "accepts complete handoff case",
    mutate: (data) => {
      data.phase = "handoff";
    },
    expectedStatus: 0,
    expectedText: 'satisfies every gate through "handoff"',
  },
  {
    name: "rejects handoff without outcomes",
    mutate: (data) => {
      data.phase = "handoff";
      data.handoff.realizedOutcomes = [];
      data.productization.items = [];
    },
    expectedStatus: 1,
    expectedText: "realizedOutcomes",
  },
  {
    name: "rejects handoff with pending field retrospective",
    mutate: (data) => {
      data.phase = "handoff";
      data.fieldJudgment.retrospective.status = "pending";
    },
    expectedStatus: 1,
    expectedText: "must be captured or none-observed",
  },
  {
    name: "rejects captured retrospective without reflection",
    mutate: (data) => {
      data.phase = "handoff";
      data.fieldJudgment.entries = data.fieldJudgment.entries.filter(
        (entry) => entry.kind !== "surprise",
      );
    },
    expectedStatus: 1,
    expectedText: "captured retrospective requires",
  },
];

const directory = await mkdtemp(join(tmpdir(), "fde-validator-"));
let failed = false;

try {
  const sourcePath = join(directory, "source.txt");
  const manifestPath = join(directory, "source-manifest.json");
  await writeFile(
    sourcePath,
    "Operators manually reconcile failed records before authorization.\n",
  );
  const preflight = spawnSync(
    process.execPath,
    [
      sourcePreflight,
      "--root",
      directory,
      "--output",
      manifestPath,
      sourcePath,
    ],
    { cwd: directory, encoding: "utf8" },
  );
  if (preflight.status !== 0) {
    console.error(`${preflight.stdout}${preflight.stderr}`);
    process.exit(1);
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  completeCase.sourceIntake.manifestSha256 = manifest.manifestSha256;
  completeCase.sourceIntake.screenedAt = manifest.generatedAt;

  for (const test of tests) {
    const data = structuredClone(completeCase);
    test.mutate(data);
    const file = join(directory, `${test.name.replaceAll(/\W+/g, "-")}.json`);
    await writeFile(file, JSON.stringify(data));

    const result = spawnSync(process.execPath, [validator, file], {
      encoding: "utf8",
    });
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
} finally {
  await rm(directory, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
