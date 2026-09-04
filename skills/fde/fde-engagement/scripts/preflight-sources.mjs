#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
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
const maxRecordedFindings = 512;
const maxManifestBytes = 2 * 1024 * 1024;
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
const canonicalWorkspaceRoot = await realpath(workspaceRoot);
const resolvedOutput = output ? resolve(output) : null;
let discoveredEntries = 0;
let entryLimitReached = false;
let recordedFindings = 0;

function insideRoot(root, path) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const candidate = relative(resolvedRoot, resolvedPath);
  return (
    (candidate === "" && resolvedRoot === resolvedPath) ||
    (!isAbsolute(candidate) &&
      candidate !== ".." &&
      !candidate.startsWith(`..${sep}`) &&
      resolve(resolvedRoot, candidate) === resolvedPath)
  );
}

function insideApprovedRoot(path) {
  return insideRoot(sourceRoot, path);
}

function sameLexicalPath(
  left,
  right,
  pathApi = {
    resolve,
    caseInsensitive: process.platform === "win32",
  },
) {
  const resolvedLeft = pathApi.resolve(left);
  const resolvedRight = pathApi.resolve(right);
  return pathApi.caseInsensitive
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function outputError(message) {
  console.error(message);
  process.exit(3);
}

async function outputDestination(path) {
  for (const inputRoot of inputRoots) {
    if (sameLexicalPath(path, inputRoot)) {
      outputError("--output must not alias an input source");
    }
  }
  if (path === workspaceRoot || !insideRoot(workspaceRoot, path)) {
    outputError("--output must stay inside the current workspace");
  }

  const parentFromWorkspace = relative(workspaceRoot, dirname(path));
  const components = parentFromWorkspace.split(sep).filter(Boolean);
  let canonicalParent = canonicalWorkspaceRoot;
  for (const component of components) {
    const next = join(canonicalParent, component);
    let info;
    try {
      info = await lstat(next);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        await mkdir(next);
      } catch (mkdirError) {
        if (mkdirError.code !== "EEXIST") throw mkdirError;
      }
      info = await lstat(next);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      outputError("--output parent must not contain a symlink or non-directory");
    }
    canonicalParent = await realpath(next);
    if (!insideRoot(canonicalWorkspaceRoot, canonicalParent)) {
      outputError("--output parent must stay inside the current workspace");
    }
  }

  const destination = join(canonicalParent, basename(path));
  let destinationInfo = null;
  let canonicalDestination = null;
  try {
    destinationInfo = await lstat(destination, { bigint: true });
    if (destinationInfo.isSymbolicLink() || !destinationInfo.isFile()) {
      outputError("--output must be a regular file, not a symlink");
    }
    canonicalDestination = await realpath(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (destinationInfo) {
    for (const inputRoot of inputRoots) {
      let inputInfo;
      let canonicalInput;
      try {
        inputInfo = await lstat(inputRoot, { bigint: true });
        canonicalInput = await realpath(inputRoot);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (
        canonicalDestination === canonicalInput ||
        (destinationInfo.dev === inputInfo.dev &&
          destinationInfo.ino === inputInfo.ino)
      ) {
        outputError("--output must not alias an input source");
      }
    }
  }
  return { destination, parent: canonicalParent };
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

function fileSnapshot(info) {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    size: info.size,
    birthtimeNs: info.birthtimeNs,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  };
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.birthtimeNs === right.birthtimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameTraversalSnapshot(left, right) {
  const sameStableFields =
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.birthtimeNs === right.birthtimeNs &&
    left.mtimeNs === right.mtimeNs;
  const freshWindowsCtimeSettlement =
    process.platform === "win32" &&
    left.ctimeNs === left.mtimeNs &&
    right.ctimeNs > left.ctimeNs &&
    right.ctimeNs - left.ctimeNs <= 1_000_000_000n;
  return (
    sameStableFields &&
    (left.ctimeNs === right.ctimeNs || freshWindowsCtimeSettlement)
  );
}

function boundedReadLimit(totalBytes, maxFileBytes, maxTotalBytes) {
  return Math.min(
    maxFileBytes,
    Math.max(0, maxTotalBytes - totalBytes),
  );
}

async function openTraversalFile(
  path,
  traversalSnapshot,
  openFile = open,
  inspectFile = lstat,
) {
  const handle = await openFile(path, "r");
  let keepOpen = false;
  try {
    const current = fileSnapshot(await inspectFile(path, { bigint: true }));
    const opened = fileSnapshot(await handle.stat({ bigint: true }));
    if (
      !sameTraversalSnapshot(traversalSnapshot, current) ||
      !sameTraversalSnapshot(traversalSnapshot, opened)
    ) {
      return { changed: true, handle: null };
    }
    keepOpen = true;
    return { changed: false, handle };
  } finally {
    if (!keepOpen) await handle.close();
  }
}

async function readBoundedFile(
  file,
  maxBytes,
  openFile = open,
  inspectFile = lstat,
) {
  const opened = await openTraversalFile(
    file.path,
    file.snapshot,
    openFile,
    inspectFile,
  );
  if (opened.changed) {
    return {
      bytes: Buffer.alloc(0),
      changed: true,
      exceededLimit: false,
      size: file.snapshot.size,
    };
  }
  const handle = opened.handle;
  try {
    const before = fileSnapshot(await handle.stat({ bigint: true }));
    if (
      file.snapshot &&
      !sameTraversalSnapshot(file.snapshot, before)
    ) {
      return {
        bytes: Buffer.alloc(0),
        changed: true,
        exceededLimit: false,
        size: before.size,
      };
    }
    const current = fileSnapshot(
      await inspectFile(file.path, { bigint: true }),
    );
    if (!sameTraversalSnapshot(current, before)) {
      return {
        bytes: Buffer.alloc(0),
        changed: true,
        exceededLimit: false,
        size: before.size,
      };
    }

    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const length = Math.min(64 * 1024, maxBytes + 1 - total);
      if (length <= 0) break;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }

    const after = fileSnapshot(await handle.stat({ bigint: true }));
    const exceededLimit = total > maxBytes;
    return {
      bytes: Buffer.concat(chunks, total),
      changed:
        !sameFileSnapshot(before, after) ||
        (!exceededLimit && BigInt(total) !== before.size),
      exceededLimit,
      size: before.size,
    };
  } finally {
    await handle.close();
  }
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

  const info = await lstat(resolvedPath, { bigint: true });
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
    const traversalSnapshot = fileSnapshot(info);
    files.push({
      path: resolvedPath,
      symlink: false,
      size: Number(traversalSnapshot.size),
      snapshot: traversalSnapshot,
    });
    return;
  }
  addTraversalFinding(resolvedPath, "non-regular-source");
}

async function hasDuplicateInputRoot(paths) {
  const lexicalRoots = new Set();
  const canonicalRoots = new Set();
  for (const root of paths) {
    if (lexicalRoots.has(root)) return true;
    lexicalRoots.add(root);
  }
  for (const root of paths.slice(0, maxDiscoveredEntries)) {
    if (!insideApprovedRoot(root)) continue;
    const pathFromSourceRoot = relative(sourceRoot, root);
    const components = pathFromSourceRoot.split(sep).filter(Boolean);
    let componentPath = sourceRoot;
    let containsLink = false;
    for (const component of components) {
      componentPath = join(componentPath, component);
      if ((await lstat(componentPath)).isSymbolicLink()) {
        containsLink = true;
        break;
      }
    }
    if (containsLink) continue;
    const canonical = await realpath(root);
    if (canonicalRoots.has(canonical)) return true;
    canonicalRoots.add(canonical);
  }
  return false;
}

async function unsupportedSnapshot(file) {
  const current = fileSnapshot(
    await lstat(file.path, { bigint: true }),
  );
  return {
    changed: !sameTraversalSnapshot(file.snapshot, current),
    size: Number(current.size),
  };
}

if (await hasDuplicateInputRoot(inputRoots)) {
  registerDiscoveredEntry(inputRoots[0]);
  addTraversalFinding(inputRoots[0], "duplicate-source-path");
} else {
  for (const root of inputRoots) {
    if (!insideApprovedRoot(root)) {
      if (!registerDiscoveredEntry(root)) break;
      addTraversalFinding(root, "outside-approved-root");
      continue;
    }
    const resultStart = files.length;
    await walk(root, 0);
    if (files.length === resultStart && !entryLimitReached) {
      addTraversalFinding(root, "empty-input-root");
    }
    if (entryLimitReached) break;
  }
}
files.sort((left, right) =>
  (left.sortKey ?? left.path).localeCompare(right.sortKey ?? right.path),
);

let totalBytes = 0;
const results = [];

for (const [index, file] of files.entries()) {
  const sourceId = `source-${String(index + 1).padStart(3, "0")}`;
  const findings = structuredClone(file.traversalFindings ?? []);
  let findingsLimited = false;
  function addPatternFinding(finding) {
    if (recordedFindings < maxRecordedFindings) {
      findings.push(finding);
      recordedFindings += 1;
      return;
    }
    if (!findingsLimited) {
      findings.push({
        rule: "findings-limit",
        severity: "block",
        line: null,
      });
      findingsLimited = true;
    }
  }
  let sourceBytes = file.size;
  let sha256 = null;

  if (findings.length > 0) {
    // Traversal findings stop before source bytes or directory entries are read.
  } else if (file.symlink) {
    findings.push({ rule: "symlink", severity: "block", line: null });
  } else {
    const remainingTotalBytes = Math.max(0, maxTotalBytes - totalBytes);
    const supportedFormat = supported.has(extname(file.path).toLowerCase());
    if (!supportedFormat) {
      const metadata = await unsupportedSnapshot(file);
      sourceBytes = metadata.size;
      totalBytes += sourceBytes;
      if (metadata.changed) {
        findings.push({
          rule: "file-changed-during-scan",
          severity: "block",
          line: null,
        });
      } else if (sourceBytes > maxFileBytes) {
        findings.push({
          rule: "file-size-limit",
          severity: "block",
          line: null,
        });
      } else if (sourceBytes > remainingTotalBytes) {
        findings.push({
          rule: "total-size-limit",
          severity: "block",
          line: null,
        });
      } else {
        findings.push({
          rule: "unsupported-or-binary-format",
          severity: "review",
          line: null,
        });
      }
    } else if (totalBytes > maxTotalBytes) {
      sourceBytes = 0;
      findings.push({
        rule: "total-size-limit",
        severity: "block",
        line: null,
      });
    } else {
      const scan = await readBoundedFile(
        file,
        boundedReadLimit(totalBytes, maxFileBytes, maxTotalBytes),
      );
      sourceBytes = scan.bytes.length;
      totalBytes += sourceBytes;
      const fileLimitExceeded =
        scan.size > BigInt(maxFileBytes) ||
        sourceBytes > maxFileBytes;
      const totalLimitExceeded = sourceBytes > remainingTotalBytes;
      if (scan.changed) {
        findings.push({
          rule: "file-changed-during-scan",
          severity: "block",
          line: null,
        });
      }
      if (fileLimitExceeded) {
        findings.push({
          rule: "file-size-limit",
          severity: "block",
          line: null,
        });
      } else if (totalLimitExceeded) {
        findings.push({
          rule: "total-size-limit",
          severity: "block",
          line: null,
        });
      } else if (!scan.changed) {
        sha256 = createHash("sha256").update(scan.bytes).digest("hex");
        let text;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(scan.bytes);
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
                addPatternFinding({
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
  }

  const status = findings.some((item) => item.severity === "block")
    ? "block"
    : findings.length > 0
      ? "review"
      : "clear";
  results.push({
    sourceId,
    bytes: sourceBytes,
    sha256,
    trust: "untrusted-data",
    status,
    findings,
  });
}

const manifestResults = [];
const resultsByFingerprint = new Map();
for (const result of results) {
  if (!result.sha256) {
    manifestResults.push(result);
    continue;
  }
  const fingerprint = `${result.bytes}:${result.sha256}`;
  const retained = resultsByFingerprint.get(fingerprint);
  if (!retained) {
    resultsByFingerprint.set(fingerprint, result);
    manifestResults.push(result);
    continue;
  }
  if (!retained.findings.some((item) => item.rule === "duplicate-source-bytes")) {
    retained.findings.push({
      rule: "duplicate-source-bytes",
      severity: "block",
      line: null,
    });
    retained.status = "block";
  }
}

let status = manifestResults.some((item) => item.status === "block")
  ? "block"
  : manifestResults.some((item) => item.status === "review")
    ? "review"
    : "clear";
let manifestBody = {
  version: 1,
  generatedAt: new Date().toISOString(),
  status,
  limits: {
    maxFileBytes,
    maxTotalBytes,
    maxTraversalDepth,
    maxDiscoveredEntries,
    maxRecordedFindings,
    maxManifestBytes,
  },
  note:
    "A clear result means no known pattern matched. A findings-limit block means additional findings were compacted. Neither result makes source content trusted or authorizes actions.",
  sources: manifestResults,
};

function serializeManifest(body) {
  const manifestSha256 = createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex");
  return `${JSON.stringify({ ...body, manifestSha256 }, null, 2)}\n`;
}

let serialized = serializeManifest(manifestBody);
if (Buffer.byteLength(serialized) > maxManifestBytes) {
  status = "block";
  manifestBody = {
    ...manifestBody,
    status: "block",
    sources: [
      {
        sourceId: "source-001",
        bytes: 0,
        sha256: null,
        trust: "untrusted-data",
        status: "block",
        findings: [
          {
            rule: "manifest-size-limit",
            severity: "block",
            line: null,
          },
        ],
      },
    ],
  };
  serialized = serializeManifest(manifestBody);
}

if (output) {
  const target = await outputDestination(resolvedOutput);
  const temporary = join(
    target.parent,
    `.${randomUUID()}.preflight-manifest.tmp`,
  );
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target.destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  console.log(`Wrote ${target.destination}`);
} else {
  await new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(serialized, (error) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

process.exitCode = status === "block" ? 2 : status === "review" ? 1 : 0;
