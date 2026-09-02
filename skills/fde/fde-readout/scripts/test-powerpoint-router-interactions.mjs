#!/usr/bin/env node

import {
  RouterError,
  routeOrthogonalEdge,
  stableRouteJson,
  validateOrthogonalRoute,
} from "./powerpoint-orthogonal-router.mjs";

const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function rect(id, x, y, w = 20, h = 20) {
  return { id, x, y, w, h };
}

function routeInput(sourceRect, targetRect, obstacles = [], existingRoutes = [], stage) {
  return {
    sourceRect,
    targetRect,
    obstacles,
    existingRoutes,
    ...(stage ? { stage } : {}),
  };
}

function assertThrows(label, code, operation) {
  try {
    operation();
    failures.push(`${label}: expected ${code}`);
  } catch (error) {
    if (!(error instanceof RouterError)) {
      failures.push(`${label}: expected RouterError, got ${error}`);
      return;
    }
    check(error.code === code, `${label}: expected ${code}, got ${error.code}`);
  }
}

function validate(route, sourceRect, targetRect, obstacles, existingRoutes, stage) {
  validateOrthogonalRoute(route, {
    sourceRect,
    targetRect,
    obstacles,
    existingRoutes,
    ...(stage ? { stage } : {}),
  });
}

function orientation(segment) {
  return segment.y1 === segment.y2 ? "h" : "v";
}

function interactions(route, existingRoutes) {
  let crossings = 0;
  let overlapUnits = 0;
  for (const first of route.segments) {
    for (const prior of existingRoutes.flatMap((item) => item.segments)) {
      if (orientation(first) !== orientation(prior)) {
        const horizontal = orientation(first) === "h" ? first : prior;
        const vertical = orientation(first) === "v" ? first : prior;
        const proper =
          vertical.x1 > Math.min(horizontal.x1, horizontal.x2) &&
          vertical.x1 < Math.max(horizontal.x1, horizontal.x2) &&
          horizontal.y1 > Math.min(vertical.y1, vertical.y2) &&
          horizontal.y1 < Math.max(vertical.y1, vertical.y2);
        crossings += proper ? 1 : 0;
      } else if (
        (orientation(first) === "h" && first.y1 === prior.y1) ||
        (orientation(first) === "v" && first.x1 === prior.x1)
      ) {
        const a1 = orientation(first) === "h" ? first.x1 : first.y1;
        const a2 = orientation(first) === "h" ? first.x2 : first.y2;
        const b1 = orientation(prior) === "h" ? prior.x1 : prior.y1;
        const b2 = orientation(prior) === "h" ? prior.x2 : prior.y2;
        overlapUnits += Math.max(
          0,
          Math.min(Math.max(a1, a2), Math.max(b1, b2)) -
            Math.max(Math.min(a1, a2), Math.min(b1, b2)),
        );
      }
    }
  }
  return { crossings, overlapUnits };
}

{
  const stage = { x: 0, y: 0, w: 220, h: 120 };
  const source = rect("source", 20, 50);
  const target = rect("target", 180, 50);
  const direct = routeOrthogonalEdge(routeInput(source, target, [], [], stage));
  const partial = {
    sourceId: "source",
    targetId: "target",
    fromSide: "right",
    toSide: "top",
    points: [
      { x: 40, y: 60 },
      { x: 100, y: 60 },
      { x: 100, y: 40 },
      { x: 190, y: 40 },
      { x: 190, y: 50 },
    ],
    segments: [
      { x1: 40, y1: 60, x2: 100, y2: 60, index: 0 },
      { x1: 100, y1: 60, x2: 100, y2: 40, index: 1 },
      { x1: 100, y1: 40, x2: 190, y2: 40, index: 2 },
      { x1: 190, y1: 40, x2: 190, y2: 50, index: 3 },
    ],
    cost: 0,
  };
  const reversePartial = {
    ...structuredClone(partial),
    sourceId: "target",
    targetId: "source",
    fromSide: "top",
    toSide: "right",
    points: [...partial.points].reverse(),
    segments: [...partial.segments].reverse().map((segment, index) => ({
      x1: segment.x2,
      y1: segment.y2,
      x2: segment.x1,
      y2: segment.y1,
      index,
    })),
  };
  for (const [label, existingRoute, expectedCost] of [
    ["full overlap", direct, 8540],
    ["partial overlap and endpoint touch", partial, 3740],
    ["reverse partial overlap", reversePartial, 3740],
  ]) {
    const candidate = { ...structuredClone(direct), cost: expectedCost };
    try {
      validate(candidate, source, target, [], [existingRoute], stage);
    } catch (error) {
      failures.push(`${label}: exact overlap cost was rejected: ${error.message}`);
    }
  }
}

{
  const stage = { x: 0, y: 0, w: 220, h: 120 };
  const source = rect("source", 20, 50);
  const target = rect("target", 180, 50);
  const blocker = rect("blocker", 95, 40, 20, 40);
  const crossingRoute = {
    sourceId: "blocker",
    targetId: "blocker",
    fromSide: "top",
    toSide: "right",
    points: [
      { x: 105, y: 40 },
      { x: 105, y: 20 },
      { x: 130, y: 20 },
      { x: 130, y: 60 },
      { x: 115, y: 60 },
    ],
    segments: [
      { x1: 105, y1: 40, x2: 105, y2: 20, index: 0 },
      { x1: 105, y1: 20, x2: 130, y2: 20, index: 1 },
      { x1: 130, y1: 20, x2: 130, y2: 60, index: 2 },
      { x1: 130, y1: 60, x2: 115, y2: 60, index: 3 },
    ],
    cost: 154,
  };
  const withoutPrior = routeOrthogonalEdge(routeInput(source, target, [blocker], [], stage));
  const withPrior = routeOrthogonalEdge(
    routeInput(source, target, [blocker], [crossingRoute], stage),
  );
  const splitCrossingRoute = structuredClone(crossingRoute);
  splitCrossingRoute.points.splice(1, 0, { x: 105, y: 34 });
  splitCrossingRoute.segments = splitCrossingRoute.points.slice(1).map((point, index) => ({
    x1: splitCrossingRoute.points[index].x,
    y1: splitCrossingRoute.points[index].y,
    x2: point.x,
    y2: point.y,
    index,
  }));
  const withSplitPrior = routeOrthogonalEdge(
    routeInput(source, target, [blocker], [splitCrossingRoute], stage),
  );
  check(interactions(withoutPrior, [crossingRoute]).crossings > 0, "crossing fixture starts with a proper crossing");
  check(interactions(withPrior, [crossingRoute]).crossings === 0, "crossing penalty selects a noncrossing route");
  check(
    stableRouteJson(withSplitPrior) === stableRouteJson(withPrior),
    "collinear prior segmentation cannot change crossing cost",
  );
  validate(withPrior, source, target, [blocker], [crossingRoute], stage);
}

{
  const stage = { x: 0, y: 0, w: 220, h: 120 };
  const source = rect("source", 20, 50);
  const target = rect("target", 180, 50);
  const first = routeOrthogonalEdge(routeInput(source, target, [], [], stage));
  const second = routeOrthogonalEdge(routeInput(source, target, [], [first], stage));
  const third = routeOrthogonalEdge(routeInput(source, target, [], [first, second], stage));
  check(stableRouteJson(first) !== stableRouteJson(second), "duplicate edge chooses a distinct lane");
  check(stableRouteJson(second) !== stableRouteJson(third), "third duplicate chooses another deterministic lane");
  check(interactions(second, [first]).overlapUnits === 0, "second duplicate avoids full overlap");
  check(interactions(third, [first, second]).overlapUnits === 0, "third duplicate avoids prior overlap");
  const shuffled = routeOrthogonalEdge(routeInput(source, target, [], [second, first], stage));
  check(
    stableRouteJson(shuffled) === stableRouteJson(third),
    "shuffled existing routes produce identical bytes",
  );
  validate(third, source, target, [], [second, first], stage);

  const reverse = routeOrthogonalEdge(routeInput(target, source, [], [first, second, third], stage));
  const reverseAgain = routeOrthogonalEdge(routeInput(target, source, [], [third, first, second], stage));
  check(stableRouteJson(reverse) === stableRouteJson(reverseAgain), "reverse edge routing is deterministic");
}

{
  const stage = { x: 0, y: 0, w: 240, h: 240 };
  const nodes = [
    rect("a", 20, 20),
    rect("b", 200, 20),
    rect("c", 200, 200),
    rect("d", 20, 200),
  ];
  const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const routes = [];
  for (const [sourceId, targetId] of [
    ["a", "b"],
    ["b", "c"],
    ["c", "d"],
    ["d", "a"],
    ["a", "c"],
  ]) {
    const source = byId[sourceId];
    const target = byId[targetId];
    const obstacles = nodes.filter((node) => node.id !== sourceId && node.id !== targetId);
    const route = routeOrthogonalEdge(routeInput(source, target, obstacles, routes, stage));
    validate(route, source, target, obstacles, routes, stage);
    routes.push(route);
  }
  const rerun = [];
  for (const [sourceId, targetId] of [
    ["a", "b"],
    ["b", "c"],
    ["c", "d"],
    ["d", "a"],
    ["a", "c"],
  ]) {
    const source = byId[sourceId];
    const target = byId[targetId];
    const obstacles = nodes.filter((node) => node.id !== sourceId && node.id !== targetId);
    rerun.push(routeOrthogonalEdge(routeInput(source, target, obstacles, rerun, stage)));
  }
  check(
    JSON.stringify(routes.map(stableRouteJson)) === JSON.stringify(rerun.map(stableRouteJson)),
    "cycle sequence is deterministic",
  );
}

{
  const stage = { x: 0, y: 0, w: 220, h: 220 };
  const node = rect("loop", 100, 100);
  const first = routeOrthogonalEdge(routeInput(node, node, [], [], stage));
  const second = routeOrthogonalEdge(routeInput(node, node, [], [first], stage));
  check(first.segments.length >= 5, "self loop has at least five segments");
  check(first.segments.every((segment) => segment.x1 !== segment.x2 || segment.y1 !== segment.y2), "self loop segments are nonzero");
  check(first.fromSide === "right" && first.toSide === "bottom", "unblocked self loop starts on the stable right side");
  check(
    Math.min(...first.points.slice(1, -1).map((point) => Math.max(
      point.x < node.x ? node.x - point.x : point.x > node.x + node.w ? point.x - node.x - node.w : 0,
      point.y < node.y ? node.y - point.y : point.y > node.y + node.h ? point.y - node.y - node.h : 0,
    ))) >= 10,
    "self loop maintains ten-point open-space clearance",
  );
  check(first.fromSide !== second.fromSide, "duplicate self loops choose distinct sides");
  validate(first, node, node, [], [], stage);
  validate(second, node, node, [], [first], stage);

  const sideBlockers = {
    right: [rect("block-bottom", 84, 128, 2, 2), rect("block-left", 94, 78, 2, 2), rect("block-top", 138, 94, 2, 2)],
    bottom: [rect("block-right", 128, 120, 2, 2), rect("block-left", 94, 78, 2, 2), rect("block-top", 138, 94, 2, 2)],
    left: [rect("block-right", 128, 120, 2, 2), rect("block-bottom", 84, 128, 2, 2), rect("block-top", 138, 94, 2, 2)],
    top: [rect("block-right", 128, 120, 2, 2), rect("block-bottom", 84, 128, 2, 2), rect("block-left", 94, 78, 2, 2)],
  };
  const loopStage = { x: 75, y: 75, w: 70, h: 70 };
  for (const [expectedSide, blockers] of Object.entries(sideBlockers)) {
    try {
      const loop = routeOrthogonalEdge(routeInput(node, node, blockers, [], loopStage));
      check(loop.fromSide === expectedSide, `staged blockers select the ${expectedSide} self-loop side`);
      validate(loop, node, node, blockers, [], loopStage);
    } catch (error) {
      failures.push(`${expectedSide} self-loop blocker fixture failed: ${error.message}`);
    }
  }
  assertThrows("all self-loop sides blocked", "E_WORKFLOW_ROUTE", () =>
    routeOrthogonalEdge(
      routeInput(node, node, [
        rect("right-wall", 124, 70, 20, 100),
        rect("bottom-wall", 70, 124, 100, 20),
        rect("left-wall", 76, 70, 20, 100),
        rect("top-wall", 70, 76, 100, 20),
      ], [], stage),
    ),
  );
}

{
  const stage = { x: 0, y: 0, w: 400, h: 340 };
  const nodes = [
    rect("discovery", 20, 20, 80, 40),
    rect("design", 20, 100, 80, 40),
    rect("pilot", 20, 180, 80, 40),
    rect("rollout", 20, 260, 80, 40),
    rect("sponsor", 300, 20, 80, 40),
    rect("owner", 300, 100, 80, 40),
    rect("users", 300, 180, 80, 40),
    rect("handoff", 300, 260, 80, 40),
  ];
  const edges = [
    ["discovery", "sponsor"],
    ["discovery", "owner"],
    ["design", "owner"],
    ["design", "users"],
    ["pilot", "owner"],
    ["pilot", "users"],
    ["pilot", "handoff"],
    ["rollout", "users"],
    ["rollout", "handoff"],
    ["sponsor", "handoff"],
  ];
  const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const routeAll = () => {
    const routes = [];
    for (const [sourceId, targetId] of edges) {
      const source = byId[sourceId];
      const target = byId[targetId];
      const obstacles = nodes.filter((node) => node.id !== sourceId && node.id !== targetId);
      const route = routeOrthogonalEdge(routeInput(source, target, obstacles, routes, stage));
      validate(route, source, target, obstacles, routes, stage);
      routes.push(route);
    }
    return routes;
  };
  const started = performance.now();
  const first = routeAll();
  const second = routeAll();
  const elapsed = performance.now() - started;
  check(
    JSON.stringify(first.map(stableRouteJson)) === JSON.stringify(second.map(stableRouteJson)),
    "dense ten-edge role map is deterministic",
  );
  const totals = first.reduce(
    (sum, route, index) => {
      const stats = interactions(route, first.slice(0, index));
      return {
        crossings: sum.crossings + stats.crossings,
        overlapUnits: sum.overlapUnits + stats.overlapUnits,
      };
    },
    { crossings: 0, overlapUnits: 0 },
  );
  check(totals.crossings <= 20, "dense role map crossings remain bounded");
  check(totals.overlapUnits <= 100, "dense role map overlap remains bounded");
  check(elapsed < 10000, `dense role map completes twice within ten seconds (${elapsed.toFixed(0)}ms)`);
}

{
  const stage = { x: 0, y: 0, w: 220, h: 120 };
  const source = rect("source", 20, 50);
  const target = rect("target", 180, 50);
  const prior = routeOrthogonalEdge(routeInput(source, target, [], [], stage));
  const withId = { ...structuredClone(prior), routeId: "route-1" };
  assertThrows("duplicate route IDs", "E_ROUTER_INPUT", () =>
    routeOrthogonalEdge(routeInput(source, target, [], [withId, structuredClone(withId)], stage)),
  );
  assertThrows("sparse existing routes", "E_ROUTER_INPUT", () => {
    const sparse = new Array(1);
    routeOrthogonalEdge(routeInput(source, target, [], sparse, stage));
  });
  assertThrows("accessor existing route", "E_ROUTER_INPUT", () => {
    const accessor = structuredClone(prior);
    Object.defineProperty(accessor, "cost", { enumerable: true, get: () => prior.cost });
    routeOrthogonalEdge(routeInput(source, target, [], [accessor], stage));
  });
  assertThrows("proxy existing route", "E_ROUTER_INPUT", () =>
    routeOrthogonalEdge(
      routeInput(source, target, [], [new Proxy(prior, { ownKeys: () => { throw new Error("trap"); } })], stage),
    ),
  );
  assertThrows("diagonal existing route", "E_WORKFLOW_ROUTE", () => {
    const diagonal = structuredClone(prior);
    diagonal.points[1].y += 1;
    diagonal.segments[0].y2 += 1;
    routeOrthogonalEdge(routeInput(source, target, [], [diagonal], stage));
  });
  const second = routeOrthogonalEdge(routeInput(source, target, [], [prior], stage));
  assertThrows("mutated interaction cost", "E_WORKFLOW_ROUTE", () => {
    const mutated = structuredClone(second);
    mutated.cost += 1;
    validate(mutated, source, target, [], [prior], stage);
  });
  assertThrows("split interaction candidate", "E_WORKFLOW_ROUTE", () => {
    const split = structuredClone(second);
    const segment = split.segments[0];
    const midpoint = {
      x: (segment.x1 + segment.x2) / 2,
      y: (segment.y1 + segment.y2) / 2,
    };
    split.points.splice(1, 0, midpoint);
    split.segments = split.points.slice(1).map((point, index) => ({
      x1: split.points[index].x,
      y1: split.points[index].y,
      x2: point.x,
      y2: point.y,
      index,
    }));
    validate(split, source, target, [], [prior], stage);
  });
}

{
  const source = rect("overlap-source", 0, 0, 30, 30);
  const target = rect("overlap-target", 20, 10, 30, 30);
  const foundation = routeOrthogonalEdge(routeInput(source, target));
  const reused = routeOrthogonalEdge(routeInput(source, target, [], [foundation]));
  const reusedAgain = routeOrthogonalEdge(routeInput(source, target, [], [foundation]));
  check(
    stableRouteJson(reused) === stableRouteJson(reusedAgain),
    "overlapping-endpoint foundation routes round-trip deterministically",
  );
  validate(reused, source, target, [], [foundation]);
  assertThrows("unrelated obstacle blocks prior foundation route", "E_WORKFLOW_ROUTE", () =>
    routeOrthogonalEdge(
      routeInput(source, target, [rect("new-blocker", 24, 12, 2, 2)], [foundation]),
    ),
  );
}

{
  const source = rect("outer", 0, 0, 100, 100);
  const target = rect("inner", 30, 30, 20, 20);
  const farObstacle = rect("far-obstacle", 180, 180, 10, 10);
  const route = routeOrthogonalEdge(
    routeInput(source, target, [farObstacle]),
  );
  validate(route, source, target, [farObstacle], []);
  check(
    stableRouteJson(route) ===
      stableRouteJson(routeOrthogonalEdge(routeInput(source, target, [farObstacle]))),
    "contained endpoints escape both endpoint halos deterministically",
  );
}

{
  const source = rect("distant-source", 0, 0);
  const target = rect("distant-target", 100, 0);
  const invalid = {
    sourceId: source.id,
    targetId: target.id,
    fromSide: "right",
    toSide: "top",
    points: [
      { x: 20, y: 10 },
      { x: 130, y: 10 },
      { x: 130, y: -10 },
      { x: 110, y: -10 },
      { x: 110, y: 0 },
    ],
    segments: [
      { x1: 20, y1: 10, x2: 130, y2: 10, index: 0 },
      { x1: 130, y1: 10, x2: 130, y2: -10, index: 1 },
      { x1: 130, y1: -10, x2: 110, y2: -10, index: 2 },
      { x1: 110, y1: -10, x2: 110, y2: 0, index: 3 },
    ],
    cost: 214,
  };
  assertThrows("distant target is not a first-leg exemption", "E_WORKFLOW_ROUTE", () =>
    validateOrthogonalRoute(invalid, { sourceRect: source, targetRect: target, obstacles: [] }),
  );
}

{
  const a = rect("a", 0, 0);
  const b = rect("b", 100, 0);
  const c = rect("c", 50, 80);
  const prior = routeOrthogonalEdge(routeInput(a, b, [c]));
  const loop = routeOrthogonalEdge(routeInput(c, c, [a, b], [prior]));
  validate(loop, c, c, [a, b], [prior]);
  check(loop.segments.length >= 5, "self loop accepts prior routes between obstacle nodes");
}

{
  const node = rect("large-loop", 8_000_000_000_000, 100, 20.001, 20.001);
  const loop = routeOrthogonalEdge(routeInput(node, node));
  validate(loop, node, node, [], []);
  check(
    loop.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
    "large self-loop anchors retain finite thousandth precision",
  );
}

{
  const node = rect("outer-lane-loop", 100, 100);
  const blockers = [
    rect("right-lane-0", 128, 118, 2, 2),
    rect("right-lane-1", 138, 128, 2, 2),
    rect("bottom-lane-0", 94, 128, 2, 2),
    rect("bottom-lane-1", 84, 138, 2, 2),
    rect("left-lane-0", 88, 94, 2, 2),
    rect("left-lane-1", 78, 84, 2, 2),
    rect("top-lane-0", 128, 88, 2, 2),
    rect("top-lane-1", 138, 78, 2, 2),
  ];
  const loop = routeOrthogonalEdge(routeInput(node, node, blockers));
  validate(loop, node, node, blockers, []);
  check(
    loop.points.some(
      (point) =>
        point.x <= node.x - 30 ||
        point.x >= node.x + node.w + 30 ||
        point.y <= node.y - 30 ||
        point.y >= node.y + node.h + 30,
    ),
    "unstaged self loops recover through a bounded outer lane",
  );
}

{
  const source = rect("budget-source", 0, 0);
  const target = rect("budget-target", 40, 0);
  const prior = routeOrthogonalEdge(routeInput(source, target));
  const justUnder = Array.from({ length: 4095 }, () => prior);
  const candidate = {
    ...structuredClone(prior),
    cost: prior.cost + 4095 * 20 * 60,
  };
  const underStarted = performance.now();
  validate(candidate, source, target, [], justUnder);
  check(
    performance.now() - underStarted < 5000,
    "just-under-limit existing routes validate within five seconds",
  );

  const overStarted = performance.now();
  assertThrows("existing route count limit", "E_WORKFLOW_ROUTE", () =>
    routeOrthogonalEdge({
      ...routeInput(source, target),
      existingRoutes: Array.from({ length: 4097 }, () => ({})),
    }),
  );
  check(
    performance.now() - overStarted < 2000,
    "over-limit route count rejects before per-route validation",
  );

  const oversizedPoints = Array.from({ length: 4098 }, (_, index) => ({
    x: 20 + index / 1000,
    y: 10,
  }));
  const oversizedRoute = {
    ...structuredClone(prior),
    points: oversizedPoints,
    segments: oversizedPoints.slice(1).map((point, index) => ({
      x1: oversizedPoints[index].x,
      y1: oversizedPoints[index].y,
      x2: point.x,
      y2: point.y,
      index,
    })),
  };
  const oversizedStarted = performance.now();
  assertThrows("per-route segment limit", "E_WORKFLOW_ROUTE", () =>
    routeOrthogonalEdge(routeInput(source, target, [], [oversizedRoute])),
  );
  check(
    performance.now() - oversizedStarted < 2000,
    "oversized single route rejects before geometric validation",
  );
}

if (failures.length > 0) {
  console.error("PowerPoint router interaction tests failed:");
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log("PowerPoint router interaction tests passed.");
