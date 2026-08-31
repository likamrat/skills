#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";

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
      /^\s*(?!never\b)(?:(?:(?:please|kindly|could you|can you|would you|you (?:must|should))\s+)?(?:send|email|show|print|upload|include|reveal|exfiltrate)\b.{0,80}\b(?:api[_ -]?key|password|secret|access token|credential)\b|(?:api[_ -]?key|password|secret|access token|credential)\b\s*(?::|-)\s*(?:(?:please|kindly)\s+)?(?:send|email|show|print|upload|include|reveal|exfiltrate)\b)/i,
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
const workspaceRoot = resolve(process.cwd());
const resolvedOutput = output ? resolve(output) : null;

function insideRoot(root, path) {
  const candidate = relative(root, path);
  return (
    candidate === "" ||
    (!candidate.startsWith("..") && !candidate.startsWith("/") && !candidate.includes(":"))
  );
}

function insideApprovedRoot(path) {
  return insideRoot(sourceRoot, path);
}

async function walk(path) {
  if (resolvedOutput && resolve(path) === resolvedOutput) return;
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    files.push({ path, symlink: true, size: 0 });
    return;
  }
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) {
      await walk(join(path, entry));
    }
    return;
  }
  if (info.isFile()) files.push({ path, symlink: false, size: info.size });
}

for (const root of inputRoots) await walk(root);
files.sort((left, right) => left.path.localeCompare(right.path));

let totalBytes = 0;
const results = [];

for (const [index, file] of files.entries()) {
  const sourceId = `source-${String(index + 1).padStart(3, "0")}`;
  const findings = [];
  let sha256 = null;

  if (!insideApprovedRoot(file.path)) {
    findings.push({
      rule: "outside-approved-root",
      severity: "block",
      line: null,
    });
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
  limits: { maxFileBytes, maxTotalBytes },
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
  process.stdout.write(serialized);
}

process.exit(status === "block" ? 2 : status === "review" ? 1 : 0);
