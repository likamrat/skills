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

function rect(id, x, y, w, h) {
  return { id, x, y, w, h };
}

function input(sourceRect, targetRect, obstacles, stage) {
  return {
    sourceRect,
    targetRect,
    existingRoutes: [],
    obstacles,
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

function bendCount(route) {
  return route.points.length - 2;
}

function assertDeterministic(label, routeInput) {
  const first = stableRouteJson(routeOrthogonalEdge(routeInput));
  const second = stableRouteJson(routeOrthogonalEdge(routeInput));
  check(first === second, `${label}: repeated routing must be byte-identical`);
  return JSON.parse(first);
}

{
  const source = rect("source", 0, 40, 20, 20);
  const target = rect("target", 180, 40, 20, 20);
  const blocker = rect("blocker", 80, 20, 40, 60);
  const route = assertDeterministic("single blocker", input(source, target, [blocker]));
  check(bendCount(route) === 2, "single blocker requires exactly two bends");
  check(
    route.points[1].y === 14 && route.points[2].y === 14,
    "equal above/below detours choose the shortest lexicographic boundary path",
  );
  validateOrthogonalRoute(route, { sourceRect: source, targetRect: target, obstacles: [blocker] });
}

{
  const source = rect("source", 0, 20, 20, 20);
  const target = rect("target", 180, 20, 20, 20);
  const obstacles = [
    rect("top-wall", 80, 0, 40, 43),
    rect("bottom-wall", 80, 56, 40, 44),
  ];
  const route = routeOrthogonalEdge(
    input(source, target, obstacles, { x: 0, y: 0, w: 200, h: 100 }),
  );
  check(
    route.points.some((point) => point.y === 49),
    "a one-point stage wall gap remains routable on the exact inflated boundary",
  );
  validateOrthogonalRoute(route, {
    sourceRect: source,
    targetRect: target,
    obstacles,
    stage: { x: 0, y: 0, w: 200, h: 100 },
  });
}

{
  const source = rect("source", 20, 160, 20, 20);
  const target = rect("target", 220, 120, 20, 20);
  const obstacles = [
    rect("first", 160, 40, 40, 80),
    rect("second", 40, 100, 60, 100),
  ];
  const route = routeOrthogonalEdge(
    input(source, target, obstacles, { x: 0, y: 0, w: 260, h: 220 }),
  );
  check(bendCount(route) === 3, "offset blockers force an exact three-bend route");
}

{
  const source = rect("source", 10, 90, 20, 20);
  const target = rect("target", 270, 90, 20, 20);
  const obstacles = [
    rect("first", 80, 0, 30, 130),
    rect("second", 170, 70, 30, 130),
  ];
  const route = routeOrthogonalEdge(
    input(source, target, obstacles, { x: 0, y: 0, w: 300, h: 200 }),
  );
  check(bendCount(route) >= 4, "alternating blockers force four or more bends");
}

{
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
  const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
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
  for (const [from, to] of edges) {
    const obstacles = nodes.filter((node) => node.id !== from && node.id !== to);
    const routeInput = input(
      byId[from],
      byId[to],
      obstacles,
      { x: 0, y: 0, w: 400, h: 340 },
    );
    const route = assertDeterministic(`role map ${from}>${to}`, routeInput);
    validateOrthogonalRoute(route, {
      sourceRect: byId[from],
      targetRect: byId[to],
      obstacles,
      stage: routeInput.stage,
    });
  }
}

{
  const source = rect("source", 0, 40, 20, 20);
  const target = rect("target", 180, 40, 20, 20);
  const obstacles = [
    rect("zeta", 125, 20, 20, 60),
    rect("alpha", 55, 20, 20, 60),
  ];
  const forward = stableRouteJson(routeOrthogonalEdge(input(source, target, obstacles)));
  const reverse = stableRouteJson(
    routeOrthogonalEdge(input(source, target, [...obstacles].reverse())),
  );
  check(forward === reverse, "shuffled obstacle input produces identical route bytes");
}

{
  const route = routeOrthogonalEdge(
    input(
      rect("source", 36, 80, 16, 19),
      rect("target", 143, 93, 13, 8),
      [
        rect("first", 66, 85, 26, 29),
        rect("second", 94, 95, 11, 28),
        rect("third", 108, 32, 32, 44),
      ],
    ),
  );
  check(route.cost === 222.5, "collapsed-prefix tie fixture retains the exact minimum cost");
  check(
    route.points.some((point) => point.y === 82) &&
      !route.points.some((point) => point.y === 85),
    "equal-cost states retain the lexicographically smaller collapsed y=82 path",
  );
}

{
  const source = rect("source", 0, 0, 20, 20);
  const target = rect("target", 0, 0, 20, 20);
  const farObstacle = rect("far", 100, 100, 10, 10);
  const withoutObstacle = routeOrthogonalEdge(input(source, target, []));
  const withObstacle = routeOrthogonalEdge(input(source, target, [farObstacle]));
  check(
    withoutObstacle.sourceId === withObstacle.sourceId &&
      withoutObstacle.targetId === withObstacle.targetId &&
      withoutObstacle.fromSide === withObstacle.fromSide &&
      withoutObstacle.toSide === withObstacle.toSide,
    "coincident distinct-ID endpoints remain routable when a far obstacle enables the grid layer",
  );
  check(
    stableRouteJson(withObstacle) ===
      stableRouteJson(routeOrthogonalEdge(input(source, target, [farObstacle]))),
    "coincident endpoint-halo exemptions remain deterministic",
  );
  validateOrthogonalRoute(withObstacle, {
    sourceRect: source,
    targetRect: target,
    obstacles: [farObstacle],
  });
}

{
  const source = rect("source", 0, 40, 20, 20);
  const target = rect("target", 100, 40, 20, 20);
  const expected = stableRouteJson(routeOrthogonalEdge(input(source, target, [])));
  const started = performance.now();
  for (const count of [100, 200]) {
    const obstacles = Array.from({ length: count }, (_, index) =>
      rect(
        `far-${String(index).padStart(3, "0")}`,
        300 + index * 20,
        200 + (index % 10) * 30,
        10,
        10,
      ),
    );
    const actual = stableRouteJson(
      routeOrthogonalEdge(input(source, target, obstacles)),
    );
    check(
      actual === expected,
      `rank-zero direct route bypasses a ${count}-obstacle candidate grid`,
    );
  }
  check(
    performance.now() - started < 2000,
    "rank-zero direct routing across 100 and 200 far obstacles finishes within two seconds",
  );
}

{
  const source = rect("source", 0, 40, 20, 20);
  const target = rect("target", 25, 40, 20, 20);
  const obstacle = rect("unrelated", 80, 40, 10, 20);
  const stage = { x: 0, y: 40, w: 100, h: 20 };
  const route = routeOrthogonalEdge(input(source, target, [obstacle], stage));
  check(
    stableRouteJson(route) ===
      stableRouteJson({
        sourceId: "source",
        targetId: "target",
        fromSide: "right",
        toSide: "left",
        points: [{ x: 20, y: 50 }, { x: 25, y: 50 }],
        segments: [{ x1: 20, y1: 50, x2: 25, y2: 50, index: 0 }],
        cost: 5,
      }),
    "direct visibility exempts both endpoint halos inside a narrow stage",
  );
  validateOrthogonalRoute(route, {
    sourceRect: source,
    targetRect: target,
    obstacles: [obstacle],
    stage,
  });
}

{
  const source = rect("source", 0, 40, 20, 20);
  const target = rect("target", 180, 40, 20, 20);
  const blocker = rect("blocker", 80, 20, 40, 60);
  const stage = { x: 0, y: 14, w: 200, h: 100 };
  const boundaryRoute = routeOrthogonalEdge(input(source, target, [blocker], stage));
  check(
    boundaryRoute.points.some((point) => point.y === 14),
    "travel on an inflated obstacle boundary is allowed",
  );

  const crossingRoute = routeOrthogonalEdge(input(source, target, []));
  assertThrows("inflated obstacle interior crossing", "E_WORKFLOW_ROUTE", () =>
    validateOrthogonalRoute(crossingRoute, {
      sourceRect: source,
      targetRect: target,
      obstacles: [blocker],
    }),
  );
}

{
  const source = rect("source", 0, 40, 20, 20);
  const target = rect("target", 180, 40, 20, 20);
  const farObstacle = rect("far", 80, 140, 20, 20);
  const route = routeOrthogonalEdge(input(source, target, [farObstacle]));
  check(
    route.points[0].x === 20 && route.points.at(-1).x === 180,
    "source and target inflation preserves exact endpoint anchors",
  );
  check(
    route.fromSide === "right" && route.toSide === "left",
    "legal egress and ingress remain available through source and target inflation",
  );
}

{
  const source = rect("source", 10, 40, 20, 20);
  const target = rect("target", 170, 40, 20, 20);
  const wall = rect("wall", 80, 0, 40, 100);
  assertThrows("stage-confined wall has no path", "E_WORKFLOW_ROUTE", () =>
    routeOrthogonalEdge(
      input(source, target, [wall], { x: 0, y: 0, w: 200, h: 100 }),
    ),
  );
  assertThrows("route stage excludes source anchor", "E_WORKFLOW_ROUTE", () =>
    routeOrthogonalEdge(
      input(source, target, [rect("far", 80, 140, 20, 20)], {
        x: 31,
        y: 0,
        w: 169,
        h: 200,
      }),
    ),
  );
}

{
  const source = rect("source", 0.0004, 40.0004, 20.0004, 20.0004);
  const target = rect("target", 180.0004, 40.0004, 20.0004, 20.0004);
  const blocker = rect("blocker", 80.0004, 20.0004, 40.0004, 60.0004);
  const routeInput = input(source, target, [blocker], {
    x: 0.0004,
    y: 14.0004,
    w: 201,
    h: 110,
  });
  const route = assertDeterministic("near-boundary decimals", routeInput);
  check(
    route.points.every(
      (point) =>
        Number(point.x.toFixed(3)) === point.x &&
        Number(point.y.toFixed(3)) === point.y,
    ),
    "decimal obstacle routes remain quantized to integer thousandths",
  );
}

{
  const base = 9007199254700;
  const routeInput = input(
    rect("source", base, 0, 5, 5),
    rect("target", base + 20, 0, 5, 5),
    [rect("far", base + 10, 100, 2, 2)],
  );
  const automatic = stableRouteJson(routeOrthogonalEdge(routeInput));
  const explicit = stableRouteJson(
    routeOrthogonalEdge({
      ...routeInput,
      stage: { x: base - 1, y: -10, w: 35, h: 150 },
    }),
  );
  check(
    automatic === explicit,
    "safe extreme coordinates clamp the automatic envelope and match an explicit stage",
  );
}

assertThrows("true inflated-bound overflow", "E_ROUTER_NONFINITE", () => {
  const edge = Number.MAX_SAFE_INTEGER / 1000 - 1;
  routeOrthogonalEdge(
    input(
      rect("source", edge, 0, 0.002, 1),
      rect("target", edge - 20, 0, 0.002, 1),
      [rect("far", edge - 10, 100, 1, 1)],
    ),
  );
});

assertThrows("malformed obstacle keys", "E_ROUTER_INPUT", () =>
  routeOrthogonalEdge(
    input(rect("s", 0, 0, 20, 20), rect("t", 100, 0, 20, 20), [
      { id: "bad", x: 40, y: 0, w: 20 },
    ]),
  ),
);
assertThrows("sparse obstacle array", "E_ROUTER_INPUT", () => {
  const obstacles = [rect("a", 30, 30, 10, 10), rect("b", 50, 50, 10, 10)];
  delete obstacles[0];
  routeOrthogonalEdge(input(rect("s", 0, 0, 20, 20), rect("t", 100, 0, 20, 20), obstacles));
});
assertThrows("proxied obstacle array", "E_ROUTER_INPUT", () => {
  const obstacles = new Proxy([], { ownKeys: () => { throw new Error("blocked"); } });
  routeOrthogonalEdge(input(rect("s", 0, 0, 20, 20), rect("t", 100, 0, 20, 20), obstacles));
});
assertThrows("accessor obstacle", "E_ROUTER_INPUT", () => {
  const obstacle = rect("bad", 40, 0, 20, 20);
  Object.defineProperty(obstacle, "x", { enumerable: true, get: () => 40 });
  routeOrthogonalEdge(input(rect("s", 0, 0, 20, 20), rect("t", 100, 0, 20, 20), [obstacle]));
});
assertThrows("nonfinite obstacle", "E_ROUTER_NONFINITE", () =>
  routeOrthogonalEdge(
    input(rect("s", 0, 0, 20, 20), rect("t", 100, 0, 20, 20), [
      rect("bad", Number.NaN, 0, 20, 20),
    ]),
  ),
);
assertThrows("negative obstacle width", "E_ROUTER_BOUNDS", () =>
  routeOrthogonalEdge(
    input(rect("s", 0, 0, 20, 20), rect("t", 100, 0, 20, 20), [
      rect("bad", 40, 0, -20, 20),
    ]),
  ),
);
assertThrows("duplicate obstacle IDs", "E_ROUTER_INPUT", () =>
  routeOrthogonalEdge(
    input(rect("s", 0, 0, 20, 20), rect("t", 100, 0, 20, 20), [
      rect("same", 30, 30, 10, 10),
      rect("same", 50, 50, 10, 10),
    ]),
  ),
);
assertThrows("obstacle duplicates source ID", "E_ROUTER_INPUT", () =>
  routeOrthogonalEdge(
    input(rect("s", 0, 0, 20, 20), rect("t", 100, 0, 20, 20), [
      rect("s", 40, 30, 10, 10),
    ]),
  ),
);

{
  const obstacles = Array.from({ length: 55 }, (_, index) =>
    rect(`obstacle-${String(index).padStart(2, "0")}`, 40 + index * 5, 20 + index * 7, 2, 2),
  );
  const started = performance.now();
  assertThrows("pathological grid", "E_WORKFLOW_ROUTE", () =>
    routeOrthogonalEdge(
      input(rect("s", 0, 0, 20, 20), rect("t", 500, 400, 20, 20), obstacles),
    ),
  );
  check(performance.now() - started < 1000, "pathological candidate grid fails within one second");
}

{
  const routeInput = input(
    rect("source", 0, 40, 20, 20),
    rect("target", 180, 40, 20, 20),
    [rect("blocker", 80, 20, 40, 60)],
  );
  const expected = stableRouteJson(routeOrthogonalEdge(routeInput));
  const started = performance.now();
  for (let index = 0; index < 300; index += 1) {
    check(
      stableRouteJson(routeOrthogonalEdge(routeInput)) === expected,
      `runtime sweep ${index}: route remains deterministic`,
    );
  }
  check(performance.now() - started < 10000, "300 obstacle routes finish within ten seconds");
}

assertThrows("mismatched self rectangles are rejected", "E_ROUTER_INPUT", () =>
  routeOrthogonalEdge(
    input(rect("same", 0, 0, 20, 20), rect("same", 100, 0, 20, 20), [
      rect("blocker", 40, 0, 20, 20),
    ]),
  ),
);
assertThrows("malformed existing routes are rejected", "E_ROUTER_INPUT", () =>
  routeOrthogonalEdge({
    ...input(rect("s", 0, 0, 20, 20), rect("t", 100, 0, 20, 20), []),
    existingRoutes: [{ sourceId: "x", targetId: "y" }],
  }),
);

if (failures.length > 0) {
  console.error("PowerPoint obstacle grid router tests failed:");
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log("PowerPoint obstacle grid router tests passed.");
