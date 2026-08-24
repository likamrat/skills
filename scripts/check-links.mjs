#!/usr/bin/env node

import { access, readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const checkExternal = process.argv.includes("--external");
const localOnly = process.argv.includes("--local");
const failures = [];
const externalUrls = new Set();
const markdownCache = new Map();
const anchorCache = new Map();
const exceptionConfig = JSON.parse(
  await readFile(join(root, "scripts", "link-check-exceptions.json"), "utf8"),
);
const externalExceptions = new Map(
  (exceptionConfig.external ?? []).map((item) => [item.url, item]),
);

function normalized(path) {
  return relative(root, path).split(sep).join("/");
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

function maskCodeBlocks(content) {
  return content.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/[^\n]/g, " "),
  );
}

function stripLinkTitle(target) {
  const match = target.match(/^(\S+)(?:\s+["'][^"']*["'])?$/);
  return match?.[1] ?? target;
}

function trimUrl(url) {
  return url.replace(/[),.;:!?]+$/g, "");
}

function slugBase(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

async function markdown(path) {
  if (!markdownCache.has(path)) {
    markdownCache.set(path, await readFile(path, "utf8"));
  }
  return markdownCache.get(path);
}

async function anchors(path) {
  if (anchorCache.has(path)) return anchorCache.get(path);
  const content = await markdown(path);
  const counts = new Map();
  const values = new Set();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const base = slugBase(match[1]);
    if (!base) continue;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    values.add(count === 0 ? base : `${base}-${count}`);
  }
  anchorCache.set(path, values);
  return values;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function validateLocalLink(source, target) {
  const [rawPath, rawFragment = ""] = target.split("#", 2);
  const decodedPath = decodeURIComponent(rawPath);
  const fragment = decodeURIComponent(rawFragment).toLowerCase();
  const destination = decodedPath
    ? resolve(dirname(source), decodedPath)
    : source;

  if (!(await exists(destination))) {
    failures.push(
      `${normalized(source)} links to missing path: ${target}`,
    );
    return;
  }

  const info = await stat(destination);
  if (fragment) {
    if (!info.isFile() || extname(destination).toLowerCase() !== ".md") {
      failures.push(
        `${normalized(source)} uses an anchor on a non-Markdown target: ${target}`,
      );
      return;
    }
    const targetAnchors = await anchors(destination);
    if (!targetAnchors.has(fragment)) {
      failures.push(
        `${normalized(source)} links to missing anchor #${fragment} in ${normalized(destination)}`,
      );
    }
  }
}

async function inspectMarkdown(path) {
  const content = await markdown(path);
  const searchable = maskCodeBlocks(content);
  const linkedUrls = new Set();
  const linkPattern = /!?\[[^\]]*]\(([^)\r\n]+)\)/g;

  for (const match of searchable.matchAll(linkPattern)) {
    const target = stripLinkTitle(match[1].trim());
    if (!target || target.startsWith("mailto:")) continue;
    if (/^https?:\/\//i.test(target)) {
      const url = trimUrl(target);
      externalUrls.add(url);
      linkedUrls.add(url);
    } else {
      await validateLocalLink(path, target);
    }
  }

  const barePattern = /https?:\/\/[^\s<>"'`]+/g;
  for (const match of searchable.matchAll(barePattern)) {
    const url = trimUrl(match[0]);
    if (!linkedUrls.has(url)) externalUrls.add(url);
  }
}

async function fetchStatus(url) {
  const target = new URL(url);
  target.hash = "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(target, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "likamrat-skills-link-check/1.0",
      },
    });
    return response.status;
  } catch (error) {
    return error.name === "AbortError" ? "timeout" : error.message;
  } finally {
    clearTimeout(timeout);
  }
}

async function validateExternalLinks() {
  const urls = [...externalUrls].sort();
  const results = new Array(urls.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(8, urls.length) }, async () => {
    while (cursor < urls.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fetchStatus(urls[index]);
    }
  });
  await Promise.all(workers);

  let expectedUnavailable = 0;
  for (const [index, status] of results.entries()) {
    const url = urls[index];
    const exception = externalExceptions.get(url);
    if (exception?.allowedStatuses?.includes(status)) {
      expectedUnavailable += 1;
      continue;
    }
    if (
      typeof status === "number" &&
      (status < 400 || [401, 403, 405, 429].includes(status))
    ) {
      continue;
    }
    failures.push(`external link is unreachable (${status}): ${url}`);
  }
  return {
    checked: urls.length,
    expectedUnavailable,
    results: urls.map((url, index) => [url, results[index]]),
  };
}

const files = (await walk(root)).filter(
  (path) => extname(path).toLowerCase() === ".md",
);
for (const file of files) await inspectMarkdown(file);

let external = { checked: 0, results: [] };
if (checkExternal && !localOnly) {
  external = await validateExternalLinks();
}

if (failures.length > 0) {
  console.error("Link validation failed:");
  failures.forEach((failure, index) =>
    console.error(`${index + 1}. ${failure}`),
  );
  process.exit(1);
}

console.log(
  `Link validation passed: ${files.length} Markdown files, local paths and anchors${
    checkExternal && !localOnly
      ? `, ${external.checked} external URLs${
          external.expectedUnavailable
            ? ` (${external.expectedUnavailable} expected pre-publication target)`
            : ""
        }`
      : ""
  }.`,
);
