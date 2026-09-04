import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const RECEIPT_KIND = "fde-readout-input-receipt/v1";
export const RECEIPT_AUTHORIZATION_DECISION = "approve";
export const RECEIPT_AUTHORIZATION_SCOPE = "compile-readout-plan-only";

const hashPattern = /^[a-f0-9]{64}$/;
const sourceStatuses = new Set(["clear", "review", "block"]);
const receiptKeys = [
  "approvedReviewEntries",
  "authorizationDecision",
  "authorizationInput",
  "authorizationScope",
  "authoritySourceDescription",
  "kind",
  "sourceInput",
];
const bindingKeys = ["manifestSha256", "sha256"];
const reviewEntryKeys = ["input", "sourceId"];
const forbiddenIntentFields = new Set([
  "approvedReviewEntries",
  "authorizationApproval",
  "authorizationDecision",
  "authorizationInput",
  "authorizationManifest",
  "authorizationScope",
  "authoritySourceDescription",
  "inputReceipt",
  "inputSha256",
  "manifestSha256",
  "provenance",
  "receipt",
  "sourceApproval",
  "sourceInput",
  "sourceManifest",
]);
const nativePath = { isAbsolute, relative, resolve, sep };

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
}

function requireExactKeys(value, expected, label) {
  requireRecord(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} fields must be exactly: ${wanted.join(", ")}`);
  }
}

function requireHash(value, label) {
  if (!hashPattern.test(value ?? "")) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function insideRoot(root, path, pathApi = nativePath) {
  const resolvedRoot = pathApi.resolve(root);
  const resolvedPath = pathApi.resolve(path);
  const candidate = pathApi.relative(resolvedRoot, resolvedPath);
  return (
    (candidate === "" && resolvedRoot === resolvedPath) ||
    (!pathApi.isAbsolute(candidate) &&
      candidate !== ".." &&
      !candidate.startsWith(`..${pathApi.sep}`) &&
      pathApi.resolve(resolvedRoot, candidate) === resolvedPath)
  );
}

export function parseJsonBytes(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} must be UTF-8: ${error.message}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
  requireRecord(value, label);
  return value;
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function statusForFindings(findings, label) {
  if (!Array.isArray(findings)) throw new Error(`${label} must be an array`);
  let hasBlock = false;
  for (const [index, finding] of findings.entries()) {
    requireRecord(finding, `${label}[${index}]`);
    if (!nonEmpty(finding.rule)) {
      throw new Error(`${label}[${index}].rule must be a non-empty string`);
    }
    if (!["review", "block"].includes(finding.severity)) {
      throw new Error(`${label}[${index}].severity is invalid`);
    }
    if (
      finding.line !== null &&
      (!Number.isInteger(finding.line) || finding.line < 1)
    ) {
      throw new Error(`${label}[${index}].line must be null or a positive integer`);
    }
    if (finding.severity === "block") hasBlock = true;
  }
  return hasBlock ? "block" : findings.length > 0 ? "review" : "clear";
}

export function verifyManifest(manifest, label) {
  requireRecord(manifest, `${label} manifest`);
  requireHash(manifest.manifestSha256, `${label} manifestSha256`);
  const body = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key !== "manifestSha256") body[key] = value;
  }
  if (sha256(JSON.stringify(body)) !== manifest.manifestSha256) {
    throw new Error(`${label} manifestSha256 does not match its body`);
  }
  if (manifest.version !== 1) {
    throw new Error(`${label} manifest version must be 1`);
  }
  if (!Array.isArray(manifest.sources)) {
    throw new Error(`${label} manifest sources must be an array`);
  }
  if (!sourceStatuses.has(manifest.status)) {
    throw new Error(`${label} manifest status is invalid`);
  }

  for (const [index, source] of manifest.sources.entries()) {
    const sourceLabel = `${label} manifest sources[${index}]`;
    requireRecord(source, sourceLabel);
    if (!nonEmpty(source.sourceId)) {
      throw new Error(`${sourceLabel}.sourceId must be a non-empty string`);
    }
    if (!Number.isInteger(source.bytes) || source.bytes < 0) {
      throw new Error(`${sourceLabel}.bytes must be a non-negative integer`);
    }
    if (source.sha256 !== null) {
      requireHash(source.sha256, `${sourceLabel}.sha256`);
    }
    if (source.trust !== "untrusted-data") {
      throw new Error(`${sourceLabel}.trust must be untrusted-data`);
    }
    if (!sourceStatuses.has(source.status)) {
      throw new Error(`${sourceLabel}.status is invalid`);
    }
    const expectedStatus = statusForFindings(
      source.findings,
      `${sourceLabel}.findings`,
    );
    if (source.status !== expectedStatus) {
      throw new Error(`${sourceLabel}.status differs from its findings`);
    }
  }

  const expectedManifestStatus = manifest.sources.some(
    (source) => source.status === "block",
  )
    ? "block"
    : manifest.sources.some((source) => source.status === "review")
      ? "review"
      : "clear";
  if (manifest.status !== expectedManifestStatus) {
    throw new Error(`${label} manifest status differs from its sources`);
  }
  return manifest;
}

export function matchManifestInput(input, manifest, label) {
  const matches = manifest.sources.filter(
    (source) =>
      source.bytes === input.byteLength && source.sha256 === input.sha256,
  );
  if (matches.length === 0) {
    throw new Error(
      `${label} does not match exactly one preflight manifest entry`,
    );
  }
  if (matches.length > 1) {
    throw new Error(`${label} matches multiple preflight manifest entries`);
  }
  if (matches[0].status === "block") {
    throw new Error(`${label} preflight status is block`);
  }
  return matches[0];
}

function normalizedReviewEntries(entries) {
  if (!Array.isArray(entries)) {
    throw new Error("receipt approvedReviewEntries must be an array");
  }
  const seen = new Set();
  const normalized = entries.map((entry, index) => {
    requireExactKeys(
      entry,
      reviewEntryKeys,
      `receipt approvedReviewEntries[${index}]`,
    );
    if (!["source", "authorization"].includes(entry.input)) {
      throw new Error(
        `receipt approvedReviewEntries[${index}].input is invalid`,
      );
    }
    if (!nonEmpty(entry.sourceId)) {
      throw new Error(
        `receipt approvedReviewEntries[${index}].sourceId must be a non-empty string`,
      );
    }
    const key = `${entry.input}:${entry.sourceId}`;
    if (seen.has(key)) {
      throw new Error("receipt approvedReviewEntries contain duplicates");
    }
    seen.add(key);
    return { input: entry.input, sourceId: entry.sourceId };
  });
  return normalized.sort((left, right) =>
    `${left.input}:${left.sourceId}`.localeCompare(
      `${right.input}:${right.sourceId}`,
    ),
  );
}

export function validateReceipt(
  receipt,
  {
    sourceInput,
    sourceManifest,
    sourceMatch,
    authorizationInput,
    authorizationManifest,
    authorizationMatch,
  },
) {
  requireExactKeys(receipt, receiptKeys, "receipt");
  if (receipt.kind !== RECEIPT_KIND) {
    throw new Error(`receipt kind must be ${RECEIPT_KIND}`);
  }
  requireExactKeys(receipt.sourceInput, bindingKeys, "receipt sourceInput");
  requireExactKeys(
    receipt.authorizationInput,
    bindingKeys,
    "receipt authorizationInput",
  );
  requireHash(receipt.sourceInput.sha256, "receipt sourceInput.sha256");
  requireHash(
    receipt.sourceInput.manifestSha256,
    "receipt sourceInput.manifestSha256",
  );
  requireHash(
    receipt.authorizationInput.sha256,
    "receipt authorizationInput.sha256",
  );
  requireHash(
    receipt.authorizationInput.manifestSha256,
    "receipt authorizationInput.manifestSha256",
  );
  if (receipt.sourceInput.sha256 !== sourceInput.sha256) {
    throw new Error("receipt source input SHA-256 differs");
  }
  if (
    receipt.authorizationInput.sha256 !== authorizationInput.sha256
  ) {
    throw new Error("receipt authorization input SHA-256 differs");
  }
  if (
    receipt.sourceInput.manifestSha256 !== sourceManifest.manifestSha256
  ) {
    throw new Error("receipt source manifest SHA-256 differs");
  }
  if (
    receipt.authorizationInput.manifestSha256 !==
    authorizationManifest.manifestSha256
  ) {
    throw new Error("receipt authorization manifest SHA-256 differs");
  }

  const expectedReviewEntries = [];
  if (sourceMatch.status === "review") {
    expectedReviewEntries.push({
      input: "source",
      sourceId: sourceMatch.sourceId,
    });
  }
  if (authorizationMatch.status === "review") {
    expectedReviewEntries.push({
      input: "authorization",
      sourceId: authorizationMatch.sourceId,
    });
  }
  if (
    canonical(normalizedReviewEntries(receipt.approvedReviewEntries)) !==
    canonical(normalizedReviewEntries(expectedReviewEntries))
  ) {
    throw new Error(
      "receipt approvedReviewEntries do not match reviewed inputs",
    );
  }
  if (receipt.authorizationDecision !== RECEIPT_AUTHORIZATION_DECISION) {
    throw new Error(
      `receipt authorizationDecision must be ${RECEIPT_AUTHORIZATION_DECISION}`,
    );
  }
  if (receipt.authorizationScope !== RECEIPT_AUTHORIZATION_SCOPE) {
    throw new Error(
      `receipt authorizationScope must be ${RECEIPT_AUTHORIZATION_SCOPE}`,
    );
  }
  if (!nonEmpty(receipt.authoritySourceDescription)) {
    throw new Error(
      "receipt authoritySourceDescription must be a non-empty string",
    );
  }
}

function formatIntentPath(node, finalSegment) {
  const segments = [finalSegment];
  for (let current = node; current; current = current.parent) {
    segments.push(current.segment);
  }
  return `intent${segments.reverse().join("")}`;
}

export function findForbiddenIntentField(value) {
  const stack = [{ value, path: null, root: true }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: current.value[index],
          path: {
            parent: current.path,
            segment: `[${index}]`,
          },
          root: false,
        });
      }
      continue;
    }
    if (!isRecord(current.value)) continue;
    const entries = Object.entries(current.value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, item] = entries[index];
      if (forbiddenIntentFields.has(key)) {
        return current.root
          ? key
          : formatIntentPath(current.path, `.${key}`);
      }
      stack.push({
        value: item,
        path: {
          parent: current.path,
          segment: `.${key}`,
        },
        root: false,
      });
    }
  }
  return null;
}
