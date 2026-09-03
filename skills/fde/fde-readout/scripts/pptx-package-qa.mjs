#!/usr/bin/env node

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

export const PACKAGE_QA_LIMITS = Object.freeze({
  maxArchiveBytes: 128 * 1024 * 1024,
  maxEntries: 2048,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalUncompressedBytes: 128 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxNameBytes: 1024,
  maxXmlAttributesPerElement: 256,
  maxXmlBytes: 8 * 1024 * 1024,
  maxXmlNamespaces: 256,
  maxXmlNodes: 100_000,
});

const CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const PACKAGE_RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PRESENTATION_NAMESPACE =
  "http://schemas.openxmlformats.org/presentationml/2006/main";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
const PRESENTATION_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
const SLIDE_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const NOTES_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml";
const RELATIONSHIPS_CONTENT_TYPE =
  "application/vnd.openxmlformats-package.relationships+xml";
const SLIDE_WIDTH_EMU = 12_192_000;
const SLIDE_HEIGHT_EMU = 6_858_000;

const RELATIONSHIP_TYPES = Object.freeze({
  officeDocument: `${OFFICE_RELATIONSHIPS_NAMESPACE}/officeDocument`,
  slide: `${OFFICE_RELATIONSHIPS_NAMESPACE}/slide`,
  notesSlide: `${OFFICE_RELATIONSHIPS_NAMESPACE}/notesSlide`,
});

const DANGEROUS_RELATIONSHIP_SUFFIXES = [
  "/attachedtemplate",
  "/activex",
  "/control",
  "/embeddedobject",
  "/externallink",
  "/image",
  "/audio",
  "/media",
  "/oleobject",
  "/package",
  "/video",
  "/vbaproject",
];

const EXECUTABLE_EXTENSIONS = new Set([
  "app",
  "bat",
  "bin",
  "cmd",
  "com",
  "cpl",
  "dll",
  "dylib",
  "exe",
  "hta",
  "jar",
  "js",
  "jse",
  "lnk",
  "mjs",
  "msi",
  "msp",
  "pif",
  "ps1",
  "scr",
  "sh",
  "so",
  "vbe",
  "vbs",
  "wsf",
  "wsh",
]);

const PACKAGE_EXTENSIONS = new Set([
  "7z",
  "docm",
  "docx",
  "dotm",
  "dotx",
  "gz",
  "odp",
  "ods",
  "odt",
  "potm",
  "potx",
  "ppsm",
  "ppsx",
  "pptm",
  "pptx",
  "rar",
  "tar",
  "xlsm",
  "xlsx",
  "xltm",
  "xltx",
  "zip",
]);

const MEDIA_EXTENSIONS = new Set([
  "aac",
  "avi",
  "bmp",
  "emf",
  "gif",
  "heic",
  "jpeg",
  "jpg",
  "m4a",
  "m4v",
  "mov",
  "mp3",
  "mp4",
  "mpeg",
  "mpg",
  "ogg",
  "png",
  "svg",
  "tif",
  "tiff",
  "wav",
  "webm",
  "webp",
  "wmf",
  "wmv",
]);

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
let crcTable;

class QaError extends Error {
  constructor(code, message, part) {
    super(message);
    this.name = "QaError";
    this.code = code;
    this.part = part;
  }
}

function isValidXmlCodePoint(point) {
  return (
    point === 0x09 ||
    point === 0x0a ||
    point === 0x0d ||
    (point >= 0x20 && point <= 0xd7ff) ||
    (point >= 0xe000 && point <= 0xfffd) ||
    (point >= 0x10000 && point <= 0x10ffff)
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readUInt16(bytes, offset, label) {
  if (offset < 0 || offset + 2 > bytes.length) {
    throw new QaError("ZIP_TRUNCATED", `${label} is truncated`);
  }
  return bytes.readUInt16LE(offset);
}

function readUInt32(bytes, offset, label) {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new QaError("ZIP_TRUNCATED", `${label} is truncated`);
  }
  return bytes.readUInt32LE(offset);
}

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    crcTable[index] = value >>> 0;
  }
  return crcTable;
}

function crc32(bytes) {
  const table = getCrcTable();
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function decodeZipName(bytes, flags) {
  if (bytes.length === 0 || bytes.length > PACKAGE_QA_LIMITS.maxNameBytes) {
    throw new QaError(
      "ZIP_PATH_INVALID",
      `entry name length must be 1-${PACKAGE_QA_LIMITS.maxNameBytes} bytes`,
    );
  }
  if ((flags & 0x0800) === 0 && bytes.some((byte) => byte > 0x7f)) {
    throw new QaError(
      "ZIP_PATH_ENCODING_UNSUPPORTED",
      "non-ASCII ZIP entry names must use the UTF-8 flag",
    );
  }
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new QaError(
      "ZIP_PATH_ENCODING_UNSUPPORTED",
      "ZIP entry name is not valid UTF-8",
    );
  }
}

function validatePackagePath(name) {
  if (
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[a-z]:/i.test(name)
  ) {
    throw new QaError("ZIP_PATH_INVALID", `unsafe ZIP entry path: ${name}`);
  }
  const isDirectory = name.endsWith("/");
  const segments = name.split("/");
  if (isDirectory) segments.pop();
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new QaError("ZIP_PATH_INVALID", `unsafe ZIP entry path: ${name}`);
  }
  return isDirectory;
}

function inspectExtraFields(bytes, label) {
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) {
      throw new QaError("ZIP_EXTRA_FIELD_MALFORMED", `${label} is truncated`);
    }
    const id = bytes.readUInt16LE(offset);
    const size = bytes.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + size > bytes.length) {
      throw new QaError("ZIP_EXTRA_FIELD_MALFORMED", `${label} is truncated`);
    }
    if (id === 0x0001) {
      throw new QaError("ZIP64_UNSUPPORTED", "ZIP64 extra fields are not allowed");
    }
    offset += size;
  }
}

function centralDirectoryHasStructure(
  bytes,
  centralOffset,
  centralSize,
  entryCount,
  endOffset,
) {
  if (
    entryCount === 0 ||
    centralOffset > endOffset ||
    centralSize > endOffset ||
    centralOffset + centralSize !== endOffset ||
    centralSize < entryCount * 46
  ) {
    return false;
  }
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > endOffset ||
      bytes.readUInt32LE(cursor) !== 0x02014b50
    ) {
      return false;
    }
    cursor +=
      46 +
      bytes.readUInt16LE(cursor + 28) +
      bytes.readUInt16LE(cursor + 30) +
      bytes.readUInt16LE(cursor + 32);
    if (cursor > endOffset) return false;
  }
  return cursor === endOffset;
}

function hasValidZip64Locator(bytes, eocdOffset) {
  if (
    eocdOffset < 20 ||
    bytes.readUInt32LE(eocdOffset - 20) !== 0x07064b50
  ) {
    return false;
  }
  const locatorOffset = eocdOffset - 20;
  const zip64OffsetValue = bytes.readBigUInt64LE(locatorOffset + 8);
  if (zip64OffsetValue > BigInt(Number.MAX_SAFE_INTEGER)) return false;
  const zip64Offset = Number(zip64OffsetValue);
  if (
    bytes.readUInt32LE(locatorOffset + 4) !== 0 ||
    bytes.readUInt32LE(locatorOffset + 16) !== 1 ||
    zip64Offset < 0 ||
    zip64Offset + 56 > locatorOffset ||
    bytes.readUInt32LE(zip64Offset) !== 0x06064b50
  ) {
    return false;
  }
  const recordSize = bytes.readBigUInt64LE(zip64Offset + 4);
  if (
    recordSize < 44n ||
    recordSize > BigInt(Number.MAX_SAFE_INTEGER) ||
    zip64Offset + 12 + Number(recordSize) !== locatorOffset ||
    bytes.readUInt32LE(zip64Offset + 16) !== 0 ||
    bytes.readUInt32LE(zip64Offset + 20) !== 0
  ) {
    return false;
  }
  const diskEntries = bytes.readBigUInt64LE(zip64Offset + 24);
  const entryCount = bytes.readBigUInt64LE(zip64Offset + 32);
  const centralSize = bytes.readBigUInt64LE(zip64Offset + 40);
  const centralOffset = bytes.readBigUInt64LE(zip64Offset + 48);
  if (
    diskEntries !== entryCount ||
    entryCount > BigInt(Number.MAX_SAFE_INTEGER) ||
    centralSize > BigInt(Number.MAX_SAFE_INTEGER) ||
    centralOffset > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return false;
  }
  return centralDirectoryHasStructure(
    bytes,
    Number(centralOffset),
    Number(centralSize),
    Number(entryCount),
    zip64Offset,
  );
}

function isStructurallyValidEocd(bytes, offset) {
  const diskNumber = bytes.readUInt16LE(offset + 4);
  const centralDisk = bytes.readUInt16LE(offset + 6);
  const diskEntries = bytes.readUInt16LE(offset + 8);
  const entryCount = bytes.readUInt16LE(offset + 10);
  const centralSize = bytes.readUInt32LE(offset + 12);
  const centralOffset = bytes.readUInt32LE(offset + 16);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount
  ) {
    return false;
  }
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    return hasValidZip64Locator(bytes, offset);
  }
  return centralDirectoryHasStructure(
    bytes,
    centralOffset,
    centralSize,
    entryCount,
    offset,
  );
}

function findEndOfCentralDirectory(bytes) {
  if (bytes.length < 22) {
    throw new QaError("ZIP_EOCD_MISSING", "ZIP end-of-central-directory is missing");
  }
  const firstCandidate = Math.max(0, bytes.length - 22 - 0xffff);
  let malformedCandidate;
  for (let offset = firstCandidate; offset <= bytes.length - 22; offset += 1) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = readUInt16(bytes, offset + 20, "ZIP comment");
    if (offset + 22 + commentLength === bytes.length) {
      malformedCandidate ??= offset;
      if (isStructurallyValidEocd(bytes, offset)) return offset;
    }
  }
  if (malformedCandidate !== undefined) return malformedCandidate;
  throw new QaError("ZIP_EOCD_MISSING", "ZIP end-of-central-directory is missing");
}

function readZipEntries(inputBytes) {
  const bytes = Buffer.isBuffer(inputBytes)
    ? inputBytes
    : Buffer.from(inputBytes.buffer, inputBytes.byteOffset, inputBytes.byteLength);
  if (bytes.length > PACKAGE_QA_LIMITS.maxArchiveBytes) {
    throw new QaError(
      "ZIP_ARCHIVE_TOO_LARGE",
      `archive exceeds ${PACKAGE_QA_LIMITS.maxArchiveBytes} bytes`,
    );
  }

  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (hasValidZip64Locator(bytes, eocdOffset)) {
    throw new QaError("ZIP64_UNSUPPORTED", "ZIP64 archives are not allowed");
  }

  const diskNumber = readUInt16(bytes, eocdOffset + 4, "ZIP disk number");
  const centralDisk = readUInt16(bytes, eocdOffset + 6, "ZIP central disk");
  const diskEntries = readUInt16(bytes, eocdOffset + 8, "ZIP disk entry count");
  const entryCount = readUInt16(bytes, eocdOffset + 10, "ZIP entry count");
  const centralSize = readUInt32(bytes, eocdOffset + 12, "ZIP central size");
  const centralOffset = readUInt32(bytes, eocdOffset + 16, "ZIP central offset");

  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount
  ) {
    throw new QaError(
      "ZIP_MULTIDISK_UNSUPPORTED",
      "multi-disk ZIP archives are not allowed",
    );
  }
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new QaError("ZIP64_UNSUPPORTED", "ZIP64 archives are not allowed");
  }
  if (entryCount === 0 || entryCount > PACKAGE_QA_LIMITS.maxEntries) {
    throw new QaError(
      "ZIP_ENTRY_COUNT_INVALID",
      `ZIP entry count must be 1-${PACKAGE_QA_LIMITS.maxEntries}`,
    );
  }
  if (
    centralOffset > eocdOffset ||
    centralSize > eocdOffset ||
    centralOffset + centralSize !== eocdOffset
  ) {
    throw new QaError(
      "ZIP_CENTRAL_DIRECTORY_INVALID",
      "central-directory bounds or offset are malformed",
    );
  }

  const centralEntries = [];
  const exactNames = new Set();
  const foldedNames = new Set();
  let cursor = centralOffset;
  let totalUncompressedBytes = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > eocdOffset ||
      readUInt32(bytes, cursor, "central-directory header") !== 0x02014b50
    ) {
      throw new QaError(
        "ZIP_CENTRAL_DIRECTORY_INVALID",
        `central-directory entry ${index + 1} is malformed`,
      );
    }
    const flags = readUInt16(bytes, cursor + 8, "central-directory flags");
    const versionNeeded = readUInt16(
      bytes,
      cursor + 6,
      "central-directory version",
    );
    const method = readUInt16(bytes, cursor + 10, "compression method");
    const expectedCrc = readUInt32(bytes, cursor + 16, "entry CRC");
    const compressedSize = readUInt32(bytes, cursor + 20, "compressed size");
    const uncompressedSize = readUInt32(bytes, cursor + 24, "uncompressed size");
    const nameLength = readUInt16(bytes, cursor + 28, "entry name length");
    const extraLength = readUInt16(bytes, cursor + 30, "extra-field length");
    const commentLength = readUInt16(bytes, cursor + 32, "entry comment length");
    const diskStart = readUInt16(bytes, cursor + 34, "entry disk");
    const localHeaderOffset = readUInt32(
      bytes,
      cursor + 42,
      "local-header offset",
    );
    const recordEnd =
      cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > eocdOffset) {
      throw new QaError(
        "ZIP_CENTRAL_DIRECTORY_INVALID",
        `central-directory entry ${index + 1} is truncated`,
      );
    }
    if (diskStart !== 0) {
      throw new QaError(
        "ZIP_MULTIDISK_UNSUPPORTED",
        "multi-disk ZIP entries are not allowed",
      );
    }
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new QaError("ZIP64_UNSUPPORTED", "ZIP64 entries are not allowed");
    }
    if (versionNeeded > 20) {
      throw new QaError(
        "ZIP_VERSION_UNSUPPORTED",
        `ZIP entry requires unsupported version ${versionNeeded / 10}`,
      );
    }
    if ((flags & 0x0001) !== 0 || (flags & 0x2040) !== 0) {
      throw new QaError("ZIP_ENCRYPTION_UNSUPPORTED", "encrypted ZIP entries are not allowed");
    }
    if ((flags & ~0x080f) !== 0) {
      throw new QaError(
        "ZIP_FLAGS_UNSUPPORTED",
        `ZIP entry uses unsupported general-purpose flags 0x${flags.toString(16)}`,
      );
    }
    if (method !== 0 && method !== 8) {
      throw new QaError(
        "ZIP_COMPRESSION_UNSUPPORTED",
        `ZIP compression method ${method} is not supported`,
      );
    }
    if (method === 0 && (flags & 0x0006) !== 0) {
      throw new QaError(
        "ZIP_FLAGS_UNSUPPORTED",
        "stored ZIP entries cannot use deflate option flags",
      );
    }

    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeZipName(nameBytes, flags);
    const isDirectory = validatePackagePath(name);
    const foldedName = name.toLowerCase();
    if (exactNames.has(name) || foldedNames.has(foldedName)) {
      throw new QaError(
        "ZIP_DUPLICATE_ENTRY",
        `duplicate or case-colliding ZIP entry: ${name}`,
      );
    }
    exactNames.add(name);
    foldedNames.add(foldedName);

    const extraStart = cursor + 46 + nameLength;
    inspectExtraFields(
      bytes.subarray(extraStart, extraStart + extraLength),
      `central-directory extra field for ${name}`,
    );
    if (isDirectory && uncompressedSize !== 0) {
      throw new QaError(
        "ZIP_DIRECTORY_INVALID",
        `directory entry must expand to zero bytes: ${name}`,
      );
    }
    if (
      compressedSize > PACKAGE_QA_LIMITS.maxEntryBytes ||
      uncompressedSize > PACKAGE_QA_LIMITS.maxEntryBytes
    ) {
      throw new QaError(
        "ZIP_ENTRY_TOO_LARGE",
        `ZIP entry exceeds ${PACKAGE_QA_LIMITS.maxEntryBytes} bytes: ${name}`,
        name,
      );
    }
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > PACKAGE_QA_LIMITS.maxTotalUncompressedBytes) {
      throw new QaError(
        "ZIP_EXPANDED_SIZE_TOO_LARGE",
        `expanded package exceeds ${PACKAGE_QA_LIMITS.maxTotalUncompressedBytes} bytes`,
      );
    }
    if (
      uncompressedSize > 0 &&
      uncompressedSize / Math.max(1, compressedSize) >
        PACKAGE_QA_LIMITS.maxCompressionRatio
    ) {
      throw new QaError(
        "ZIP_COMPRESSION_RATIO_EXCEEDED",
        `ZIP entry exceeds compression ratio ${PACKAGE_QA_LIMITS.maxCompressionRatio}: ${name}`,
        name,
      );
    }

    centralEntries.push({
      compressedSize,
      expectedCrc,
      flags,
      isDirectory,
      localHeaderOffset,
      method,
      name,
      nameBytes,
      uncompressedSize,
      versionNeeded,
    });
    cursor = recordEnd;
  }

  if (cursor !== eocdOffset) {
    throw new QaError(
      "ZIP_CENTRAL_DIRECTORY_INVALID",
      "central-directory size does not match its entries",
    );
  }

  const spans = [];
  const entries = [];
  for (const entry of centralEntries) {
    const offset = entry.localHeaderOffset;
    if (
      offset + 30 > centralOffset ||
      readUInt32(bytes, offset, `local header for ${entry.name}`) !== 0x04034b50
    ) {
      throw new QaError(
        "ZIP_LOCAL_HEADER_INVALID",
        `local header is malformed: ${entry.name}`,
        entry.name,
      );
    }
    const localFlags = readUInt16(bytes, offset + 6, "local flags");
    const localVersionNeeded = readUInt16(bytes, offset + 4, "local version");
    const localMethod = readUInt16(bytes, offset + 8, "local method");
    const localCrc = readUInt32(bytes, offset + 14, "local CRC");
    const localCompressedSize = readUInt32(bytes, offset + 18, "local compressed size");
    const localUncompressedSize = readUInt32(bytes, offset + 22, "local uncompressed size");
    const localNameLength = readUInt16(bytes, offset + 26, "local name length");
    const localExtraLength = readUInt16(bytes, offset + 28, "local extra length");
    const dataStart = offset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataStart > centralOffset || dataEnd > centralOffset) {
      throw new QaError(
        "ZIP_LOCAL_HEADER_INVALID",
        `entry data exceeds local-file area: ${entry.name}`,
        entry.name,
      );
    }
    const localNameBytes = bytes.subarray(offset + 30, offset + 30 + localNameLength);
    const localName = decodeZipName(localNameBytes, localFlags);
    if (
      localFlags !== entry.flags ||
      localVersionNeeded !== entry.versionNeeded ||
      localMethod !== entry.method ||
      localName !== entry.name
    ) {
      throw new QaError(
        "ZIP_HEADER_MISMATCH",
        `central and local headers disagree: ${entry.name}`,
        entry.name,
      );
    }
    inspectExtraFields(
      bytes.subarray(
        offset + 30 + localNameLength,
        offset + 30 + localNameLength + localExtraLength,
      ),
      `local extra field for ${entry.name}`,
    );
    if (
      (entry.flags & 0x0008) === 0 &&
      (localCrc !== entry.expectedCrc ||
        localCompressedSize !== entry.compressedSize ||
        localUncompressedSize !== entry.uncompressedSize)
    ) {
      throw new QaError(
        "ZIP_HEADER_MISMATCH",
        `central and local sizes or CRC disagree: ${entry.name}`,
        entry.name,
      );
    }
    if (
      (entry.flags & 0x0008) !== 0 &&
      ((localCrc !== 0 && localCrc !== entry.expectedCrc) ||
        (localCompressedSize !== 0 &&
          localCompressedSize !== entry.compressedSize) ||
        (localUncompressedSize !== 0 &&
          localUncompressedSize !== entry.uncompressedSize))
    ) {
      throw new QaError(
        "ZIP_HEADER_MISMATCH",
        `local data-descriptor placeholders disagree: ${entry.name}`,
        entry.name,
      );
    }

    const compressed = bytes.subarray(dataStart, dataEnd);
    let content;
    try {
      if (entry.method === 0) {
        content = Buffer.from(compressed);
      } else {
        const inflated = inflateRawSync(compressed, {
          info: true,
          maxOutputLength: PACKAGE_QA_LIMITS.maxEntryBytes,
        });
        content = inflated.buffer;
        if (inflated.engine.bytesWritten !== compressed.length) {
          throw new QaError(
            "ZIP_DEFLATE_TRAILING_DATA",
            `deflate payload has unconsumed trailing bytes: ${entry.name}`,
            entry.name,
          );
        }
      }
    } catch (error) {
      if (error instanceof QaError) throw error;
      throw new QaError(
        "ZIP_DEFLATE_INVALID",
        `deflate stream is invalid for ${entry.name}`,
        entry.name,
      );
    }
    if (content.length !== entry.uncompressedSize) {
      throw new QaError(
        "ZIP_SIZE_MISMATCH",
        `expanded size does not match the central directory: ${entry.name}`,
        entry.name,
      );
    }
    if (crc32(content) !== entry.expectedCrc) {
      throw new QaError(
        "ZIP_CRC_MISMATCH",
        `CRC-32 mismatch: ${entry.name}`,
        entry.name,
      );
    }

    let recordEnd = dataEnd;
    if ((entry.flags & 0x0008) !== 0) {
      const matchesDescriptorAt = (start) =>
        start + 12 <= centralOffset &&
        bytes.readUInt32LE(start) === entry.expectedCrc &&
        bytes.readUInt32LE(start + 4) === entry.compressedSize &&
        bytes.readUInt32LE(start + 8) === entry.uncompressedSize;
      const unsignedDescriptor = matchesDescriptorAt(dataEnd);
      const signedDescriptor =
        dataEnd + 4 <= centralOffset &&
        bytes.readUInt32LE(dataEnd) === 0x08074b50 &&
        matchesDescriptorAt(dataEnd + 4);
      if (!unsignedDescriptor && !signedDescriptor) {
        throw new QaError(
          "ZIP_DATA_DESCRIPTOR_INVALID",
          `data descriptor disagrees with the central directory: ${entry.name}`,
          entry.name,
        );
      }
      recordEnd = dataEnd + (unsignedDescriptor ? 12 : 16);
    }

    spans.push({ end: recordEnd, name: entry.name, start: offset });
    entries.push({
      compressedSize: entry.compressedSize,
      compressionMethod: entry.method === 0 ? "stored" : "deflate",
      content,
      isDirectory: entry.isDirectory,
      name: entry.name,
      uncompressedSize: entry.uncompressedSize,
    });
  }

  spans.sort((left, right) => left.start - right.start);
  if (spans[0].start !== 0) {
    throw new QaError(
      "ZIP_LOCAL_OFFSET_INVALID",
      "first local-file header must begin at byte zero",
    );
  }
  for (let index = 1; index < spans.length; index += 1) {
    if (spans[index].start !== spans[index - 1].end) {
      throw new QaError(
        "ZIP_LOCAL_OFFSET_INVALID",
        `local-file records overlap or leave untracked bytes: ${spans[index - 1].name} and ${spans[index].name}`,
      );
    }
  }
  if (spans.at(-1).end !== centralOffset) {
    throw new QaError(
      "ZIP_LOCAL_OFFSET_INVALID",
      "local-file records do not end at the central directory",
    );
  }

  return entries;
}

function decodeXmlEntities(value, part) {
  let output = "";
  for (let index = 0; index < value.length; ) {
    if (value[index] !== "&") {
      output += value[index];
      index += 1;
      continue;
    }
    const end = value.indexOf(";", index + 1);
    if (end < 0) {
      throw new QaError("XML_ENTITY_UNSUPPORTED", "unterminated XML entity", part);
    }
    const entity = value.slice(index + 1, end);
    const named = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      quot: '"',
    }[entity];
    let decoded = named;
    if (decoded === undefined && /^#x[0-9A-Fa-f]+$/.test(entity)) {
      const point = Number.parseInt(entity.slice(2), 16);
      decoded = point <= 0x10ffff ? String.fromCodePoint(point) : undefined;
    } else if (decoded === undefined && /^#[0-9]+$/.test(entity)) {
      const point = Number.parseInt(entity.slice(1), 10);
      decoded = point <= 0x10ffff ? String.fromCodePoint(point) : undefined;
    }
    if (
      decoded === undefined ||
      [...decoded].some((character) => {
        const point = character.codePointAt(0);
        return (
          !isValidXmlCodePoint(point)
        );
      })
    ) {
      throw new QaError(
        "XML_ENTITY_UNSUPPORTED",
        `unsupported XML entity: &${entity};`,
        part,
      );
    }
    output += decoded;
    index = end + 1;
  }
  return output;
}

function parseElementTag(source, part) {
  const trimmed = source.trim();
  const selfClosing = trimmed.endsWith("/");
  const body = selfClosing ? trimmed.slice(0, -1).trimEnd() : trimmed;
  const nameMatch = body.match(/^([A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?)/);
  if (!nameMatch) {
    throw new QaError("XML_MALFORMED", "invalid XML element name", part);
  }
  const name = nameMatch[1];
  const attributes = Object.create(null);
  let cursor = name.length;
  while (cursor < body.length) {
    const whitespace = body.slice(cursor).match(/^\s+/);
    if (!whitespace) {
      throw new QaError("XML_MALFORMED", `invalid attributes on ${name}`, part);
    }
    cursor += whitespace[0].length;
    if (cursor >= body.length) break;
    const attributeMatch = body
      .slice(cursor)
      .match(/^([A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?)/);
    if (!attributeMatch) {
      throw new QaError("XML_MALFORMED", `invalid attribute on ${name}`, part);
    }
    const attributeName = attributeMatch[1];
    cursor += attributeName.length;
    const equalsMatch = body.slice(cursor).match(/^\s*=\s*/);
    if (!equalsMatch) {
      throw new QaError(
        "XML_MALFORMED",
        `attribute ${attributeName} lacks a value`,
        part,
      );
    }
    cursor += equalsMatch[0].length;
    const quote = body[cursor];
    if (quote !== '"' && quote !== "'") {
      throw new QaError(
        "XML_MALFORMED",
        `attribute ${attributeName} must be quoted`,
        part,
      );
    }
    const end = body.indexOf(quote, cursor + 1);
    if (end < 0) {
      throw new QaError(
        "XML_MALFORMED",
        `attribute ${attributeName} is unterminated`,
        part,
      );
    }
    if (Object.hasOwn(attributes, attributeName)) {
      throw new QaError(
        "XML_MALFORMED",
        `duplicate XML attribute ${attributeName}`,
        part,
      );
    }
    const rawValue = body.slice(cursor + 1, end);
    if (rawValue.includes("<")) {
      throw new QaError(
        "XML_MALFORMED",
        `attribute ${attributeName} contains a raw less-than sign`,
        part,
      );
    }
    attributes[attributeName] = decodeXmlEntities(rawValue, part);
    cursor = end + 1;
  }
  if (
    Object.keys(attributes).length >
    PACKAGE_QA_LIMITS.maxXmlAttributesPerElement
  ) {
    throw new QaError(
      "XML_ATTRIBUTE_LIMIT_EXCEEDED",
      `XML element exceeds ${PACKAGE_QA_LIMITS.maxXmlAttributesPerElement} attributes`,
      part,
    );
  }
  return { attributes, name, selfClosing };
}

function expandXmlName(name, namespaces, isAttribute, part) {
  const separator = name.indexOf(":");
  const prefix = separator >= 0 ? name.slice(0, separator) : "";
  const localName = separator >= 0 ? name.slice(separator + 1) : name;
  const namespaceUri = prefix
    ? namespaces.get(prefix)
    : isAttribute
      ? ""
      : (namespaces.get("") ?? "");
  if (prefix && !namespaceUri) {
    throw new QaError(
      "XML_NAMESPACE_INVALID",
      `XML prefix is not declared: ${prefix}`,
      part,
    );
  }
  return { localName, namespaceUri: namespaceUri ?? "", prefix };
}

function parseXml(bytes, part) {
  if (bytes.length > PACKAGE_QA_LIMITS.maxXmlBytes) {
    throw new QaError(
      "XML_TOO_LARGE",
      `XML part exceeds ${PACKAGE_QA_LIMITS.maxXmlBytes} bytes`,
      part,
    );
  }
  let xml;
  try {
    xml = utf8Decoder.decode(bytes);
  } catch {
    throw new QaError("XML_ENCODING_INVALID", "XML part is not valid UTF-8", part);
  }
  if (xml.startsWith("\ufeff")) xml = xml.slice(1);
  for (const character of xml) {
    const point = character.codePointAt(0);
    if (!isValidXmlCodePoint(point)) {
      throw new QaError(
        "XML_CHARACTER_INVALID",
        `XML part contains disallowed character U+${point
          .toString(16)
          .toUpperCase()
          .padStart(4, "0")}`,
        part,
      );
    }
  }
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(xml)) {
    throw new QaError(
      "XML_CONSTRUCT_UNSUPPORTED",
      "DTD, entity declarations, and CDATA are not allowed",
      part,
    );
  }
  if (xml.startsWith("<?xml")) {
    const declaration = xml.match(
      /^<\?xml\s+version\s*=\s*(["'])1\.0\1(?:\s+encoding\s*=\s*(["'])(?:UTF-8|utf-8)\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>/,
    );
    if (!declaration) {
      throw new QaError(
        "XML_DECLARATION_INVALID",
        "XML declaration must specify version 1.0 and optional UTF-8 encoding and standalone state",
        part,
      );
    }
    xml = xml.slice(declaration[0].length);
  }
  if (xml.includes("<?")) {
    throw new QaError(
      "XML_CONSTRUCT_UNSUPPORTED",
      "XML processing instructions are not allowed",
      part,
    );
  }

  const document = {
    attributes: Object.create(null),
    children: [],
    name: "#document",
  };
  const stack = [document];
  const namespaces = new Map([["xml", XML_NAMESPACE]]);
  const restoreNamespaces = (changes) => {
    for (let index = changes.length - 1; index >= 0; index -= 1) {
      const change = changes[index];
      if (change.hadValue) namespaces.set(change.prefix, change.value);
      else namespaces.delete(change.prefix);
    }
  };
  let cursor = 0;
  let nodeCount = 0;
  while (cursor < xml.length) {
    const opening = xml.indexOf("<", cursor);
    const textEnd = opening < 0 ? xml.length : opening;
    const text = xml.slice(cursor, textEnd);
    if (text.includes("&")) decodeXmlEntities(text, part);
    if (text.includes("]]>")) {
      throw new QaError(
        "XML_MALFORMED",
        "XML text contains the forbidden CDATA terminator",
        part,
      );
    }
    if (stack.length === 1 && text.trim().length > 0) {
      throw new QaError(
        "XML_MALFORMED",
        "non-whitespace text is not allowed outside the root element",
        part,
      );
    }
    if (stack.length > 1 && text.trim().length > 0) {
      stack.at(-1).hasNonWhitespaceText = true;
    }
    if (opening < 0) {
      cursor = xml.length;
      break;
    }
    if (xml.startsWith("<!--", opening)) {
      const end = xml.indexOf("-->", opening + 4);
      const comment = end < 0 ? "" : xml.slice(opening + 4, end);
      if (end < 0 || comment.includes("--") || comment.endsWith("-")) {
        throw new QaError("XML_MALFORMED", "malformed XML comment", part);
      }
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("</", opening)) {
      const end = xml.indexOf(">", opening + 2);
      if (end < 0) {
        throw new QaError("XML_MALFORMED", "unterminated closing tag", part);
      }
      const name = xml.slice(opening + 2, end).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/.test(name)) {
        throw new QaError("XML_MALFORMED", "invalid closing tag", part);
      }
      const current = stack.pop();
      if (stack.length === 0 || current.name !== name) {
        throw new QaError("XML_MALFORMED", `mismatched closing tag ${name}`, part);
      }
      restoreNamespaces(current.namespaceChanges);
      cursor = end + 1;
      continue;
    }
    if (xml.startsWith("<!", opening)) {
      throw new QaError(
        "XML_CONSTRUCT_UNSUPPORTED",
        "unsupported XML declaration",
        part,
      );
    }

    let end = opening + 1;
    let quote;
    while (end < xml.length) {
      const character = xml[end];
      if (quote) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
      end += 1;
    }
    if (end >= xml.length || quote) {
      throw new QaError("XML_MALFORMED", "unterminated opening tag", part);
    }
    const parsed = parseElementTag(xml.slice(opening + 1, end), part);
    nodeCount += 1;
    if (nodeCount > PACKAGE_QA_LIMITS.maxXmlNodes) {
      throw new QaError(
        "XML_NODE_LIMIT_EXCEEDED",
        `XML part exceeds ${PACKAGE_QA_LIMITS.maxXmlNodes} elements`,
        part,
      );
    }
    const namespaceDeclarations = [];
    const namespaceChanges = [];
    for (const [name, value] of Object.entries(parsed.attributes)) {
      if (name !== "xmlns" && !name.startsWith("xmlns:")) continue;
      const prefix = name === "xmlns" ? "" : name.slice("xmlns:".length);
      if (
        prefix === "xmlns" ||
        (prefix === "xml" && value !== XML_NAMESPACE) ||
        (prefix !== "" && value === "") ||
        value === XMLNS_NAMESPACE
      ) {
        throw new QaError(
          "XML_NAMESPACE_INVALID",
          `invalid namespace declaration: ${name}`,
          part,
        );
      }
      namespaceChanges.push({
        hadValue: namespaces.has(prefix),
        prefix,
        value: namespaces.get(prefix),
      });
      namespaces.set(prefix, value);
      namespaceDeclarations.push({ prefix, uri: value });
    }
    if (namespaces.size > PACKAGE_QA_LIMITS.maxXmlNamespaces) {
      restoreNamespaces(namespaceChanges);
      throw new QaError(
        "XML_NAMESPACE_LIMIT_EXCEEDED",
        `XML namespace scope exceeds ${PACKAGE_QA_LIMITS.maxXmlNamespaces} bindings`,
        part,
      );
    }
    const expandedElement = expandXmlName(parsed.name, namespaces, false, part);
    const attributeNodes = [];
    const expandedAttributes = new Set();
    for (const [name, value] of Object.entries(parsed.attributes)) {
      if (name === "xmlns" || name.startsWith("xmlns:")) continue;
      const expanded = expandXmlName(name, namespaces, true, part);
      const key = `${expanded.namespaceUri}\0${expanded.localName}`;
      if (expandedAttributes.has(key)) {
        throw new QaError(
          "XML_NAMESPACE_INVALID",
          `duplicate expanded XML attribute: ${name}`,
          part,
        );
      }
      expandedAttributes.add(key);
      attributeNodes.push({ ...expanded, name, value });
    }
    const element = {
      ...expandedElement,
      attributeNodes,
      attributes: parsed.attributes,
      children: [],
      hasNonWhitespaceText: false,
      name: parsed.name,
      namespaceChanges,
      namespaceDeclarations,
    };
    stack.at(-1).children.push(element);
    if (!parsed.selfClosing) stack.push(element);
    else restoreNamespaces(namespaceChanges);
    cursor = end + 1;
  }

  if (stack.length !== 1) {
    throw new QaError("XML_MALFORMED", "unclosed XML elements", part);
  }
  if (document.children.length !== 1) {
    throw new QaError(
      "XML_MALFORMED",
      "XML document must have exactly one root element",
      part,
    );
  }
  return document.children[0];
}

function isElement(element, namespaceUri, localName) {
  return (
    element?.namespaceUri === namespaceUri && element?.localName === localName
  );
}

function attributeValue(element, namespaceUri, localName) {
  return element?.attributeNodes.find(
    (attribute) =>
      attribute.namespaceUri === namespaceUri &&
      attribute.localName === localName,
  )?.value;
}

function isVisible(value) {
  return value === undefined || ["1", "true", "on"].includes(value.toLowerCase());
}

function relationshipSource(relPart) {
  if (relPart === "_rels/.rels") return "";
  const match = relPart.match(/^(.*\/)_rels\/([^/]+)\.rels$/);
  return match ? `${match[1]}${match[2]}` : undefined;
}

function decodeUriSegment(segment, part) {
  let decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new QaError(
      "RELATIONSHIP_TARGET_INVALID",
      `relationship target has invalid percent encoding: ${segment}`,
      part,
    );
  }
  if (
    decoded.length === 0 ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded === "." ||
    decoded === ".."
  ) {
    throw new QaError(
      "RELATIONSHIP_TARGET_INVALID",
      `relationship target has an unsafe segment: ${segment}`,
      part,
    );
  }
  return segment;
}

function resolveRelationshipTarget(source, target, part) {
  if (
    !target ||
    target.includes("\\") ||
    target.includes("\0") ||
    target.startsWith("/") ||
    target.includes("?") ||
    target.includes("#") ||
    /^[a-z][a-z0-9+.-]*:/i.test(target)
  ) {
    throw new QaError(
      "RELATIONSHIP_TARGET_INVALID",
      `relationship target is not a local package path: ${target}`,
      part,
    );
  }
  const segments = source ? posix.dirname(source).split("/") : [];
  if (segments.length === 1 && segments[0] === ".") segments.pop();
  for (const rawSegment of target.split("/")) {
    if (rawSegment === "" || rawSegment === ".") {
      throw new QaError(
        "RELATIONSHIP_TARGET_INVALID",
        `relationship target contains an empty or dot segment: ${target}`,
        part,
      );
    }
    if (rawSegment === "..") {
      if (segments.length === 0) {
        throw new QaError(
          "RELATIONSHIP_TARGET_INVALID",
          `relationship target escapes the package: ${target}`,
          part,
        );
      }
      segments.pop();
      continue;
    }
    segments.push(decodeUriSegment(rawSegment, part));
  }
  if (segments.length === 0) {
    throw new QaError(
      "RELATIONSHIP_TARGET_INVALID",
      `relationship target does not name a part: ${target}`,
      part,
    );
  }
  return segments.join("/");
}

function contentTypePartName(value, part) {
  if (!value.startsWith("/") || value.includes("\\") || value.includes("?") || value.includes("#")) {
    throw new QaError(
      "CONTENT_TYPES_INVALID",
      `Override PartName is invalid: ${value}`,
      part,
    );
  }
  return resolveRelationshipTarget("", value.slice(1), part);
}

function parseRelationships(entry, source, addFinding) {
  let root;
  try {
    root = parseXml(entry.content, entry.name);
  } catch (error) {
    addFinding(error.code ?? "XML_MALFORMED", error.message, entry.name);
    return [];
  }
  if (!isElement(root, PACKAGE_RELATIONSHIPS_NAMESPACE, "Relationships")) {
    addFinding(
      "RELATIONSHIPS_ROOT_INVALID",
      "relationship part must use the OPC Relationships root and namespace",
      entry.name,
    );
    return [];
  }
  const unexpectedRootAttributes = root.attributeNodes.map(
    (attribute) => attribute.name,
  );
  if (unexpectedRootAttributes.length > 0) {
    addFinding(
      "RELATIONSHIPS_ROOT_INVALID",
      `unsupported Relationships attributes: ${unexpectedRootAttributes.join(", ")}`,
      entry.name,
    );
  }

  const relationships = [];
  const ids = new Set();
  for (const child of root.children) {
    if (
      !isElement(child, PACKAGE_RELATIONSHIPS_NAMESPACE, "Relationship") ||
      child.children.length > 0 ||
      child.hasNonWhitespaceText
    ) {
      addFinding(
        "RELATIONSHIPS_ELEMENT_INVALID",
        "relationship parts may contain only empty Relationship elements",
        entry.name,
      );
      continue;
    }
    const unexpected = child.attributeNodes
      .filter(
        (attribute) =>
          attribute.namespaceUri !== "" ||
          !["Id", "Target", "TargetMode", "Type"].includes(
            attribute.localName,
          ),
      )
      .map((attribute) => attribute.name);
    if (unexpected.length > 0) {
      addFinding(
        "RELATIONSHIPS_ELEMENT_INVALID",
        `unsupported Relationship attributes: ${unexpected.join(", ")}`,
        entry.name,
      );
    }
    const id = attributeValue(child, "", "Id");
    const target = attributeValue(child, "", "Target");
    const targetMode = attributeValue(child, "", "TargetMode");
    const type = attributeValue(child, "", "Type");
    if (!id || !target || !type || ids.has(id)) {
      addFinding(
        "RELATIONSHIP_ID_INVALID",
        "relationships require unique non-empty Id, Type, and Target values",
        entry.name,
      );
      continue;
    }
    ids.add(id);
    if (targetMode !== undefined && !["External", "Internal"].includes(targetMode)) {
      addFinding(
        "RELATIONSHIP_MODE_INVALID",
        `unsupported TargetMode ${targetMode}`,
        entry.name,
      );
      continue;
    }
    const external =
      targetMode === "External" || /^[a-z][a-z0-9+.-]*:/i.test(target);
    let resolvedTarget;
    if (external) {
      addFinding(
        "EXTERNAL_RELATIONSHIP_FORBIDDEN",
        `external relationship ${id} is not allowed`,
        entry.name,
      );
    } else {
      try {
        resolvedTarget = resolveRelationshipTarget(source, target, entry.name);
      } catch (error) {
        addFinding(error.code, error.message, entry.name);
      }
    }
    if (
      DANGEROUS_RELATIONSHIP_SUFFIXES.some((suffix) =>
        type.toLowerCase().endsWith(suffix),
      ) ||
      type.toLowerCase().includes("webextension")
    ) {
      addFinding(
        type.toLowerCase().endsWith("/attachedtemplate")
          ? "REMOTE_TEMPLATE_FORBIDDEN"
          : "UNSAFE_RELATIONSHIP_FORBIDDEN",
        `relationship type is not allowed: ${type}`,
        entry.name,
      );
    }
    relationships.push({
      external,
      id,
      resolvedTarget,
      target,
      type,
    });
  }
  return relationships;
}

function validateContentTypes(entriesByName, addFinding) {
  const part = "[Content_Types].xml";
  const entry = entriesByName.get(part);
  if (!entry) {
    addFinding(
      "CONTENT_TYPES_MISSING",
      "[Content_Types].xml is required",
      part,
    );
    return { defaults: new Map(), overrides: new Map() };
  }
  let root;
  try {
    root = parseXml(entry.content, part);
  } catch (error) {
    addFinding(error.code ?? "XML_MALFORMED", error.message, part);
    return { defaults: new Map(), overrides: new Map() };
  }
  if (!isElement(root, CONTENT_TYPES_NAMESPACE, "Types")) {
    addFinding(
      "CONTENT_TYPES_ROOT_INVALID",
      "[Content_Types].xml must use the OPC Types root and namespace",
      part,
    );
    return { defaults: new Map(), overrides: new Map() };
  }
  if (root.attributeNodes.length > 0) {
    addFinding(
      "CONTENT_TYPES_ROOT_INVALID",
      "[Content_Types].xml has unsupported root attributes",
      part,
    );
  }

  const defaults = new Map();
  const overrides = new Map();
  const foldedOverrides = new Set();
  const maxOverrides = Math.max(0, entriesByName.size - 1);
  let overrideLimitReported = false;
  for (const child of root.children) {
    if (
      child.children.length > 0 ||
      child.hasNonWhitespaceText ||
      child.namespaceUri !== CONTENT_TYPES_NAMESPACE ||
      !["Default", "Override"].includes(child.localName)
    ) {
      addFinding(
        "CONTENT_TYPES_ELEMENT_INVALID",
        "[Content_Types].xml may contain only empty Default and Override elements",
        part,
      );
      continue;
    }
    const allowed =
      child.localName === "Default"
        ? new Set(["ContentType", "Extension"])
        : new Set(["ContentType", "PartName"]);
    if (
      child.attributeNodes.some(
        (attribute) =>
          attribute.namespaceUri !== "" || !allowed.has(attribute.localName),
      )
    ) {
      addFinding(
        "CONTENT_TYPES_ELEMENT_INVALID",
        `${child.localName} has unsupported attributes`,
        part,
      );
      continue;
    }
    const contentType = attributeValue(child, "", "ContentType");
    if (!contentType || /[\s;]|[^\x21-\x7e]/.test(contentType)) {
      addFinding(
        "CONTENT_TYPE_INVALID",
        `${child.localName} has an invalid ContentType`,
        part,
      );
      continue;
    }
    if (child.localName === "Default") {
      const extension = attributeValue(child, "", "Extension")?.toLowerCase();
      if (!extension || !/^[a-z0-9][a-z0-9._-]*$/.test(extension) || defaults.has(extension)) {
        addFinding(
          "CONTENT_TYPE_DUPLICATE",
          `Default extension is invalid or duplicated: ${extension ?? ""}`,
          part,
        );
        continue;
      }
      defaults.set(extension, contentType);
    } else {
      try {
        const partName = contentTypePartName(
          attributeValue(child, "", "PartName") ?? "",
          part,
        );
        const folded = partName.toLowerCase();
        if (foldedOverrides.has(folded)) {
          addFinding(
            "CONTENT_TYPE_DUPLICATE",
            `Override PartName is duplicated: ${partName}`,
            part,
          );
          continue;
        }
        if (overrides.size >= maxOverrides) {
          if (!overrideLimitReported) {
            addFinding(
              "CONTENT_TYPE_OVERRIDE_LIMIT_EXCEEDED",
              "content-type overrides cannot outnumber package parts",
              part,
            );
            overrideLimitReported = true;
          }
          continue;
        }
        foldedOverrides.add(folded);
        overrides.set(partName, contentType);
      } catch (error) {
        addFinding(error.code, error.message, part);
      }
    }
  }

  for (const name of entriesByName.keys()) {
    if (name === part) continue;
    const extension = packageExtension(name);
    if (!overrides.has(name) && !defaults.has(extension)) {
      addFinding(
        "CONTENT_TYPE_MISSING",
        `package part has no content type: ${name}`,
        name,
      );
    }
  }
  for (const name of overrides.keys()) {
    if (!entriesByName.has(name)) {
      addFinding(
        "CONTENT_TYPE_OVERRIDE_ORPHANED",
        `content-type override names a missing part: ${name}`,
        part,
      );
    }
  }
  return { defaults, overrides };
}

function packageExtension(name) {
  const baseName = posix.basename(name);
  const dot = baseName.lastIndexOf(".");
  return dot >= 0 ? baseName.slice(dot + 1).toLowerCase() : "";
}

function effectiveContentType(name, contentTypes) {
  return (
    contentTypes.overrides.get(name) ??
    contentTypes.defaults.get(packageExtension(name))
  );
}

function normalizedContentType(name, contentTypes) {
  return (effectiveContentType(name, contentTypes) ?? "").toLowerCase();
}

function startsWithBytes(bytes, signature) {
  return (
    bytes.length >= signature.length &&
    signature.every((byte, index) => bytes[index] === byte)
  );
}

function validateUnsafeParts(entriesByName, contentTypes, addFinding) {
  for (const [name, entry] of entriesByName) {
    const lowerName = name.toLowerCase();
    const pathSegments = lowerName.split("/");
    const extension = packageExtension(name);
    const contentType = normalizedContentType(name, contentTypes);
    const allowedThumbnail =
      lowerName === "docprops/thumbnail.jpeg" && contentType === "image/jpeg";
    const allowedPrinterSettings =
      /^ppt\/printersettings\/printersettings[1-9][0-9]*\.bin$/.test(
        lowerName,
      ) &&
      contentType ===
        "application/vnd.openxmlformats-officedocument.presentationml.printersettings";
    if (
      lowerName.includes("/activex/") ||
      lowerName.includes("/embeddings/") ||
      lowerName.includes("/oleobjects/") ||
      pathSegments.some((segment) => segment.startsWith("webextension")) ||
      lowerName.endsWith("/vbaproject.bin") ||
      contentType.includes("macroenabled") ||
      contentType.includes("vbaproject") ||
      contentType.includes("activex") ||
      contentType.includes("oleobject") ||
      contentType.includes("webextension") ||
      contentType.includes("openxmlformats-officedocument.package") ||
      contentType.includes("wordprocessingml.") ||
      contentType.includes("spreadsheetml.") ||
      [
        "application/msword",
        "application/vnd.ms-excel",
        "application/vnd.ms-powerpoint",
        "application/x-7z-compressed",
        "application/x-rar-compressed",
        "application/x-tar",
        "application/x-zip-compressed",
        "application/zip",
      ].includes(contentType) ||
      PACKAGE_EXTENSIONS.has(extension)
    ) {
      addFinding(
        "EMBEDDED_ACTIVE_CONTENT_FORBIDDEN",
        `macro, OLE, ActiveX, or embedded package content is not allowed: ${name}`,
        name,
      );
    }
    if (
      startsWithBytes(entry.content, [0x50, 0x4b, 0x03, 0x04]) ||
      startsWithBytes(entry.content, [
        0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
      ])
    ) {
      addFinding(
        "EMBEDDED_ACTIVE_CONTENT_FORBIDDEN",
        `embedded ZIP or OLE container signature is not allowed: ${name}`,
        name,
      );
    }
    if (
      lowerName.includes("/media/") ||
      (!allowedThumbnail &&
        (MEDIA_EXTENSIONS.has(extension) ||
          /^(?:image|audio|video)\//.test(contentType)))
    ) {
      addFinding(
        "MEDIA_PART_FORBIDDEN",
        `media content is not allowed: ${name}`,
        name,
      );
    }
    if (
      !allowedPrinterSettings &&
      (EXECUTABLE_EXTENSIONS.has(extension) ||
        contentType === "application/octet-stream" ||
        contentType === "application/x-msdownload")
    ) {
      addFinding(
        "EXECUTABLE_CONTENT_FORBIDDEN",
        `unexpected executable content is not allowed: ${name}`,
        name,
      );
    }
    if (
      startsWithBytes(entry.content, [0x4d, 0x5a]) ||
      startsWithBytes(entry.content, [0x7f, 0x45, 0x4c, 0x46]) ||
      [
        [0xfe, 0xed, 0xfa, 0xce],
        [0xfe, 0xed, 0xfa, 0xcf],
        [0xce, 0xfa, 0xed, 0xfe],
        [0xcf, 0xfa, 0xed, 0xfe],
      ].some((signature) => startsWithBytes(entry.content, signature))
    ) {
      addFinding(
        "EXECUTABLE_CONTENT_FORBIDDEN",
        `executable payload signature is not allowed: ${name}`,
        name,
      );
    }
  }
}

function parseRequiredXml(entriesByName, name, addFinding) {
  const entry = entriesByName.get(name);
  if (!entry) {
    addFinding("REQUIRED_PART_MISSING", `required package part is missing: ${name}`, name);
    return undefined;
  }
  try {
    return parseXml(entry.content, name);
  } catch (error) {
    addFinding(error.code ?? "XML_MALFORMED", error.message, name);
    return undefined;
  }
}

function validateRoot(root, expectedLocalName, part, addFinding) {
  if (
    !root ||
    !isElement(root, PRESENTATION_NAMESPACE, expectedLocalName)
  ) {
    addFinding(
      "PRESENTATION_XML_ROOT_INVALID",
      `${part} must use the ${expectedLocalName} PresentationML root and namespace`,
      part,
    );
    return false;
  }
  return true;
}

function validateOoxml(entries) {
  const findings = [];
  const findingKeys = new Set();
  const addFinding = (code, message, part) => {
    const finding = {
      code,
      message,
      ...(part ? { part } : {}),
      severity: "error",
    };
    const key = JSON.stringify(finding);
    if (!findingKeys.has(key)) {
      findingKeys.add(key);
      findings.push(finding);
    }
  };

  const fileEntries = entries.filter((entry) => !entry.isDirectory);
  const entriesByName = new Map(fileEntries.map((entry) => [entry.name, entry]));
  const contentTypes = validateContentTypes(entriesByName, addFinding);
  validateUnsafeParts(entriesByName, contentTypes, addFinding);
  for (const entry of fileEntries) {
    const contentType = normalizedContentType(entry.name, contentTypes);
    if (
      entry.name !== "[Content_Types].xml" &&
      (packageExtension(entry.name) === "xml" ||
        contentType === "application/xml" ||
        contentType === "text/xml" ||
        contentType.endsWith("+xml"))
    ) {
      try {
        parseXml(entry.content, entry.name);
      } catch (error) {
        addFinding(error.code ?? "XML_MALFORMED", error.message, entry.name);
      }
    }
  }

  const relationshipsBySource = new Map();
  let relationshipCount = 0;
  for (const entry of fileEntries.filter((candidate) =>
    candidate.name.endsWith(".rels"),
  )) {
    if (
      normalizedContentType(entry.name, contentTypes) !==
      RELATIONSHIPS_CONTENT_TYPE
    ) {
      addFinding(
        "RELATIONSHIPS_CONTENT_TYPE_INVALID",
        "relationship parts must use the OPC relationships content type",
        entry.name,
      );
    }
    const source = relationshipSource(entry.name);
    if (source === undefined || (source && !entriesByName.has(source))) {
      addFinding(
        "RELATIONSHIP_PART_ORPHANED",
        `relationship part has no valid source part: ${entry.name}`,
        entry.name,
      );
      continue;
    }
    const relationships = parseRelationships(entry, source, addFinding);
    relationshipCount += relationships.length;
    if (relationshipsBySource.has(source)) {
      addFinding(
        "RELATIONSHIP_PART_DUPLICATE",
        `source has more than one relationship part: ${source || "/"}`,
        entry.name,
      );
    } else {
      relationshipsBySource.set(source, relationships);
    }
    for (const relationship of relationships) {
      if (
        !relationship.external &&
        relationship.resolvedTarget &&
        !entriesByName.has(relationship.resolvedTarget)
      ) {
        addFinding(
          "RELATIONSHIP_TARGET_MISSING",
          `relationship target is missing: ${relationship.resolvedTarget}`,
          entry.name,
        );
      }
    }
  }

  const rootRelationships = relationshipsBySource.get("") ?? [];
  const officeRelationships = rootRelationships.filter(
    (relationship) => relationship.type === RELATIONSHIP_TYPES.officeDocument,
  );
  if (
    officeRelationships.length !== 1 ||
    officeRelationships[0]?.resolvedTarget !== "ppt/presentation.xml"
  ) {
    addFinding(
      "OFFICE_DOCUMENT_RELATIONSHIP_INVALID",
      "the package must have one root officeDocument relationship to ppt/presentation.xml",
      "_rels/.rels",
    );
  }

  const presentationPart = "ppt/presentation.xml";
  if (
    entriesByName.has(presentationPart) &&
    normalizedContentType(presentationPart, contentTypes) !==
      PRESENTATION_CONTENT_TYPE.toLowerCase()
  ) {
    addFinding(
      "PRESENTATION_CONTENT_TYPE_INVALID",
      "ppt/presentation.xml must use the non-macro presentation content type",
      presentationPart,
    );
  }
  const presentation = parseRequiredXml(entriesByName, presentationPart, addFinding);
  const orderedSlides = [];
  const orderedNotes = [];

  if (
    presentation &&
    validateRoot(presentation, "presentation", presentationPart, addFinding)
  ) {
    const sizeElements = presentation.children.filter(
      (child) => isElement(child, PRESENTATION_NAMESPACE, "sldSz"),
    );
    const size = sizeElements[0];
    if (
      sizeElements.length !== 1 ||
      attributeValue(size, "", "cx") !== String(SLIDE_WIDTH_EMU) ||
      attributeValue(size, "", "cy") !== String(SLIDE_HEIGHT_EMU)
    ) {
      addFinding(
        "SLIDE_SIZE_INVALID",
        "presentation page size must be 960x540 points (12192000x6858000 EMU)",
        presentationPart,
      );
    }

    const slideLists = presentation.children.filter(
      (child) => isElement(child, PRESENTATION_NAMESPACE, "sldIdLst"),
    );
    if (slideLists.length !== 1 || slideLists[0].children.length === 0) {
      addFinding(
        "SLIDE_LIST_INVALID",
        "presentation must contain one non-empty ordered slide list",
        presentationPart,
      );
    } else {
      const slideIds = new Set();
      const relationshipIds = new Set();
      const presentationRelationships =
        relationshipsBySource.get(presentationPart) ?? [];
      const slideRelationships = presentationRelationships.filter(
        (relationship) => relationship.type === RELATIONSHIP_TYPES.slide,
      );
      const relationshipsById = new Map(
        presentationRelationships.map((relationship) => [
          relationship.id,
          relationship,
        ]),
      );
      for (const slideId of slideLists[0].children) {
        if (
          !isElement(slideId, PRESENTATION_NAMESPACE, "sldId") ||
          slideId.children.length > 0 ||
          slideId.hasNonWhitespaceText
        ) {
          addFinding(
            "SLIDE_LIST_INVALID",
            "slide list may contain only empty p:sldId elements",
            presentationPart,
          );
          continue;
        }
        const numericId = attributeValue(slideId, "", "id");
        const numericSlideId = Number(numericId);
        const relationshipId = attributeValue(
          slideId,
          OFFICE_RELATIONSHIPS_NAMESPACE,
          "id",
        );
        if (
          !/^[0-9]{1,10}$/.test(numericId ?? "") ||
          numericSlideId < 256 ||
          numericSlideId >= 2_147_483_648 ||
          !relationshipId ||
          slideIds.has(numericSlideId) ||
          relationshipIds.has(relationshipId)
        ) {
          addFinding(
            "SLIDE_ID_INVALID",
            "slides require unique IDs in 256-2147483647 and unique r:id values",
            presentationPart,
          );
          continue;
        }
        slideIds.add(numericSlideId);
        relationshipIds.add(relationshipId);
        if (!isVisible(attributeValue(slideId, "", "show"))) {
          addFinding(
            "HIDDEN_SLIDE_FORBIDDEN",
            `hidden slide is not allowed: ${relationshipId}`,
            presentationPart,
          );
        }
        const relationship = relationshipsById.get(relationshipId);
        if (
          relationship?.type !== RELATIONSHIP_TYPES.slide ||
          !relationship.resolvedTarget
        ) {
          addFinding(
            "SLIDE_RELATIONSHIP_INVALID",
            `slide ${relationshipId} lacks an internal slide relationship`,
            presentationPart,
          );
          continue;
        }
        if (!/^ppt\/slides\/slide[1-9][0-9]*\.xml$/.test(relationship.resolvedTarget)) {
          addFinding(
            "SLIDE_PART_NAME_INVALID",
            `slide relationship targets a nonstandard part: ${relationship.resolvedTarget}`,
            presentationPart,
          );
        }
        orderedSlides.push(relationship.resolvedTarget);
      }
      for (const relationship of slideRelationships) {
        if (!relationshipIds.has(relationship.id)) {
          addFinding(
            "ORPHAN_SLIDE_RELATIONSHIP",
            `presentation slide relationship is not in the ordered slide list: ${relationship.id}`,
            presentationPart,
          );
        }
      }
    }
  }

  const slideTargetSet = new Set(orderedSlides);
  if (slideTargetSet.size !== orderedSlides.length) {
    addFinding(
      "SLIDE_PART_REUSED",
      "ordered slides must target unique slide parts",
      presentationPart,
    );
  }
  const actualSlideParts = [
    ...new Set(
      [...entriesByName.keys()].filter(
        (name) =>
          /^ppt\/slides\/[^/]+\.xml$/.test(name) ||
          normalizedContentType(name, contentTypes) ===
            SLIDE_CONTENT_TYPE.toLowerCase(),
      ),
    ),
  ].sort(compareText);
  for (const part of actualSlideParts) {
    if (!/^ppt\/slides\/slide[1-9][0-9]*\.xml$/.test(part)) {
      addFinding(
        "SLIDE_PART_NAME_INVALID",
        `slide content type is assigned to a nonstandard part: ${part}`,
        part,
      );
    }
    if (!slideTargetSet.has(part)) {
      addFinding("ORPHAN_SLIDE_PART", `slide part is not ordered: ${part}`, part);
    }
  }
  for (const part of orderedSlides) {
    if (!entriesByName.has(part)) {
      orderedNotes.push(null);
      continue;
    }
    if (
      normalizedContentType(part, contentTypes) !==
      SLIDE_CONTENT_TYPE.toLowerCase()
    ) {
      addFinding(
        "SLIDE_CONTENT_TYPE_INVALID",
        `slide part has an invalid content type: ${part}`,
        part,
      );
    }
    const slide = parseRequiredXml(entriesByName, part, addFinding);
    if (
      slide &&
      validateRoot(slide, "sld", part, addFinding) &&
      !isVisible(attributeValue(slide, "", "show"))
    ) {
      addFinding("HIDDEN_SLIDE_FORBIDDEN", `hidden slide is not allowed: ${part}`, part);
    }

    const notesRelationships = (relationshipsBySource.get(part) ?? []).filter(
      (relationship) => relationship.type === RELATIONSHIP_TYPES.notesSlide,
    );
    if (
      notesRelationships.length !== 1 ||
      !notesRelationships[0].resolvedTarget ||
      notesRelationships[0].external
    ) {
      addFinding(
        "SLIDE_NOTES_RELATIONSHIP_INVALID",
        "each slide must have exactly one internal notesSlide relationship",
        part,
      );
      orderedNotes.push(null);
      continue;
    }
    const notesPart = notesRelationships[0].resolvedTarget;
    if (!/^ppt\/notesSlides\/notesSlide[1-9][0-9]*\.xml$/.test(notesPart)) {
      addFinding(
        "NOTES_PART_NAME_INVALID",
        `notes relationship targets a nonstandard part: ${notesPart}`,
        part,
      );
    }
    orderedNotes.push(notesPart);
  }

  const validOrderedNotes = orderedNotes.filter(Boolean);
  const notesTargetSet = new Set(validOrderedNotes);
  if (
    validOrderedNotes.length !== orderedSlides.length ||
    notesTargetSet.size !== validOrderedNotes.length
  ) {
    addFinding(
      "SLIDE_NOTES_NOT_UNIQUE",
      "every ordered slide must target one unique notes part",
      presentationPart,
    );
  }

  const actualNotesParts = [
    ...new Set(
      [...entriesByName.keys()].filter(
        (name) =>
          /^ppt\/notesSlides\/[^/]+\.xml$/.test(name) ||
          normalizedContentType(name, contentTypes) ===
            NOTES_CONTENT_TYPE.toLowerCase(),
      ),
    ),
  ].sort(compareText);
  for (const part of actualNotesParts) {
    if (!/^ppt\/notesSlides\/notesSlide[1-9][0-9]*\.xml$/.test(part)) {
      addFinding(
        "NOTES_PART_NAME_INVALID",
        `notes content type is assigned to a nonstandard part: ${part}`,
        part,
      );
    }
    if (!notesTargetSet.has(part)) {
      addFinding("ORPHAN_NOTES_PART", `notes part is not used by a slide: ${part}`, part);
    }
  }
  for (let index = 0; index < orderedNotes.length; index += 1) {
    const notesPart = orderedNotes[index];
    const slidePart = orderedSlides[index];
    if (!notesPart) continue;
    if (!entriesByName.has(notesPart)) continue;
    if (
      normalizedContentType(notesPart, contentTypes) !==
      NOTES_CONTENT_TYPE.toLowerCase()
    ) {
      addFinding(
        "NOTES_CONTENT_TYPE_INVALID",
        `notes part has an invalid content type: ${notesPart}`,
        notesPart,
      );
    }
    const notes = parseRequiredXml(entriesByName, notesPart, addFinding);
    if (notes) validateRoot(notes, "notes", notesPart, addFinding);
    const reciprocal = (relationshipsBySource.get(notesPart) ?? []).filter(
      (relationship) => relationship.type === RELATIONSHIP_TYPES.slide,
    );
    if (
      reciprocal.length !== 1 ||
      reciprocal[0].external ||
      reciprocal[0].resolvedTarget !== slidePart
    ) {
      addFinding(
        "NOTES_SLIDE_RECIPROCAL_INVALID",
        `notes part must relate back to only its owning slide: ${slidePart}`,
        notesPart,
      );
    }
  }

  findings.sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.part ?? "", right.part ?? "") ||
      compareText(left.message, right.message),
  );

  return {
    findings,
    orderedNotes,
    orderedSlides,
    relationshipCount,
  };
}

function failureReport(bytes, error, byteLength = bytes?.length ?? null) {
  const finding = {
    code: error instanceof QaError ? error.code : "PACKAGE_READ_FAILED",
    message: error.message,
    ...(error instanceof QaError && error.part ? { part: error.part } : {}),
    severity: "error",
  };
  return {
    schemaVersion: 1,
    valid: false,
    package: {
      byteLength,
      sha256: bytes ? sha256(bytes) : null,
    },
    counts: {
      archiveEntries: 0,
      notes: 0,
      parts: 0,
      relationships: 0,
      slides: 0,
    },
    slides: [],
    parts: [],
    findings: [finding],
  };
}

export function inspectPptxBytes(inputBytes) {
  if (!(Buffer.isBuffer(inputBytes) || inputBytes instanceof Uint8Array)) {
    throw new TypeError("inspectPptxBytes requires a Buffer or Uint8Array");
  }
  const bytes = Buffer.isBuffer(inputBytes)
    ? inputBytes
    : Buffer.from(inputBytes.buffer, inputBytes.byteOffset, inputBytes.byteLength);
  let entries;
  try {
    entries = readZipEntries(bytes);
  } catch (error) {
    return failureReport(bytes, error);
  }

  const validation = validateOoxml(entries);
  const fileEntries = entries.filter((entry) => !entry.isDirectory);
  const entriesByName = new Map(fileEntries.map((entry) => [entry.name, entry]));
  const parts = fileEntries
    .map((entry) => ({
      compressedSize: entry.compressedSize,
      compressionMethod: entry.compressionMethod,
      name: entry.name,
      sha256: sha256(entry.content),
      uncompressedSize: entry.uncompressedSize,
    }))
    .sort((left, right) => compareText(left.name, right.name));
  const slides = validation.orderedSlides.map((part, index) => {
    const notesPart = validation.orderedNotes[index] ?? null;
    return {
      index: index + 1,
      notesPart,
      notesSha256: notesPart && entriesByName.has(notesPart)
        ? sha256(entriesByName.get(notesPart).content)
        : null,
      part,
      sha256: entriesByName.has(part)
        ? sha256(entriesByName.get(part).content)
        : null,
    };
  });
  return {
    schemaVersion: 1,
    valid: validation.findings.length === 0,
    package: {
      byteLength: bytes.length,
      sha256: sha256(bytes),
    },
    counts: {
      archiveEntries: entries.length,
      notes: validation.orderedNotes.filter(Boolean).length,
      parts: fileEntries.length,
      relationships: validation.relationshipCount,
      slides: validation.orderedSlides.length,
    },
    slides,
    parts,
    findings: validation.findings,
  };
}

export async function inspectPptxPackage(path) {
  let handle;
  let file;
  let bytes;
  let readError;
  try {
    handle = await open(path, "r");
    file = await handle.stat();
    if (!file.isFile()) {
      throw new QaError("PACKAGE_READ_FAILED", "input path is not a regular file");
    }
    if (file.size > PACKAGE_QA_LIMITS.maxArchiveBytes) {
      throw new QaError(
        "ZIP_ARCHIVE_TOO_LARGE",
        `archive exceeds ${PACKAGE_QA_LIMITS.maxArchiveBytes} bytes`,
      );
    }
    bytes = Buffer.alloc(file.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) {
        throw new QaError(
          "PACKAGE_READ_FAILED",
          "input package changed or ended while being read",
        );
      }
      offset += result.bytesRead;
    }
    const growthProbe = Buffer.alloc(1);
    const growth = await handle.read(growthProbe, 0, 1, bytes.length);
    if (growth.bytesRead !== 0) {
      throw new QaError(
        "PACKAGE_READ_FAILED",
        "input package changed while being read",
      );
    }
  } catch (error) {
    readError =
      error instanceof QaError
        ? error
        : new QaError("PACKAGE_READ_FAILED", "unable to read input package");
  }
  if (handle) {
    try {
      await handle.close();
    } catch {
      readError ??= new QaError(
        "PACKAGE_READ_FAILED",
        "unable to close input package",
      );
    }
  }
  return readError
    ? failureReport(undefined, readError, file?.size ?? null)
    : inspectPptxBytes(bytes);
}

export function formatPptxQaReport(report, { pretty = false } = {}) {
  return `${JSON.stringify(report, null, pretty ? 2 : undefined)}\n`;
}

async function runCli(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "Usage: node pptx-package-qa.mjs [--pretty] <presentation.pptx>\n",
    );
    return 0;
  }
  const pretty = argv.includes("--pretty");
  const positional = argv.filter((argument) => argument !== "--pretty");
  if (
    positional.length !== 1 ||
    argv.some((argument) => argument.startsWith("-") && argument !== "--pretty")
  ) {
    process.stderr.write(
      "Usage: node pptx-package-qa.mjs [--pretty] <presentation.pptx>\n",
    );
    return 2;
  }
  const report = await inspectPptxPackage(positional[0]);
  process.stdout.write(formatPptxQaReport(report, { pretty }));
  return report.valid ? 0 : 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await runCli(process.argv.slice(2));
}
