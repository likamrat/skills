#!/usr/bin/env node

import {
  RouterError,
  nodeAnchors,
  preferredAnchorPairs,
  routeOrthogonalEdge,
  snapshotGeometry,
  stableRouteJson,
  validateOrthogonalRoute,
} from "./powerpoint-orthogonal-router.mjs";

const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function clone(value) {
  return structuredClone(value);
}

function rect(id, x, y, w, h) {
  return { id, x, y, w, h };
}

function assertThrows(label, code, fn) {
  try {
    fn();
    failures.push(`${label}: expected ${code} to be thrown`);
  } catch (error) {
    if (!(error instanceof RouterError)) {
      failures.push(`${label}: expected a RouterError, got ${error}`);
      return;
    }
    check(error.code === code, `${label}: expected ${code}, got ${error.code}: ${error.message}`);
    check(typeof error.path === "string" && error.path.length > 0, `${label}: error requires a path`);
  }
}

function routeInput(source, target, overrides = {}) {
  return {
    sourceRect: source,
    targetRect: target,
    existingRoutes: [],
    obstacles: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// nodeAnchors
// ---------------------------------------------------------------------------

{
  const r = rect("n1", 10, 20, 100, 40);
  const anchors = nodeAnchors(r);
  check(anchors.length === 4, "nodeAnchors returns exactly four anchors");
  check(
    anchors.map((anchor) => anchor.side).join(",") === "left,right,top,bottom",
    "nodeAnchors returns sides in left, right, top, bottom order",
  );
  const bySide = Object.fromEntries(anchors.map((anchor) => [anchor.side, anchor]));
  check(bySide.left.x === 10 && bySide.left.y === 40, "left anchor is the left-edge midpoint");
  check(bySide.right.x === 110 && bySide.right.y === 40, "right anchor is the right-edge midpoint");
  check(bySide.top.x === 60 && bySide.top.y === 20, "top anchor is the top-edge midpoint");
  check(bySide.bottom.x === 60 && bySide.bottom.y === 60, "bottom anchor is the bottom-edge midpoint");
  for (const anchor of anchors) {
    check(Object.keys(anchor).sort().join(",") === "side,x,y", "anchor has exact keys side, x, y");
  }
}

{
  const r = rect("frac", 0.1, 0.1, 10.00001, 10.00007);
  const anchors = nodeAnchors(r);
  for (const anchor of anchors) {
    check(Number.isFinite(anchor.x) && Number.isFinite(anchor.y), "rounded anchor coordinates stay finite");
    check(!Object.is(anchor.x, -0) && !Object.is(anchor.y, -0), "anchor coordinates normalize -0 to 0");
  }
}

assertThrows("nodeAnchors missing key", "E_ROUTER_INPUT", () => nodeAnchors({ id: "x", x: 0, y: 0, w: 1 }));
assertThrows("nodeAnchors extra key", "E_ROUTER_INPUT", () =>
  nodeAnchors({ id: "x", x: 0, y: 0, w: 1, h: 1, extra: true }),
);
assertThrows("nodeAnchors nonfinite", "E_ROUTER_NONFINITE", () =>
  nodeAnchors({ id: "x", x: Number.POSITIVE_INFINITY, y: 0, w: 1, h: 1 }),
);
assertThrows("nodeAnchors zero width", "E_ROUTER_BOUNDS", () =>
  nodeAnchors({ id: "x", x: 0, y: 0, w: 0, h: 1 }),
);
assertThrows("nodeAnchors negative height", "E_ROUTER_BOUNDS", () =>
  nodeAnchors({ id: "x", x: 0, y: 0, w: 1, h: -1 }),
);
assertThrows("nodeAnchors non-string id", "E_ROUTER_INPUT", () =>
  nodeAnchors({ id: 5, x: 0, y: 0, w: 1, h: 1 }),
);
assertThrows("nodeAnchors null", "E_ROUTER_INPUT", () => nodeAnchors(null));
assertThrows("nodeAnchors array rect", "E_ROUTER_INPUT", () => nodeAnchors([1, 2, 3]));

// ---------------------------------------------------------------------------
// preferredAnchorPairs preference order
// ---------------------------------------------------------------------------

function preferredPair(source, target) {
  return preferredAnchorPairs(source, target)[0];
}

{
  const source = rect("s", 0, 0, 20, 20);
  const rightTarget = rect("t", 100, 0, 20, 20);
  const leftTarget = rect("t", -100, 0, 20, 20);
  const downTarget = rect("t", 0, 100, 20, 20);
  const upTarget = rect("t", 0, -100, 20, 20);

  check(
    preferredPair(source, rightTarget).sourceSide === "right" &&
      preferredPair(source, rightTarget).targetSide === "left",
    "rightward target prefers right to left",
  );
  check(
    preferredPair(source, leftTarget).sourceSide === "left" &&
      preferredPair(source, leftTarget).targetSide === "right",
    "leftward target prefers left to right",
  );
  check(
    preferredPair(source, downTarget).sourceSide === "bottom" &&
      preferredPair(source, downTarget).targetSide === "top",
    "downward target prefers bottom to top",
  );
  check(
    preferredPair(source, upTarget).sourceSide === "top" &&
      preferredPair(source, upTarget).targetSide === "bottom",
    "upward target prefers top to bottom",
  );

  const diagDownRight = rect("t", 100, 100, 20, 20);
  const diagDownLeft = rect("t", -100, 100, 20, 20);
  const diagUpRight = rect("t", 100, -100, 20, 20);
  const diagUpLeft = rect("t", -100, -100, 20, 20);
  check(
    preferredPair(source, diagDownRight).sourceSide === "right" &&
      preferredPair(source, diagDownRight).targetSide === "left",
    "exact diagonal tie (down-right) resolves horizontal-first as right to left",
  );
  check(
    preferredPair(source, diagUpRight).sourceSide === "right" &&
      preferredPair(source, diagUpRight).targetSide === "left",
    "exact diagonal tie (up-right) resolves horizontal-first as right to left",
  );
  check(
    preferredPair(source, diagDownLeft).sourceSide === "left" &&
      preferredPair(source, diagDownLeft).targetSide === "right",
    "exact diagonal tie (down-left) resolves horizontal-first as left to right",
  );
  check(
    preferredPair(source, diagUpLeft).sourceSide === "left" &&
      preferredPair(source, diagUpLeft).targetSide === "right",
    "exact diagonal tie (up-left) resolves horizontal-first as left to right",
  );

  const samePlace = rect("t", 0, 0, 20, 20);
  check(
    preferredPair(source, samePlace).sourceSide === "right" &&
      preferredPair(source, samePlace).targetSide === "left",
    "coincident centers default to the horizontal-first tie rule",
  );
}

{
  for (const dxSign of [-1, 1]) {
    for (const dySign of [-1, 1]) {
      const source = rect("s", 0, 0, 1, 1);
      const target = rect("t", dxSign * 1.2345, dySign * 1.2345, 1, 1);
      const pair = preferredPair(source, target);
      check(
        pair.sourceSide === (dxSign < 0 ? "left" : "right") &&
          pair.targetSide === (dxSign < 0 ? "right" : "left"),
        `symmetric quantized diagonal (${dxSign}, ${dySign}) resolves horizontal-first`,
      );
    }
  }
}

{
  const source = rect("s", 0, 0, 20, 20);
  const target = rect("t", -61.308, -61.308, 20, 20);
  const pair = preferredPair(source, target);
  check(
    pair.sourceSide === "left" && pair.targetSide === "right",
    "quantized negative diagonal (-61.308, -61.308) resolves horizontal-first",
  );
}

{
  const source = rect("s", 0, 0, 20, 20);
  const target = rect("t", 100, 40, 20, 20);
  const pairs = preferredAnchorPairs(source, target);
  check(pairs.length === 16, "preferredAnchorPairs returns all 16 side combinations");
  const seen = new Set(pairs.map((pair) => `${pair.sourceSide}>${pair.targetSide}`));
  check(seen.size === 16, "preferredAnchorPairs returns 16 distinct side pairs");
  check(
    pairs.every((pair, index) => pair.preferenceRank === index),
    "preferenceRank matches array position",
  );
  check(pairs[0].preferenceRank === 0, "first pair carries preferenceRank 0");
  for (const pair of pairs) {
    check(Object.keys(pair).sort().join(",") === "preferenceRank,sourceAnchor,sourceSide,targetAnchor,targetSide", "pair has exact keys");
  }
}

assertThrows("preferredAnchorPairs bad source", "E_ROUTER_BOUNDS", () =>
  preferredAnchorPairs({ id: "s", x: 0, y: 0, w: -1, h: 1 }, rect("t", 10, 10, 5, 5)),
);

// ---------------------------------------------------------------------------
// routeOrthogonalEdge: straight routes
// ---------------------------------------------------------------------------

{
  const source = rect("s", 0, 0, 40, 20);
  const target = rect("t", 140, 0, 40, 20);
  const route = routeOrthogonalEdge(routeInput(source, target));
  check(route.fromSide === "right" && route.toSide === "left", "aligned horizontal targets connect right to left");
  check(route.points.length === 2 && route.segments.length === 1, "straight route has two points and one segment");
  check(route.points[0].x === 40 && route.points[0].y === 10, "straight route starts at the source right anchor");
  check(route.points[1].x === 140 && route.points[1].y === 10, "straight route ends at the target left anchor");
  check(route.cost === 100, "straight horizontal cost equals the Manhattan distance");
  check(Object.keys(route).sort().join(",") === "cost,fromSide,points,segments,sourceId,targetId,toSide", "route has exact keys");
  for (const segment of route.segments) {
    check(Object.keys(segment).sort().join(",") === "index,x1,x2,y1,y2", "segment has exact keys");
  }
}

{
  const source = rect("s", 0, 0, 40, 20);
  const target = rect("t", 0, 100, 40, 20);
  const route = routeOrthogonalEdge(routeInput(source, target));
  check(route.fromSide === "bottom" && route.toSide === "top", "aligned vertical targets connect bottom to top");
  check(route.points.length === 2 && route.segments.length === 1, "straight vertical route has one segment");
  check(route.cost === 80, "straight vertical cost equals the Manhattan distance");
}

// ---------------------------------------------------------------------------
// routeOrthogonalEdge: one-bend quadrants
// ---------------------------------------------------------------------------

function normalFor(side) {
  return { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } }[side];
}
function sign(value) {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}
function dirOf(a, b) {
  return { x: sign(b.x - a.x), y: sign(b.y - a.y) };
}
function vecEq(a, b) {
  return a.x === b.x && a.y === b.y;
}
function comparePts(a, b) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const pa = a[index];
    const pb = b[index];
    if (!pa) return -1;
    if (!pb) return 1;
    if (pa.x !== pb.x) return pa.x - pb.x;
    if (pa.y !== pb.y) return pa.y - pb.y;
  }
  return 0;
}

const REF_THOUSAND = 1000;
const REF_MAX_COORDINATE = Number.MAX_SAFE_INTEGER / REF_THOUSAND;

function referenceRound3(value) {
  if (!Number.isFinite(value)) throw new Error("reference input must be finite");
  if (Math.abs(value) > REF_MAX_COORDINATE) return Object.is(value, -0) ? 0 : value;
  const rounded = Math.round(value * REF_THOUSAND) / REF_THOUSAND;
  if (!Number.isFinite(rounded)) throw new Error("reference rounded value must be finite");
  return Object.is(rounded, -0) ? 0 : rounded;
}

function referenceUnits(value) {
  const rounded = referenceRound3(value);
  if (Math.abs(rounded) > REF_MAX_COORDINATE) {
    throw new Error("reference value exceeds safe integer thousandths");
  }
  const units = Math.round(rounded * REF_THOUSAND);
  if (!Number.isSafeInteger(units)) throw new Error("reference thousandths must be safe");
  return units;
}

function referenceAnchors(rectangle) {
  const centerX = referenceRound3(rectangle.x + rectangle.w / 2);
  const centerY = referenceRound3(rectangle.y + rectangle.h / 2);
  return {
    left: { x: referenceRound3(rectangle.x), y: centerY },
    right: { x: referenceRound3(rectangle.x + rectangle.w), y: centerY },
    top: { x: centerX, y: referenceRound3(rectangle.y) },
    bottom: { x: centerX, y: referenceRound3(rectangle.y + rectangle.h) },
  };
}

function referencePairs(source, target) {
  const sourceAnchors = referenceAnchors(source);
  const targetAnchors = referenceAnchors(target);
  const dx = target.x + target.w / 2 - (source.x + source.w / 2);
  const dy = target.y + target.h / 2 - (source.y + source.h / 2);
  const dxMagnitude = referenceUnits(Math.abs(dx));
  const dyMagnitude = referenceUnits(Math.abs(dy));
  const preferred =
    dxMagnitude >= dyMagnitude
      ? dx >= 0
        ? { sourceSide: "right", targetSide: "left" }
        : { sourceSide: "left", targetSide: "right" }
      : dy >= 0
        ? { sourceSide: "bottom", targetSide: "top" }
        : { sourceSide: "top", targetSide: "bottom" };
  const clockwise = ["top", "right", "bottom", "left"];
  const pairs = [];
  for (const sourceSide of clockwise) {
    for (const targetSide of clockwise) pairs.push({ sourceSide, targetSide });
  }
  const preferredIndex = pairs.findIndex(
    (pair) =>
      pair.sourceSide === preferred.sourceSide &&
      pair.targetSide === preferred.targetSide,
  );
  pairs.unshift(...pairs.splice(preferredIndex, 1));
  return pairs.map((pair, preferenceRank) => ({
    ...pair,
    preferenceRank,
    sourceAnchor: sourceAnchors[pair.sourceSide],
    targetAnchor: targetAnchors[pair.targetSide],
  }));
}

function collapseReferencePoints(points) {
  return points.filter(
    (point, index) =>
      index === 0 ||
      point.x !== points[index - 1].x ||
      point.y !== points[index - 1].y,
  );
}

function referenceCandidates(pair, withOffsets) {
  const s = {
    x: referenceUnits(pair.sourceAnchor.x),
    y: referenceUnits(pair.sourceAnchor.y),
  };
  const t = {
    x: referenceUnits(pair.targetAnchor.x),
    y: referenceUnits(pair.targetAnchor.y),
  };
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const exitNormal = normalFor(pair.sourceSide);
  const targetNormal = normalFor(pair.targetSide);
  const entryNormal = { x: -targetNormal.x, y: -targetNormal.y };
  const candidates = [];
  if (!withOffsets && dx === 0 && dy === 0) return candidates;
  if (!withOffsets && (dx === 0 || dy === 0)) {
    if (vecEq(dirOf(s, t), exitNormal) && vecEq(dirOf(s, t), entryNormal)) {
      candidates.push([s, t]);
    }
    return candidates;
  }
  if (!withOffsets) {
    for (const bend of [{ x: t.x, y: s.y }, { x: s.x, y: t.y }]) {
      if (
        vecEq(dirOf(s, bend), exitNormal) &&
        vecEq(dirOf(bend, t), entryNormal)
      ) {
        candidates.push([s, bend, t]);
      }
    }
    return candidates;
  }
  const egress = { x: s.x + exitNormal.x, y: s.y + exitNormal.y };
  const ingress = { x: t.x + targetNormal.x, y: t.y + targetNormal.y };
  for (const middle of [
    { x: ingress.x, y: egress.y },
    { x: egress.x, y: ingress.y },
  ]) {
    const points = collapseReferencePoints([s, egress, middle, ingress, t]);
    if (
      vecEq(dirOf(points[0], points[1]), exitNormal) &&
      vecEq(dirOf(points.at(-2), points.at(-1)), entryNormal)
    ) {
      candidates.push(points);
    }
  }
  return candidates;
}

// Independent reference implementation used to cross-check the module's
// optimal-route selection without reusing its internal code paths.
function referenceRoute(source, target) {
  const pairs = referencePairs(source, target);
  let best = null;
  for (const withOffsets of [false, true]) {
    for (const pair of pairs) {
      for (const points of referenceCandidates(pair, withOffsets)) {
        const bendCount = points.length - 2;
        let manhattan = 0;
        for (let index = 1; index < points.length; index += 1) {
          manhattan += Math.abs(points[index].x - points[index - 1].x);
          manhattan += Math.abs(points[index].y - points[index - 1].y);
        }
        const costUnits =
          manhattan +
          bendCount * 18 * REF_THOUSAND +
          pair.preferenceRank * 20 * REF_THOUSAND;
        if (
          !best ||
          costUnits < best.costUnits ||
          (costUnits === best.costUnits && comparePts(points, best.points) < 0)
        ) {
          best = { pair, points, costUnits };
        }
      }
    }
    if (best) break;
  }
  if (!best) return null;
  return {
    pair: best.pair,
    points: best.points.map((point) => ({
      x: point.x / REF_THOUSAND,
      y: point.y / REF_THOUSAND,
    })),
    cost: best.costUnits / REF_THOUSAND,
  };
}

function checkReferenceMatch(label, source, target) {
  const reference = referenceRoute(source, target);
  if (!reference) {
    assertThrows(label, "E_ROUTER_UNSUPPORTED", () => routeOrthogonalEdge(routeInput(source, target)));
    return;
  }
  const route = routeOrthogonalEdge(routeInput(source, target));
  check(route.fromSide === reference.pair.sourceSide, `${label}: fromSide matches the reference optimum`);
  check(route.toSide === reference.pair.targetSide, `${label}: toSide matches the reference optimum`);
  check(route.cost === reference.cost, `${label}: cost matches the reference optimum`);
  check(
    route.points.length === reference.points.length &&
      route.points.every((point, index) => point.x === reference.points[index].x && point.y === reference.points[index].y),
    `${label}: points match the reference optimum`,
  );
  const validated = validateOrthogonalRoute(route, { sourceRect: source, targetRect: target });
  check(validated.cost === route.cost, `${label}: validated route matches the computed route`);
}

checkReferenceMatch("lower-right quadrant", rect("s", 0, 0, 40, 20), rect("t", 200, 150, 40, 20));
checkReferenceMatch("lower-left quadrant", rect("s", 200, 0, 40, 20), rect("t", 0, 150, 40, 20));
checkReferenceMatch("upper-right quadrant", rect("s", 0, 150, 40, 20), rect("t", 200, 0, 40, 20));
checkReferenceMatch("upper-left quadrant", rect("s", 200, 150, 40, 20), rect("t", 0, 0, 40, 20));

{
  // Lower-right quadrant: target is below and to the right of source, so the
  // chosen anchors must physically face into that quadrant (never approach
  // from the far side of either rect).
  const source = rect("s", 0, 0, 40, 20);
  const target = rect("t", 200, 150, 40, 20);
  const route = routeOrthogonalEdge(routeInput(source, target));
  check(["right", "bottom"].includes(route.fromSide), "lower-right route exits toward the target quadrant");
  check(["left", "top"].includes(route.toSide), "lower-right route enters from the source-facing side");
  check(route.points.length === 3 && route.segments.length === 2, "quadrant route bends exactly once");
}

// ---------------------------------------------------------------------------
// choose shortest anchor/bend, and lexicographic tie-break
// ---------------------------------------------------------------------------

{
  // A square source and target placed on the exact diagonal give two
  // equal-Manhattan bend candidates (HV and VH) through the dominant
  // preferred pair's opposite anchors, which are never valid together, so the
  // module must fall back past several ranks; verify it still finds the
  // reference optimum and prefers the lexicographically smaller point path
  // on any true cost tie.
  const source = rect("s", 0, 0, 40, 40);
  const target = rect("t", 140, 140, 40, 40);
  const reference = referenceRoute(source, target);
  const route = routeOrthogonalEdge(routeInput(source, target));
  check(reference.cost === route.cost, "diagonal square placement matches the reference minimum cost");
  check(
    route.points.every((point, index) => point.x === reference.points[index].x && point.y === reference.points[index].y),
    "diagonal square placement matches the reference winning path",
  );
}

{
  const source = rect("s", 0, 0, 40, 40);
  const target = rect("t", 407.786, 407.786, 40, 40);
  const reference = referenceRoute(source, target);
  const route = routeOrthogonalEdge(routeInput(source, target));
  check(reference.cost === 893.572, "reference equal-candidate regression cost is exactly 893.572");
  check(route.cost === 893.572, "router exposes the selected integer-thousandth cost as 893.572");
  check(
    JSON.stringify(route.points) === JSON.stringify(reference.points),
    "893.572 exact-cost tie uses the reference lexicographic point sequence",
  );
}

function mulberry32(seed) {
  let state = seed;
  return function next() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

{
  const random = mulberry32(20260901);
  const iterations = 400;
  let checkedRoutes = 0;
  for (let i = 0; i < iterations; i += 1) {
    const sourceRect = rect(
      "fuzz-source",
      Math.round(random() * 400 - 200),
      Math.round(random() * 400 - 200),
      10 + Math.round(random() * 90),
      10 + Math.round(random() * 90),
    );
    const targetRect = rect(
      "fuzz-target",
      Math.round(random() * 400 - 200),
      Math.round(random() * 400 - 200),
      10 + Math.round(random() * 90),
      10 + Math.round(random() * 90),
    );
    const reference = referenceRoute(sourceRect, targetRect);
    check(reference !== null, `fuzz ${i}: independent reference finds a route`);
    if (!reference) continue;
    const before = clone(routeInput(sourceRect, targetRect));
    const route = routeOrthogonalEdge(routeInput(sourceRect, targetRect));
    checkedRoutes += 1;
    check(route.cost === reference.cost, `fuzz ${i}: cost matches the reference optimum`);
    check(
      route.points.length === reference.points.length &&
        route.points.every(
          (point, index) => point.x === reference.points[index].x && point.y === reference.points[index].y,
        ),
      `fuzz ${i}: points match the reference optimum`,
    );
    const validated = validateOrthogonalRoute(route, {
      sourceRect,
      targetRect,
      stage: { x: -1000, y: -1000, w: 2000, h: 2000 },
    });
    check(validated.sourceId === route.sourceId, `fuzz ${i}: validated route round-trips`);
    check(
      JSON.stringify(sourceRect) === JSON.stringify(before.sourceRect) &&
        JSON.stringify(targetRect) === JSON.stringify(before.targetRect),
      `fuzz ${i}: routing must not mutate input rects`,
    );
  }
  check(checkedRoutes === iterations, "fuzz sweep cross-checks all 400 seeded cases");
}

// ---------------------------------------------------------------------------
// Decimals, rounding, and -0 normalization
// ---------------------------------------------------------------------------

{
  const source = rect("s", 0, 0, 33.3333, 10);
  const target = rect("t", -100, 0, 20, 10);
  const route = routeOrthogonalEdge(routeInput(source, target));
  for (const point of route.points) {
    check(Number(point.x.toFixed(3)) === point.x, `rounded point x has at most 3 decimals: ${point.x}`);
    check(Number(point.y.toFixed(3)) === point.y, `rounded point y has at most 3 decimals: ${point.y}`);
    check(!Object.is(point.x, -0) && !Object.is(point.y, -0), "route points normalize -0 to 0");
  }
}

{
  for (const x of [1e306, Number.MAX_VALUE]) {
    const anchors = nodeAnchors(rect(`huge-${x}`, x, 0, 1, 1));
    check(
      anchors.every((anchor) => Number.isFinite(anchor.x) && Number.isFinite(anchor.y)),
      `overflow-safe anchor quantization remains finite for x=${x}`,
    );
  }
}

assertThrows("unsafe integer-thousandth route coordinates fail closed", "E_ROUTER_NONFINITE", () =>
  routeOrthogonalEdge(
    routeInput(rect("s", 1e13, 0, 20, 20), rect("t", 1e13 + 100, 0, 20, 20)),
  ),
);
assertThrows("integer-thousandth costs that collapse as numbers fail closed", "E_ROUTER_NONFINITE", () =>
  routeOrthogonalEdge(
    routeInput(
      rect("s", 0.001, 0, 0.002, 1),
      rect("t", Number.MAX_SAFE_INTEGER / 1000 - 1, 0, 0.002, 1),
    ),
  ),
);
assertThrows("overflowing anchor arithmetic is deterministic", "E_ROUTER_NONFINITE", () =>
  nodeAnchors(rect("overflow", Number.MAX_VALUE, 0, Number.MAX_VALUE, 1)),
);

{
  const edgeX = Number.MAX_SAFE_INTEGER / 1000 - 1;
  for (const x of [edgeX, edgeX - 0.002, edgeX - 0.004]) {
    const sourceRect = rect("edge-source", x, 0, 0.002, 1);
    const targetRect = rect("edge-target", x, 0, 0.002, 1);
    const route = routeOrthogonalEdge(routeInput(sourceRect, targetRect));
    check(
      route.segments.every(
        (segment) => segment.x1 !== segment.x2 || segment.y1 !== segment.y2,
      ),
      `representable egress near ${x} emits no zero-length segments`,
    );
    check(
      route.points[0].x !== route.points[1].x || route.points[0].y !== route.points[1].y,
      `representable egress near ${x} remains distinct after number conversion`,
    );
    check(
      stableRouteJson(route) ===
        stableRouteJson(routeOrthogonalEdge(routeInput(sourceRect, targetRect))),
      `representable egress near ${x} is deterministic`,
    );
    validateOrthogonalRoute(route, { sourceRect, targetRect });
  }
}

{
  const sourceRect = rect("tiny-source", 0, 0, 0.0001, 0.0001);
  const targetRect = rect("tiny-target", 0.0002, 0, 0.0001, 0.0001);
  const route = routeOrthogonalEdge(routeInput(sourceRect, targetRect));
  check(route.points.length >= 4, "quantized coincident anchors use offset fallback");
  check(
    route.segments.every(
      (segment) => segment.x1 !== segment.x2 || segment.y1 !== segment.y2,
    ),
    "quantized coincident anchors emit no zero-length segments",
  );
  check(
    vecEq(dirOf(route.points[0], route.points[1]), normalFor(route.fromSide)),
    "quantized coincident route exits on the outward source normal",
  );
  check(
    vecEq(
      dirOf(route.points.at(-2), route.points.at(-1)),
      { x: -normalFor(route.toSide).x, y: -normalFor(route.toSide).y },
    ),
    "quantized coincident route approaches on the inward target normal",
  );
  validateOrthogonalRoute(route, { sourceRect, targetRect });
}

{
  const sourceRect = rect("overflow-loser-source", -400, -400, 400, 1);
  const targetRect = rect(
    "overflow-loser-target",
    Number.MAX_SAFE_INTEGER / 1000 - 320,
    -200,
    0.002,
    1,
  );
  const route = routeOrthogonalEdge(routeInput(sourceRect, targetRect));
  check(
    route.fromSide === "right" && route.toSide === "top",
    "cost-overflowing losing candidate does not abort the safe right-to-top winner",
  );
  check(Number.isSafeInteger(route.cost * 1000), "selected winner exposes a safe numeric cost");
  check(
    route.segments.every(
      (segment) => segment.x1 !== segment.x2 || segment.y1 !== segment.y2,
    ),
    "safe winner before an overflowing candidate emits no zero-length segments",
  );
  check(
    stableRouteJson(route) ===
      stableRouteJson(routeOrthogonalEdge(routeInput(sourceRect, targetRect))),
    "safe winner before an overflowing candidate is deterministic",
  );
  validateOrthogonalRoute(route, { sourceRect, targetRect });
}

// ---------------------------------------------------------------------------
// Determinism and stable JSON
// ---------------------------------------------------------------------------

{
  const source = rect("s", 0, 0, 40, 20);
  const target = rect("t", 140, 0, 40, 20);
  const routeA = routeOrthogonalEdge(routeInput(source, target));
  const routeB = routeOrthogonalEdge(routeInput(source, target));
  check(stableRouteJson(routeA) === stableRouteJson(routeB), "identical inputs serialize to identical bytes");

  const reordered = {
    cost: routeA.cost,
    toSide: routeA.toSide,
    targetId: routeA.targetId,
    fromSide: routeA.fromSide,
    sourceId: routeA.sourceId,
    segments: routeA.segments,
    points: routeA.points,
  };
  check(
    stableRouteJson(routeA) === stableRouteJson(reordered),
    "stable JSON is independent of property insertion order",
  );
  check(
    stableRouteJson(routeA) === JSON.stringify(JSON.parse(stableRouteJson(routeA))),
    "stable JSON is valid, re-parseable JSON",
  );
}

// ---------------------------------------------------------------------------
// Strict detached plain-data input rejection
// ---------------------------------------------------------------------------

assertThrows("snapshotGeometry rejects symbol keys", "E_ROUTER_INPUT", () => {
  const value = { id: "x" };
  value[Symbol("hidden")] = 1;
  snapshotGeometry(value);
});
assertThrows("snapshotGeometry rejects non-enumerable properties", "E_ROUTER_INPUT", () => {
  const value = {};
  Object.defineProperty(value, "id", { value: "x", enumerable: false, writable: true, configurable: true });
  snapshotGeometry(value);
});
assertThrows("snapshotGeometry rejects accessors", "E_ROUTER_INPUT", () => {
  const value = {};
  Object.defineProperty(value, "id", { enumerable: true, configurable: true, get: () => "x" });
  snapshotGeometry(value);
});
assertThrows("snapshotGeometry rejects non-writable properties", "E_ROUTER_INPUT", () => {
  const value = {};
  Object.defineProperty(value, "id", { value: "x", enumerable: true, writable: false, configurable: true });
  snapshotGeometry(value);
});
assertThrows("snapshotGeometry rejects custom object prototypes", "E_ROUTER_INPUT", () => {
  snapshotGeometry(Object.create({ id: "x" }));
});
assertThrows("snapshotGeometry rejects custom array prototypes", "E_ROUTER_INPUT", () => {
  const value = [1, 2, 3];
  Object.setPrototypeOf(value, Object.create(Array.prototype));
  snapshotGeometry(value);
});
assertThrows("snapshotGeometry rejects sparse arrays", "E_ROUTER_INPUT", () => {
  const value = [1, 2, 3];
  delete value[1];
  snapshotGeometry(value);
});
assertThrows("snapshotGeometry rejects non-finite numbers", "E_ROUTER_NONFINITE", () => {
  snapshotGeometry({ id: Number.NaN });
});
assertThrows("snapshotGeometry rejects null values", "E_ROUTER_INPUT", () => {
  snapshotGeometry({ id: null });
});
assertThrows("snapshotGeometry wraps ownKeys proxy errors", "E_ROUTER_INPUT", () => {
  snapshotGeometry(new Proxy({}, { ownKeys: () => { throw new Error("ownKeys leak"); } }));
});
assertThrows("snapshotGeometry normalizes proxy-thrown RouterError", "E_ROUTER_INPUT", () => {
  snapshotGeometry(
    new Proxy(
      {},
      { ownKeys: () => { throw new RouterError("E_ROUTER_NONFINITE", "$.spoof", "spoof"); } },
    ),
  );
});
assertThrows("snapshotGeometry wraps getPrototypeOf proxy errors", "E_ROUTER_INPUT", () => {
  snapshotGeometry(new Proxy({}, { getPrototypeOf: () => { throw new Error("prototype leak"); } }));
});
assertThrows("snapshotGeometry wraps descriptor proxy errors", "E_ROUTER_INPUT", () => {
  snapshotGeometry(
    new Proxy(
      { value: 1 },
      { getOwnPropertyDescriptor: () => { throw new Error("descriptor leak"); } },
    ),
  );
});
assertThrows("snapshotGeometry wraps descriptor value access errors", "E_ROUTER_INPUT", () => {
  snapshotGeometry(
    new Proxy(
      { value: 1 },
      {
        getOwnPropertyDescriptor() {
          return new Proxy(
            { value: 1, writable: true, enumerable: true, configurable: true },
            { get: () => { throw new Error("value leak"); } },
          );
        },
      },
    ),
  );
});
assertThrows("snapshotGeometry rejects self cycles", "E_ROUTER_INPUT", () => {
  const value = {};
  value.self = value;
  snapshotGeometry(value);
});
assertThrows("snapshotGeometry rejects mutual cycles", "E_ROUTER_INPUT", () => {
  const left = {};
  const right = { left };
  left.right = right;
  snapshotGeometry(left);
});

{
  const source = rect("s", 0, 0, 40, 20);
  const target = rect("t", 140, 0, 40, 20);
  let descriptorReads = 0;
  const proxied = new Proxy(target, {
    getOwnPropertyDescriptor(actualTarget, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(actualTarget, key);
      if (key !== "x") return descriptor;
      descriptorReads += 1;
      return { ...descriptor, value: descriptorReads === 1 ? descriptor.value : -999 };
    },
  });
  const route = routeOrthogonalEdge(routeInput(source, proxied));
  check(descriptorReads === 1, "proxy descriptors are captured exactly once during snapshotting");
  check(route.points[1].x === 140, "route uses the detached snapshot, not later proxy mutations");
}

{
  const value = { list: [1, 2, 3] };
  let lengthReads = 0;
  value.list = new Proxy(value.list, {
    get(actualTarget, key, receiver) {
      if (key === "length") lengthReads += 1;
      return Reflect.get(actualTarget, key, receiver);
    },
  });
  snapshotGeometry(value);
  check(lengthReads === 0, "array snapshots use the captured length descriptor without get traps");
}

// ---------------------------------------------------------------------------
// routeOrthogonalEdge: schema, self-edge, and obstacle rejection
// ---------------------------------------------------------------------------

assertThrows("routeOrthogonalEdge missing key", "E_ROUTER_INPUT", () =>
  routeOrthogonalEdge({ sourceRect: rect("a", 0, 0, 10, 10), targetRect: rect("b", 20, 0, 10, 10), existingRoutes: [] }),
);
assertThrows("routeOrthogonalEdge extra key", "E_ROUTER_INPUT", () =>
  routeOrthogonalEdge(routeInput(rect("a", 0, 0, 10, 10), rect("b", 20, 0, 10, 10), { extra: true })),
);
assertThrows("routeOrthogonalEdge mismatched self rect", "E_ROUTER_INPUT", () => {
  const a = rect("same", 0, 0, 10, 10);
  const b = rect("same", 20, 0, 10, 10);
  routeOrthogonalEdge(routeInput(a, b));
});
assertThrows("routeOrthogonalEdge malformed existing route", "E_ROUTER_INPUT", () =>
  routeOrthogonalEdge(
    routeInput(rect("a", 0, 0, 10, 10), rect("b", 20, 0, 10, 10), {
      existingRoutes: [{ sourceId: "x", targetId: "y" }],
    }),
  ),
);
assertThrows("routeOrthogonalEdge non-array existingRoutes", "E_ROUTER_INPUT", () =>
  routeOrthogonalEdge(
    routeInput(rect("a", 0, 0, 10, 10), rect("b", 20, 0, 10, 10), { existingRoutes: "none" }),
  ),
);

// ---------------------------------------------------------------------------
// validateOrthogonalRoute: mutations must be rejected deterministically
// ---------------------------------------------------------------------------

function baseRouteAndContext() {
  const sourceRect = rect("a", 0, 0, 40, 20);
  const targetRect = rect("b", 140, 0, 40, 20);
  const route = routeOrthogonalEdge(routeInput(sourceRect, targetRect));
  return { route, context: { sourceRect, targetRect } };
}

{
  const { route, context } = baseRouteAndContext();
  const valid = validateOrthogonalRoute(route, context);
  check(valid.sourceId === route.sourceId, "a well-formed route validates successfully");
}

function assertRouteThrows(label, code, mutate) {
  const { route, context } = baseRouteAndContext();
  const mutated = clone(route);
  mutate(mutated);
  assertThrows(label, code, () => validateOrthogonalRoute(mutated, context));
}

assertRouteThrows("missing route key", "E_ROUTER_INPUT", (route) => {
  delete route.cost;
});
assertRouteThrows("extra route key", "E_ROUTER_INPUT", (route) => {
  route.extra = true;
});
assertRouteThrows("diagonal segment", "E_WORKFLOW_ROUTE", (route) => {
  route.segments[0].y2 = route.segments[0].y1 + 5;
});
assertRouteThrows("zero-length segment", "E_WORKFLOW_ROUTE", (route) => {
  route.segments[0].x2 = route.segments[0].x1;
  route.segments[0].y2 = route.segments[0].y1;
});
assertRouteThrows("discontinuous segments", "E_WORKFLOW_ROUTE", (route) => {
  route.points[1].x += 10;
});
assertRouteThrows("wrong endpoint anchor", "E_WORKFLOW_ROUTE", (route) => {
  route.points[route.points.length - 1].x += 5;
  route.segments[route.segments.length - 1].x2 += 5;
});
assertRouteThrows("wrong declared side", "E_WORKFLOW_ROUTE", (route) => {
  route.toSide = "bottom";
});
assertRouteThrows("bad cost value", "E_WORKFLOW_ROUTE", (route) => {
  route.cost = -1;
});
assertRouteThrows("nonfinite cost", "E_ROUTER_NONFINITE", (route) => {
  route.cost = Number.NaN;
});
assertRouteThrows("bad segment index", "E_WORKFLOW_ROUTE", (route) => {
  route.segments[0].index = 5;
});
assertRouteThrows("mismatched sourceId", "E_WORKFLOW_ROUTE", (route) => {
  route.sourceId = "not-a";
});

{
  const sourceRect = rect("a", 100, 0, 40, 20);
  const targetRect = rect("b", 0, 0, 40, 20);
  const route = routeOrthogonalEdge(routeInput(sourceRect, targetRect));
  route.points.splice(1, 0, { x: 120, y: 10 });
  route.segments = [
    { x1: 100, y1: 10, x2: 120, y2: 10, index: 0 },
    { x1: 120, y1: 10, x2: 40, y2: 10, index: 1 },
  ];
  assertThrows("source-left route cannot travel right through source", "E_WORKFLOW_ROUTE", () =>
    validateOrthogonalRoute(route, { sourceRect, targetRect }),
  );
}

{
  const sourceRect = rect("same-place-source", 0, 0, 40, 20);
  const targetRect = rect("same-place-target", 0, 0, 40, 20);
  const route = routeOrthogonalEdge(routeInput(sourceRect, targetRect));
  check(route.points.length >= 4, "coincident geometry receives deterministic egress and ingress points");
  check(
    vecEq(dirOf(route.points[0], route.points[1]), normalFor(route.fromSide)),
    "generated fallback route exits on the outward source normal",
  );
  check(
    vecEq(
      dirOf(route.points.at(-2), route.points.at(-1)),
      { x: -normalFor(route.toSide).x, y: -normalFor(route.toSide).y },
    ),
    "generated fallback route approaches on the inward target normal",
  );
  validateOrthogonalRoute(route, { sourceRect, targetRect });
}

{
  const { route, context } = baseRouteAndContext();
  const outOfBounds = { ...context, stage: { x: 0, y: 0, w: 20, h: 20 } };
  assertThrows("route outside stage bounds", "E_ROUTER_BOUNDS", () =>
    validateOrthogonalRoute(route, outOfBounds),
  );
  const generousStage = { ...context, stage: { x: -50, y: -50, w: 500, h: 500 } };
  const validated = validateOrthogonalRoute(route, generousStage);
  check(validated.cost === route.cost, "route within a generous stage still validates");
}

{
  const sourceRect = rect("stage-source", 0.7, 0.2, 0.05, 0.1);
  const boundaryTarget = rect("stage-target", 0.8, 0.2, 0.05, 0.1);
  const stage = { x: 0.7, y: 0, w: 0.1, h: 1 };
  const boundaryRoute = routeOrthogonalEdge(routeInput(sourceRect, boundaryTarget));
  check(
    boundaryRoute.points.some((point) => point.x === 0.8),
    "stage boundary regression includes the quantized x=0.8 endpoint",
  );
  validateOrthogonalRoute(boundaryRoute, { sourceRect, targetRect: boundaryTarget, stage });

  const outsideTarget = rect("stage-target", 0.801, 0.2, 0.05, 0.1);
  const outsideRoute = routeOrthogonalEdge(routeInput(sourceRect, outsideTarget));
  assertThrows("quantized stage rejects x=0.801", "E_ROUTER_BOUNDS", () =>
    validateOrthogonalRoute(outsideRoute, { sourceRect, targetRect: outsideTarget, stage }),
  );

  assertThrows("overflowing stage extent fails closed", "E_ROUTER_NONFINITE", () =>
    validateOrthogonalRoute(boundaryRoute, {
      sourceRect,
      targetRect: boundaryTarget,
      stage: { x: Number.MAX_VALUE, y: 0, w: Number.MAX_VALUE, h: 1 },
    }),
  );
}

assertThrows("validateOrthogonalRoute unknown context key", "E_ROUTER_INPUT", () => {
  const { route, context } = baseRouteAndContext();
  validateOrthogonalRoute(route, { ...context, extra: true });
});

// ---------------------------------------------------------------------------
// stableRouteJson must not mutate its input
// ---------------------------------------------------------------------------

{
  const { route } = baseRouteAndContext();
  const before = JSON.stringify(route);
  stableRouteJson(route);
  check(JSON.stringify(route) === before, "stableRouteJson does not mutate its input");
}

if (failures.length > 0) {
  console.error("PowerPoint orthogonal router tests failed:");
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log("PowerPoint orthogonal router tests passed.");
