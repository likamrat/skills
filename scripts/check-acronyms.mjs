#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scanRoots = [
  join(root, "README.md"),
  join(root, "CONTRIBUTING.md"),
  join(root, "docs"),
  join(root, "drafts"),
  join(root, "skills"),
];
const acronym = /\bFDEs?\b/g;
const expansion =
  /\bforward deployed engineer(?:ing|s)?\s+\(FDEs?\)/gi;

function normalize(path) {
  return path.replaceAll("\\", "/");
}

function lineNumber(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function markRange(characters, start, end) {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== "\n" && characters[index] !== "\r") {
      characters[index] = " ";
    }
  }
}

function visibleMarkdown(text) {
  const characters = [...text];
  const ranges = [];
  const patterns = [
    /^---\r?\n[\s\S]*?\r?\n---[ \t]*$/gm,
    /^```[\s\S]*?^```[ \t]*$/gm,
    /^~~~[\s\S]*?^~~~[ \t]*$/gm,
    /`[^`\n]+`/g,
    /\]\([^)]+\)/g,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }

  ranges
    .sort((left, right) => left[0] - right[0])
    .forEach(([start, end]) => markRange(characters, start, end));

  return characters.join("");
}

async function markdownFiles(path) {
  const entryName = basename(path);
  if (entryName.endsWith(".md")) return [path];

  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(child)));
    else if (entry.name.endsWith(".md")) files.push(child);
  }
  return files;
}

const files = (
  await Promise.all(scanRoots.map((path) => markdownFiles(path)))
).flat();
const failures = [];

for (const file of files) {
  const text = await readFile(file, "utf8");
  const visible = visibleMarkdown(text);
  acronym.lastIndex = 0;
  const firstUse = acronym.exec(visible);
  if (!firstUse) continue;

  expansion.lastIndex = 0;
  const firstExpansion = expansion.exec(visible);
  const expansionCoversFirstUse =
    firstExpansion &&
    firstExpansion.index <= firstUse.index &&
    firstExpansion.index + firstExpansion[0].length >=
      firstUse.index + firstUse[0].length;

  if (!expansionCoversFirstUse) {
    failures.push(
      `${normalize(relative(root, file))}:${lineNumber(text, firstUse.index)} introduces ${firstUse[0]} before expanding it`,
    );
  }
}

if (failures.length > 0) {
  console.error("Acronym validation failed:");
  failures.forEach((failure, index) =>
    console.error(`${index + 1}. ${failure}`),
  );
  process.exit(1);
}

console.log(
  `Acronym validation passed: ${files.length} Markdown file(s).`,
);
