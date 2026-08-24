#!/usr/bin/env node

import { findStyleIssues } from "./readout-style.mjs";

const emDash = String.fromCodePoint(0x2014);

const cases = [
  {
    name: "accepts evidence-led prose",
    text: "The claims log records separate recommendation and authorization events. [log-001]",
    expected: 0,
  },
  {
    name: "rejects stock transformation language",
    text: "In today's rapidly evolving landscape, we can leverage AI to unlock the potential of a robust solution.",
    expectedMinimum: 3,
  },
  {
    name: "rejects named No AI Slop patterns with fixes",
    text: [
      "Here's the thing, the launch marks a pivotal moment.",
      "What most people get wrong is distribution.",
      "The best part: it learns.",
      "The launch adds search, highlighting our commitment.",
      "Experts agree the app serves as a centralized hub.",
      "We will utilize a robust process. Simply, we begin.",
      "Plot twist: the future isn't coming. It's already here.",
      "Ultimately, this is the key point.",
    ].join("\n"),
    expectedRules: [
      "throat-clearing",
      "importance-puffery",
      "faux-insight",
      "colon-reveal",
      "superficial-analysis",
      "weasel-attribution",
      "fake-strong-verb",
      "banned-ai-vocabulary",
      "often-empty-adverb",
      "rhetorical-setup",
      "fake-profound-ending",
      "summary-recap-ending",
      "interpretive-metadiscourse",
    ],
  },
  {
    name: "rejects bare source link dumps",
    text: [
      "## Sources",
      "",
      "- [One](https://example.com/one)",
      "- Two: https://example.com/two",
      "- https://example.com/three",
    ].join("\n"),
    expectedRules: ["bare-source-list"],
  },
  {
    name: "rejects chatbot residue",
    text: "Certainly! Great question, here is the report.",
    expectedMinimum: 2,
  },
  {
    name: "rejects report punctuation theatrics",
    text: `First ${emDash} transform. Next ${emDash} scale. Finally ${emDash} win!`,
    expectedMinimum: 2,
  },
  {
    name: "accepts precise inequality notation",
    text: "Reject when amount != approver_limit. [rule-001]",
    expected: 0,
  },
  {
    name: "accepts literal not-just construction",
    text: "Adoption requires not just login but sustained supervised use. [metric-004]",
    expected: 0,
  },
  {
    name: "rejects evidence-free generic claims",
    text: "The workflow has significant inefficiencies that create meaningful risk.",
    expectedMinimum: 2,
  },
  {
    name: "allows supported generic wording",
    text: "The workflow has significant risk. [risk-002]",
    expected: 0,
  },
  {
    name: "rejects em dashes in docs",
    text: `A ${emDash} B ${emDash} C is a literal notation used by this document.`,
    profile: "docs",
    expectedMinimum: 1,
  },
  {
    name: "rejects transient repository positioning",
    text: "Forward deployed engineering is the first role. More roles and skills will follow.",
    profile: "docs",
    expectedMinimum: 2,
  },
  {
    name: "rejects transient indexing status",
    text: "The listing may return 404 until the repository has been indexed.",
    profile: "docs",
    expectedMinimum: 1,
  },
  {
    name: "rejects vague method metaphors",
    text: "This role-specific operating system uses a conversational engine to create compounding learning and find stable seams.",
    profile: "docs",
    expectedMinimum: 4,
  },
  {
    name: "rejects slogan-shaped operating rules",
    text: "Close both loops to protect trust and reach a trusted production outcome with product leverage.",
    profile: "docs",
    expectedMinimum: 4,
  },
  {
    name: "accepts durable repository copy",
    text: "Each skill states what evidence to collect, which decisions require human judgment, and what conditions stop the work.",
    profile: "docs",
    expected: 0,
  },
];

let failed = false;

for (const test of cases) {
  const issues = findStyleIssues(test.text, {
    profile: test.profile ?? "report",
  });
  const passed =
    test.expectedRules !== undefined
      ? test.expectedRules.every((rule) =>
          issues.some(
            (issue) =>
              issue.rule === rule &&
              typeof issue.suggestion === "string" &&
              issue.suggestion.length > 0,
          ),
        )
      : test.expected !== undefined
        ? issues.length === test.expected
        : issues.length >= test.expectedMinimum;

  console.log(`${passed ? "PASS" : "FAIL"}: ${test.name}`);
  if (!passed) {
    failed = true;
    console.error(JSON.stringify(issues, null, 2));
  }
  if (
    issues.some(
      (issue) =>
        typeof issue.suggestion !== "string" || issue.suggestion.length === 0,
    )
  ) {
    failed = true;
    console.error(`FAIL: ${test.name} returned a finding without a repair`);
  }
}

process.exit(failed ? 1 : 0);
