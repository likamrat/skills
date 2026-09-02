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

function round3(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
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
  } catch (error) {
    fail("E_ROUTER_INPUT", path, `property inspection failed: ${error.message}`);
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
export function snapshotGeometry(value, path = "$") {
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

  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch (error) {
    fail("E_ROUTER_INPUT", path, `property inspection failed: ${error.message}`);
  }
  if (keys.some((key) => typeof key === "symbol")) {
    fail("E_ROUTER_INPUT", path, "symbol properties are not allowed");
  }

  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      fail("E_ROUTER_INPUT", path, "array prototype must be Array.prototype");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor?.value;
    if (
      !lengthDescriptor ||
      !Object.hasOwn(lengthDescriptor, "value") ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      lengthDescriptor.writable !== true
    ) {
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
      snapshot[index] = snapshotGeometry(descriptor.value, `${path}[${index}]`);
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
      value: snapshotGeometry(descriptor.value, `${path}.${key}`),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return snapshot;
}

function exactKeys(value, expected, path) {
  if (!isPlainObject(value)) fail("E_ROUTER_INPUT", path, "expected plain object");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("E_ROUTER_INPUT", path, `expected keys ${wanted.join(", ")}`);
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
  const horizontalDominant = Math.abs(dx) >= Math.abs(dy);
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

function candidateRoutes(sourceAnchor, targetAnchor, sourceSide, targetSide) {
  const dx = targetAnchor.x - sourceAnchor.x;
  const dy = targetAnchor.y - sourceAnchor.y;
  if (dx === 0 && dy === 0) return [];

  const exitNormal = NORMALS[sourceSide];
  const entryNormal = negate(NORMALS[targetSide]);
  const candidates = [];

  if (dx === 0 || dy === 0) {
    const direction = segmentDirection(sourceAnchor, targetAnchor);
    if (sameVector(direction, exitNormal) && sameVector(direction, entryNormal)) {
      candidates.push([sourceAnchor, targetAnchor]);
    }
    return candidates;
  }

  const bendHV = { x: targetAnchor.x, y: sourceAnchor.y };
  const firstHV = segmentDirection(sourceAnchor, bendHV);
  const secondHV = segmentDirection(bendHV, targetAnchor);
  if (sameVector(firstHV, exitNormal) && sameVector(secondHV, entryNormal)) {
    candidates.push([sourceAnchor, bendHV, targetAnchor]);
  }

  const bendVH = { x: sourceAnchor.x, y: targetAnchor.y };
  const firstVH = segmentDirection(sourceAnchor, bendVH);
  const secondVH = segmentDirection(bendVH, targetAnchor);
  if (sameVector(firstVH, exitNormal) && sameVector(secondVH, entryNormal)) {
    candidates.push([sourceAnchor, bendVH, targetAnchor]);
  }

  return candidates;
}

function collapsePoints(points) {
  const collapsed = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const previous = collapsed[collapsed.length - 1];
    if (!pointsEqual(previous, points[index])) collapsed.push(points[index]);
  }
  return collapsed;
}

function manhattanLength(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.abs(points[index].x - points[index - 1].x);
    total += Math.abs(points[index].y - points[index - 1].y);
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

function buildSegments(points) {
  const segments = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    segments.push({
      x1: round3(points[index].x),
      y1: round3(points[index].y),
      x2: round3(points[index + 1].x),
      y2: round3(points[index + 1].y),
      index,
    });
  }
  return segments;
}

function validateExistingCollection(value, path) {
  if (!Array.isArray(value)) fail("E_ROUTER_INPUT", path, "expected an array");
  if (value.length > 0) {
    fail(
      "E_ROUTER_UNSUPPORTED",
      path,
      "obstacle-aware and existing-route-aware routing is not supported by this foundation layer",
    );
  }
}

/**
 * Route a single orthogonal (axis-aligned) edge between two non-overlapping
 * rect nodes with no obstacles and no existing routes to avoid. This is the
 * foundation layer: zero-obstacle, non-self routing only. `existingRoutes`
 * and `obstacles` must be supplied as empty arrays; a nonempty value throws
 * E_ROUTER_UNSUPPORTED so callers know a richer routing layer is required.
 */
export function routeOrthogonalEdge(input) {
  const snapshot = snapshotGeometry(input, "$");
  exactKeys(snapshot, ["sourceRect", "targetRect", "existingRoutes", "obstacles"], "$");

  const source = validateRect(snapshot.sourceRect, "$.sourceRect");
  const target = validateRect(snapshot.targetRect, "$.targetRect");
  validateExistingCollection(snapshot.existingRoutes, "$.existingRoutes");
  validateExistingCollection(snapshot.obstacles, "$.obstacles");

  if (source.id === target.id) {
    fail(
      "E_ROUTER_UNSUPPORTED",
      "$.targetRect.id",
      "self-edge routing is not supported by this foundation layer",
    );
  }

  const pairs = preferredAnchorPairs(source, target);
  let best = null;
  for (const pair of pairs) {
    const candidates = candidateRoutes(
      pair.sourceAnchor,
      pair.targetAnchor,
      pair.sourceSide,
      pair.targetSide,
    );
    for (const rawPoints of candidates) {
      const points = collapsePoints(rawPoints);
      if (points.length < 2) continue;
      const bendCount = points.length - 2;
      const cost =
        manhattanLength(points) + bendCount * BEND_COST + pair.preferenceRank * PREFERENCE_COST;
      const candidate = { pair, points, cost };
      if (!best) {
        best = candidate;
        continue;
      }
      if (candidate.cost < best.cost) {
        best = candidate;
      } else if (candidate.cost === best.cost) {
        if (comparePointSequences(candidate.points, best.points) < 0) best = candidate;
      }
    }
  }

  if (!best) {
    fail(
      "E_ROUTER_UNSUPPORTED",
      "$",
      "no zero-obstacle axis-aligned route exists for the given anchors",
    );
  }

  const points = best.points.map((point) => ({ x: round3(point.x), y: round3(point.y) }));
  const segments = buildSegments(points);
  return {
    sourceId: source.id,
    targetId: target.id,
    fromSide: best.pair.sourceSide,
    toSide: best.pair.targetSide,
    points,
    segments,
    cost: round3(best.cost),
  };
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

function withinStage(x, y, stage, path) {
  if (!stage) return;
  if (x < stage.x || x > stage.x + stage.w || y < stage.y || y > stage.y + stage.h) {
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
    if (!["sourceRect", "targetRect", "stage"].includes(key)) {
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
  if (hasSourceRect !== hasTargetRect) {
    fail(
      "E_ROUTER_INPUT",
      "$context",
      "sourceRect and targetRect must be supplied together",
    );
  }
  if (hasSourceRect && hasTargetRect) {
    const sourceRect = validateRect(contextSnapshot.sourceRect, "$context.sourceRect");
    const targetRect = validateRect(contextSnapshot.targetRect, "$context.targetRect");
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
    points.forEach((point, index) => {
      withinStage(point.x, point.y, stageRect, `$.points[${index}]`);
    });
    segments.forEach((segment, index) => {
      withinStage(segment.x1, segment.y1, stageRect, `$.segments[${index}]`);
      withinStage(segment.x2, segment.y2, stageRect, `$.segments[${index}]`);
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
