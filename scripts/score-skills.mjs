#!/usr/bin/env node

import { access, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const jsonOutput = process.argv.includes("--json");

function normalize(path) {
  return path.split(sep).join("/");
}

function points(value, maximum) {
  return Math.min(Math.max(value, 0), maximum);
}

function readFrontmatterField(content, key) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return undefined;

  const lines = frontmatter[1].split(/\r?\n/);
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

function readMetadataVersion(content) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return undefined;
  return frontmatter[1]
    .split(/\r?\n/)
    .find((line) => /^\s+version:/.test(line))
    ?.split(":")
    .slice(1)
    .join(":")
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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

function localMarkdownLinks(content) {
  return [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(?:https?:|mailto:|#)/.test(target))
    .map((target) => decodeURIComponent(target.split("#")[0]))
    .filter(Boolean);
}

function progressiveDisclosurePoints(coreLines, approximateTokens, references, linksValid, contextualLinks) {
  let tokenPoints = 0;
  if (approximateTokens <= 3000) tokenPoints = 10;
  else if (approximateTokens <= 4000) tokenPoints = 8;
  else if (approximateTokens <= 5000) tokenPoints = 5;
  else if (approximateTokens <= 6000) tokenPoints = 2;

  return (
    tokenPoints +
    (coreLines <= 500 ? 3 : 0) +
    (references > 0 ? 3 : 0) +
    (linksValid ? 2 : 0) +
    (contextualLinks > 0 ? 2 : 0)
  );
}

const results = [];

for (const declaredPath of manifest.skills ?? []) {
  const skillRoot = resolve(root, declaredPath);
  const skillName = basename(skillRoot);
  const skillFile = join(skillRoot, "SKILL.md");
  const content = await readFile(skillFile, "utf8");
  const description = readFrontmatterField(content, "description") ?? "";
  const name = readFrontmatterField(content, "name") ?? "";
  const version = readMetadataVersion(content);
  const files = await walk(skillRoot);
  const references = files.filter(
    (file) =>
      normalize(relative(skillRoot, file)).startsWith("references/") &&
      file.endsWith(".md"),
  );
  const scripts = files.filter((file) => file.endsWith(".mjs"));
  const validatorScripts = scripts.filter((file) =>
    basename(file).startsWith("validate-"),
  );
  const testScripts = scripts.filter(
    (file) =>
      basename(file).startsWith("test-") &&
      basename(file) !== "test-package.mjs",
  );
  const localLinks = localMarkdownLinks(content);
  const linkChecks = await Promise.all(
    localLinks.map((target) => exists(resolve(skillRoot, target))),
  );
  const linksValid = linkChecks.every(Boolean);
  const contextualLinks = (
    content.match(
      /(?:read|use|copy|run|see)\s+\[[^\]]+\]\((?:references|assets|scripts)\//gi,
    ) ?? []
  ).length;

  const evalsPath = join(skillRoot, "evals", "evals.json");
  const triggersPath = join(skillRoot, "evals", "trigger-cases.json");
  const evals = JSON.parse(await readFile(evalsPath, "utf8"));
  const triggers = JSON.parse(await readFile(triggersPath, "utf8"));
  const behaviorEvals = evals.evals ?? [];
  const positiveTriggers = triggers.should_trigger ?? [];
  const negativeTriggers = triggers.should_not_trigger ?? [];
  const assertionCount = behaviorEvals.reduce(
    (total, entry) => total + (entry.assertions?.length ?? 0),
    0,
  );
  const uniqueIds =
    new Set(behaviorEvals.map((entry) => entry.id)).size ===
    behaviorEvals.length;
  const behaviorComplete =
    behaviorEvals.length > 0 &&
    behaviorEvals.every(
      (entry) =>
        typeof entry.prompt === "string" &&
        entry.prompt.length > 0 &&
        typeof entry.expected_output === "string" &&
        entry.expected_output.length > 0 &&
        Array.isArray(entry.assertions) &&
        entry.assertions.length >= 3,
    );

  const coreLines = content.split(/\r?\n/).length;
  const coreBytes = Buffer.byteLength(content);
  const approximateTokens = Math.ceil(coreBytes / 4);

  const specification =
    (name === skillName && description.length > 0 && description.length <= 1024
      ? 5
      : 0) +
    ((await exists(join(skillRoot, "README.md"))) &&
    (await exists(join(skillRoot, "LICENSE")))
      ? 5
      : 0) +
    ((await exists(join(skillRoot, "scripts", "test-package.mjs"))) &&
    (await exists(evalsPath)) &&
    (await exists(triggersPath))
      ? 5
      : 0);

  const activation =
    (/\bUse (?:this skill )?(?:when|only for)\b/.test(description) ? 5 : 0) +
    (description.length <= 400 ? 3 : 0) +
    points((positiveTriggers.length / 8) * 5, 5) +
    points((negativeTriggers.length / 8) * 5, 5) +
    (positiveTriggers.length + negativeTriggers.length >= 20 ? 2 : 0);

  const behavior =
    points((behaviorEvals.length / 5) * 5, 5) +
    (behaviorComplete ? 10 : 0) +
    (uniqueIds ? 5 : 0);

  const deterministic =
    ((await exists(join(skillRoot, "scripts", "test-package.mjs"))) ? 5 : 0) +
    (validatorScripts.length > 0 ? 5 : 0) +
    (testScripts.length > 0 ? 5 : 0);

  const disclosure = progressiveDisclosurePoints(
    coreLines,
    approximateTokens,
    references.length,
    linksValid,
    contextualLinks,
  );

  const hasBenchmark =
    (await exists(join(skillRoot, "evals", "benchmark.json"))) ||
    (await exists(join(skillRoot, "evals", "baseline.json")));
  const historyDirectory = join(skillRoot, "evals", "history");
  const historyFiles = (await exists(historyDirectory))
    ? await readdir(historyDirectory)
    : [];
  const hasHistory =
    (await exists(join(skillRoot, "CHANGELOG.md"))) ||
    historyFiles.some((file) => file.endsWith(".json"));
  const hasTriggerEvidence = historyFiles.some((file) =>
    file.startsWith("trigger-"),
  );
  const hasBehaviorEvidence = historyFiles.some((file) =>
    file.startsWith("behavior-"),
  );
  const evolution =
    (version ? 2 : 0) +
    (positiveTriggers.length + negativeTriggers.length > 0 ? 2 : 0) +
    (behaviorEvals.length > 0 ? 2 : 0) +
    (hasBenchmark ? 2 : 0) +
    (hasHistory ? 2 : 0);

  const readiness = Math.round(
    (specification + activation + behavior + deterministic + disclosure + evolution) *
      10,
  ) / 10;

  results.push({
    skill: skillName,
    readiness,
    empiricalEffectiveness: hasBenchmark
      ? "benchmark recorded"
      : hasTriggerEvidence && hasBehaviorEvidence
        ? "limited activation + behavior"
        : hasBehaviorEvidence
          ? "limited behavior"
          : hasTriggerEvidence
            ? "activation only"
            : "not measured",
    core: {
      lines: coreLines,
      bytes: coreBytes,
      approximateTokens,
    },
    activation: {
      shouldTrigger: positiveTriggers.length,
      shouldNotTrigger: negativeTriggers.length,
      score: Math.round(activation * 10) / 10,
      maximum: 20,
    },
    behaviorEvals: {
      cases: behaviorEvals.length,
      assertions: assertionCount,
      score: Math.round(behavior * 10) / 10,
      maximum: 20,
    },
    deterministic: {
      validators: validatorScripts.length,
      tests: testScripts.length + 1,
      score: deterministic,
      maximum: 15,
    },
    progressiveDisclosure: {
      references: references.length,
      contextualLinks,
      score: disclosure,
      maximum: 20,
    },
    evolution: {
      version: version ?? null,
      benchmark: hasBenchmark,
      history: hasHistory,
      score: evolution,
      maximum: 10,
    },
    specification: {
      score: specification,
      maximum: 15,
    },
  });
}

if (jsonOutput) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
} else {
  console.table(
    results.map((result) => ({
      skill: result.skill,
      readiness: `${result.readiness}/100`,
      empirical: result.empiricalEffectiveness,
      core: `${result.core.lines} lines / ~${result.core.approximateTokens} tokens`,
      triggers: `${result.activation.shouldTrigger}/${result.activation.shouldNotTrigger}`,
      evals: `${result.behaviorEvals.cases}/${result.behaviorEvals.assertions}`,
    })),
  );
  console.log(
    "Readiness measures package and evaluation infrastructure. It does not measure whether the skill improves agent output.",
  );
}
