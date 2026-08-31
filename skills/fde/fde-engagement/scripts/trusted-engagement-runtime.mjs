import { randomUUID } from "node:crypto";
import { open, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  EMPTY_HEAD, mintAuthority, mintSubmission, prepareRecord, replayRecords,
  requireExactHead, requireTrustedPrefix, requireValue, signEntry, verifyEntry,
} from "./trusted-engagement-auth.mjs";
import { serializeJson, snapshotJson } from "./protocol-json.mjs";
const UTF8 = new TextDecoder("utf-8", { fatal: true });
async function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) { if (error.code !== "ENOENT") throw error;
    return join(await realpath(dirname(absolute)), basename(absolute));
  }
}
async function checkedPaths(logPath, checkpointPath) {
  const logName = await canonicalPath(logPath);
  const names = await Promise.all([Promise.resolve(logName),
    canonicalPath(checkpointPath), canonicalPath(`${logName}.lock`)]);
  const display = names;
  const identities = await Promise.all(names.map(async (path) => {
    try {
      const value = await stat(path);
      return `${value.dev}:${value.ino}`;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }));
  requireValue(display[0] !== display[1] && display[1] !== display[2] &&
    (identities[1] === null ||
      (identities[0] !== identities[1] && identities[1] !== identities[2])),
    "log and checkpoint paths must differ",
  );
  return { logPath: names[0], checkpointPath: names[1] };
}
function requireSingleLink(value, label) {
  requireValue(value.nlink === 1, `${label} must have exactly one filesystem link`);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readStableLog(logPath) {
  const handle = await open(logPath, "r");
  try {
    const before = await handle.stat();
    requireSingleLink(before, "log");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const named = await stat(logPath);
    requireValue(
      sameIdentity(before, after) && sameIdentity(before, named),
      "log identity changed during verification",
    );
    requireSingleLink(after, "log");
    requireSingleLink(named, "log");
    return { bytes, identity: before };
  } finally {
    await handle.close();
  }
}

async function verifiedLog(logPath, keyProvider) {
  const { bytes, identity } = await readStableLog(logPath);
  if (bytes.length === 0) {
    return { entries: [], records: [], head: EMPTY_HEAD, identity };
  }
  requireValue(bytes.at(-1) === 10, "log has a trailing partial record");
  let text;
  try { text = UTF8.decode(bytes); } catch {
    throw new Error("log is not valid UTF-8");
  }
  const lines = text.split("\n");
  lines.pop();
  const entries = [];
  const records = [];
  let previousDigest = null;
  for (let index = 0; index < lines.length; index += 1) {
    let parsed;
    try {
      parsed = JSON.parse(lines[index]);
    } catch (error) {
      throw new Error(`log line ${index + 1} is corrupt: ${error.message}`);
    }
    const entry = snapshotJson(parsed);
    requireValue(serializeJson(entry) === lines[index],
      `log line ${index + 1} is not canonical JSON`);
    records.push(await verifyEntry(entry, index + 1, previousDigest, keyProvider));
    entries.push(entry);
    previousDigest = entry.entryDigest;
  }
  const head = snapshotJson(
    { version: 1, sequence: entries.length, digest: previousDigest });
  return { entries, records, head, identity };
}

async function removeTemporary(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function writeCheckpoint(checkpointPath, head, state) {
  const temporary = `${checkpointPath}.${process.pid}.${randomUUID()}.tmp`;
  let replaced = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${serializeJson({ version: 1, head, state })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, checkpointPath);
    replaced = true;
    await syncParentDirectory(checkpointPath);
  } finally {
    if (!replaced) await removeTemporary(temporary);
  }
}

async function syncParentDirectory(path) {
  if (process.platform === "win32") return;
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function reserveCheckpoint(checkpointPath, logIdentity) {
  let handle;
  try { handle = await open(checkpointPath, "wx", 0o600); } catch (error) {
    if (error.code === "EEXIST")
      throw new Error("checkpoint path exists during log initialization");
    throw error;
  }
  try {
    requireValue(!sameIdentity(logIdentity, await handle.stat()),
      "checkpoint path aliases the initialized log");
  } finally { await handle.close(); }
}

async function withLock(logPath, action) {
  const lockPath = `${logPath}.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("log is locked by another writer");
    throw error;
  }
  try {
    return await action();
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function initializeInput({ logPath, checkpointPath }, syncParent) {
  requireValue(typeof logPath === "string" && typeof checkpointPath === "string",
    "log and checkpoint paths are required");
  ({ logPath, checkpointPath } = await checkedPaths(logPath, checkpointPath));
  return withLock(logPath, async () => {
    const handle = await open(logPath, "wx", 0o600);
    let identity;
    try {
      await handle.sync();
      identity = await handle.stat();
      requireSingleLink(identity, "log");
    } finally {
      await handle.close();
    }
    await syncParent(logPath);
    await reserveCheckpoint(checkpointPath, identity);
    const state = await replayRecords([], () => undefined);
    await writeCheckpoint(checkpointPath, EMPTY_HEAD, state);
    return snapshotJson({ head: EMPTY_HEAD, state });
  });
}

export function initializeLog(options, syncParent = syncParentDirectory) {
  const input = snapshotJson(options);
  requireValue(typeof syncParent === "function", "syncParent is required");
  return initializeInput(input, syncParent);
}

async function appendTransformed(options, keyProvider, transform) {
  let { logPath, checkpointPath, expectedHead, keyId } = options;
  ({ logPath, checkpointPath } = await checkedPaths(logPath, checkpointPath));
  const input = prepareRecord(options.record);
  return withLock(logPath, async () => {
    const current = await verifiedLog(logPath, keyProvider);
    requireExactHead(expectedHead, current.head);
    const record = await transform(input, keyId, keyProvider, options);
    const state = await replayRecords([...current.records, record], keyProvider);
    const entry = await signEntry(record, current.head, keyId, keyProvider);
    const handle = await open(logPath, "a", 0o600);
    try {
      const identity = await handle.stat();
      requireValue(
        sameIdentity(identity, current.identity),
        "log identity changed before append",
      );
      requireSingleLink(identity, "log");
      await handle.writeFile(`${serializeJson(entry)}\n`);
      await handle.sync();
      requireSingleLink(await handle.stat(), "log");
    } finally {
      await handle.close();
    }
    const head = snapshotJson({
      version: 1, sequence: entry.sequence, digest: entry.entryDigest,
    });
    await writeCheckpoint(checkpointPath, head, state);
    return snapshotJson({ head, state });
  });
}

function appendInput(options, keyProvider, transform) {
  const input = snapshotJson(options);
  requireValue(typeof keyProvider === "function", "keyProvider is required");
  return appendTransformed(input, keyProvider, transform);
}

export function appendRecord(options, keyProvider) {
  return appendInput(options, keyProvider, async (record) => record);
}

export function appendTrustedAuthority(options, keyProvider) {
  return appendInput(options, keyProvider, (record, keyId, provider, input) =>
    mintAuthority(record, input.authority, keyId, provider));
}

export function appendTrustedSubmission(options, keyProvider) {
  return appendInput(options, keyProvider, (record, keyId, provider, input) =>
    mintSubmission(record, input.submitter, keyId, provider));
}

async function verifyInput({ logPath, checkpointPath, trustedHead }, keyProvider) {
  ({ logPath, checkpointPath } = await checkedPaths(logPath, checkpointPath));
  return withLock(logPath, async () => {
    const current = await verifiedLog(logPath, keyProvider);
    requireTrustedPrefix(trustedHead, current.entries);
    const state = await replayRecords(current.records, keyProvider);
    await writeCheckpoint(checkpointPath, current.head, state);
    return snapshotJson({ head: current.head, state });
  });
}

export function verifyAndReplay(options, keyProvider) {
  const input = snapshotJson(options);
  requireValue(typeof keyProvider === "function", "keyProvider is required");
  return verifyInput(input, keyProvider);
}
