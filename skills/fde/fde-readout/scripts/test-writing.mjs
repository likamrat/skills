#!/usr/bin/env node

import {
  findWritingIssues,
  maskLiteralContent,
} from "./writing-style.mjs";

const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

const clean = [
  "The audit log records authorization separately above $25,000. [ev-001]",
  "The FDE recommends a supervised release because two escalation cases failed.",
].join("\n");
check(
  findWritingIssues(clean).length === 0,
  "specific evidence-bound prose should pass",
);

const dirty = [
  "Here's the thing, the launch marks a pivotal moment.",
  "What most people get wrong is distribution.",
  "The best part: it learns.",
  "The launch adds search, highlighting our commitment.",
  "Experts agree the app serves as a centralized hub.",
  "We will utilize a robust process. Simply, we begin.",
  "Plot twist: the future isn't coming. It's already here.",
  "Ultimately, this is the key point.",
].join("\n");
const dirtyIssues = findWritingIssues(dirty);
const expectedRules = [
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
];
for (const rule of expectedRules) {
  check(
    dirtyIssues.some(
      (issue) =>
        issue.rule === rule &&
        typeof issue.suggestion === "string" &&
        issue.suggestion.length > 0,
    ),
    `dirty prose should report ${rule} with a repair`,
  );
}
check(
  dirtyIssues.every(
    (issue) =>
      typeof issue.suggestion === "string" && issue.suggestion.length > 0,
  ),
  "every writing finding should include a repair",
);

const literal = [
  "Use `What most people get wrong` as a test fixture.",
  "```text",
  "The future isn't coming. It's already here.",
  "```",
  "[Source](https://example.com/realm)",
].join("\n");
check(
  findWritingIssues(literal, { profile: "docs" }).length === 0,
  "inline code, fenced code, and link targets should be masked",
);
check(
  maskLiteralContent(literal).split("\n").length === literal.split("\n").length,
  "masking should preserve line numbers",
);

const sourceDump = [
  "## Public research baseline",
  "",
  "- [One](https://example.com/one)",
  "- Two: https://example.com/two",
  "- https://example.com/three",
].join("\n");
check(
  findWritingIssues(sourceDump, { profile: "docs" }).some(
    (issue) => issue.rule === "bare-source-list",
  ),
  "bare source link dumps should be reported",
);

if (failures.length > 0) {
  console.error("Writing-style tests failed:");
  failures.forEach((failure, index) =>
    console.error(`${index + 1}. ${failure}`),
  );
  process.exit(1);
}

console.log("Writing-style tests passed.");
