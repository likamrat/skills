const RECT_KEYS = ["id", "x", "y", "w", "h"];
const SIDES = ["left", "right", "top", "bottom"];
const CLOCKWISE_SIDES = ["top", "right", "bottom", "left"];
const ROUTE_KEYS = [
  "sourceId",
  "targetId",
  "fromSide",
  "toSide",
  "points",
  "segments",
  "cost",
];
const POINT_KEYS = ["x", "y"];
const SEGMENT_KEYS = ["x1", "y1", "x2", "y2", "index"];
const NORMALS = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};
const BEND_COST = 18;
const PREFERENCE_COST = 20;
const THOUSAND = 1000;
const OBSTACLE_CLEARANCE_UNITS = 6 * THOUSAND;
const GRID_LINE_CLEARANCE_UNITS = 2 * THOUSAND;
const MAP_CLEARANCE_UNITS = 24 * THOUSAND;
const MAX_GRID_NODES = 12000;
const MAX_SEARCH_STATES = 50000;
const BEND_COST_UNITS = BigInt(BEND_COST * THOUSAND);
const PREFERENCE_COST_UNITS = BigInt(PREFERENCE_COST * THOUSAND);

export class RouterError extends Error {
  constructor(code, path, message) {
    super(`${code} at ${path}: ${message}`);
    this.name = "RouterError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new RouterError(code, path, message);
}

function round3(value, path = "$") {
  if (!Number.isFinite(value)) {
    fail("E_ROUTER_NONFINITE", path, "number must be finite");
  }
  // Above this threshold every representable number is already coarser than
  // one thousandth, and multiplying by 1000 could overflow.
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER / THOUSAND) {
    return Object.is(value, -0) ? 0 : value;
  }
  const rounded = Math.round(value * THOUSAND) / THOUSAND;
  if (!Number.isFinite(rounded)) {
    fail("E_ROUTER_NONFINITE", path, "rounded number must be finite");
  }
  return Object.is(rounded, -0) ? 0 : rounded;
}

function toThousandths(value, path) {
  const rounded = round3(value, path);
  if (Math.abs(rounded) > Number.MAX_SAFE_INTEGER / THOUSAND) {
    fail("E_ROUTER_NONFINITE", path, "number exceeds the safe integer-thousandth range");
  }
  const units = Math.round(rounded * THOUSAND);
  if (!Number.isSafeInteger(units)) {
    fail("E_ROUTER_NONFINITE", path, "number cannot be represented as safe integer thousandths");
  }
  return Object.is(units, -0) ? 0 : units;
}

function fromThousandths(units, path = "$") {
  if (!Number.isSafeInteger(units)) {
    fail("E_ROUTER_NONFINITE", path, "integer-thousandth value is unsafe");
  }
  const value = units / THOUSAND;
  if (!Number.isFinite(value)) {
    fail("E_ROUTER_NONFINITE", path, "integer-thousandth value is nonfinite");
  }
  if (toThousandths(value, path) !== units) {
    fail("E_ROUTER_NONFINITE", path, "integer-thousandth value loses precision as a number");
  }
  return Object.is(value, -0) ? 0 : value;
}

function fromBigIntThousandths(units, path = "$") {
  if (units > BigInt(Number.MAX_SAFE_INTEGER) || units < BigInt(Number.MIN_SAFE_INTEGER)) {
    fail("E_ROUTER_NONFINITE", path, "integer-thousandth value is unsafe");
  }
  return fromThousandths(Number(units), path);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function descriptorFor(value, key, path) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail("E_ROUTER_INPUT", path, "property inspection failed");
  }
  if (
    !descriptor ||
    !Object.hasOwn(descriptor, "value") ||
    descriptor.enumerable !== true ||
    descriptor.writable !== true
  ) {
    fail(
      "E_ROUTER_INPUT",
      path,
      "properties must be enumerable writable data properties",
    );
  }
  return descriptor;
}

/**
 * Detach and validate a value as strict plain JSON-like data: objects with
 * Object.prototype or null prototype, dense arrays with Array.prototype and
 * only own numeric indices, enumerable writable data properties only, no
 * symbol keys, and finite numbers. Returns a fresh detached snapshot so the
 * caller cannot observe further mutation of, or accessor/proxy tricks on,
 * the original input.
 */
function snapshotGeometryAt(value, path, active) {
  try {
    return snapshotGeometryValue(value, path, active);
  } catch (error) {
    if (error instanceof RouterError) throw error;
    fail("E_ROUTER_INPUT", path, "property inspection failed");
  }
}

function snapshotGeometryValue(value, path, active) {
  if (value === null) fail("E_ROUTER_INPUT", path, "null is not allowed");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("E_ROUTER_NONFINITE", path, "number must be finite");
    }
    return value;
  }
  if (["string", "boolean"].includes(typeof value)) return value;
  if (typeof value !== "object") {
    fail("E_ROUTER_INPUT", path, "value must be plain JSON data");
  }

  if (active.has(value)) {
    fail("E_ROUTER_INPUT", path, "cyclic references are not allowed");
  }
  active.add(value);
  try {
    let prototype;
    let keys;
    try {
      prototype = Object.getPrototypeOf(value);
      keys = Reflect.ownKeys(value);
    } catch {
      fail("E_ROUTER_INPUT", path, "property inspection failed");
    }
    if (keys.some((key) => typeof key === "symbol")) {
      fail("E_ROUTER_INPUT", path, "symbol properties are not allowed");
    }

    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) {
        fail("E_ROUTER_INPUT", path, "array prototype must be Array.prototype");
      }
      let lengthDescriptor;
      try {
        lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      } catch {
        fail("E_ROUTER_INPUT", `${path}.length`, "property inspection failed");
      }
      if (
        !lengthDescriptor ||
        !Object.hasOwn(lengthDescriptor, "value") ||
        lengthDescriptor.writable !== true
      ) {
        fail("E_ROUTER_INPUT", `${path}.length`, "array length descriptor is invalid");
      }
      const length = lengthDescriptor.value;
      if (!Number.isSafeInteger(length) || length < 0) {
        fail("E_ROUTER_INPUT", `${path}.length`, "array length descriptor is invalid");
      }
      const indexKeys = keys.filter((key) => key !== "length");
      if (
        indexKeys.length !== length ||
        indexKeys.some((key, index) => key !== String(index))
      ) {
        fail("E_ROUTER_INPUT", path, "array must contain only dense owned indexes");
      }
      const snapshot = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptorFor(value, String(index), `${path}[${index}]`);
        snapshot[index] = snapshotGeometryAt(descriptor.value, `${path}[${index}]`, active);
      }
      return snapshot;
    }

    if (prototype !== Object.prototype && prototype !== null) {
      fail("E_ROUTER_INPUT", path, "object prototype must be Object.prototype or null");
    }
    const snapshot =
      prototype === null ? Object.create(null) : Object.create(Object.prototype);
    for (const key of keys) {
      const descriptor = descriptorFor(value, key, `${path}.${key}`);
      Object.defineProperty(snapshot, key, {
        value: snapshotGeometryAt(descriptor.value, `${path}.${key}`, active),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return snapshot;
  } finally {
    active.delete(value);
  }
}

export function snapshotGeometry(value, path = "$") {
  return snapshotGeometryAt(value, path, new WeakSet());
}

function exactKeys(value, expected, path) {
  if (!isPlainObject(value)) fail("E_ROUTER_INPUT", path, "expected plain object");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("E_ROUTER_INPUT", path, `expected keys ${wanted.join(", ")}`);
  }
}

function exactOptionalKeys(value, required, optional, path) {
  if (!isPlainObject(value)) fail("E_ROUTER_INPUT", path, "expected plain object");
  const actual = Object.keys(value).sort();
  const allowed = [...required, ...optional].sort();
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail("E_ROUTER_INPUT", path, `missing required key ${key}`);
    }
  }
  if (actual.some((key) => !allowed.includes(key))) {
    fail("E_ROUTER_INPUT", path, `expected keys ${allowed.join(", ")}`);
  }
}

function requireFiniteNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("E_ROUTER_NONFINITE", path, "expected a finite number");
  }
  return value;
}

function requireNonEmptyString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    fail("E_ROUTER_INPUT", path, "expected a nonempty string");
  }
  return value;
}

function validateRect(rect, path) {
  const snapshot = snapshotGeometry(rect, path);
  exactKeys(snapshot, RECT_KEYS, path);
  const id = requireNonEmptyString(snapshot.id, `${path}.id`);
  const x = requireFiniteNumber(snapshot.x, `${path}.x`);
  const y = requireFiniteNumber(snapshot.y, `${path}.y`);
  const w = requireFiniteNumber(snapshot.w, `${path}.w`);
  const h = requireFiniteNumber(snapshot.h, `${path}.h`);
  if (w <= 0) fail("E_ROUTER_BOUNDS", `${path}.w`, "width must be positive");
  if (h <= 0) fail("E_ROUTER_BOUNDS", `${path}.h`, "height must be positive");
  return { id, x, y, w, h };
}

function anchorPoint(rect, side) {
  const centerX = rect.x + rect.w / 2;
  const centerY = rect.y + rect.h / 2;
  switch (side) {
    case "left":
      return { side, x: round3(rect.x), y: round3(centerY) };
    case "right":
      return { side, x: round3(rect.x + rect.w), y: round3(centerY) };
    case "top":
      return { side, x: round3(centerX), y: round3(rect.y) };
    case "bottom":
      return { side, x: round3(centerX), y: round3(rect.y + rect.h) };
    default:
      throw new Error(`unreachable side ${side}`);
  }
}

function anchorsBySide(rect) {
  const anchors = {};
  for (const side of SIDES) anchors[side] = anchorPoint(rect, side);
  return anchors;
}

/**
 * Return the four exact side-midpoint anchors for a rect, in the fixed
 * deterministic order left, right, top, bottom.
 */
export function nodeAnchors(rect) {
  const validated = validateRect(rect, "$.rect");
  const anchors = anchorsBySide(validated);
  return SIDES.map((side) => ({ ...anchors[side] }));
}

function dominantPreferredSides(source, target) {
  const sourceCenter = { x: source.x + source.w / 2, y: source.y + source.h / 2 };
  const targetCenter = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  const dxMagnitude = toThousandths(Math.abs(dx), "$.center.dx");
  const dyMagnitude = toThousandths(Math.abs(dy), "$.center.dy");
  const horizontalDominant = dxMagnitude >= dyMagnitude;
  if (horizontalDominant) {
    return dx >= 0
      ? { sourceSide: "right", targetSide: "left" }
      : { sourceSide: "left", targetSide: "right" };
  }
  return dy >= 0
    ? { sourceSide: "bottom", targetSide: "top" }
    : { sourceSide: "top", targetSide: "bottom" };
}

/**
 * Rank all 16 source-side/target-side anchor pairs for a source and target
 * rect. Rank 0 is the dominant-axis preferred pair (matching the direction
 * from the source rect's center to the target rect's center, with a
 * deterministic horizontal-first rule on diagonal ties). The remaining pairs
 * follow in a fixed clockwise side order (top, right, bottom, left) for
 * source side, then target side.
 */
export function preferredAnchorPairs(sourceRect, targetRect) {
  const source = validateRect(sourceRect, "$.sourceRect");
  const target = validateRect(targetRect, "$.targetRect");
  const sourceAnchors = anchorsBySide(source);
  const targetAnchors = anchorsBySide(target);
  const preferred = dominantPreferredSides(source, target);

  const allPairs = [];
  for (const sourceSide of CLOCKWISE_SIDES) {
    for (const targetSide of CLOCKWISE_SIDES) {
      allPairs.push({ sourceSide, targetSide });
    }
  }
  const preferredIndex = allPairs.findIndex(
    (pair) =>
      pair.sourceSide === preferred.sourceSide && pair.targetSide === preferred.targetSide,
  );
  const [preferredPair] = allPairs.splice(preferredIndex, 1);
  allPairs.unshift(preferredPair);

  return allPairs.map((pair, index) => ({
    sourceSide: pair.sourceSide,
    targetSide: pair.targetSide,
    sourceAnchor: { ...sourceAnchors[pair.sourceSide] },
    targetAnchor: { ...targetAnchors[pair.targetSide] },
    preferenceRank: index,
  }));
}

function negate(vector) {
  return { x: -vector.x, y: -vector.y };
}

function sign(value) {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

function segmentDirection(a, b) {
  return { x: sign(b.x - a.x), y: sign(b.y - a.y) };
}

function sameVector(a, b) {
  return a.x === b.x && a.y === b.y;
}

function pointsEqual(a, b) {
  return a.x === b.x && a.y === b.y;
}

function pointToUnits(point, path) {
  return {
    x: toThousandths(point.x, `${path}.x`),
    y: toThousandths(point.y, `${path}.y`),
  };
}

function representableOffset(point, normal, path, minimumDistance = 1) {
  for (let distance = minimumDistance; distance < minimumDistance + 4; distance += 1) {
    const x = point.x + normal.x * distance;
    const y = point.y + normal.y * distance;
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) continue;
    if (
      toThousandths(x / THOUSAND, `${path}.x`) === x &&
      toThousandths(y / THOUSAND, `${path}.y`) === y
    ) {
      return { x, y };
    }
  }
  return null;
}

function candidateRoutes(sourceAnchor, targetAnchor, sourceSide, targetSide, withOffsets) {
  const source = pointToUnits(sourceAnchor, "$.sourceAnchor");
  const target = pointToUnits(targetAnchor, "$.targetAnchor");
  const dx = target.x - source.x;
  const dy = target.y - source.y;

  const exitNormal = NORMALS[sourceSide];
  const entryNormal = negate(NORMALS[targetSide]);
  const candidates = [];

  if (!withOffsets && dx === 0 && dy === 0) return { candidates, precisionBlocked: false };

  if (!withOffsets && (dx === 0 || dy === 0)) {
    const direction = segmentDirection(source, target);
    if (sameVector(direction, exitNormal) && sameVector(direction, entryNormal)) {
      candidates.push([source, target]);
    }
    return { candidates, precisionBlocked: false };
  }

  if (!withOffsets) {
    const bendHV = { x: target.x, y: source.y };
    const firstHV = segmentDirection(source, bendHV);
    const secondHV = segmentDirection(bendHV, target);
    if (sameVector(firstHV, exitNormal) && sameVector(secondHV, entryNormal)) {
      candidates.push([source, bendHV, target]);
    }

    const bendVH = { x: source.x, y: target.y };
    const firstVH = segmentDirection(source, bendVH);
    const secondVH = segmentDirection(bendVH, target);
    if (sameVector(firstVH, exitNormal) && sameVector(secondVH, entryNormal)) {
      candidates.push([source, bendVH, target]);
    }
    return { candidates, precisionBlocked: false };
  }

  const egress = representableOffset(source, exitNormal, "$.egress");
  let ingress = representableOffset(target, NORMALS[targetSide], "$.ingress");
  if (egress && ingress && pointsEqual(egress, ingress)) {
    ingress = representableOffset(target, NORMALS[targetSide], "$.ingress", 2);
  }
  if (!egress || !ingress) return { candidates, precisionBlocked: true };
  const middleHV = { x: ingress.x, y: egress.y };
  const middleVH = { x: egress.x, y: ingress.y };
  for (const raw of [
    [source, egress, middleHV, ingress, target],
    [source, egress, middleVH, ingress, target],
  ]) {
    const points = collapsePoints(raw);
    if (
      points.length >= 2 &&
      sameVector(segmentDirection(points[0], points[1]), exitNormal) &&
      sameVector(segmentDirection(points.at(-2), points.at(-1)), entryNormal)
    ) {
      candidates.push(points);
    }
  }
  return { candidates, precisionBlocked: false };
}

function collapsePoints(points) {
  const collapsed = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const previous = collapsed[collapsed.length - 1];
    if (!pointsEqual(previous, points[index])) collapsed.push(points[index]);
  }
  return collapsed;
}

function manhattanLengthUnits(points) {
  let total = 0n;
  for (let index = 1; index < points.length; index += 1) {
    const dx = BigInt(points[index].x) - BigInt(points[index - 1].x);
    const dy = BigInt(points[index].y) - BigInt(points[index - 1].y);
    total += dx < 0n ? -dx : dx;
    total += dy < 0n ? -dy : dy;
  }
  return total;
}

function comparePointSequences(a, b) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const pointA = a[index];
    const pointB = b[index];
    if (!pointA) return -1;
    if (!pointB) return 1;
    if (pointA.x !== pointB.x) return pointA.x - pointB.x;
    if (pointA.y !== pointB.y) return pointA.y - pointB.y;
  }
  return 0;
}

function compareStrings(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function safeUnitAdd(value, delta, path) {
    const result = value + delta;
    if (!Number.isSafeInteger(result)) {
      fail("E_ROUTER_NONFINITE", path, "coordinate exceeds the safe integer-thousandth range");
    }
    return result;
  }

  function clampedUnitAdd(value, delta) {
    const result = BigInt(value) + BigInt(delta);
    if (result < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER;
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
    return Number(result);
  }

  function rectToUnitBounds(rect, path) {
    const right = rect.x + rect.w;
    const bottom = rect.y + rect.h;
    if (!Number.isFinite(right)) fail("E_ROUTER_NONFINITE", `${path}.w`, "horizontal extent must be finite");
    if (!Number.isFinite(bottom)) fail("E_ROUTER_NONFINITE", `${path}.h`, "vertical extent must be finite");
    return {
      id: rect.id,
      left: toThousandths(rect.x, `${path}.x`),
      top: toThousandths(rect.y, `${path}.y`),
      right: toThousandths(right, `${path}.w`),
      bottom: toThousandths(bottom, `${path}.h`),
    };
  }

  function inflateBounds(bounds, path) {
    return {
      id: bounds.id,
      left: safeUnitAdd(bounds.left, -OBSTACLE_CLEARANCE_UNITS, `${path}.x`),
      top: safeUnitAdd(bounds.top, -OBSTACLE_CLEARANCE_UNITS, `${path}.y`),
      right: safeUnitAdd(bounds.right, OBSTACLE_CLEARANCE_UNITS, `${path}.w`),
      bottom: safeUnitAdd(bounds.bottom, OBSTACLE_CLEARANCE_UNITS, `${path}.h`),
    };
  }

  function validateStageAt(stage, path) {
    exactKeys(stage, ["x", "y", "w", "h"], path);
    const validated = {
      x: requireFiniteNumber(stage.x, `${path}.x`),
      y: requireFiniteNumber(stage.y, `${path}.y`),
      w: requireFiniteNumber(stage.w, `${path}.w`),
      h: requireFiniteNumber(stage.h, `${path}.h`),
    };
    if (validated.w <= 0) fail("E_ROUTER_BOUNDS", `${path}.w`, "width must be positive");
    if (validated.h <= 0) fail("E_ROUTER_BOUNDS", `${path}.h`, "height must be positive");
    const bounds = rectToUnitBounds({ id: "stage", ...validated }, path);
    return { ...validated, ...bounds };
  }

  function pointKey(point) {
    return `${point.x},${point.y}`;
  }

  function pointInOpenRect(point, rect) {
    return (
      point.x > rect.left &&
      point.x < rect.right &&
      point.y > rect.top &&
      point.y < rect.bottom
    );
  }

  function segmentCrossesOpenRect(a, b, rect) {
    if (a.x === b.x) {
      if (!(a.x > rect.left && a.x < rect.right)) return false;
      const low = Math.min(a.y, b.y);
      const high = Math.max(a.y, b.y);
      return low < rect.bottom && high > rect.top;
    }
    if (a.y === b.y) {
      if (!(a.y > rect.top && a.y < rect.bottom)) return false;
      const low = Math.min(a.x, b.x);
      const high = Math.max(a.x, b.x);
      return low < rect.right && high > rect.left;
    }
    return true;
  }

  function segmentClear(a, b, blockers, ignoredId = null) {
    return blockers.every(
      (blocker) => blocker.id === ignoredId || !segmentCrossesOpenRect(a, b, blocker),
    );
  }

  function directionName(a, b) {
    if (a.x < b.x && a.y === b.y) return "R";
    if (a.x > b.x && a.y === b.y) return "L";
    if (a.y < b.y && a.x === b.x) return "D";
    if (a.y > b.y && a.x === b.x) return "U";
    fail("E_WORKFLOW_ROUTE", "$", "grid edge must be nonzero and orthogonal");
  }

  function normalDirection(normal) {
    if (normal.x === 1) return "R";
    if (normal.x === -1) return "L";
    if (normal.y === 1) return "D";
    return "U";
  }

  function collapseCollinearPoints(points) {
    const collapsed = [];
    for (const point of points) {
      if (collapsed.length > 0 && pointsEqual(collapsed.at(-1), point)) continue;
      while (collapsed.length >= 2) {
        const a = collapsed.at(-2);
        const b = collapsed.at(-1);
        const first = segmentDirection(a, b);
        const second = segmentDirection(b, point);
        if (!sameVector(first, second)) break;
        collapsed.pop();
      }
      collapsed.push(point);
    }
    return collapsed;
  }

  class MinHeap {
    constructor(compare) {
      this.values = [];
      this.compare = compare;
    }

    get length() {
      return this.values.length;
    }

    push(value) {
      this.values.push(value);
      let index = this.values.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (this.compare(this.values[parent], value) <= 0) break;
        this.values[index] = this.values[parent];
        index = parent;
      }
      this.values[index] = value;
    }

    pop() {
      const first = this.values[0];
      const last = this.values.pop();
      if (this.values.length === 0) return first;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= this.values.length) break;
        let child = left;
        if (
          right < this.values.length &&
          this.compare(this.values[right], this.values[left]) < 0
        ) {
          child = right;
        }
        if (this.compare(this.values[child], last) >= 0) break;
        this.values[index] = this.values[child];
        index = child;
      }
      this.values[index] = last;
      return first;
    }
  }

  function compareSearchEntries(a, b) {
    if (a.cost !== b.cost) return a.cost < b.cost ? -1 : 1;
    const pathOrder = comparePointSequences(a.path, b.path);
    if (pathOrder !== 0) return pathOrder;
    const directionOrder = compareStrings(a.direction, b.direction);
    if (directionOrder !== 0) return directionOrder;
    return a.nodeIndex - b.nodeIndex;
  }

  function addGridConnection(adjacency, nodes, firstIndex, secondIndex, blockers) {
    const first = nodes[firstIndex];
    const second = nodes[secondIndex];
    if (!segmentClear(first, second, blockers)) return;
    const distance =
      BigInt(Math.abs(first.x - second.x)) + BigInt(Math.abs(first.y - second.y));
    adjacency[firstIndex].push({ nodeIndex: secondIndex, distance });
    adjacency[secondIndex].push({ nodeIndex: firstIndex, distance });
  }

  function buildGrid(source, target, obstacles, stage) {
    const sourceBounds = rectToUnitBounds(source, "$.sourceRect");
    const targetBounds = rectToUnitBounds(target, "$.targetRect");
    const obstacleBounds = obstacles.map((obstacle, index) =>
      rectToUnitBounds(obstacle, `$.obstacles[${index}]`),
    );
    const actualBounds = [sourceBounds, targetBounds, ...obstacleBounds];
    const blockers = actualBounds.map((bounds, index) =>
      inflateBounds(bounds, index === 0 ? "$.sourceRect" : index === 1 ? "$.targetRect" : `$.obstacles[${index - 2}]`),
    );

    let mapBounds;
    if (stage) {
      mapBounds = stage;
    } else {
      mapBounds = {
        left: clampedUnitAdd(
          Math.min(...actualBounds.map((bounds) => bounds.left)),
          -MAP_CLEARANCE_UNITS,
        ),
        top: clampedUnitAdd(
          Math.min(...actualBounds.map((bounds) => bounds.top)),
          -MAP_CLEARANCE_UNITS,
        ),
        right: clampedUnitAdd(
          Math.max(...actualBounds.map((bounds) => bounds.right)),
          MAP_CLEARANCE_UNITS,
        ),
        bottom: clampedUnitAdd(
          Math.max(...actualBounds.map((bounds) => bounds.bottom)),
          MAP_CLEARANCE_UNITS,
        ),
      };
    }

    const pairs = preferredAnchorPairs(source, target).map((pair) => {
      const sourceAnchor = pointToUnits(pair.sourceAnchor, "$.sourceAnchor");
      const targetAnchor = pointToUnits(pair.targetAnchor, "$.targetAnchor");
      const sourceNormal = NORMALS[pair.sourceSide];
      const targetNormal = NORMALS[pair.targetSide];
      const egress = {
        x: safeUnitAdd(
          sourceAnchor.x,
          sourceNormal.x * OBSTACLE_CLEARANCE_UNITS,
          "$.egress.x",
        ),
        y: safeUnitAdd(
          sourceAnchor.y,
          sourceNormal.y * OBSTACLE_CLEARANCE_UNITS,
          "$.egress.y",
        ),
      };
      const ingress = {
        x: safeUnitAdd(
          targetAnchor.x,
          targetNormal.x * OBSTACLE_CLEARANCE_UNITS,
          "$.ingress.x",
        ),
        y: safeUnitAdd(
          targetAnchor.y,
          targetNormal.y * OBSTACLE_CLEARANCE_UNITS,
          "$.ingress.y",
        ),
      };
      return { ...pair, sourceAnchor, targetAnchor, egress, ingress };
    });

    const xValues = new Set([mapBounds.left, mapBounds.right]);
    const yValues = new Set([mapBounds.top, mapBounds.bottom]);
    const allowedPoints = new Set();
    for (const pair of pairs) {
      for (const point of [pair.sourceAnchor, pair.targetAnchor, pair.egress, pair.ingress]) {
        xValues.add(point.x);
        yValues.add(point.y);
        allowedPoints.add(pointKey(point));
      }
    }
    for (const blocker of blockers) {
      xValues.add(blocker.left);
      xValues.add(blocker.right);
      yValues.add(blocker.top);
      yValues.add(blocker.bottom);
      xValues.add(clampedUnitAdd(blocker.left, -GRID_LINE_CLEARANCE_UNITS));
      xValues.add(clampedUnitAdd(blocker.right, GRID_LINE_CLEARANCE_UNITS));
      yValues.add(clampedUnitAdd(blocker.top, -GRID_LINE_CLEARANCE_UNITS));
      yValues.add(clampedUnitAdd(blocker.bottom, GRID_LINE_CLEARANCE_UNITS));
    }

    const xs = [...xValues]
      .filter((value) => value >= mapBounds.left && value <= mapBounds.right)
      .sort((a, b) => a - b);
    const ys = [...yValues]
      .filter((value) => value >= mapBounds.top && value <= mapBounds.bottom)
      .sort((a, b) => a - b);
    if (xs.length * ys.length > MAX_GRID_NODES) {
      fail("E_WORKFLOW_ROUTE", "$.obstacles", "candidate grid exceeds the bounded node limit");
    }

    const nodes = [];
    const nodeByKey = new Map();
    for (const x of xs) {
      for (const y of ys) {
        const point = { x, y };
        if (
          !allowedPoints.has(pointKey(point)) &&
          blockers.some((blocker) => pointInOpenRect(point, blocker))
        ) {
          continue;
        }
        nodeByKey.set(pointKey(point), nodes.length);
        nodes.push(point);
      }
    }

    const adjacency = Array.from({ length: nodes.length }, () => []);
    const rows = new Map();
    const columns = new Map();
    nodes.forEach((point, index) => {
      if (!rows.has(point.y)) rows.set(point.y, []);
      if (!columns.has(point.x)) columns.set(point.x, []);
      rows.get(point.y).push(index);
      columns.get(point.x).push(index);
    });
    for (const y of [...rows.keys()].sort((a, b) => a - b)) {
      const indexes = rows.get(y).sort((a, b) => nodes[a].x - nodes[b].x);
      for (let index = 1; index < indexes.length; index += 1) {
        addGridConnection(adjacency, nodes, indexes[index - 1], indexes[index], blockers);
      }
    }
    for (const x of [...columns.keys()].sort((a, b) => a - b)) {
      const indexes = columns.get(x).sort((a, b) => nodes[a].y - nodes[b].y);
      for (let index = 1; index < indexes.length; index += 1) {
        addGridConnection(adjacency, nodes, indexes[index - 1], indexes[index], blockers);
      }
    }
    adjacency.forEach((neighbors) => {
      neighbors.sort((a, b) => {
        const pointOrder = comparePointSequences(
          [nodes[a.nodeIndex]],
          [nodes[b.nodeIndex]],
        );
        return pointOrder || (a.distance < b.distance ? -1 : a.distance > b.distance ? 1 : 0);
      });
    });

    return {
      actualBounds,
      blockers,
      mapBounds,
      pairs,
      nodes,
      nodeByKey,
      adjacency,
    };
  }

  function rankZeroDirectCandidate(source, target, obstacles, stage) {
    const pair = preferredAnchorPairs(source, target)[0];
    const sourceAnchor = pointToUnits(pair.sourceAnchor, "$.sourceAnchor");
    const targetAnchor = pointToUnits(pair.targetAnchor, "$.targetAnchor");
    const direction = segmentDirection(sourceAnchor, targetAnchor);
    if (
      pointsEqual(sourceAnchor, targetAnchor) ||
      !sameVector(direction, NORMALS[pair.sourceSide]) ||
      !sameVector(direction, negate(NORMALS[pair.targetSide])) ||
      (stage &&
        (!pointInsideBounds(sourceAnchor, stage) ||
          !pointInsideBounds(targetAnchor, stage)))
    ) {
      return null;
    }
    const blockers = obstacles.map((obstacle, index) =>
      inflateBounds(
        rectToUnitBounds(obstacle, `$.obstacles[${index}]`),
        `$.obstacles[${index}]`,
      ),
    );
    if (!segmentClear(sourceAnchor, targetAnchor, blockers)) return null;
    return {
      pair,
      points: [sourceAnchor, targetAnchor],
      costUnits: manhattanLengthUnits([sourceAnchor, targetAnchor]),
    };
  }

  function directVisibilityCandidate(grid, pair) {
    const direction = segmentDirection(pair.sourceAnchor, pair.targetAnchor);
    if (
      pointsEqual(pair.sourceAnchor, pair.targetAnchor) ||
      !sameVector(direction, NORMALS[pair.sourceSide]) ||
      !sameVector(direction, negate(NORMALS[pair.targetSide])) ||
      !pointInsideBounds(pair.sourceAnchor, grid.mapBounds) ||
      !pointInsideBounds(pair.targetAnchor, grid.mapBounds) ||
      !segmentClear(pair.sourceAnchor, pair.targetAnchor, grid.blockers.slice(2))
    ) {
      return null;
    }
    return {
      pair,
      points: [pair.sourceAnchor, pair.targetAnchor],
      costUnits:
        manhattanLengthUnits([pair.sourceAnchor, pair.targetAnchor]) +
        BigInt(pair.preferenceRank) * PREFERENCE_COST_UNITS,
    };
  }

  function pointInsideBounds(point, bounds) {
    return (
      point.x >= bounds.left &&
      point.x <= bounds.right &&
      point.y >= bounds.top &&
      point.y <= bounds.bottom
    );
  }

  function searchGridPair(grid, pair, sourceId, targetId) {
    if (
      !pointInsideBounds(pair.sourceAnchor, grid.mapBounds) ||
      !pointInsideBounds(pair.targetAnchor, grid.mapBounds) ||
      !pointInsideBounds(pair.egress, grid.mapBounds) ||
      !pointInsideBounds(pair.ingress, grid.mapBounds)
    ) {
      return null;
    }
    if (!segmentClear(pair.sourceAnchor, pair.egress, grid.blockers, sourceId)) return null;
    if (!segmentClear(pair.ingress, pair.targetAnchor, grid.blockers, targetId)) return null;
    const startIndex = grid.nodeByKey.get(pointKey(pair.egress));
    const goalIndex = grid.nodeByKey.get(pointKey(pair.ingress));
    if (startIndex === undefined || goalIndex === undefined) return null;

    const startDirection = normalDirection(NORMALS[pair.sourceSide]);
    const finalDirection = normalDirection(negate(NORMALS[pair.targetSide]));
    const initial = {
      nodeIndex: startIndex,
      direction: startDirection,
      cost:
        BigInt(OBSTACLE_CLEARANCE_UNITS) +
        BigInt(pair.preferenceRank) * PREFERENCE_COST_UNITS,
      path: collapseCollinearPoints([pair.sourceAnchor, grid.nodes[startIndex]]),
    };
    const heap = new MinHeap(compareSearchEntries);
    const bestStates = new Map();
    const startKey = `${startIndex}|${startDirection}`;
    bestStates.set(startKey, initial);
    heap.push(initial);
    let bestGoal = null;
    let visited = 0;

    while (heap.length > 0) {
      const current = heap.pop();
      const stateKey = `${current.nodeIndex}|${current.direction}`;
      const recorded = bestStates.get(stateKey);
      if (
        !recorded ||
        current.cost !== recorded.cost ||
        comparePointSequences(current.path, recorded.path) !== 0
      ) {
        continue;
      }
      if (bestGoal && current.cost > bestGoal.costUnits) break;
      visited += 1;
      if (visited > MAX_SEARCH_STATES) {
        fail("E_WORKFLOW_ROUTE", "$.obstacles", "grid search exceeds the bounded state limit");
      }

      if (current.nodeIndex === goalIndex) {
        const terminalBend = current.direction === finalDirection ? 0n : BEND_COST_UNITS;
        const cost = current.cost + BigInt(OBSTACLE_CLEARANCE_UNITS) + terminalBend;
        const points = collapseCollinearPoints([...current.path, pair.targetAnchor]);
        const candidate = { pair, points, costUnits: cost };
        if (
          !bestGoal ||
          candidate.costUnits < bestGoal.costUnits ||
          (candidate.costUnits === bestGoal.costUnits &&
            comparePointSequences(candidate.points, bestGoal.points) < 0)
        ) {
          bestGoal = candidate;
        }
        continue;
      }

      for (const neighbor of grid.adjacency[current.nodeIndex]) {
        const nextPoint = grid.nodes[neighbor.nodeIndex];
        const nextDirection = directionName(grid.nodes[current.nodeIndex], nextPoint);
        const bend = nextDirection === current.direction ? 0n : BEND_COST_UNITS;
        const next = {
          nodeIndex: neighbor.nodeIndex,
          direction: nextDirection,
          cost: current.cost + neighbor.distance + bend,
          path: collapseCollinearPoints([...current.path, nextPoint]),
        };
        if (bestGoal && next.cost > bestGoal.costUnits) continue;
        const nextKey = `${next.nodeIndex}|${next.direction}`;
        const previous = bestStates.get(nextKey);
        if (
          previous &&
          (previous.cost < next.cost ||
            (previous.cost === next.cost &&
              comparePointSequences(previous.path, next.path) <= 0))
        ) {
          continue;
        }
        bestStates.set(nextKey, next);
        heap.push(next);
      }
    }
    return bestGoal;
}

function buildSegments(points) {
  const segments = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    segments.push({
      x1: points[index].x,
      y1: points[index].y,
      x2: points[index + 1].x,
      y2: points[index + 1].y,
      index,
    });
  }
  return segments;
}

function validateExistingRoutes(value, path) {
  if (!Array.isArray(value)) fail("E_ROUTER_INPUT", path, "expected an array");
  if (value.length > 0) {
    fail(
      "E_ROUTER_UNSUPPORTED",
      path,
      "existing-route-aware routing is not supported by this grid layer",
    );
  }
}

function routeWithoutObstacles(source, target) {
  const pairs = preferredAnchorPairs(source, target);
  let best = null;
  let precisionBlocked = false;
  for (const withOffsets of [false, true]) {
    for (const pair of pairs) {
      const result = candidateRoutes(
        pair.sourceAnchor,
        pair.targetAnchor,
        pair.sourceSide,
        pair.targetSide,
        withOffsets,
      );
      precisionBlocked ||= result.precisionBlocked;
      for (const rawPoints of result.candidates) {
        const points = collapsePoints(rawPoints);
        if (points.length < 2) continue;
        const bendCount = BigInt(points.length - 2);
        let costUnits = manhattanLengthUnits(points);
        costUnits += bendCount * BEND_COST_UNITS;
        costUnits += BigInt(pair.preferenceRank) * PREFERENCE_COST_UNITS;
        const candidate = { pair, points, costUnits };
        if (
          !best ||
          candidate.costUnits < best.costUnits ||
          (candidate.costUnits === best.costUnits &&
            comparePointSequences(candidate.points, best.points) < 0)
        ) {
          best = candidate;
        }
      }
    }
    if (best) break;
  }

  if (!best) {
    if (precisionBlocked) {
      fail(
        "E_ROUTER_NONFINITE",
        "$",
        "no representable egress or ingress distance exists at the coordinate magnitude",
      );
    }
    fail(
      "E_ROUTER_UNSUPPORTED",
      "$",
      "no zero-obstacle axis-aligned route exists for the given anchors",
    );
  }

  const points = best.points.map((point, index) => ({
    x: fromThousandths(point.x, `$.points[${index}].x`),
    y: fromThousandths(point.y, `$.points[${index}].y`),
  }));
  const segments = buildSegments(points);
  return {
    sourceId: source.id,
    targetId: target.id,
    fromSide: best.pair.sourceSide,
    toSide: best.pair.targetSide,
    points,
    segments,
    cost: fromBigIntThousandths(best.costUnits, "$.cost"),
  };
}

function validateAndSortObstacles(value, source, target) {
  if (!Array.isArray(value)) fail("E_ROUTER_INPUT", "$.obstacles", "expected an array");
  const obstacles = value.map((obstacle, index) =>
    validateRect(obstacle, `$.obstacles[${index}]`),
  );
  const seen = new Set([source.id, target.id]);
  for (const [index, obstacle] of obstacles.entries()) {
    if (seen.has(obstacle.id)) {
      fail("E_ROUTER_INPUT", `$.obstacles[${index}].id`, "rectangle IDs must be unique");
    }
    seen.add(obstacle.id);
  }
  return obstacles
    .map((obstacle, index) => ({
      obstacle,
      bounds: rectToUnitBounds(obstacle, `$.obstacles[${index}]`),
    }))
    .sort((a, b) => {
      const idOrder = compareStrings(a.obstacle.id, b.obstacle.id);
      if (idOrder !== 0) return idOrder;
      for (const key of ["left", "top", "right", "bottom"]) {
        if (a.bounds[key] !== b.bounds[key]) return a.bounds[key] - b.bounds[key];
      }
      return 0;
    })
    .map((entry) => entry.obstacle);
}

function routeFromGridCandidate(source, target, candidate) {
  const points = candidate.points.map((point, index) => ({
    x: fromThousandths(point.x, `$.points[${index}].x`),
    y: fromThousandths(point.y, `$.points[${index}].y`),
  }));
  return {
    sourceId: source.id,
    targetId: target.id,
    fromSide: candidate.pair.sourceSide,
    toSide: candidate.pair.targetSide,
    points,
    segments: buildSegments(points),
    cost: fromBigIntThousandths(candidate.costUnits, "$.cost"),
  };
}

function validateGeneratedGridRoute(route, grid, sourceId, targetId) {
  const unitPoints = route.points.map((point, index) =>
    pointToUnits(point, `$.points[${index}]`),
  );
  for (let index = 1; index < unitPoints.length; index += 1) {
    const ignored = new Set();
    if (index === 1) ignored.add(sourceId);
    if (index === unitPoints.length - 1) ignored.add(targetId);
    for (const blocker of grid.blockers) {
      if (
        !ignored.has(blocker.id) &&
        segmentCrossesOpenRect(unitPoints[index - 1], unitPoints[index], blocker)
      ) {
        fail("E_WORKFLOW_ROUTE", `$.segments[${index - 1}]`, "route crosses an inflated obstacle interior");
      }
    }
  }
}

/**
 * Route one non-self orthogonal edge around zero or more rectangular
 * obstacles. Existing routes remain unsupported in this layer. An optional
 * stage bounds the candidate grid; otherwise routing uses a finite envelope
 * around the nodes and obstacles.
 */
export function routeOrthogonalEdge(input) {
  const snapshot = snapshotGeometry(input, "$");
  exactOptionalKeys(
    snapshot,
    ["sourceRect", "targetRect", "existingRoutes", "obstacles"],
    ["stage"],
    "$",
  );

  const source = validateRect(snapshot.sourceRect, "$.sourceRect");
  const target = validateRect(snapshot.targetRect, "$.targetRect");
  validateExistingRoutes(snapshot.existingRoutes, "$.existingRoutes");
  if (source.id === target.id) {
    fail(
      "E_ROUTER_UNSUPPORTED",
      "$.targetRect.id",
      "self-edge routing is not supported by this grid layer",
    );
  }
  const obstacles = validateAndSortObstacles(snapshot.obstacles, source, target);
  const stage = Object.hasOwn(snapshot, "stage")
    ? validateStageAt(snapshot.stage, "$.stage")
    : null;

  if (obstacles.length === 0) {
    const foundationRoute = routeWithoutObstacles(source, target);
    if (!stage) return foundationRoute;
    try {
      validateOrthogonalRoute(foundationRoute, {
        sourceRect: source,
        targetRect: target,
        stage: { x: stage.x, y: stage.y, w: stage.w, h: stage.h },
      });
      return foundationRoute;
    } catch (error) {
      if (!(error instanceof RouterError) || error.code !== "E_ROUTER_BOUNDS") throw error;
    }
  }

  const direct = rankZeroDirectCandidate(source, target, obstacles, stage);
  if (direct) {
    const route = routeFromGridCandidate(source, target, direct);
    validateOrthogonalRoute(route, {
      sourceRect: source,
      targetRect: target,
      obstacles,
      ...(stage
        ? { stage: { x: stage.x, y: stage.y, w: stage.w, h: stage.h } }
        : {}),
    });
    return route;
  }

  const grid = buildGrid(source, target, obstacles, stage);
  let best = null;
  for (const pair of grid.pairs) {
    for (const candidate of [
      directVisibilityCandidate(grid, pair),
      searchGridPair(grid, pair, source.id, target.id),
    ]) {
      if (
        candidate &&
        (!best ||
          candidate.costUnits < best.costUnits ||
          (candidate.costUnits === best.costUnits &&
            comparePointSequences(candidate.points, best.points) < 0))
      ) {
        best = candidate;
      }
    }
  }
  if (!best) {
    fail("E_WORKFLOW_ROUTE", "$", "no bounded obstacle-avoiding route exists");
  }

  const route = routeFromGridCandidate(source, target, best);
  validateGeneratedGridRoute(route, grid, source.id, target.id);
  validateOrthogonalRoute(route, {
    sourceRect: source,
    targetRect: target,
    obstacles,
    ...(stage
      ? { stage: { x: stage.x, y: stage.y, w: stage.w, h: stage.h } }
      : {}),
  });
  return route;
}

function requireSide(value, path) {
  if (!SIDES.includes(value)) fail("E_ROUTER_INPUT", path, `expected one of ${SIDES.join(", ")}`);
  return value;
}

function validateRoutePoint(point, path) {
  exactKeys(point, POINT_KEYS, path);
  return {
    x: requireFiniteNumber(point.x, `${path}.x`),
    y: requireFiniteNumber(point.y, `${path}.y`),
  };
}

function validateRouteSegment(segment, path) {
  exactKeys(segment, SEGMENT_KEYS, path);
  return {
    x1: requireFiniteNumber(segment.x1, `${path}.x1`),
    y1: requireFiniteNumber(segment.y1, `${path}.y1`),
    x2: requireFiniteNumber(segment.x2, `${path}.x2`),
    y2: requireFiniteNumber(segment.y2, `${path}.y2`),
    index: segment.index,
  };
}

function stageBounds(stage) {
  const right = stage.x + stage.w;
  const bottom = stage.y + stage.h;
  if (!Number.isFinite(right)) {
    fail("E_ROUTER_NONFINITE", "$context.stage.w", "stage horizontal extent must be finite");
  }
  if (!Number.isFinite(bottom)) {
    fail("E_ROUTER_NONFINITE", "$context.stage.h", "stage vertical extent must be finite");
  }
  return {
    left: toThousandths(stage.x, "$context.stage.x"),
    top: toThousandths(stage.y, "$context.stage.y"),
    right: toThousandths(right, "$context.stage.w"),
    bottom: toThousandths(bottom, "$context.stage.h"),
  };
}

function withinStage(x, y, stage, path) {
  const xUnits = toThousandths(x, `${path}.x`);
  const yUnits = toThousandths(y, `${path}.y`);
  if (
    xUnits < stage.left ||
    xUnits > stage.right ||
    yUnits < stage.top ||
    yUnits > stage.bottom
  ) {
    fail("E_ROUTER_BOUNDS", path, "route geometry falls outside the stage bounds");
  }
}

/**
 * Validate a routed edge for structural and geometric correctness: exact
 * shape, contiguous axis-aligned nonzero segments matching the point list,
 * declared endpoint anchors that match the supplied source/target rects, a
 * finite nonnegative cost, and (when a stage rect is supplied in context)
 * every point and segment endpoint contained within the stage bounds.
 */
export function validateOrthogonalRoute(route, context = {}) {
  const routeSnapshot = snapshotGeometry(route, "$");
  exactKeys(routeSnapshot, ROUTE_KEYS, "$");

  const contextSnapshot = snapshotGeometry(context, "$context");
  if (!isPlainObject(contextSnapshot)) {
    fail("E_ROUTER_INPUT", "$context", "expected plain object");
  }
  for (const key of Object.keys(contextSnapshot)) {
    if (!["sourceRect", "targetRect", "stage", "obstacles"].includes(key)) {
      fail("E_ROUTER_INPUT", `$context.${key}`, "unknown context field");
    }
  }

  const sourceId = requireNonEmptyString(routeSnapshot.sourceId, "$.sourceId");
  const targetId = requireNonEmptyString(routeSnapshot.targetId, "$.targetId");
  const fromSide = requireSide(routeSnapshot.fromSide, "$.fromSide");
  const toSide = requireSide(routeSnapshot.toSide, "$.toSide");

  if (!Array.isArray(routeSnapshot.points)) fail("E_ROUTER_INPUT", "$.points", "expected an array");
  if (routeSnapshot.points.length < 2) {
    fail("E_WORKFLOW_ROUTE", "$.points", "route must contain at least two points");
  }
  const points = routeSnapshot.points.map((point, index) =>
    validateRoutePoint(point, `$.points[${index}]`),
  );

  if (!Array.isArray(routeSnapshot.segments)) {
    fail("E_ROUTER_INPUT", "$.segments", "expected an array");
  }
  if (routeSnapshot.segments.length !== points.length - 1) {
    fail(
      "E_WORKFLOW_ROUTE",
      "$.segments",
      "segment count must equal point count minus one",
    );
  }
  const segments = routeSnapshot.segments.map((segment, index) =>
    validateRouteSegment(segment, `$.segments[${index}]`),
  );

  for (const [index, segment] of segments.entries()) {
    const path = `$.segments[${index}]`;
    if (segment.index !== index) {
      fail("E_WORKFLOW_ROUTE", `${path}.index`, "segment index must match its position");
    }

    if (!sameVector(segmentDirection(points[0], points[1]), NORMALS[fromSide])) {
      fail("E_WORKFLOW_ROUTE", "$.segments[0]", "first segment must follow the outward source normal");
    }
    if (
      !sameVector(
        segmentDirection(points.at(-2), points.at(-1)),
        negate(NORMALS[toSide]),
      )
    ) {
      fail(
        "E_WORKFLOW_ROUTE",
        `$.segments[${segments.length - 1}]`,
        "final segment must follow the inward target normal",
      );
    }
    const point = points[index];
    const nextPoint = points[index + 1];
    if (segment.x1 !== point.x || segment.y1 !== point.y) {
      fail("E_WORKFLOW_ROUTE", path, "segment start must match the preceding point");
    }
    if (segment.x2 !== nextPoint.x || segment.y2 !== nextPoint.y) {
      fail("E_WORKFLOW_ROUTE", path, "segment end must match the following point");
    }
    const horizontal = segment.x1 !== segment.x2;
    const vertical = segment.y1 !== segment.y2;
    if (horizontal === vertical) {
      fail(
        "E_WORKFLOW_ROUTE",
        path,
        "segment must be exactly one of horizontal or vertical, and nonzero",
      );
    }
  }

  const cost = requireFiniteNumber(routeSnapshot.cost, "$.cost");
  if (cost < 0) fail("E_WORKFLOW_ROUTE", "$.cost", "cost must be nonnegative");

  const hasSourceRect = Object.hasOwn(contextSnapshot, "sourceRect");
  const hasTargetRect = Object.hasOwn(contextSnapshot, "targetRect");
  let sourceRect = null;
  let targetRect = null;
  if (hasSourceRect !== hasTargetRect) {
    fail(
      "E_ROUTER_INPUT",
      "$context",
      "sourceRect and targetRect must be supplied together",
    );
  }
  if (hasSourceRect && hasTargetRect) {
    sourceRect = validateRect(contextSnapshot.sourceRect, "$context.sourceRect");
    targetRect = validateRect(contextSnapshot.targetRect, "$context.targetRect");
    if (sourceRect.id !== sourceId) {
      fail("E_WORKFLOW_ROUTE", "$.sourceId", "sourceId must match context.sourceRect.id");
    }
    if (targetRect.id !== targetId) {
      fail("E_WORKFLOW_ROUTE", "$.targetId", "targetId must match context.targetRect.id");
    }
    const expectedSourceAnchor = anchorPoint(sourceRect, fromSide);
    const expectedTargetAnchor = anchorPoint(targetRect, toSide);
    const firstPoint = points[0];
    const lastPoint = points[points.length - 1];
    if (firstPoint.x !== expectedSourceAnchor.x || firstPoint.y !== expectedSourceAnchor.y) {
      fail(
        "E_WORKFLOW_ROUTE",
        "$.points[0]",
        "first point must equal the source anchor for the declared fromSide",
      );
    }
    if (lastPoint.x !== expectedTargetAnchor.x || lastPoint.y !== expectedTargetAnchor.y) {
      fail(
        "E_WORKFLOW_ROUTE",
        `$.points[${points.length - 1}]`,
        "last point must equal the target anchor for the declared toSide",
      );
    }
  }

  if (Object.hasOwn(contextSnapshot, "obstacles")) {
    if (!sourceRect || !targetRect) {
      fail(
        "E_ROUTER_INPUT",
        "$context.obstacles",
        "obstacle validation requires sourceRect and targetRect",
      );
    }
    if (!Array.isArray(contextSnapshot.obstacles)) {
      fail("E_ROUTER_INPUT", "$context.obstacles", "expected an array");
    }
    const contextObstacles = contextSnapshot.obstacles.map((obstacle, index) =>
      validateRect(obstacle, `$context.obstacles[${index}]`),
    );
    const ids = new Set([sourceRect.id, targetRect.id]);
    for (const [index, obstacle] of contextObstacles.entries()) {
      if (ids.has(obstacle.id)) {
        fail(
          "E_ROUTER_INPUT",
          `$context.obstacles[${index}].id`,
          "rectangle IDs must be unique",
        );
      }
      ids.add(obstacle.id);
    }
    const validationRects =
      contextObstacles.length === 0
        ? []
        : [sourceRect, targetRect, ...contextObstacles];
    const blockers = validationRects.map((rect, index) =>
      inflateBounds(
        rectToUnitBounds(
          rect,
          index === 0
            ? "$context.sourceRect"
            : index === 1
              ? "$context.targetRect"
              : `$context.obstacles[${index - 2}]`,
        ),
        index === 0
          ? "$context.sourceRect"
          : index === 1
            ? "$context.targetRect"
            : `$context.obstacles[${index - 2}]`,
      ),
    );
    const unitPoints = points.map((point, index) =>
      pointToUnits(point, `$.points[${index}]`),
    );
    for (let index = 1; index < unitPoints.length; index += 1) {
      for (const blocker of blockers) {
        if (
          (index === 1 && blocker.id === sourceRect.id) ||
          (index === unitPoints.length - 1 && blocker.id === targetRect.id)
        ) {
          continue;
        }
        if (segmentCrossesOpenRect(unitPoints[index - 1], unitPoints[index], blocker)) {
          fail(
            "E_WORKFLOW_ROUTE",
            `$.segments[${index - 1}]`,
            "route crosses an inflated obstacle interior",
          );
        }
      }
    }
  }

  if (Object.hasOwn(contextSnapshot, "stage")) {
    const stage = contextSnapshot.stage;
    exactKeys(stage, ["x", "y", "w", "h"], "$context.stage");
    const stageRect = {
      x: requireFiniteNumber(stage.x, "$context.stage.x"),
      y: requireFiniteNumber(stage.y, "$context.stage.y"),
      w: requireFiniteNumber(stage.w, "$context.stage.w"),
      h: requireFiniteNumber(stage.h, "$context.stage.h"),
    };
    if (stageRect.w <= 0) fail("E_ROUTER_BOUNDS", "$context.stage.w", "width must be positive");
    if (stageRect.h <= 0) fail("E_ROUTER_BOUNDS", "$context.stage.h", "height must be positive");
    const bounds = stageBounds(stageRect);
    points.forEach((point, index) => {
      withinStage(point.x, point.y, bounds, `$.points[${index}]`);
    });
    segments.forEach((segment, index) => {
      withinStage(segment.x1, segment.y1, bounds, `$.segments[${index}]`);
      withinStage(segment.x2, segment.y2, bounds, `$.segments[${index}]`);
    });
  }

  return { sourceId, targetId, fromSide, toSide, points, segments, cost };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

/**
 * Serialize a route to deterministic, stable JSON bytes: strict plain-data
 * snapshotting followed by recursive key sorting, so the same logical route
 * always produces byte-identical output regardless of property insertion
 * order.
 */
export function stableRouteJson(route) {
  const snapshot = snapshotGeometry(route, "$");
  return JSON.stringify(canonical(snapshot));
}
