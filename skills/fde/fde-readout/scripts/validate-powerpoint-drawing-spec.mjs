#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { stableSerialize } from "./powerpoint-layout.mjs";

const integerKeys = new Set([
  "sourceIndex",
  "z",
  "maxLines",
  "index",
  "seriesIndex",
  "categoryIndex",
  "fromCategoryIndex",
  "toCategoryIndex",
  "edgeIndex",
  "segmentIndex",
]);
const maxSafeInteger = 9_007_199_254_740_991n;

function isSafeIntegerToken(source) {
  const match =
    /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) return false;
  const negative = match[1] === "-";
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? 0);
  let digits = `${match[2]}${fraction}`.replace(/^0+/, "");
  if (digits.length === 0) return true;
  const scale = exponent - fraction.length;
  if (scale < 0) {
    const requiredZeros = -scale;
    if (
      requiredZeros > digits.length ||
      !digits.endsWith("0".repeat(requiredZeros))
    ) {
      return false;
    }
    digits = digits.slice(0, -requiredZeros);
  } else {
    if (digits.length + scale > 16) return false;
    digits += "0".repeat(scale);
  }
  const integer = BigInt(`${negative ? "-" : ""}${digits || "0"}`);
  return integer >= -maxSafeInteger && integer <= maxSafeInteger;
}

function validateIntegerTokens(source) {
  let offset = 0;

  function skipWhitespace() {
    while (/\s/.test(source[offset] ?? "")) offset += 1;
  }

  function readString() {
    const start = offset;
    offset += 1;
    while (offset < source.length) {
      if (source[offset] === "\\") {
        offset += 2;
      } else if (source[offset] === '"') {
        offset += 1;
        return JSON.parse(source.slice(start, offset));
      } else {
        offset += 1;
      }
    }
    throw new SyntaxError("unterminated JSON string");
  }

  function readValue(path) {
    skipWhitespace();
    const tokenStart = offset;
    if (source[offset] === "{") {
      offset += 1;
      skipWhitespace();
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        skipWhitespace();
        const key = readString();
        skipWhitespace();
        offset += 1;
        readValue([...path, key]);
        skipWhitespace();
        if (source[offset] === "}") {
          offset += 1;
          return;
        }
        offset += 1;
      }
    } else if (source[offset] === "[") {
      offset += 1;
      skipWhitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      let itemIndex = 0;
      while (offset < source.length) {
        readValue([...path, itemIndex]);
        itemIndex += 1;
        skipWhitespace();
        if (source[offset] === "]") {
          offset += 1;
          return;
        }
        offset += 1;
      }
    } else if (source[offset] === '"') {
      readString();
    } else if (source.startsWith("true", offset)) {
      offset += 4;
    } else if (source.startsWith("false", offset)) {
      offset += 5;
    } else if (source.startsWith("null", offset)) {
      offset += 4;
    } else {
      const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
        source.slice(offset),
      )?.[0];
      if (!number) throw new SyntaxError(`invalid JSON token at ${offset}`);
      offset += number.length;
      const key = path.at(-1);
      const stageDimension =
        path.length === 2 &&
        path[0] === "stage" &&
        (key === "width" || key === "height");
      if (
        (integerKeys.has(key) || stageDimension) &&
        !isSafeIntegerToken(source.slice(tokenStart, offset))
      ) {
        throw new TypeError(
          `${path.join(".")} must use a mathematically safe integer token`,
        );
      }
    }
  }

  readValue([]);
  skipWhitespace();
  if (offset !== source.length) {
    throw new SyntaxError(`unexpected JSON content at ${offset}`);
  }
}

const source = readFileSync(0, "utf8");
const spec = JSON.parse(source);
validateIntegerTokens(source);
stableSerialize(spec);

const encodedStringPrefix = "__FDE_UTF16LE_B64__";
function encodeStringValues(value) {
  if (typeof value === "string") {
    return `${encodedStringPrefix}${Buffer.from(value, "utf16le").toString("base64")}`;
  }
  if (Array.isArray(value)) return value.map(encodeStringValues);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        encodeStringValues(item),
      ]),
    );
  }
  return value;
}

process.stdout.write(JSON.stringify(encodeStringValues(spec)));
