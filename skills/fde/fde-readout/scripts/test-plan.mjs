#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const validator = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "validate-readout-plan.mjs",
);

const evidence = [
  {
    id: "profile-001",
    statement: "The fictional company operates a shipment exception workflow.",
    class: "synthetic",
    source: "Fictional example",
    confidence: "high",
    sensitivity: "public",
    authorized: true,
  },
  {
    id: "finding-001",
    statement: "The fictional workflow uses three sources.",
    class: "synthetic",
    source: "Fictional example",
    confidence: "high",
    sensitivity: "public",
    authorized: true,
  },
  {
    id: "decision-001",
    statement: "The fictional sponsor owns the pilot decision.",
    class: "synthetic",
    source: "Fictional example",
    confidence: "high",
    sensitivity: "public",
    authorized: true,
  },
  {
    id: "brand-001",
    statement: "The fictional brand is approved.",
    class: "synthetic",
    source: "Fictional example",
    confidence: "high",
    sensitivity: "public",
    authorized: true,
  },
];

const slideBase = {
  customerSafe: true,
  notes: "Fictional speaker notes.",
  judgmentIds: [],
};

const plan = {
  version: "1.0",
  id: "fictional-readout",
  title: "Fictional decision readout",
  fictional: true,
  asOf: "2026-08-23",
  audience: "customer",
  purpose: "Approve a supervised pilot",
  confidentiality: "Fictional customer readout",
  density: "speaker-led",
  delivery: ["html", "pptx"],
  brand: {
    source: "fictional-defined",
    authorized: true,
    wordmark: "FICTIONAL CO",
    fontFamily: "Segoe UI",
    colors: {
      ink: "#0B1020",
      system: "#2563EB",
      decision: "#B91C8C",
      risk: "#D92D20",
      paper: "#FFFFFF",
      muted: "#4B5563",
      line: "#D1D5DB",
    },
    requiredFooter: "FICTIONAL DEMONSTRATION",
    evidenceIds: ["brand-001"],
    styleReference: {
      source: "",
      authorized: false,
      scope: "none",
      reusedAssets: [],
    },
  },
  evidence,
  humanContext: [
    {
      id: "judgment-observation-001",
      kind: "firsthand-observation",
      authorRole: "FDE",
      origin: "human-confirmed",
      statement:
        "The operator assembled one decision from sources that did not agree.",
      whyItMatters:
        "The workflow problem is missing shared context, not just missing prose.",
      evidenceIds: ["finding-001"],
      customerSafe: true,
    },
    {
      id: "judgment-rationale-001",
      kind: "decision-rationale",
      authorRole: "FDE",
      origin: "human-confirmed",
      statement:
        "The pilot keeps confirmation human because the evidence does not support transferring authority.",
      whyItMatters:
        "The recommendation follows the observed authority boundary.",
      evidenceIds: ["decision-001", "finding-001"],
      customerSafe: true,
    },
  ],
  slides: [
    {
      ...slideBase,
      id: "cover",
      family: "cover",
      title: "Fictional decision readout",
      evidenceIds: ["profile-001", "decision-001"],
      judgmentIds: ["judgment-observation-001"],
      content: {
        subtitle: "Recommendation-only pilot",
        decision: "Approve a supervised pilot",
      },
    },
    {
      ...slideBase,
      id: "decision",
      family: "decision",
      title: "Approve a supervised pilot",
      evidenceIds: ["decision-001", "finding-001"],
      judgmentIds: ["judgment-rationale-001"],
      content: {
        recommendation: "APPROVE",
        bullets: ["Recommendation only", "Human confirmation"],
        facts: [
          {
            label: "Owner",
            value: "Operations sponsor",
            evidenceIds: ["decision-001"],
          },
        ],
      },
    },
    {
      ...slideBase,
      id: "workflow",
      family: "workflow",
      title: "Three sources feed one decision",
      evidenceIds: ["finding-001"],
      judgmentIds: ["judgment-observation-001"],
      content: {
        nodes: [
          { id: "source-a", label: "Source A", detail: "Data", role: "source" },
          { id: "source-b", label: "Source B", detail: "Message", role: "source" },
          { id: "operator", label: "Operator", detail: "Reviews", role: "actor" },
          { id: "decision", label: "Decision", detail: "Confirms", role: "decision" },
        ],
        edges: [
          { from: "source-a", to: "operator", kind: "system" },
          { from: "source-b", to: "operator", kind: "system" },
          { from: "operator", to: "decision", kind: "decision" },
        ],
      },
    },
    {
      ...slideBase,
      id: "risks",
      family: "risks",
      title: "The pilot contains the highest risk",
      evidenceIds: ["finding-001"],
      judgmentIds: ["judgment-rationale-001"],
      content: {
        items: [
          {
            risk: "Wrong recommendation",
            impact: "Delayed work",
            control: "Human confirmation",
            residualRisk: "Review takes time",
            evidenceIds: ["finding-001"],
          },
        ],
        stopCondition: {
          statement: "Stop on an uncontained severe failure.",
          evidenceIds: ["finding-001"],
        },
      },
    },
    {
      ...slideBase,
      id: "evidence",
      family: "evidence",
      title: "Evidence remains visible",
      evidenceIds: ["profile-001", "finding-001", "decision-001", "brand-001"],
      judgmentIds: [
        "judgment-observation-001",
        "judgment-rationale-001",
      ],
      content: {
        groups: [
          {
            label: "Profile",
            items: ["Company context"],
            evidenceIds: ["profile-001"],
          },
          {
            label: "Decision",
            items: ["Owner and recommendation"],
            evidenceIds: ["decision-001", "finding-001"],
          },
        ],
        controls: ["Closed source set", "Fictional labels"],
      },
    },
  ],
};

const tests = [
  {
    name: "accepts complete plan",
    mutate: () => {},
    expectedStatus: 0,
    expectedText: "5 slides; html + pptx",
  },
  {
    name: "accepts authorized fictional unbranded plan",
    mutate: (data) => {
      data.brand.source = "unbranded";
      data.brand.wordmark = "";
      data.evidence[3].statement =
        "The readout owner approved a neutral original design.";
    },
    expectedStatus: 0,
    expectedText: "5 slides; html + pptx",
  },
  {
    name: "accepts evidence-bound real external unbranded plan",
    mutate: (data) => {
      data.fictional = false;
      data.brand.source = "unbranded";
      data.brand.wordmark = "";
      for (const item of data.evidence) {
        item.class = "stakeholder_report";
        item.source = "Authorized customer source";
      }
    },
    expectedStatus: 0,
    expectedText: "5 slides; html + pptx",
  },
  {
    name: "rejects synthetic evidence in real external unbranded plan",
    mutate: (data) => {
      data.fictional = false;
      data.brand.source = "unbranded";
      data.brand.wordmark = "";
    },
    expectedStatus: 1,
    expectedText: "cannot be synthetic for a real external readout",
  },
  {
    name: "rejects unbranded wordmark",
    mutate: (data) => {
      data.brand.source = "unbranded";
      data.brand.wordmark = "PSEUDO BRAND";
    },
    expectedStatus: 1,
    expectedText: "brand.wordmark to be an empty string",
  },
  {
    name: "rejects unbranded logo",
    mutate: (data) => {
      data.brand.source = "unbranded";
      data.brand.wordmark = "";
      data.brand.logo = "logo.svg";
    },
    expectedStatus: 1,
    expectedText: "unbranded treatment cannot define a logo",
  },
  {
    name: "rejects unauthorized unbranded treatment",
    mutate: (data) => {
      data.brand.source = "unbranded";
      data.brand.wordmark = "";
      data.brand.authorized = false;
    },
    expectedStatus: 1,
    expectedText: "authorized brand treatment",
  },
  {
    name: "rejects fictional-defined empty wordmark",
    mutate: (data) => {
      data.brand.wordmark = "";
    },
    expectedStatus: 1,
    expectedText: "fictional-defined treatment requires brand.wordmark",
  },
  ...["customer-provided", "authorized-public"].flatMap((source) => [
    {
      name: `rejects ${source} empty wordmark`,
      mutate: (data) => {
        data.fictional = false;
        data.brand.source = source;
        data.brand.wordmark = "";
      },
      expectedStatus: 1,
      expectedText: `${source} treatment requires brand.wordmark`,
    },
    {
      name: `rejects unauthorized ${source} treatment`,
      mutate: (data) => {
        data.fictional = false;
        data.brand.source = source;
        data.brand.authorized = false;
      },
      expectedStatus: 1,
      expectedText: "authorized brand treatment",
    },
  ]),
  {
    name: "rejects unbranded asset reuse",
    mutate: (data) => {
      data.brand.source = "unbranded";
      data.brand.wordmark = "";
      data.brand.styleReference = {
        source: "reference.pptx",
        authorized: true,
        scope: "approved-asset-reuse",
        reusedAssets: ["logo.svg"],
      };
    },
    expectedStatus: 1,
    expectedText: "unbranded treatment cannot list reused assets",
  },
  {
    name: "keeps style reference authorization required",
    mutate: (data) => {
      data.brand.styleReference = {
        source: "reference.pptx",
        authorized: false,
        scope: "design-language-only",
        reusedAssets: [],
      };
    },
    expectedStatus: 1,
    expectedText: "styleReference requires authorization",
  },
  {
    name: "rejects unknown evidence",
    mutate: (data) => {
      data.slides[2].evidenceIds = ["missing-001"];
    },
    expectedStatus: 1,
    expectedText: "unknown evidence",
  },
  {
    name: "rejects unsafe customer slide",
    mutate: (data) => {
      data.slides[3].customerSafe = false;
    },
    expectedStatus: 1,
    expectedText: "must be customerSafe",
  },
  {
    name: "rejects bad slide order",
    mutate: (data) => {
      [data.slides[0], data.slides[1]] = [data.slides[1], data.slides[0]];
    },
    expectedStatus: 1,
    expectedText: "first slide must use family cover",
  },
  {
    name: "rejects workflow unknown node",
    mutate: (data) => {
      data.slides[2].content.edges[0].to = "missing-node";
    },
    expectedStatus: 1,
    expectedText: ".to is unknown",
  },
  {
    name: "rejects low contrast",
    mutate: (data) => {
      data.brand.colors.ink = "#CCCCCC";
    },
    expectedStatus: 1,
    expectedText: "4.5:1 contrast",
  },
  {
    name: "rejects asset reuse in design-only scope",
    mutate: (data) => {
      data.brand.styleReference = {
        source: "reference.pptx",
        authorized: true,
        scope: "design-language-only",
        reusedAssets: ["logo.svg"],
      };
    },
    expectedStatus: 1,
    expectedText: "cannot list reused assets",
  },
  {
    name: "rejects missing firsthand human context",
    mutate: (data) => {
      data.humanContext = data.humanContext.filter(
        (item) => item.kind !== "firsthand-observation",
      );
      for (const slide of data.slides) {
        slide.judgmentIds = slide.judgmentIds.filter(
          (id) => id !== "judgment-observation-001",
        );
      }
    },
    expectedStatus: 1,
    expectedText: "requires firsthand observation",
  },
  {
    name: "rejects agent-generated human context",
    mutate: (data) => {
      data.humanContext[0].origin = "agent-generated";
    },
    expectedStatus: 1,
    expectedText: "origin must be human-provided or human-confirmed",
  },
  {
    name: "rejects decision slide without human rationale",
    mutate: (data) => {
      data.slides[1].judgmentIds = [];
    },
    expectedStatus: 1,
    expectedText: "decision slide requires a decision-rationale",
  },
  {
    name: "accepts chart and table families",
    mutate: (data) => {
      data.slides.splice(
        data.slides.length - 1,
        0,
        {
          ...slideBase,
          id: "trend-chart",
          family: "chart",
          title: "Routing time declines",
          evidenceIds: ["finding-001"],
          content: {
            chartType: "line",
            categories: ["W1", "W2", "W3"],
            unit: "minutes",
            series: [
              {
                name: "Median routing",
                values: [47, 35, 24],
                evidenceIds: ["finding-001"],
              },
            ],
            insight: {
              statement: "Routing time declines across the fictional sample.",
              evidenceIds: ["finding-001"],
            },
          },
        },
        {
          ...slideBase,
          id: "evidence-table",
          family: "table",
          title: "Controls remain explicit",
          evidenceIds: ["finding-001"],
          content: {
            columns: ["Control", "Owner"],
            rows: [
              {
                cells: ["Human confirmation", "Operator"],
                evidenceIds: ["finding-001"],
              },
            ],
            insight: {
              statement: "The operator retains decision authority.",
              evidenceIds: ["finding-001"],
            },
          },
        },
      );
    },
    expectedStatus: 0,
    expectedText: "7 slides",
  },
  {
    name: "rejects mismatched chart values",
    mutate: (data) => {
      data.slides.splice(data.slides.length - 1, 0, {
        ...slideBase,
        id: "bad-chart",
        family: "chart",
        title: "Bad chart",
        evidenceIds: ["finding-001"],
        content: {
          chartType: "bar",
          categories: ["A", "B"],
          unit: "items",
          series: [
            {
              name: "Count",
              values: [1],
              evidenceIds: ["finding-001"],
            },
          ],
          insight: {
            statement: "The chart is invalid.",
            evidenceIds: ["finding-001"],
          },
        },
      });
    },
    expectedStatus: 1,
    expectedText: "values must match categories",
  },
];

const directory = await mkdtemp(join(tmpdir(), "fde-readout-plan-"));
let failed = false;

try {
  for (const test of tests) {
    const data = structuredClone(plan);
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
