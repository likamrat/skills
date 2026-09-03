#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const failures = [];
const staticOnly = process.argv.slice(2).includes("--static-only");

function check(condition, message) {
  if (!condition) failures.push(message);
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

const skillPath = join(skillRoot, "SKILL.md");
const skill = await readFile(skillPath, "utf8");
const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
check(frontmatter, "SKILL.md requires YAML frontmatter");

if (frontmatter) {
  const lines = frontmatter[1].split(/\r?\n/);
  const fields = lines
    .filter((line) => line.length > 0 && !/^\s/.test(line))
    .map((line) => line.slice(0, line.indexOf(":")));
  const allowed = new Set([
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
  ]);

  function readField(key) {
    const start = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (start < 0) return undefined;
    const inline = lines[start].slice(key.length + 1).trim();
    if (inline && !["|", "|-", ">", ">-"].includes(inline)) {
      return inline.replace(/^['"]|['"]$/g, "");
    }
    const continuation = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith("  ")) break;
      continuation.push(line.trim());
    }
    return continuation.join(" ");
  }

  const name = readField("name");
  const description = readField("description") ?? "";
  const compatibility = readField("compatibility") ?? "";
  check(name === basename(skillRoot), "frontmatter name must match directory");
  check(
    fields.every((field) => allowed.has(field)),
    `unsupported frontmatter fields: ${fields
      .filter((field) => !allowed.has(field))
      .join(", ")}`,
  );
  check(
    description.length >= 1 && description.length <= 1024,
    "description must be 1-1024 characters",
  );
  check(
    description.length <= 400,
    "description must not exceed the repository's 400-character limit",
  );
  check(
    /\bUse (?:this skill )?when\b/.test(description),
    "description must include triggers",
  );
  check(compatibility.length <= 500, "compatibility must not exceed 500 characters");
}

check(skill.split(/\r?\n/).length <= 500, "SKILL.md must not exceed 500 lines");

const files = await walk(skillRoot);
const emDash = String.fromCodePoint(0x2014);
const emDashEntities = [
  `&${"mdash"};`,
  `&#${"8212"};`,
  `&#x${"2014"};`,
  `&#X${"2014"};`,
];
const textExtensions = new Set([
  ".html",
  ".json",
  ".md",
  ".mjs",
  ".ps1",
  ".txt",
  ".yaml",
  ".yml",
]);
for (const file of files.filter(
  (candidate) =>
    textExtensions.has(extname(candidate)) || basename(candidate) === "LICENSE",
)) {
  const content = await readFile(file, "utf8");
  check(!content.includes(emDash), `${file} contains an em dash`);
  for (const entity of emDashEntities) {
    check(!content.includes(entity), `${file} contains an em dash entity`);
  }
}

for (const file of files.filter((candidate) => extname(candidate) === ".json")) {
  try {
    JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    failures.push(`${file} is invalid JSON: ${error.message}`);
  }
}

for (const file of files.filter((candidate) => extname(candidate) === ".md")) {
  const content = await readFile(file, "utf8");
  const links = [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(
    (match) => match[1],
  );
  for (const link of links) {
    if (/^(?:https?:|mailto:)/.test(link)) continue;
    const target = decodeURIComponent(link.split("#")[0]);
    if (!target) continue;
    try {
      await access(resolve(dirname(file), target));
    } catch {
      failures.push(`${file} has a broken local link: ${link}`);
    }
  }
}

const bannedPhrases = [
  /\bin today'?s rapidly evolving landscape\b/i,
  /\bunlock (?:the |your |its )?potential\b/i,
  /\bleverage ai\b/i,
  /\bgame[- ]changer\b/i,
  /\bseamless integration\b/i,
  /\btrusted production outcome\b/i,
  /\bclose both loops\b/i,
  /\bcompounding learning\b/i,
];
for (const file of files.filter((candidate) =>
  [".md", ".json"].includes(extname(candidate)),
)) {
  const content = await readFile(file, "utf8");
  for (const pattern of bannedPhrases) {
    if (pattern.test(content.replace(/`[^`\n]+`/g, ""))) {
      failures.push(`${file} contains stock language: ${pattern}`);
    }
  }
}

const requiredAssets = [
  [join(skillRoot, "assets", "readout-plan.template.json"), "plan template"],
  [join(skillRoot, "assets", "readout-intent.template.json"), "intent template"],
  [
    join(skillRoot, "assets", "powerpoint-smoke-approval.template.json"),
    "PowerPoint smoke approval template",
  ],
  [
    join(skillRoot, "assets", "powerpoint-16x9-seed.pptx"),
    "PowerPoint seed",
  ],
  [
    join(skillRoot, "assets", "powerpoint-16x9-seed.metadata.json"),
    "PowerPoint seed metadata",
  ],
  [
    join(
      skillRoot,
      "assets",
      "examples",
      "lattice-harbor-readout-plan.json",
    ),
    "example plan",
  ],
  [
    join(skillRoot, "assets", "examples", "lattice-harbor-html", "index.html"),
    "example HTML deck",
  ],
  [
    join(skillRoot, "assets", "examples", "lattice-harbor-readout.pptx"),
    "example PowerPoint",
  ],
  [
    join(skillRoot, "assets", "examples", "lattice-harbor-readout.png"),
    "example montage",
  ],
  [
    join(skillRoot, "scripts", "create-powerpoint-skeleton.ps1"),
    "native PowerPoint skeleton helper",
  ],
  [
    join(skillRoot, "scripts", "powerpoint-layout.mjs"),
    "PowerPoint drawing-spec compiler",
  ],
  [
    join(skillRoot, "scripts", "render-powerpoint-spec.mjs"),
    "PowerPoint drawing-spec CLI",
  ],
  [
    join(skillRoot, "scripts", "pptx-package-qa.mjs"),
    "dependency-free PPTX package QA CLI",
  ],
  [
    join(skillRoot, "scripts", "render-powerpoint-worker.ps1"),
    "native PowerPoint worker",
  ],
  [
    join(skillRoot, "scripts", "validate-powerpoint-drawing-spec.mjs"),
    "PowerPoint drawing-spec validator",
  ],
  [
    join(skillRoot, "scripts", "powerpoint-workflow-connectors.psm1"),
    "PowerPoint workflow connector validator",
  ],
];
for (const [path, label] of requiredAssets) {
  try {
    const file = await stat(path);
    check(file.size > 0, `${label} must not be empty`);
  } catch {
    failures.push(`${label} is missing`);
  }

}

const seedPath = join(skillRoot, "assets", "powerpoint-16x9-seed.pptx");
const seedMetadataPath = join(
  skillRoot,
  "assets",
  "powerpoint-16x9-seed.metadata.json",
);
const expectedSeedMetadata = {
  schemaVersion: 1,
  id: "powerpoint-16x9-seed",
  sha256: "f109680b3231c5a9c0dbb4e8920867c648feaa91cf2a7f361d84f58f7c6dab90",
  byteLength: 32179,
  activeSlideCount: 1,
  notesCount: 0,
  widthEmu: 12192000,
  heightEmu: 6858000,
  purpose: "Clean native 16:9 PowerPoint seed for new editable decks.",
};

try {
  const [seed, metadataText] = await Promise.all([
    readFile(seedPath),
    readFile(seedMetadataPath, "utf8"),
  ]);
  const metadata = JSON.parse(metadataText);
  const actualSha256 = createHash("sha256").update(seed).digest("hex");
  const expectedFields = Object.keys(expectedSeedMetadata).sort();
  const actualFields = Object.keys(metadata).sort();

  check(
    JSON.stringify(actualFields) === JSON.stringify(expectedFields),
    "PowerPoint seed metadata fields must match the package contract",
  );
  for (const [field, expected] of Object.entries(expectedSeedMetadata)) {
    check(
      metadata[field] === expected,
      `PowerPoint seed metadata ${field} must equal ${JSON.stringify(expected)}`,
    );
  }
  check(
    seed.byteLength === expectedSeedMetadata.byteLength,
    `PowerPoint seed must be exactly ${expectedSeedMetadata.byteLength} bytes`,
  );
  check(
    actualSha256 === expectedSeedMetadata.sha256,
    `PowerPoint seed SHA-256 must equal ${expectedSeedMetadata.sha256}`,
  );
} catch (error) {
  failures.push(`PowerPoint seed contract could not be verified: ${error.message}`);
}

try {
  const skeletonHelper = await readFile(
    join(skillRoot, "scripts", "create-powerpoint-skeleton.ps1"),
    "utf8",
  );
  check(
    skeletonHelper.includes("$PlanSlide.notes") &&
      skeletonHelper.includes("$PlanSlide.evidenceIds") &&
      skeletonHelper.includes("$PlanSlide.judgmentIds"),
    "PowerPoint skeleton helper must use validated ReadoutPlan note fields",
  );
  check(
    skeletonHelper.includes("$shape.PlaceholderFormat.Type -eq 2") &&
      skeletonHelper.includes("$presentation.Slides.AddSlide"),
    "PowerPoint skeleton helper must target notes-body placeholders and add native slides",
  );
  check(
    skeletonHelper.includes("IsNullOrWhiteSpace($Seed)") &&
      skeletonHelper.includes("Join-Path $PSScriptRoot"),
    "PowerPoint skeleton helper must resolve its default seed after parameter binding",
  );
  check(
    !skeletonHelper.includes("speakerNotes"),
    "PowerPoint skeleton helper must not use the unsupported speakerNotes field",
  );
  check(
    !skeletonHelper.includes("ConvertFrom-Json -Depth"),
    "PowerPoint skeleton helper must remain compatible with Windows PowerShell 5.1",
  );
  check(
    skeletonHelper.includes("[string[]]$SmokeSlideIds") &&
      skeletonHelper.includes("$PSBoundParameters.ContainsKey('SmokeSlideIds')") &&
      skeletonHelper.includes("$selectedSlides = $planSlides"),
    "PowerPoint skeleton helper must preserve full-plan behavior while supporting explicit smoke selection",
  );
  check(
    skeletonHelper.includes("$sourcePlanSha256") &&
      skeletonHelper.includes("selectedSlideIds") &&
      skeletonHelper.includes("selectedSlideFamilies"),
    "PowerPoint skeleton helper must bind output to the source full plan and selected slides",
  );
  check(
    !skeletonHelper.includes(".FileFormat"),
    "PowerPoint skeleton helper must not access unsupported Presentation.FileFormat",
  );
} catch (error) {
  failures.push(`PowerPoint skeleton helper contract could not be verified: ${error.message}`);
}

for (const file of files.filter(
  (candidate) => extname(candidate) === ".md",
)) {
  const content = await readFile(file, "utf8");
  check(
    !/\bnpx\b[^\r\n]*dom-to-pptx/i.test(content),
    `${file} must not offer runtime dom-to-pptx installation`,
  );
}

const evals = JSON.parse(
  await readFile(join(skillRoot, "evals", "evals.json"), "utf8"),
);
const triggers = JSON.parse(
  await readFile(join(skillRoot, "evals", "trigger-cases.json"), "utf8"),
);
check(evals.skill_name === basename(skillRoot), "eval skill_name must match");
check(triggers.skill_name === basename(skillRoot), "trigger skill_name must match");
const evalIds = evals.evals.map((entry) => entry.id);
check(new Set(evalIds).size === evalIds.length, "eval IDs must be unique");
for (const entry of evals.evals) {
  check(typeof entry.prompt === "string" && entry.prompt.length > 0, `eval ${entry.id} needs a prompt`);
  check(
    Array.isArray(entry.assertions) && entry.assertions.length > 0,
    `eval ${entry.id} needs assertions`,
  );
}
check(
  Array.isArray(triggers.should_trigger) && triggers.should_trigger.length >= 3,
  "trigger fixtures require at least three should-trigger cases",
);
check(
  Array.isArray(triggers.should_not_trigger) &&
    triggers.should_not_trigger.length >= 3,
  "trigger fixtures require at least three should-not-trigger cases",
);

for (const script of [
  "test-browser-candidates.mjs",
  "test-compile-readout-intent.mjs",
  "test-plan.mjs",
  "test-html.mjs",
  "test-writing.mjs",
  "test-source-preflight.mjs",
  "test-powerpoint-skeleton.mjs",
  "test-powerpoint-smoke-contract.mjs",
  "test-powerpoint-layout.mjs",
  "test-powerpoint-shape-families.mjs",
  "test-powerpoint-table-families.mjs",
  "test-powerpoint-worker-tables.mjs",
  "test-powerpoint-chart-family.mjs",
  "test-powerpoint-worker-charts.mjs",
  "test-powerpoint-orthogonal-router.mjs",
  "test-powerpoint-router-grid.mjs",
  "test-powerpoint-router-interactions.mjs",
  "test-powerpoint-workflow-family.mjs",
  "test-pptx-package-qa.mjs",
  "test-powerpoint-worker-connectors.mjs",
]) {
  const result = spawnSync(
    process.execPath,
    [
      join(skillRoot, "scripts", script),
      ...(staticOnly && script === "test-powerpoint-skeleton.mjs"
        ? ["--static-only"]
        : []),
    ],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    failures.push(`${script} failed:\n${result.stdout}${result.stderr}`);
  }
}

const docsLint = spawnSync(
  process.execPath,
  [
    join(skillRoot, "scripts", "lint-writing.mjs"),
    "--profile",
    "docs",
    skillRoot,
  ],
  { encoding: "utf8" },
);
if (docsLint.status !== 0) {
  failures.push(
    `skill documentation lint failed:\n${docsLint.stdout}${docsLint.stderr}`,
  );
}

if (failures.length > 0) {
  console.error("FDE readout package validation failed:");
  failures.forEach((failure, index) =>
    console.error(`${index + 1}. ${failure}`),
  );
  process.exit(1);
}

console.log(
  `FDE readout package checks passed: ${evals.evals.length} evals and ${files.length} files.`,
);
