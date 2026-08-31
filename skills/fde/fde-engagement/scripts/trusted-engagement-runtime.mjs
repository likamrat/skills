#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  const display = names.map((path) => process.platform === "win32"
    ? path.toLowerCase() : path);
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

async function verifiedLog(logPath, keyProvider) {
  const bytes = await readFile(logPath);
  if (bytes.length === 0) return { entries: [], records: [], head: EMPTY_HEAD };
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
  return { entries, records, head };
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
    if (process.platform !== "win32") {
      const directory = await open(dirname(checkpointPath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    if (!replaced) await removeTemporary(temporary);
  }
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

export async function initializeLog({ logPath, checkpointPath }) {
  requireValue(typeof logPath === "string" && typeof checkpointPath === "string",
    "log and checkpoint paths are required");
  ({ logPath, checkpointPath } = await checkedPaths(logPath, checkpointPath));
  return withLock(logPath, async () => {
    const handle = await open(logPath, "wx", 0o600);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const state = await replayRecords([], () => undefined);
    await writeCheckpoint(checkpointPath, EMPTY_HEAD, state);
    return snapshotJson({ head: EMPTY_HEAD, state });
  });
}

async function appendTransformed(options, transform) {
  let { logPath, checkpointPath, expectedHead, keyId, keyProvider } = options;
  ({ logPath, checkpointPath } = await checkedPaths(logPath, checkpointPath));
  const input = prepareRecord(options.record);
  return withLock(logPath, async () => {
    const current = await verifiedLog(logPath, keyProvider);
    requireExactHead(expectedHead, current.head);
    const record = await transform(input, keyId, keyProvider);
    const state = await replayRecords([...current.records, record], keyProvider);
    const entry = await signEntry(record, current.head, keyId, keyProvider);
    const handle = await open(logPath, "a", 0o600);
    try {
      await handle.writeFile(`${serializeJson(entry)}\n`);
      await handle.sync();
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

export function appendRecord(options) {
  return appendTransformed(options, async (record) => record);
}

export function appendTrustedAuthority(options) {
  return appendTransformed(options, (record, keyId, keyProvider) =>
    mintAuthority(record, options.authority, keyId, keyProvider));
}

export function appendTrustedSubmission(options) {
  return appendTransformed(options, (record, keyId, keyProvider) =>
    mintSubmission(record, options.submitter, keyId, keyProvider));
}

export async function verifyAndReplay({
  logPath, checkpointPath, trustedHead, keyProvider,
}) {
  ({ logPath, checkpointPath } = await checkedPaths(logPath, checkpointPath));
  return withLock(logPath, async () => {
    const current = await verifiedLog(logPath, keyProvider);
    requireTrustedPrefix(trustedHead, current.entries);
    const state = await replayRecords(current.records, keyProvider);
    await writeCheckpoint(checkpointPath, current.head, state);
    return snapshotJson({ head: current.head, state });
  });
}

function parseArguments(values) {
  const [command, ...rest] = values;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    requireValue(
      flag?.startsWith("--") && rest[index + 1] != null,
      `invalid argument near ${flag ?? "end of command"}`,
    );
    options[flag.slice(2)] = rest[index + 1];
  }
  return { command, options };
}

function required(options, name) {
  const value = options[name];
  requireValue(
    typeof value === "string" && value.length > 0,
    `--${name} is required`,
  );
  return value;
}

async function jsonFile(path, label) {
  try {
    return snapshotJson(JSON.parse(UTF8.decode(await readFile(path))));
  } catch (error) {
    throw new Error(`${label} is invalid: ${error.message}`);
  }
}

function environmentKey() {
  const keyId = process.env.FDE_HMAC_KEY_ID;
  const hex = process.env.FDE_HMAC_KEY_HEX;
  requireValue(
    keyId && hex && /^[a-fA-F0-9]{64,}$/.test(hex) && hex.length % 2 === 0,
    "FDE_HMAC_KEY_ID and a 32-byte or longer FDE_HMAC_KEY_HEX are required",
  );
  const key = Buffer.from(hex, "hex");
  return {
    keyId,
    keyProvider: async (requested) => requested === keyId ? key : undefined,
  };
}

export async function runCli(argv) {
  const { command, options } = parseArguments(argv);
  const logPath = required(options, "log");
  const checkpointPath = required(options, "checkpoint");
  if (command === "init") return initializeLog({ logPath, checkpointPath });
  const { keyId, keyProvider } = environmentKey();
  if (command === "replay") {
    return verifyAndReplay({
      logPath,
      checkpointPath,
      trustedHead: await jsonFile(required(options, "trusted-head"), "trusted head"),
      keyProvider,
    });
  }
  const common = {
    logPath,
    checkpointPath,
    record: await jsonFile(required(options, "record"), "record"),
    expectedHead: await jsonFile(required(options, "expected-head"), "expected head"),
    keyId,
    keyProvider,
  };
  if (command === "append") return appendRecord(common);
  if (command === "append-authority") {
    return appendTrustedAuthority({
      ...common,
      authority: { kind: "human", id: required(options, "actor-id") },
    });
  }
  if (command === "append-submission") {
    return appendTrustedSubmission({
      ...common,
      submitter: {
        kind: required(options, "actor-kind"),
        id: required(options, "actor-id"),
      },
    });
  }
  throw new Error(`unknown command ${command ?? "(missing)"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${serializeJson(await runCli(process.argv.slice(2)))}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
