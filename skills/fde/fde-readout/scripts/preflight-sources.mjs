#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  opendir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const output =
  outputIndex >= 0 ? args.splice(outputIndex, 2)[1] : undefined;
const rootIndex = args.indexOf("--root");
const approvedRoot =
  rootIndex >= 0 ? args.splice(rootIndex, 2)[1] : undefined;

if (
  args.length === 0 ||
  (outputIndex >= 0 && !output) ||
  (rootIndex >= 0 && !approvedRoot)
) {
  console.error(
    "Usage: node scripts/preflight-sources.mjs --root approved-directory [--output manifest.json] <file-or-directory> [...]",
  );
  process.exit(3);
}

if (!approvedRoot) {
  console.error("--root is required");
  process.exit(3);
}

const supported = new Set([
  ".csv",
  ".html",
  ".json",
  ".log",
  ".md",
  ".tsv",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const maxFileBytes = 2 * 1024 * 1024;
const maxTotalBytes = 10 * 1024 * 1024;
const maxTraversalDepth = 32;
const maxDiscoveredEntries = 1000;
const rules = [
  {
    id: "instruction-override",
    severity: "block",
    pattern:
      /\b(?:ignore|disregard|forget|override)\b.{0,80}\b(?:instruction|system|developer|assistant|rule|policy|prompt)\b/i,
  },
  {
    id: "role-spoofing",
    severity: "block",
    pattern:
      /(?:^|\s)(?:system|developer|assistant)\s*(?:message|prompt|instruction|override)\s*:|<\s*\/?\s*(?:system|developer|assistant)\b/i,
  },
  {
    id: "credential-request",
    severity: "block",
    pattern:
      /^\s*(?:(?:[-*+]\s+|\d{1,3}[.)]\s+|[A-Za-z][A-Za-z -]{0,23}:\s+))?(?!never\b)(?:(?:(?:please|kindly|could you|can you|would you|you (?:must|should))\s+)?(?:send|email|show|print|upload|include|reveal|exfiltrate)\b.{0,80}\b(?:api[_ -]?key|password|secret|access token|credential)\b|(?:api[_ -]?key|password|secret|access token|credential)\b\s*(?::|-)\s*(?:(?:please|kindly)\s+)?(?:send|email|show|print|upload|include|reveal|exfiltrate)\b)/i,
  },
  {
    id: "tool-or-action-request",
    severity: "review",
    pattern:
      /\b(?:run|execute|invoke|call|install|download|upload|send|post|delete|write|modify|visit|follow)\b.{0,60}\b(?:command|tool|script|package|url|link|file|credential|secret|permission|data)\b/i,
  },
  {
    id: "active-html",
    severity: "block",
    pattern:
      /<\s*(?:script|iframe|object|embed|meta)\b|javascript\s*:/i,
  },
  {
    id: "hidden-unicode-control",
    severity: "block",
    pattern: /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u,
  },
  {
    id: "external-url",
    severity: "review",
    pattern: /\bhttps?:\/\/\S+/i,
  },
  {
    id: "shell-like-command",
    severity: "review",
    pattern:
      /^\s*(?:[$>]|PS>|[A-Za-z]:\\>|curl\b|wget\b|npx\b|npm\s+(?:install|exec)\b|pip\s+install\b|powershell\b|bash\b|cmd(?:\.exe)?\b)/i,
  },
  {
    id: "encoded-payload",
    severity: "review",
    pattern:
      /(?:[A-Za-z0-9+/]{200,}={0,2})|(?:\b[0-9a-fA-F]{200,}\b)/,
  },
];

const files = [];
const inputRoots = args.map((path) => resolve(path));
const sourceRoot = resolve(approvedRoot);
const canonicalSourceRoot = await realpath(sourceRoot);
const workspaceRoot = resolve(process.cwd());
const resolvedOutput = output ? resolve(output) : null;
let discoveredEntries = 0;
let entryLimitReached = false;

function insideRoot(root, path) {
  const candidate = relative(root, path);
  return (
    candidate === "" ||
    (!isAbsolute(candidate) &&
      candidate !== ".." &&
      !candidate.startsWith(`..${sep}`))
  );
}

function insideApprovedRoot(path) {
  return insideRoot(sourceRoot, path);
}

function addTraversalFinding(path, rule, sortKey = path) {
  files.push({
    path,
    sortKey,
    symlink: false,
    size: 0,
    traversalFindings: [{ rule, severity: "block", line: null }],
  });
}

function registerDiscoveredEntry(path) {
  discoveredEntries += 1;
  if (discoveredEntries <= maxDiscoveredEntries) return true;
  entryLimitReached = true;
  addTraversalFinding(
    path,
    "discovered-entry-limit",
    "\uffff-discovered-entry-limit",
  );
  return false;
}

async function walk(path, depth) {
  if (entryLimitReached) return;
  const resolvedPath = resolve(path);
  if (!registerDiscoveredEntry(resolvedPath)) return;
  if (resolvedOutput && resolvedPath === resolvedOutput) return;

  const pathFromSourceRoot = relative(sourceRoot, resolvedPath);
  const components = pathFromSourceRoot.split(sep).filter(Boolean);
  let componentPath = sourceRoot;
  for (const component of components.slice(0, -1)) {
    componentPath = join(componentPath, component);
    const componentInfo = await lstat(componentPath);
    if (componentInfo.isSymbolicLink()) {
      addTraversalFinding(resolvedPath, "symlink");
      return;
    }
  }

  const info = await lstat(resolvedPath);
  if (info.isSymbolicLink()) {
    files.push({ path: resolvedPath, symlink: true, size: 0 });
    return;
  }
  const canonicalPath = await realpath(resolvedPath);
  if (!insideRoot(canonicalSourceRoot, canonicalPath)) {
    addTraversalFinding(resolvedPath, "outside-approved-root");
    return;
  }
  if (info.isDirectory()) {
    if (depth > maxTraversalDepth) {
      addTraversalFinding(resolvedPath, "traversal-depth-limit");
      return;
    }
    const directory = await opendir(resolvedPath);
    for await (const entry of directory) {
      await walk(join(resolvedPath, entry.name), depth + 1);
      if (entryLimitReached) break;
    }
    return;
  }
  if (info.isFile()) {
    files.push({ path: resolvedPath, symlink: false, size: info.size });
  }
}

for (const root of inputRoots) {
  if (!insideApprovedRoot(root)) {
    addTraversalFinding(root, "outside-approved-root");
    continue;
  }
  await walk(root, 0);
  if (entryLimitReached) break;
}
files.sort((left, right) =>
  (left.sortKey ?? left.path).localeCompare(right.sortKey ?? right.path),
);

let totalBytes = 0;
const results = [];

for (const [index, file] of files.entries()) {
  const sourceId = `source-${String(index + 1).padStart(3, "0")}`;
  const findings = structuredClone(file.traversalFindings ?? []);
  let sha256 = null;

  if (findings.length > 0) {
    // Traversal findings stop before source bytes or directory entries are read.
  } else if (file.symlink) {
    findings.push({ rule: "symlink", severity: "block", line: null });
  } else if (!supported.has(extname(file.path).toLowerCase())) {
    findings.push({
      rule: "unsupported-or-binary-format",
      severity: "review",
      line: null,
    });
  } else if (file.size > maxFileBytes) {
    findings.push({
      rule: "file-size-limit",
      severity: "block",
      line: null,
    });
  } else {
    totalBytes += file.size;
    if (totalBytes > maxTotalBytes) {
      findings.push({
        rule: "total-size-limit",
        severity: "block",
        line: null,
      });
    } else {
      const bytes = await readFile(file.path);
      sha256 = createHash("sha256").update(bytes).digest("hex");
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        findings.push({
          rule: "invalid-utf8",
          severity: "review",
          line: null,
        });
      }

      if (text !== undefined) {
        const lines = text.normalize("NFKC").split(/\r?\n/);
        for (const [lineIndex, line] of lines.entries()) {
          for (const rule of rules) {
            rule.pattern.lastIndex = 0;
            if (rule.pattern.test(line)) {
              findings.push({
                rule: rule.id,
                severity: rule.severity,
                line: lineIndex + 1,
              });
            }
          }
        }
      }
    }
  }

  const status = findings.some((item) => item.severity === "block")
    ? "block"
    : findings.length > 0
      ? "review"
      : "clear";
  results.push({
    sourceId,
    bytes: file.size,
    sha256,
    trust: "untrusted-data",
    status,
    findings,
  });
}

const status = results.some((item) => item.status === "block")
  ? "block"
  : results.some((item) => item.status === "review")
    ? "review"
    : "clear";
const manifestBody = {
  version: 1,
  generatedAt: new Date().toISOString(),
  status,
  limits: {
    maxFileBytes,
    maxTotalBytes,
    maxTraversalDepth,
    maxDiscoveredEntries,
  },
  note:
    "A clear result means no known pattern matched. It does not make source content trusted or authorize actions.",
  sources: results,
};
const manifestSha256 = createHash("sha256")
  .update(JSON.stringify(manifestBody))
  .digest("hex");
const manifest = { ...manifestBody, manifestSha256 };
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

if (output) {
  if (!insideRoot(workspaceRoot, resolvedOutput)) {
    console.error("--output must stay inside the current workspace");
    process.exit(3);
  }
  await mkdir(dirname(resolvedOutput), { recursive: true });
  await writeFile(resolvedOutput, serialized);
  console.log(`Wrote ${resolvedOutput}`);
} else {
  await new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(serialized, (error) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

process.exitCode = status === "block" ? 2 : status === "review" ? 1 : 0;
