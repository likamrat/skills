#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findStyleIssues } from "./readout-style.mjs";

const [casePath, briefPath, outputPath] = process.argv.slice(2);

if (!casePath || !briefPath || process.argv.includes("--help")) {
  console.log(
    "Usage: node scripts/render-readout.mjs <case-file.json> <readout-brief.json> [output.md]",
  );
  process.exit(casePath && briefPath ? 0 : 2);
}

const validator = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "validate-readout-brief.mjs",
);
const validation = spawnSync(
  process.execPath,
  [validator, casePath, briefPath],
  { encoding: "utf8" },
);

if (validation.status !== 0) {
  process.stderr.write(`${validation.stdout}${validation.stderr}`);
  process.exit(validation.status ?? 1);
}

const caseFile = JSON.parse(await readFile(resolve(casePath), "utf8"));
const brief = JSON.parse(await readFile(resolve(briefPath), "utf8"));
const evidenceById = new Map(
  (caseFile.evidence ?? []).map((item) => [item.id, item]),
);
const sections = new Set(brief.includedSections);
const builtInSections = new Set([
  "executive-summary",
  "findings",
  "risks",
  "decisions",
  "next-steps",
  "product-signals",
  "evidence-register",
]);
const sectionTitles = {
  "outcome-and-scope": "Outcome and scope",
  "current-state": "Current state",
  "target-operating-model": "Target operating model",
  implementation: "Implementation",
  evaluation: "Evaluation evidence",
  "deployment-and-adoption": "Deployment and adoption",
  handoff: "Handoff",
  "realized-outcomes": "Realized outcomes",
  productization: "Productization",
};

function cell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function evidence(ids) {
  return ids.map((id) => `[${id}]`).join(" ");
}

function pushTable(lines, headers, rows) {
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`|${headers.map(() => "---").join("|")}|`);
  for (const row of rows) {
    lines.push(`| ${row.map(cell).join(" | ")} |`);
  }
}

function renderReport() {
  const gateReason =
    brief.audience === "fde-leadership"
      ? brief.gateStatusReason
      : brief.audienceGateReason;
  const lines = [
    `# ${brief.engagementName}: ${brief.audience === "fde-leadership" ? "FDE leadership update" : brief.audience === "technical-handoff" ? "Technical handoff" : "Findings and next steps"}`,
    "",
    `**Audience:** ${brief.audience}`,
    `**As of:** ${brief.asOf}`,
    `**Phase:** ${brief.caseFilePhase}`,
    `**Gate:** ${brief.gateStatus} - ${gateReason} ${evidence(brief.gateEvidenceIds)}`,
    `**Confidentiality:** ${brief.confidentiality}`,
    "",
    "## Decision supported",
    "",
    brief.purpose,
    "",
  ];

  for (const section of brief.includedSections) {
    if (builtInSections.has(section)) continue;
    lines.push(`## ${sectionTitles[section] ?? section}`, "");
    pushTable(
      lines,
      ["Item", "Position", "Evidence"],
      brief.sectionContent[section].map((item) => [
        item.label,
        item.value,
        evidence(item.evidenceIds),
      ]),
    );
    lines.push("");
  }

  if (sections.has("findings")) {
    lines.push("## Findings", "");
    for (const finding of brief.findings) {
      lines.push(
        `### ${finding.title}`,
        "",
        `${finding.statement} ${evidence(finding.evidenceIds)}`,
        "",
        `**Consequence:** ${finding.consequence}`,
        `**Confidence:** ${finding.confidence}`,
        "",
      );
    }
  }

  lines.push("## Recommendations", "");
  pushTable(
    lines,
    ["Action", "Rationale", "Alternatives", "Reverses if", "Owner", "Timing", "Evidence"],
    brief.recommendations.map((item) => [
      item.action,
      item.rationale,
      item.alternativesConsidered.join("; ") || "None recorded",
      item.changesIf,
      item.owner,
      item.timing,
      evidence(item.evidenceIds),
    ]),
  );
  lines.push("");

  if (sections.has("risks")) {
    lines.push("## Risks and controls", "");
    pushTable(
      lines,
      ["Risk", "Impact", "Control", "Residual risk", "Owner", "Evidence"],
      brief.risks.map((item) => [
        item.risk,
        item.impact,
        item.control,
        item.residualRisk,
        item.owner,
        evidence(item.evidenceIds),
      ]),
    );
    lines.push("");
  }

  if (sections.has("decisions") && brief.decisionsNeeded.length > 0) {
    lines.push("## Decisions needed", "");
    pushTable(
      lines,
      ["Decision", "Options", "Recommendation", "Owner", "Due", "Evidence"],
      brief.decisionsNeeded.map((item) => [
        item.decision,
        item.options.join("; "),
        item.recommendation,
        item.owner,
        item.due,
        evidence(item.evidenceIds),
      ]),
    );
    lines.push("");
  }

  if (sections.has("next-steps")) {
    lines.push("## Next steps", "");
    pushTable(
      lines,
      ["Action", "Owner", "Due", "Dependency", "Definition of done", "Status", "Evidence"],
      brief.nextSteps.map((item) => [
        item.action,
        item.owner,
        item.due,
        item.dependency,
        item.definitionOfDone,
        item.status,
        evidence(item.evidenceIds),
      ]),
    );
    lines.push("");
  }

  if (
    brief.audience === "fde-leadership" &&
    sections.has("product-signals") &&
    brief.productSignals.length > 0
  ) {
    lines.push("## Product signals", "");
    pushTable(
      lines,
      ["Signal", "Engagements", "Repetition evidence", "Disposition", "Owner", "Evidence"],
      brief.productSignals.map((item) => [
        item.signal,
        item.engagementRefs.length,
        item.engagementRefs
          .map(
            (reference) =>
              `${reference.engagementId} ${evidence(reference.evidenceIds)}`,
          )
          .join("; "),
        item.disposition,
        item.owner,
        evidence(item.evidenceIds),
      ]),
    );
    lines.push("");
  }

  if (sections.has("evidence-register")) {
    lines.push("## Evidence register", "");
    pushTable(
      lines,
      ["ID", "Source", "Class", "Observed", "Confidence", "Sensitivity"],
      brief.approvedEvidenceIds.map((id) => {
        const item = evidenceById.get(id);
        return [
          id,
          item.source,
          item.class,
          item.observedAt,
          item.confidence,
          item.sensitivity,
        ];
      }),
    );
    lines.push("");
  }

  return lines;
}

function renderDeckOutline() {
  const gateReason =
    brief.audience === "fde-leadership"
      ? brief.gateStatusReason
      : brief.audienceGateReason;
  let slide = 1;
  const lines = [
    "# PowerPoint readout outline",
    "",
    "**No `.pptx` is produced by this renderer. Populate a copy of `assets/fde-readout-template.pptx` with a presentation tool.**",
    "",
    `## Slide ${slide++}: ${brief.engagementName}`,
    "",
    `- ${brief.audience}`,
    `- ${brief.asOf}`,
    `- ${brief.confidentiality}`,
    "",
    `## Slide ${slide++}: ${brief.gateStatus.toUpperCase()} - ${gateReason}`,
    "",
    `- Decision: ${brief.purpose}`,
    `- Evidence: ${evidence(brief.gateEvidenceIds)}`,
    `- Recommendation: ${brief.recommendations[0].action}`,
    "",
  ];

  for (const section of brief.includedSections) {
    if (builtInSections.has(section)) continue;
    lines.push(
      `## Slide ${slide++}: ${sectionTitles[section] ?? section}`,
      "",
      ...brief.sectionContent[section].map(
        (item) =>
          `- ${item.label}: ${item.value} ${evidence(item.evidenceIds)}`,
      ),
      "",
    );
  }

  if (sections.has("findings")) {
    lines.push(
      `## Slide ${slide++}: Evidence-backed findings`,
      "",
      ...brief.findings.map(
        (item) =>
          `- ${item.title}: ${item.statement} ${evidence(item.evidenceIds)}`,
      ),
      "",
    );
  }

  if (sections.has("risks")) {
    lines.push(
      `## Slide ${slide++}: Highest risks and controls`,
      "",
      ...brief.risks.map(
        (item) =>
          `- ${item.risk} -> ${item.control}; residual: ${item.residualRisk} ${evidence(item.evidenceIds)}`,
      ),
      "",
    );
  }

  lines.push(
    `## Slide ${slide++}: Recommendations`,
    "",
    ...brief.recommendations.map(
      (item) =>
        `- ${item.action}; alternatives: ${item.alternativesConsidered.join("; ") || "none recorded"}; reverses if: ${item.changesIf}; ${item.owner}, ${item.timing} ${evidence(item.evidenceIds)}`,
    ),
    "",
  );

  if (sections.has("decisions") && brief.decisionsNeeded.length > 0) {
    lines.push(
      `## Slide ${slide++}: Decisions needed`,
      "",
      ...brief.decisionsNeeded.map(
        (item) =>
          `- ${item.decision} - recommend ${item.recommendation}; ${item.owner}, ${item.due} ${evidence(item.evidenceIds)}`,
      ),
      "",
    );
  }

  lines.push(`## Slide ${slide++}: Next steps`, "");
  pushTable(
    lines,
    ["Action", "Owner", "Due", "Status", "Dependency", "Definition of done", "Evidence"],
    brief.nextSteps.map((item) => [
      item.action,
      item.owner,
      item.due,
      item.status,
      item.dependency,
      item.definitionOfDone,
      evidence(item.evidenceIds),
    ]),
  );
  lines.push("");

  if (
    brief.audience === "fde-leadership" &&
    sections.has("product-signals") &&
    brief.productSignals.length > 0
  ) {
    lines.push(
      `## Slide ${slide++}: Internal product signals`,
      "",
      "**INTERNAL ONLY**",
      "",
      ...brief.productSignals.map(
        (item) =>
          `- ${item.signal}: ${item.disposition}; ${item.engagementRefs
            .map(
              (reference) =>
                `${reference.engagementId} ${evidence(reference.evidenceIds)}`,
            )
            .join("; ")}; signal evidence ${evidence(item.evidenceIds)}`,
      ),
      "",
    );
  }

  lines.push(
    `## Slide ${slide}: Evidence register`,
    "",
    ...brief.approvedEvidenceIds.map((id) => {
      const item = evidenceById.get(id);
      return `- [${id}] ${item.source}; ${item.class}; ${item.observedAt}; ${item.confidence}`;
    }),
    "",
  );

  return lines;
}

const output = [];
if (["report", "both"].includes(brief.format)) {
  output.push(...renderReport());
}
if (brief.format === "both") output.push("---", "");
if (["deck", "both"].includes(brief.format)) {
  output.push(...renderDeckOutline());
}

const markdown = `${output.join("\n").trim()}\n`;
const styleIssues = findStyleIssues(markdown, { profile: "report" });

if (styleIssues.length > 0) {
  console.error("Rendered readout failed the anti-slop style gate:");
  styleIssues.forEach((issue, index) =>
    console.error(
      `${index + 1}. line ${issue.line} [${issue.rule}] ${issue.excerpt}`,
    ),
  );
  process.exit(1);
}

if (outputPath) {
  await writeFile(resolve(outputPath), markdown);
  console.log(`Wrote ${resolve(outputPath)}`);
} else {
  process.stdout.write(markdown);
}
