#!/usr/bin/env node

import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { findStyleIssues } from "./readout-style.mjs";

const args = process.argv.slice(2);
const profileIndex = args.indexOf("--profile");
const profile =
  profileIndex >= 0 ? args.splice(profileIndex, 2)[1] : "report";

if (!["report", "docs"].includes(profile) || args.length === 0) {
  console.log(
    "Usage: node scripts/lint-readout.mjs [--profile report|docs] <file-or-directory> [...]",
  );
  process.exit(2);
}

async function walk(path) {
  const info = await stat(path);
  if (info.isFile()) return [path];

  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    files.push(...(await walk(join(path, entry.name))));
  }
  return files;
}

const supported = new Set([".md", ".txt", ".json"]);
const files = [];

for (const input of args) {
  files.push(...(await walk(resolve(input))));
}

let issueCount = 0;
for (const file of files.filter((path) => supported.has(extname(path)))) {
  const text = await readFile(file, "utf8");
  for (const issue of findStyleIssues(text, { profile })) {
    issueCount += 1;
    console.error(
      `${file}:${issue.line} [${issue.rule}] ${issue.excerpt}${
        issue.suggestion ? ` -> ${issue.suggestion}` : ""
      }`,
    );
  }
}

if (issueCount > 0) {
  console.error(`Found ${issueCount} style issue(s).`);
  process.exit(1);
}

console.log(`No ${profile} style issues found in ${files.length} file(s).`);
