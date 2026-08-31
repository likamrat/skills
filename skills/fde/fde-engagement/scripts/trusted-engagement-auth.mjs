import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { replayEngagement } from "./engagement-protocol.mjs";
import { encodeJson, serializeJson, snapshotJson } from "./protocol-json.mjs";

const VERSION = 1;
const ALGORITHM = "hmac-sha256";
const AUTHORITY = "fde-authority-v1";
const SUBMISSION = "fde-submission-v1";
const LOG = "fde-log-entry-v1";
const ENVELOPE_KEYS = ["algorithm", "domain", "keyId", "signature", "version"];
const ENTRY_KEYS = [
  "authentication", "entryDigest", "previousDigest", "record", "sequence", "version",
];
const SIGNED_ENTRY_KEYS = ENTRY_KEYS.filter((key) => key !== "entryDigest");

export const EMPTY_HEAD = snapshotJson({ version: VERSION, sequence: 0, digest: null });

export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, label) {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  const actual = Object.keys(value).sort();
  requireValue(
    actual.length === keys.length && keys.every((key, index) => key === actual[index]),
    `${label} has unexpected fields`,
  );
}

const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

function metadata(envelope, domain, label) {
  exactKeys(envelope, ENVELOPE_KEYS, label);
  requireValue(envelope.version === VERSION, `${label}.version is unsupported`);
  requireValue(envelope.domain === domain, `${label}.domain is unsupported`);
  requireValue(envelope.algorithm === ALGORITHM, `${label}.algorithm is unsupported`);
  requireValue(nonEmpty(envelope.keyId), `${label}.keyId is required`);
  requireValue(
    typeof envelope.signature === "string" &&
      /^[a-f0-9]{64}$/.test(envelope.signature),
    `${label}.signature must be 64 lowercase hex characters`,
  );
  return { version: VERSION, domain, algorithm: ALGORITHM, keyId: envelope.keyId };
}

async function keyBytes(keyProvider, keyId) {
  requireValue(typeof keyProvider === "function", "keyProvider is required");
  const value = await keyProvider(keyId);
  requireValue(
    value instanceof Uint8Array && value.byteLength >= 32,
    `key ${keyId} is missing or shorter than 32 bytes`,
  );
  return Buffer.from(value);
}

function hmac(key, domain, value) {
  return createHmac("sha256", key)
    .update(domain).update("\0").update(serializeJson(value)).digest("hex");
}

const sha256 = (value) =>
  createHash("sha256").update(serializeJson(value)).digest("hex");

function equalHex(actual, expected, label) {
  requireValue(
    typeof actual === "string" && /^[a-f0-9]{64}$/.test(actual),
    `${label} must be 64 lowercase hex characters`,
  );
  requireValue(
    typeof expected === "string" && /^[a-f0-9]{64}$/.test(expected),
    `${label} comparison value is invalid`,
  );
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function unsignedRecord(record, field, envelopeMetadata) {
  return { ...record, [field]: envelopeMetadata };
}

async function verifyRecord(record, field, domain, keyProvider) {
  const envelope = record[field];
  const envelopeMetadata = metadata(envelope, domain, `${record.id}.${field}`);
  const key = await keyBytes(keyProvider, envelopeMetadata.keyId);
  return equalHex(
    envelope.signature,
    hmac(key, domain, unsignedRecord(record, field, envelopeMetadata)),
    `${record.id}.${field}.signature`,
  );
}

async function mint(record, field, domain, keyId, keyProvider) {
  requireValue(
    !Object.hasOwn(record, "attestation") &&
      !Object.hasOwn(record, "submissionReceipt"),
    `${record.id ?? "record"} must not contain a preexisting trust envelope`,
  );
  requireValue(nonEmpty(keyId), "keyId is required");
  const envelope = { version: VERSION, domain, algorithm: ALGORITHM, keyId };
  const signature = hmac(
    await keyBytes(keyProvider, keyId),
    domain,
    unsignedRecord(record, field, envelope),
  );
  return snapshotJson({ ...record, [field]: { ...envelope, signature } });
}

function actor(value, requiredKind) {
  const copy = snapshotJson(value);
  exactKeys(copy, ["id", "kind"], "trusted actor");
  requireValue(nonEmpty(copy.id) && nonEmpty(copy.kind), "trusted actor is invalid");
  requireValue(
    !requiredKind || copy.kind === requiredKind,
    `trusted actor.kind must be ${requiredKind}`,
  );
  return copy;
}

export function prepareRecord(value) {
  const record = snapshotJson(value);
  requireValue(
    record && typeof record === "object" && !Array.isArray(record),
    "record must be an object",
  );
  requireValue(
    !Object.hasOwn(record, "trusted"),
    "record.trusted is not an accepted authority field",
  );
  return record;
}

export async function mintAuthority(record, authority, keyId, keyProvider) {
  requireValue(
    record.type !== "case-submitted",
    "case-submitted records require a submission receipt",
  );
  return mint(
    { ...record, actor: actor(authority, "human") },
    "attestation",
    AUTHORITY,
    keyId,
    keyProvider,
  );
}

export async function mintSubmission(record, submitter, keyId, keyProvider) {
  requireValue(
    record.type === "case-submitted",
    "trusted submissions require type case-submitted",
  );
  return mint(
    { ...record, actor: actor(submitter) },
    "submissionReceipt",
    SUBMISSION,
    keyId,
    keyProvider,
  );
}

export async function signEntry(record, head, keyId, keyProvider) {
  requireValue(nonEmpty(keyId), "keyId is required");
  const authentication = {
    version: VERSION, domain: LOG, algorithm: ALGORITHM, keyId,
  };
  const unsigned = {
    version: VERSION,
    sequence: head.sequence + 1,
    previousDigest: head.digest,
    record: encodeJson(record),
    authentication,
  };
  const signature = hmac(await keyBytes(keyProvider, keyId), LOG, unsigned);
  const signed = {
    ...unsigned,
    authentication: { ...authentication, signature },
  };
  return snapshotJson({ ...signed, entryDigest: sha256(signed) });
}

export async function verifyEntry(entry, sequence, previousDigest, keyProvider) {
  exactKeys(entry, ENTRY_KEYS, `entry ${sequence}`);
  requireValue(entry.version === VERSION, `entry ${sequence}.version is unsupported`);
  requireValue(entry.sequence === sequence, `entry ${sequence}.sequence is invalid`);
  if (previousDigest === null) {
    requireValue(entry.previousDigest === null, `entry ${sequence}.previousDigest is invalid`);
  } else {
    requireValue(
      equalHex(entry.previousDigest, previousDigest, `entry ${sequence}.previousDigest`),
      `entry ${sequence}.previousDigest does not match`,
    );
  }
  const envelope = metadata(
    entry.authentication,
    LOG,
    `entry ${sequence}.authentication`,
  );
  const signed = Object.fromEntries(
    SIGNED_ENTRY_KEYS.map((key) => [key, entry[key]]),
  );
  const unsigned = { ...signed, authentication: envelope };
  const key = await keyBytes(keyProvider, envelope.keyId);
  requireValue(
    equalHex(
      entry.authentication.signature,
      hmac(key, LOG, unsigned),
      `entry ${sequence}.authentication.signature`,
    ),
    `entry ${sequence} authentication failed`,
  );
  requireValue(
    equalHex(entry.entryDigest, sha256(signed), `entry ${sequence}.entryDigest`),
    `entry ${sequence}.entryDigest does not match`,
  );
  requireValue(typeof entry.record === "string", `entry ${sequence}.record is invalid`);
  let record;
  try {
    record = snapshotJson(JSON.parse(entry.record));
  } catch (error) {
    throw new Error(`entry ${sequence}.record is corrupt: ${error.message}`);
  }
  requireValue(
    encodeJson(record) === entry.record,
    `entry ${sequence}.record is not strict JSON`,
  );
  return record;
}

function checkedHead(value, label) {
  const head = snapshotJson(value);
  exactKeys(head, ["digest", "sequence", "version"], label);
  requireValue(head.version === VERSION, `${label}.version is unsupported`);
  requireValue(
    Number.isSafeInteger(head.sequence) && head.sequence >= 0,
    `${label}.sequence is invalid`,
  );
  if (head.sequence === 0) {
    requireValue(head.digest === null, `${label}.digest must be null`);
  } else {
    requireValue(
      typeof head.digest === "string" && /^[a-f0-9]{64}$/.test(head.digest),
      `${label}.digest must be 64 lowercase hex characters`,
    );
  }
  return head;
}

export function requireExactHead(value, current) {
  const head = checkedHead(value, "expectedHead");
  requireValue(
    head.sequence === current.sequence &&
      (head.digest === null ||
        equalHex(head.digest, current.digest, "expectedHead.digest")),
    "expectedHead does not equal the current log head",
  );
}

export function requireTrustedPrefix(value, entries) {
  const head = checkedHead(value, "trustedHead");
  requireValue(head.sequence <= entries.length, "trustedHead identifies a truncated log");
  if (head.sequence > 0) {
    requireValue(
      equalHex(
        head.digest,
        entries[head.sequence - 1].entryDigest,
        "trustedHead.digest",
      ),
      "trustedHead does not match the verified log prefix",
    );
  }
}

export function replayRecords(records, keyProvider) {
  return replayEngagement(records, {
    verifyAuthority: (record) =>
      verifyRecord(record, "attestation", AUTHORITY, keyProvider),
    verifyCaseSubmission: (record) =>
      verifyRecord(record, "submissionReceipt", SUBMISSION, keyProvider),
  });
}
