#!/usr/bin/env node

import { access, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function normalize(path) {
  return path.split(sep).join("/");
}

async function findSkillFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await findSkillFiles(path)));
    else if (entry.name === "SKILL.md") files.push(path);
  }
  return files;
}

function readFrontmatterField(content, key) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return undefined;
  const line = frontmatter[1]
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(`${key}:`));
  return line?.slice(key.length + 1).trim();
}

const declaredPaths = (manifest.skills ?? []).map((path) =>
  normalize(path.replace(/^\.\//, "").replace(/\/$/, "")),
);
const skillFiles = await findSkillFiles(join(root, "skills"));
const draftSkillFiles = await findSkillFiles(join(root, "drafts"));
const discoveredPaths = skillFiles.map((path) =>
  normalize(relative(root, dirname(path))),
);

check(
  Array.isArray(manifest.skills) && manifest.skills.length > 0,
  "package.json must declare at least one skill",
);
check(
  new Set(declaredPaths).size === declaredPaths.length,
  "package.json skill paths must be unique",
);
check(
  JSON.stringify([...declaredPaths].sort()) ===
    JSON.stringify([...discoveredPaths].sort()),
  `package.json skills do not match discovered skills.\nDeclared: ${declaredPaths.join(", ")}\nDiscovered: ${discoveredPaths.join(", ")}`,
);
check(
  draftSkillFiles.length === 0,
  `drafts must not contain discoverable SKILL.md files: ${draftSkillFiles
    .map((path) => normalize(relative(root, path)))
    .join(", ")}`,
);

const names = [];
for (const skillFile of skillFiles) {
  const directory = dirname(skillFile);
  const content = await readFile(skillFile, "utf8");
  const name = readFrontmatterField(content, "name");
  const descriptionMarker = readFrontmatterField(content, "description");

  check(Boolean(name), `${skillFile} is missing frontmatter name`);
  check(
    Boolean(descriptionMarker),
    `${skillFile} is missing frontmatter description`,
  );
  check(
    name === basename(directory),
    `${skillFile} name must match directory ${basename(directory)}`,
  );
  names.push(name);

  try {
    const readme = await readFile(join(directory, "README.md"), "utf8");
    check(
      !/\bnpx\s+(?:--yes\s+)?skills(?:@|\s)/i.test(readme),
      `${name} README must link to the root install guide instead of duplicating skills CLI commands`,
    );
    check(
      /README\.md#installation-30-second-setup/i.test(readme),
      `${name} README must link to the root 30-second setup`,
    );
  } catch {
    // A human-facing README is optional for small internal skills.
  }

  const packageTest = join(directory, "scripts", "test-package.mjs");
  try {
    await access(packageTest);
    const result = spawnSync(process.execPath, [packageTest], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      failures.push(
        `${name} package tests failed:\n${result.stdout}${result.stderr}`,
      );
    }
  } catch {
    // Per-skill package tests are optional for small, instruction-only skills.
  }
}

check(new Set(names).size === names.length, "skill names must be unique");

const rootReadme = await readFile(join(root, "README.md"), "utf8");
const requiredCliCommands = [
  "npx skills@latest add likamrat/skills --skill '*' --agent github-copilot -y",
  "npx skills@latest add likamrat/skills --skill fde-engagement --global --agent github-copilot -y",
  "npx skills@latest use likamrat/skills --skill fde-engagement",
  "npx skills@latest update --project -y",
];
for (const command of requiredCliCommands) {
  check(
    rootReadme.includes(command),
    `README is missing tested CLI command: ${command}`,
  );
}
check(
  !/npx skills@latest use [^\r\n]+ --agent\b/.test(rootReadme),
  "README one-session use command must not launch an interactive nested agent",
);

const docsLinter = join(
  root,
  "skills",
  "fde",
  "fde-engagement",
  "scripts",
  "lint-readout.mjs",
);
const rootDocsLint = spawnSync(
  process.execPath,
  [
    docsLinter,
    "--profile",
    "docs",
    join(root, "README.md"),
    join(root, "CONTRIBUTING.md"),
    join(root, "drafts", "README.md"),
    join(root, "THIRD_PARTY_NOTICES.md"),
    join(root, "package.json"),
  ],
  { encoding: "utf8" },
);
if (rootDocsLint.status !== 0) {
  failures.push(
    `root documentation lint failed:\n${rootDocsLint.stdout}${rootDocsLint.stderr}`,
  );
}

if (failures.length > 0) {
  console.error("Repository validation failed:");
  failures.forEach((failure, index) =>
    console.error(`${index + 1}. ${failure}`),
  );
  process.exit(1);
}

console.log(
  `Repository validation passed: ${names.length} skill(s) (${names.join(", ")}).`,
);
