import { isProxy } from "node:util/types";
const { every, join, map, sort } = Array.prototype; const { add: setAdd, delete: setDelete, has: setHas } = Set.prototype; const reflectApply = Reflect.apply;
function requireJson(condition, path, reason) {
  if (!condition) throw new Error(`${path} ${reason}`);
}
function copyJson(value, path, ancestors) {
  const type = typeof value;
  if (value === null || type === "string" || type === "boolean") return value;
  if (type === "number") {
    requireJson(Number.isFinite(value), path, "must be a finite number");
    return value;
  }
  requireJson(type === "object", path, "must contain JSON data only");
  requireJson(!isProxy(value), path, "must not contain a proxy");
  requireJson(!reflectApply(setHas, ancestors, [value]), path, "must not contain a cycle");
  reflectApply(setAdd, ancestors, [value]);
  let result;
  if (Array.isArray(value)) {
    requireJson(Object.getPrototypeOf(value) === Array.prototype, path, "must be a plain array");
    const keys = Reflect.ownKeys(value);
    requireJson(reflectApply(every, keys, [(key) =>
      key === "length" || (typeof key === "string" && /^(?:0|[1-9]\d*)$/.test(key)),
    ]), path, "must not have custom or symbol properties");
    requireJson(keys.length === value.length + 1, path, "must not contain sparse entries");
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      requireJson(descriptor?.enumerable && Object.hasOwn(descriptor, "value"), `${path}[${index}]`, "must be an enumerable data property");
    }
    result = reflectApply(map, value, [(item, index) => copyJson(item, `${path}[${index}]`, ancestors)]);
  } else {
    const prototype = Object.getPrototypeOf(value);
    requireJson(prototype === Object.prototype || prototype === null, path, "must be a plain object without inherited semantic properties");
    const keys = Reflect.ownKeys(value);
    requireJson(reflectApply(every, keys, [(key) => typeof key === "string"]), path, "must not have symbol properties");
    result = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      requireJson(descriptor.enumerable && Object.hasOwn(descriptor, "value"), `${path}.${key}`, "must be an enumerable data property");
      Object.defineProperty(result, key, {
        value: copyJson(descriptor.value, `${path}.${key}`, ancestors),
        enumerable: true,
      });
    }
  }
  reflectApply(setDelete, ancestors, [value]);
  return Object.freeze(result);
}
function encode(value, sortKeys) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${reflectApply(join, reflectApply(map, value, [(item) => encode(item, sortKeys)]), [","])}]`;
  const keys = Object.keys(value);
  if (sortKeys) reflectApply(sort, keys, []);
  const fields = reflectApply(map, keys, [
    (key) => `${JSON.stringify(key)}:${encode(value[key], sortKeys)}`]);
  return `{${reflectApply(join, fields, [","])}}`;
}
export const snapshotJson = (value) => copyJson(value, "$", new Set());
export const encodeJson = (value) => encode(snapshotJson(value), false);
export const serializeJson = (value) => encode(snapshotJson(value), true);
