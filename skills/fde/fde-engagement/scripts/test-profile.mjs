#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const validator = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "validate-engagement-profile.mjs",
);

const evidence = [
  {
    id: "profile-001",
    statement: "The fictional company moves freight for regional manufacturers.",
    class: "synthetic",
    source: "Fictional example definition",
    observedAt: "2026-08-23",
    confidence: "high",
    disproof: "The fictional scenario is revised.",
    sensitivity: "public",
    authorized: true,
  },
  {
    id: "problem-001",
    statement: "The fictional exception queue has a 47-minute median routing time.",
    class: "synthetic",
    source: "Fictional workflow sample",
    observedAt: "2026-08-23",
    confidence: "high",
    disproof: "The fictional scenario is revised.",
    sensitivity: "public",
    authorized: true,
  },
  {
    id: "brand-001",
    statement: "The fictional brand uses navy, harbor blue, and signal orange.",
    class: "synthetic",
    source: "Fictional brand definition",
    observedAt: "2026-08-23",
    confidence: "high",
    disproof: "The fictional brand definition changes.",
    sensitivity: "public",
    authorized: true,
  },
];

const caseFile = { evidence };
const profile = {
  version: "1.0",
  engagementId: "lattice-harbor-exception-triage",
  fictional: true,
  asOf: "2026-08-23",
  customer: {
    displayName: "Lattice Harbor Logistics",
    legalName: "Lattice Harbor Logistics, Inc.",
    industry: "Freight logistics",
    businessModel: "Coordinates regional freight movements for manufacturers.",
    customerSegments: ["Regional manufacturers"],
    operatingFootprint: ["United States port and rail corridors"],
    businessUnit: "Network operations",
    website: "https://latticeharbor.example",
    evidenceIds: ["profile-001"],
  },
  problem: {
    title: "Shipment exception triage",
    decision: "Approve a four-week supervised triage pilot",
    outcome: "Route shipment exceptions faster without changing commitment authority.",
    baseline: "47-minute median first routing time",
    affectedWorkflow: "Network operations exception queue",
    failureModes: ["Wrong queue assignment"],
    consequences: ["Delayed shipment recovery"],
    priorAttempts: ["Shared spreadsheet routing rules"],
    constraints: ["Customer commitments remain human-authorized"],
    nonGoals: ["Autonomous customer commitments"],
    fitHypothesis: "Embedded workflow evidence is required before deployment.",
    alternativesConsidered: ["Process repair", "Standard rules automation"],
    evidenceIds: ["problem-001"],
  },
  stakeholders: [
    {
      kind: "sponsor",
      role: "VP Network Operations",
      responsibility: "Owns the operating outcome.",
      decisionAuthority: "Approves the pilot.",
      incentivesAndRisks: "Balances recovery speed and service risk.",
      evidenceIds: ["profile-001"],
    },
    {
      kind: "operator",
      role: "Exception dispatcher",
      responsibility: "Routes shipment exceptions.",
      decisionAuthority: "Confirms every pilot recommendation.",
      incentivesAndRisks: "Balances queue speed and routing accuracy.",
      evidenceIds: ["profile-001"],
    },
    {
      kind: "technical-owner",
      role: "Director of Operations Systems",
      responsibility: "Owns integrations and support.",
      decisionAuthority: "Approves technical release readiness.",
      incentivesAndRisks: "Limits incidents and maintenance burden.",
      evidenceIds: ["profile-001"],
    },
    {
      kind: "decision-maker",
      role: "VP Network Operations",
      responsibility: "Decides whether the pilot begins.",
      decisionAuthority: "Final pilot go or no-go.",
      incentivesAndRisks: "Owns customer service performance.",
      evidenceIds: ["profile-001"],
    },
  ],
  systems: [
    {
      name: "Atlas TMS",
      role: "Records shipments and exception status.",
      sourceOfTruth: true,
      owner: "Operations Systems",
      evidenceIds: ["profile-001"],
    },
  ],
  brand: {
    source: "fictional-defined",
    authorized: true,
    wordmark: "LATTICE HARBOR",
    logoPath: "",
    primaryColor: "#0B1F33",
    secondaryColor: "#087E8B",
    accentColor: "#FF7A45",
    riskColor: "#B4471A",
    backgroundColor: "#F4F7F8",
    textColor: "#132A3A",
    fontFamily: "Aptos",
    tone: ["direct", "operational", "measured"],
    requiredFooter: "FICTIONAL DEMONSTRATION",
    confidentialityLabel: "FICTIONAL CUSTOMER READOUT",
    prohibitedUses: ["Do not present the company or metrics as real."],
    evidenceIds: ["brand-001"],
    styleReference: {
      source: "",
      authorized: false,
      scope: "none",
      reusedAssets: [],
    },
  },
  readout: {
    audience: "customer",
    decision: "Approve a four-week supervised triage pilot",
    format: "deck",
    deliveryFormats: ["pptx", "html"],
    asOf: "2026-08-23",
    confidentiality: "FICTIONAL CUSTOMER READOUT",
  },
  openQuestions: [],
  profileEvidenceIds: ["profile-001", "problem-001", "brand-001"],
};

const tests = [
  {
    name: "accepts a complete fictional branded profile",
    mutate: () => {},
    expectedStatus: 0,
    expectedText: "ready for customer deck",
  },
  {
    name: "rejects missing business model",
    mutate: (data) => {
      data.customer.businessModel = "";
    },
    expectedStatus: 1,
    expectedText: "customer.businessModel",
  },
  {
    name: "rejects unresolved profile questions",
    mutate: (data) => {
      data.openQuestions = ["Who owns the pilot decision?"];
    },
    expectedStatus: 1,
    expectedText: "openQuestions must be empty",
  },
  {
    name: "rejects deck without brand authorization",
    mutate: (data) => {
      data.brand.authorized = false;
    },
    expectedStatus: 1,
    expectedText: "requires authorized branding",
  },
  {
    name: "rejects weak text contrast",
    mutate: (data) => {
      data.brand.backgroundColor = "#FFFFFF";
      data.brand.textColor = "#CCCCCC";
    },
    expectedStatus: 1,
    expectedText: "4.5:1 contrast",
  },
  {
    name: "rejects a missing decision maker",
    mutate: (data) => {
      data.stakeholders = data.stakeholders.filter(
        (item) => item.kind !== "decision-maker",
      );
    },
    expectedStatus: 1,
    expectedText: "stakeholders requires kind: decision-maker",
  },
  {
    name: "rejects mismatched readout decision",
    mutate: (data) => {
      data.readout.decision = "Approve production";
    },
    expectedStatus: 1,
    expectedText: "must match problem.decision",
  },
  {
    name: "rejects deck without a presentation delivery format",
    mutate: (data) => {
      data.readout.deliveryFormats = ["markdown"];
    },
    expectedStatus: 1,
    expectedText: "requires pptx or html delivery",
  },
  {
    name: "rejects asset reuse from design-only reference",
    mutate: (data) => {
      data.brand.styleReference = {
        source: "User-provided reference.pptx",
        authorized: true,
        scope: "design-language-only",
        reusedAssets: ["logo.svg"],
      };
    },
    expectedStatus: 1,
    expectedText: "cannot list reused assets",
  },
  {
    name: "rejects real profile built from synthetic evidence",
    mutate: (data) => {
      data.fictional = false;
      data.brand.source = "customer-provided";
    },
    expectedStatus: 1,
    expectedText: "requires real evidence",
  },
];

const directory = await mkdtemp(join(tmpdir(), "fde-profile-"));
const casePath = join(directory, "case.json");
await writeFile(casePath, JSON.stringify(caseFile));
let failed = false;

try {
  for (const test of tests) {
    const data = structuredClone(profile);
    test.mutate(data);
    const profilePath = join(
      directory,
      `${test.name.replaceAll(/\W+/g, "-")}.json`,
    );
    await writeFile(profilePath, JSON.stringify(data));

    const result = spawnSync(
      process.execPath,
      [validator, casePath, profilePath],
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
} finally {
  await rm(directory, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
