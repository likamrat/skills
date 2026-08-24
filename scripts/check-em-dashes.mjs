#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const emDash = String.fromCodePoint(0x2014);
const htmlEntities = [
  `&${"mdash"};`,
  `&#${"8212"};`,
  `&#x${"2014"};`,
  `&#X${"2014"};`,
];
const excludedDirectories = new Set([".git", "node_modules"]);
const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".rels",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const extensionlessTextFiles = new Set([".gitignore", "LICENSE"]);

function normalize(path) {
  return path.replaceAll("\\", "/");
}

function lineNumber(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      (excludedDirectories.has(entry.name) ||
        entry.name.startsWith(".trigger-eval-") ||
        entry.name.startsWith(".cli-smoke-"))
    ) {
      continue;
    }

    const path = join(directory, entry.name);
    if (entry.name.includes(emDash)) {
      throw new Error(
        `File or directory name contains an em dash: ${normalize(relative(root, path))}`,
      );
    }
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (
      textExtensions.has(extname(entry.name).toLowerCase()) ||
      extensionlessTextFiles.has(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

const failures = [];
const files = await walk(root);

for (const file of files) {
  const text = await readFile(file, "utf8");
  const relativePath = normalize(relative(root, file));

  let index = text.indexOf(emDash);
  while (index >= 0) {
    failures.push(`${relativePath}:${lineNumber(text, index)} [em-dash]`);
    index = text.indexOf(emDash, index + emDash.length);
  }

  for (const entity of htmlEntities) {
    index = text.indexOf(entity);
    while (index >= 0) {
      failures.push(
        `${relativePath}:${lineNumber(text, index)} [em-dash-entity] ${entity}`,
      );
      index = text.indexOf(entity, index + entity.length);
    }
  }
}

if (failures.length > 0) {
  console.error("Em dash validation failed:");
  failures.forEach((failure, index) =>
    console.error(`${index + 1}. ${failure}`),
  );
  process.exit(1);
}

console.log(
  `Em dash validation passed: ${files.length} text file(s), including hidden and generated skill files.`,
);
