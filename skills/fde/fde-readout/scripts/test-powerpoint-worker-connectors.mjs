#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileReadoutPlan } from "./powerpoint-layout.mjs";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const skillRoot = resolve(scriptsDir, "..");
const modulePath = join(scriptsDir, "powerpoint-workflow-connectors.psm1");
const workerPath = join(scriptsDir, "render-powerpoint-worker.ps1");
const skeletonHelper = join(scriptsDir, "create-powerpoint-skeleton.ps1");
const specCompiler = join(scriptsDir, "render-powerpoint-spec.mjs");
const samplePath = join(
  skillRoot,
  "assets",
  "examples",
  "lattice-harbor-readout-plan.json",
);
const directory = await mkdtemp(join(tmpdir(), "fde-worker-connectors-"));
const failures = [];
const cliArguments = process.argv.slice(2);
const nativeRequested = cliArguments.includes("--native");
const nativeUnderMutex = cliArguments.includes("--native-under-test-mutex");
const moduleSource = await readFile(modulePath, "utf8");
const workerSource = await readFile(workerPath, "utf8");
const testSource = await readFile(fileURLToPath(import.meta.url), "utf8");
const nativeImplementationStart = testSource.indexOf(
  ["if (nativeRequested", " && !nativeUnderMutex) {"].join(""),
);
const nativeImplementationSource =
  nativeImplementationStart >= 0
    ? testSource.slice(nativeImplementationStart)
    : "";
const nativeWrapperEnd = nativeImplementationSource.indexOf(
  "\nif (!nativeRequested) {",
);
const nativeWrapperSource =
  nativeWrapperEnd > 0
    ? nativeImplementationSource.slice(0, nativeWrapperEnd)
    : "";
const runPowerShellStart = nativeImplementationSource.indexOf(
  "function runPowerShell(",
);
const runPowerShellEnd = nativeImplementationSource.indexOf(
  "\nfunction powerPointProcesses(",
  runPowerShellStart,
);
const runPowerShellSource =
  runPowerShellStart >= 0 && runPowerShellEnd > runPowerShellStart
    ? nativeImplementationSource.slice(runPowerShellStart, runPowerShellEnd)
    : "";
const helperImplementationStart = testSource.indexOf("function stable(");
const helperImplementationEnd = testSource.indexOf(
  "\nlet sequence = 0;",
  helperImplementationStart,
);
const helperImplementationSource =
  helperImplementationStart >= 0 &&
  helperImplementationEnd > helperImplementationStart
    ? testSource.slice(helperImplementationStart, helperImplementationEnd)
    : "";
const powershellExecutables = (
  process.platform === "win32"
    ? ["powershell", "pwsh"]
    : ["pwsh", "powershell"]
).filter((candidate) => {
  const probe = spawnSync(
    candidate,
    ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    { encoding: "utf8" },
  );
  return !probe.error && probe.status === 0;
});
const powershellExecutable = powershellExecutables[0];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function clone(value) {
  return structuredClone(value);
}

function compactFixtureEvidenceIds(plan, evidenceIds) {
  let json = JSON.stringify(plan);
  evidenceIds.forEach((id, index) => {
    json = json.replaceAll(id, `e${index + 1}`);
  });
  return JSON.parse(json);
}

function stable(value) {
  function canonical(candidate) {
    if (Array.isArray(candidate)) return candidate.map(canonical);
    if (candidate === null || typeof candidate !== "object") return candidate;
    return Object.fromEntries(
      Object.keys(candidate)
        .sort()
        .map((key) => [key, canonical(candidate[key])]),
    );
  }
  return JSON.stringify(canonical(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function declareNestedEvidence(slide) {
  const ids = [];
  function visit(value, key = "") {
    if (key === "evidenceIds" && Array.isArray(value)) {
      ids.push(...value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
    } else if (value && typeof value === "object") {
      Object.entries(value).forEach(([childKey, child]) =>
        visit(child, childKey),
      );
    }
  }
  visit(slide.content);
  slide.evidenceIds = [...new Set([...slide.evidenceIds, ...ids])];
}

function workflowSlide(spec) {
  return spec.slides.find((slide) => slide.family === "workflow");
}

function connectorGroups(slide) {
  const groups = new Map();
  for (const primitive of slide.primitives) {
    if (!primitive.role.startsWith("workflow-edge-")) continue;
    const group = groups.get(primitive.edgeIndex) ?? [];
    group.push(primitive);
    groups.set(primitive.edgeIndex, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, segments]) => segments);
}

function nativeWorkflowSlide() {
  return {
    id: "native-connector-workflow",
    family: "workflow",
    title: "Native connectors preserve deterministic workflow routes",
    customerSafe: true,
    notes: "Fictional native connector fixture. Source: [workflow-001].",
    evidenceIds: ["workflow-001"],
    judgmentIds: [
      "judgment-observation-001",
      "judgment-failed-attempt-001",
    ],
    content: {
      nodes: [
        {
          id: "source-a",
          label: "SOURCE A",
          detail: "first source",
          role: "source",
        },
        {
          id: "source-b",
          label: "SOURCE B",
          detail: "second source",
          role: "source",
        },
        {
          id: "actor-a",
          label: "ACTOR A",
          detail: "first operator",
          role: "actor",
        },
        {
          id: "actor-b",
          label: "ACTOR B",
          detail: "second operator",
          role: "actor",
        },
        {
          id: "system-a",
          label: "SYSTEM A",
          detail: "first service",
          role: "system",
        },
        {
          id: "system-b",
          label: "SYSTEM B",
          detail: "second service",
          role: "system",
        },
        {
          id: "decision-a",
          label: "DECISION A",
          detail: "first gate",
          role: "decision",
        },
        {
          id: "decision-b",
          label: "DECISION B",
          detail: "second gate",
          role: "decision",
        },
      ],
      edges: [
        { from: "source-a", to: "actor-a", kind: "system" },
        { from: "source-b", to: "actor-b", kind: "system" },
        { from: "actor-a", to: "system-a", kind: "system" },
        { from: "actor-b", to: "system-b", kind: "system" },
        { from: "system-a", to: "decision-a", kind: "decision" },
        { from: "decision-a", to: "system-a", kind: "decision" },
        { from: "system-b", to: "decision-b", kind: "decision" },
        { from: "source-a", to: "actor-a", kind: "system" },
        { from: "actor-a", to: "actor-a", kind: "decision" },
        { from: "decision-b", to: "source-b", kind: "decision" },
      ],
    },
  };
}

function nativeEvidenceSlide(evidenceIds, judgmentIds) {
  return {
    id: "native-connector-evidence",
    family: "evidence",
    title: "Native connector evidence remains explicit",
    customerSafe: true,
    notes: "Fictional native connector evidence register.",
    evidenceIds,
    judgmentIds,
    content: {
      groups: [
        {
          label: "Decision fixture",
          items: ["Customer", "authority", "target", "evaluation"],
          evidenceIds: evidenceIds.filter((id) => id !== "workflow-001"),
        },
        {
          label: "Workflow fixture",
          items: ["Connector topology and route metadata"],
          evidenceIds: ["workflow-001"],
        },
      ],
      controls: [
        "Fictional fixture data",
        "Exact connector geometry is verified after reopen",
      ],
    },
  };
}

function nativeConnectorFixturePlan(sourcePlan) {
  const cover = clone(
    sourcePlan.slides.find((slide) => slide.family === "cover"),
  );
  const decision = clone(
    sourcePlan.slides.find((slide) => slide.family === "decision"),
  );
  const metrics = clone(
    sourcePlan.slides.find((slide) => slide.family === "metrics"),
  );
  const workflow = nativeWorkflowSlide();
  const evidenceIds = [
    "customer-001",
    "assignment-001",
    "brand-001",
    "baseline-001",
    "authority-001",
    "target-001",
    "build-001",
    "eval-001",
    "workflow-001",
  ];
  const judgmentIds = [
    "judgment-observation-001",
    "judgment-failed-attempt-001",
    "judgment-rationale-001",
    "judgment-surprise-001",
  ];
  sourcePlan.slides = [
    cover,
    decision,
    workflow,
    metrics,
    nativeEvidenceSlide(evidenceIds, judgmentIds),
  ];
  sourcePlan.slides.forEach(declareNestedEvidence);
  sourcePlan.evidence = sourcePlan.evidence.filter((entry) =>
    evidenceIds.includes(entry.id),
  );
  sourcePlan.humanContext = sourcePlan.humanContext.filter((entry) =>
    judgmentIds.includes(entry.id),
  );
  return compactFixtureEvidenceIds(sourcePlan, evidenceIds);
}

function expectedConnectorRoutes(spec) {
  const groups = connectorGroups(workflowSlide(spec));
  return groups.map((segments, index) => {
    const first = segments[0];
    return {
      edgeIndex: index + 1,
      kind: first.role.match(/^workflow-edge-(system|decision)-/)[1],
      sourceNodeId: first.sourceNodeId,
      targetNodeId: first.targetNodeId,
      segmentCount: segments.length,
      points: [
        { x: first.x1, y: first.y1 },
        ...segments.map((segment) => ({ x: segment.x2, y: segment.y2 })),
      ],
    };
  });
}

function connectorHashProjections(spec) {
  const allPrimitives = [];
  const allMetadata = [];
  const allPointSequences = [];
  const slides = spec.slides.map((slide) => {
    const connectors = slide.primitives.filter((primitive) =>
      /^workflow-edge-(system|decision)-\d{2}$/.test(primitive.role),
    );
    const primitives = connectors.map((primitive) => ({
      name: primitive.name,
      role: primitive.role,
      z: primitive.z,
      x1: primitive.x1,
      y1: primitive.y1,
      x2: primitive.x2,
      y2: primitive.y2,
      colorRole: primitive.colorRole,
      transparency: primitive.transparency,
      width: primitive.width,
      dash: primitive.dash,
      arrowStart: primitive.arrowStart,
      arrowEnd: primitive.arrowEnd,
      sourceNodeId: primitive.sourceNodeId,
      targetNodeId: primitive.targetNodeId,
      edgeIndex: primitive.edgeIndex,
      segmentIndex: primitive.segmentIndex,
    }));
    const routes = connectorGroups(slide).map((segments) => {
      const first = segments[0];
      const points = [
        { x: first.x1, y: first.y1 },
        ...segments.map((segment) => ({ x: segment.x2, y: segment.y2 })),
      ];
      const metadata = {
        edgeIndex: first.edgeIndex,
        kind: first.role.match(/^workflow-edge-(system|decision)-/)[1],
        sourceNodeId: first.sourceNodeId,
        targetNodeId: first.targetNodeId,
        segmentCount: segments.length,
      };
      const pointSequence = {
        edgeIndex: first.edgeIndex,
        points,
      };
      return {
        ...metadata,
        points,
        pointSequenceSha256: sha256(JSON.stringify(pointSequence)),
      };
    });
    const metadata = routes.map((route) => ({
      edgeIndex: route.edgeIndex,
      kind: route.kind,
      sourceNodeId: route.sourceNodeId,
      targetNodeId: route.targetNodeId,
      segmentCount: route.segmentCount,
    }));
    const pointSequences = routes.map((route) => ({
      edgeIndex: route.edgeIndex,
      points: route.points,
    }));
    allPrimitives.push(...primitives);
    allMetadata.push(...metadata);
    allPointSequences.push(...pointSequences);
    return {
      id: slide.id,
      connectorPrimitiveSha256: sha256(JSON.stringify(primitives)),
      routeMetadataSha256: sha256(JSON.stringify(metadata)),
      pointSequenceSha256: sha256(JSON.stringify(pointSequences)),
      routes,
    };
  });
  return {
    primitiveSha256: sha256(JSON.stringify(allPrimitives)),
    routeMetadataSha256: sha256(JSON.stringify(allMetadata)),
    pointSequenceSha256: sha256(JSON.stringify(allPointSequences)),
    slides,
  };
}

let sequence = 0;
async function validateSpec(spec, executable = powershellExecutable) {
  sequence += 1;
  const specPath = join(directory, `connector-spec-${sequence}.json`);
  await writeFile(specPath, JSON.stringify(spec), "utf8");
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  Import-Module -Name $env:FDE_CONNECTOR_MODULE -Force",
    "  $json = [IO.File]::ReadAllText($env:FDE_CONNECTOR_SPEC, [Text.UTF8Encoding]::new($false, $true))",
    "  $spec = $json | ConvertFrom-Json",
    "  $report = Get-WorkflowConnectorSpecReport -SpecObject $spec",
    "  [Console]::Out.WriteLine(($report | ConvertTo-Json -Depth 30 -Compress))",
    "  exit 0",
    "}",
    "catch {",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "  exit 1",
    "}",
  ].join("\n");
  const result = spawnSync(
    executable,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FDE_CONNECTOR_MODULE: modulePath,
        FDE_CONNECTOR_SPEC: specPath,
      },
    },
  );
  return {
    ...result,
    report:
      result.status === 0 && result.stdout.trim()
        ? JSON.parse(result.stdout.trim())
        : undefined,
  };
}

async function expectRejected(label, spec, mutate, expectedText) {
  const candidate = clone(spec);
  mutate(candidate);
  const result = await validateSpec(candidate);
  check(result.status !== 0, `${label}: malformed connector spec must be rejected`);
  check(
    result.status !== 0 &&
      result.stderr.toLowerCase().includes(expectedText.toLowerCase()),
    `${label}: expected diagnostic containing ${JSON.stringify(expectedText)}, got ${result.stderr.trim()}`,
  );
}

try {
  const sample = JSON.parse(await readFile(samplePath, "utf8"));
  sample.slides.forEach(declareNestedEvidence);
  const raw = Buffer.from(JSON.stringify(sample), "utf8");
  const spec = compileReadoutPlan(sample, {
    sourcePlanSha256: createHash("sha256").update(raw).digest("hex"),
    mode: "full",
  });
  const slide = workflowSlide(spec);
  const groups = connectorGroups(slide);
  check(slide, "fixture must compile a workflow slide");
  check(groups.length >= 2, "fixture must compile at least two connector routes");
  check(
    groups.some((group) => group.length > 1),
    "fixture must compile a multi-segment connector route",
  );
  const nativePlan = nativeConnectorFixturePlan(
    JSON.parse(await readFile(samplePath, "utf8")),
  );
  const nativeRaw = Buffer.from(JSON.stringify(nativePlan), "utf8");
  const nativePlanPath = join(directory, "native-plan.json");
  const nativeSpecPath = join(directory, "native-spec.json");
  await writeFile(nativePlanPath, stable(nativePlan), "utf8");
  const nativePublicCompile = spawnSync(
    process.execPath,
    [
      specCompiler,
      "--plan",
      nativePlanPath,
      "--mode",
      "full",
      "--output",
      nativeSpecPath,
    ],
    { encoding: "utf8" },
  );
  check(
    nativePublicCompile.status === 0,
    `native fixture failed public validation: ${combinedOutput(nativePublicCompile)}`,
  );
  const nativeSpec = compileReadoutPlan(nativePlan, {
    sourcePlanSha256: createHash("sha256")
      .update(nativeRaw)
      .digest("hex"),
    mode: "full",
  });
  check(nativeSpec.slides.length === 5, "native connector fixture must have five slides");
  check(
    nativeSpec.slides
      .flatMap((slide) => slide.primitives)
      .every((primitive) => ["text", "shape", "line"].includes(primitive.kind)),
    "native connector fixture contains a primitive unsupported by this worker layer",
  );
  assertNativeFixtureTopology(nativePlan, nativeSpec);

  if (powershellExecutable) {
    for (const executable of powershellExecutables) {
      const editionValid = await validateSpec(spec, executable);
      check(
        editionValid.status === 0,
        `valid connector spec must pass ${executable} preflight:\n${editionValid.stderr}`,
      );
    }
    const valid = await validateSpec(spec);
    check(
      valid.status === 0,
      `valid connector spec must pass pure PowerShell preflight:\n${valid.stderr}`,
    );
    if (valid.report) {
      const expectedSegmentCount = groups.reduce(
        (total, group) => total + group.length,
        0,
      );
      check(
        valid.report.routeCount === groups.length,
        "preflight report must count exact workflow routes",
      );
      check(
        valid.report.segmentCount === expectedSegmentCount,
        "preflight report must count exact workflow segments",
      );
      check(
        valid.report.costStatus ===
          "not-declared-by-fde-drawing-spec/1.0",
        "preflight report must not invent an undeclared route cost",
      );
      for (const key of [
        "connectorPrimitiveSha256",
        "routeMetadataSha256",
        "pointSequenceSha256",
      ]) {
        check(
          /^[0-9a-f]{64}$/.test(valid.report[key]),
          `preflight report must include ${key}`,
        );
      }
      const workflowReport = valid.report.slides.find(
        (item) => item.id === slide.id,
      );
      check(
        workflowReport.routes.every(
          (route) =>
            route.declaredCost === null &&
            route.points.length === route.segmentCount + 1 &&
            /^[0-9a-f]{64}$/.test(route.pointSequenceSha256),
        ),
        "route report must preserve exact point order while keeping absent cost null",
      );
    }
    const repeated = await validateSpec(spec);
    check(
      repeated.status === 0 &&
        JSON.stringify(repeated.report) === JSON.stringify(valid.report),
      "connector preflight report must be byte-deterministic",
    );
    const nativeProjectionReport = await validateSpec(nativeSpec);
    check(
      nativeProjectionReport.status === 0,
      `native connector fixture must pass pure PowerShell preflight:\n${nativeProjectionReport.stderr}`,
    );
    if (nativeProjectionReport.report) {
      const expectedHashes = connectorHashProjections(nativeSpec);
      const expectedSlide = expectedHashes.slides.find(
        (item) => item.id === "native-connector-workflow",
      );
      const actualSlide = nativeProjectionReport.report.slides.find(
        (item) => item.id === "native-connector-workflow",
      );
      check(
        nativeProjectionReport.report.connectorPrimitiveSha256 ===
          expectedHashes.primitiveSha256,
        "independent connector primitive hash projection differs from PowerShell preflight",
      );
      check(
        nativeProjectionReport.report.routeMetadataSha256 ===
          expectedHashes.routeMetadataSha256,
        "independent connector route-metadata hash projection differs from PowerShell preflight",
      );
      check(
        nativeProjectionReport.report.pointSequenceSha256 ===
          expectedHashes.pointSequenceSha256,
        "independent connector point-sequence hash projection differs from PowerShell preflight",
      );
      for (const field of [
        "connectorPrimitiveSha256",
        "routeMetadataSha256",
        "pointSequenceSha256",
      ]) {
        check(
          actualSlide?.[field] === expectedSlide?.[field],
          `independent workflow slide ${field} projection differs from PowerShell preflight`,
        );
      }
      actualSlide?.routes.forEach((route, index) => {
        check(
          route.pointSequenceSha256 ===
            expectedSlide.routes[index].pointSequenceSha256,
          `independent route ${route.edgeIndex} point-sequence hash projection differs from PowerShell preflight`,
        );
      });
    }

    await expectRejected(
      "malformed metadata",
      spec,
      (candidate) => {
        delete connectorGroups(workflowSlide(candidate))[0][0].segmentIndex;
      },
      "exact workflow line primitive fields",
    );
    await expectRejected(
      "unsupported connector kind",
      spec,
      (candidate) => {
        connectorGroups(workflowSlide(candidate))[0][0].kind = "connector";
      },
      "must retain drawing-spec kind 'line'",
    );
    await expectRejected(
      "case-mutated connector key",
      spec,
      (candidate) => {
        const segment = connectorGroups(workflowSlide(candidate))[0][0];
        segment.SourceNodeId = segment.sourceNodeId;
        delete segment.sourceNodeId;
      },
      "missing required field 'sourceNodeId'",
    );
    await expectRejected(
      "case-mutated connector role",
      spec,
      (candidate) => {
        const segment = connectorGroups(workflowSlide(candidate))[0][0];
        segment.role = segment.role.replace("system", "System");
      },
      "malformed role",
    );
    await expectRejected(
      "diagonal segment",
      spec,
      (candidate) => {
        const segment = connectorGroups(workflowSlide(candidate))[0][0];
        if (segment.x1 === segment.x2) segment.x2 += 1;
        else segment.y2 += 1;
      },
      "nonzero and orthogonal",
    );
    await expectRejected(
      "zero-length segment",
      spec,
      (candidate) => {
        const segment = connectorGroups(workflowSlide(candidate))[0][0];
        segment.x2 = segment.x1;
        segment.y2 = segment.y1;
      },
      "nonzero and orthogonal",
    );
    await expectRejected(
      "discontinuous route",
      spec,
      (candidate) => {
        const group = connectorGroups(workflowSlide(candidate)).find(
          (item) => item.length > 1,
        );
        const segment = group[1];
        if (segment.x1 === segment.x2) {
          segment.y1 += 1;
        } else {
          segment.x1 += 1;
        }
      },
      "exact segment anchors",
    );
    await expectRejected(
      "out-of-stage segment",
      spec,
      (candidate) => {
        const segment = connectorGroups(workflowSlide(candidate))[0][0];
        if (segment.x1 === segment.x2) {
          segment.x1 = 47;
          segment.x2 = 47;
        } else {
          segment.y1 = 115;
          segment.y2 = 115;
        }
      },
      "escapes the workflow stage",
    );
    await expectRejected(
      "duplicate drawing name",
      spec,
      (candidate) => {
        candidate.slides[1].primitives[0].name =
          candidate.slides[0].primitives[0].name;
      },
      "duplicate drawing name",
    );
    await expectRejected(
      "semantic style mismatch",
      spec,
      (candidate) => {
        const segment = connectorGroups(workflowSlide(candidate))[0][0];
        segment.colorRole =
          segment.colorRole === "system" ? "decision" : "system";
      },
      "semantic",
    );
    await expectRejected(
      "missing decision route",
      spec,
      (candidate) => {
        for (const group of connectorGroups(workflowSlide(candidate))) {
          for (const segment of group) {
            segment.role = segment.role.replace("decision", "system");
            segment.colorRole = "system";
            segment.width = 1;
          }
        }
      },
      "must contain a decision route",
    );
    await expectRejected(
      "connector above nodes",
      spec,
      (candidate) => {
        const target = workflowSlide(candidate);
        const segment = connectorGroups(target)[0][0];
        const node = target.primitives.find((primitive) =>
          primitive.role.startsWith("workflow-node-"),
        );
        [segment.z, node.z] = [node.z, segment.z];
        target.primitives.sort((left, right) => left.z - right.z);
      },
      "behind workflow nodes",
    );
  }

  for (const [name, pattern] of [
    ["exact connector AddConnector rendering", /\$Shapes\.AddConnector\(/],
    ["connector semantic dispatch", /Test-WorkflowConnectorPrimitive[\s\S]*Add-WorkflowConnectorPrimitive/],
    ["connector failpoint", /Invoke-TestFailpoint -Stage 'connector'/],
    ["connector mutation hook", /FDE_POWERPOINT_TEST_MUTATE_CONNECTOR_BEFORE_VERIFY/],
    ["reopened connector geometry verification", /Assert-WorkflowConnectorShape[\s\S]*Get-WorkflowConnectorEndpoints/],
    ["reopened connector style verification", /Reopened connector style changed/],
    ["reopened connector count verification", /Reopened connector count changed/],
    ["connector report hashes", /routeMetadataSha256[\s\S]*pointSequenceSha256/],
    ["connector line release", /Release-ComRef[^\r\n]*workflow connector line format/],
    ["connector color release", /Release-ComRef[^\r\n]*workflow connector line color/],
    ["connector shape release", /Release-ComRef[^\r\n]*workflow connector shape/],
  ]) {
    check(pattern.test(workerSource), `worker omits ${name}`);
  }
  check(
    workerSource.indexOf(
      "$connectorSpecReport = Get-WorkflowConnectorSpecReport -SpecObject $specObject",
    ) <
      workerSource.indexOf(
        "$powerPoint = New-Object -ComObject PowerPoint.Application",
      ),
    "strict connector validation must run before COM activation",
  );
  check(
    !/FinalReleaseComObject/i.test(workerSource),
    "worker must never use FinalReleaseComObject",
  );
  check(
    !/ReleaseComObject\s*\(\s*\$powerPoint\s*\)|Release-ComRef[^\r\n]*\$powerPoint/i.test(
      workerSource,
    ),
    "worker must never release the root PowerPoint Application RCW",
  );
  check(
    /Get-WorkflowConnectorSpecReport[\s\S]*costStatus = 'not-declared-by-fde-drawing-spec\/1\.0'/.test(
      moduleSource,
    ),
    "validator must preserve the drawing spec's lack of route cost",
  );
  check(
    nativeImplementationSource.length > 0,
    "connector harness is missing its native implementation path",
  );
  if (nativeImplementationSource) {
    for (const [pattern, message] of [
      [/--native-under-test-mutex/, "native path lacks the under-mutex selector"],
      [
        /FdeReadoutPowerPointWorkerNativeTest/,
        "native path lacks the outer connector-test mutex",
      ],
      [/\.WaitOne\(\)/, "outer connector-test mutex is not an unbounded wait"],
      [
        /assertZeroPowerPoint\("initial native baseline"\)/,
        "native path lacks the immediate zero-PowerPoint baseline",
      ],
      [
        /assertZeroPowerPoint\(/,
        "native path does not assert PowerPoint cleanup after invocations",
      ],
      [
        /assertNoStagingPaths\(/,
        "native path does not check for abandoned staging paths",
      ],
      [
        /assertCleanupReceipt\(/,
        "native path does not verify cleanup-bound worker failures",
      ],
      [
        /"-FailAfter",\s*"connector"/,
        "native path does not pass the connector failpoint argument",
      ],
      [
        /FDE_POWERPOINT_TEST_FAILPOINTS:\s*"1"/,
        "native path lacks the worker test-hook guard",
      ],
      [
        /FDE_POWERPOINT_TEST_MUTATE_CONNECTOR_BEFORE_VERIFY:\s*"1"/,
        "native path lacks reopened connector mutation coverage",
      ],
      [
        /Test failpoint after connector/,
        "native path expects the wrong connector failpoint diagnostic",
      ],
      [
        /must be nonzero and orthogonal/,
        "native path lacks malformed pre-COM connector coverage",
      ],
      [
        /assertNoCleanupReceipt\(/,
        "native path does not prove malformed rejection stayed pre-COM",
      ],
      [
        /expectedConnectorRoutes\(spec\)/,
        "native path does not verify full connector route points",
      ],
      [
        /persisted connector report differs from stdout/,
        "native path does not compare the persisted connector report",
      ],
      [
        /primitiveSha256/,
        "native path does not verify connector report hashes",
      ],
      [
        /connectorHashProjections\(spec\)/,
        "native path lacks independent connector hash projections",
      ],
      [
        /expectedHashes(?:\.primitiveSha256|\["primitiveSha256"\])/,
        "native path does not compare the exact primitive hash",
      ],
      [
        /expectedRoute\.pointSequenceSha256/,
        "native path does not compare per-route point hashes",
      ],
      [
        /\[\s*specCompiler,\s*"--plan",\s*planPath,\s*"--mode",\s*"full",\s*"--output",\s*specPath,?\s*\]/,
        "native path invokes the drawing-spec compiler with the wrong contract",
      ],
      [
        /"-Plan",\s*planPath,\s*"-Output",\s*skeletonPath/,
        "native path invokes the skeleton helper with the wrong contract",
      ],
      [
        /\[type\]::GetTypeFromProgID\('PowerPoint\.Application'\)/,
        "native path lacks a nonactivating PowerPoint availability check",
      ],
    ]) {
      check(pattern.test(nativeImplementationSource), message);
    }
    check(
      !/New-Object\s+-ComObject\s+PowerPoint\.Application/.test(
        nativeImplementationSource,
      ),
      "native harness availability check activates PowerPoint",
    );
  }
  check(
    /function stable\(/.test(helperImplementationSource),
    "connector harness lacks stable JSON comparison support",
  );
  check(
    /function sha256\(/.test(helperImplementationSource),
    "connector harness lacks SHA-256 support",
  );
  check(
    /function connectorHashProjections\(/.test(helperImplementationSource),
    "connector harness lacks independent hash projection support",
  );
  check(
    nativeWrapperSource.length > 0,
    "connector harness native mutex wrapper could not be located",
  );
  if (nativeWrapperSource) {
    check(
      !/timeout\s*:/.test(nativeWrapperSource),
      "connector harness outer native process has a timeout",
    );
  }
  check(
    runPowerShellSource.length > 0,
    "connector harness runPowerShell helper could not be located",
  );
  if (runPowerShellSource) {
    check(
      !/timeout\s*:/.test(runPowerShellSource),
      "connector harness runPowerShell can bypass worker cleanup",
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("PowerPoint worker connector tests failed:");
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

if (nativeRequested && !nativeUnderMutex) {
  if (process.platform !== "win32") {
    console.log(
      "PowerPoint worker native connector tests skipped outside Windows.",
    );
    process.exit(0);
  }
  const testPath = fileURLToPath(import.meta.url);
  const wrapper = [
    "$ErrorActionPreference = 'Stop'",
    "$mutex = New-Object System.Threading.Mutex($false, 'Local\\FdeReadoutPowerPointWorkerNativeTest')",
    "$held = $false",
    "try {",
    "  try {",
    "    $held = $mutex.WaitOne()",
    "  } catch [System.Threading.AbandonedMutexException] {",
    "    $held = $true",
    "  }",
    `  & ${quotePowerShellLiteral(process.execPath)} ${quotePowerShellLiteral(testPath)} --native --native-under-test-mutex`,
    "  exit $LASTEXITCODE",
    "} finally {",
    "  if ($held) { $mutex.ReleaseMutex() }",
    "  $mutex.Dispose()",
    "}",
  ].join("\n");
  const nativeResult = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", wrapper],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (nativeResult.stdout) {
    process.stdout.write(nativeResult.stdout);
  }
  if (nativeResult.stderr) {
    process.stderr.write(nativeResult.stderr);
  }
  if (nativeResult.error) {
    console.error(nativeResult.error.message);
    process.exit(1);
  }
  process.exit(nativeResult.status ?? 1);
}

if (!nativeRequested) {
  console.log("PowerPoint worker connector tests passed without COM.");
  process.exit(0);
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(argumentsList, environment = {}) {
  return spawnSync("powershell", argumentsList, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...environment },
  });
}

function powerPointProcesses() {
  const result = runPowerShell([
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    [
      "$items = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue)",
      "try {",
      "  [pscustomobject]@{ processes = @($items | ForEach-Object { [pscustomobject]@{ id = $_.Id; startTime = $_.StartTime.ToUniversalTime().ToString('o') } }) } | ConvertTo-Json -Compress -Depth 4",
      "} finally {",
      "  foreach ($item in $items) { $item.Dispose() }",
      "}",
    ].join("\n"),
  ]);
  if (result.status !== 0 || result.error) {
    throw new Error(
      `PowerPoint process inspection failed: ${result.error?.message ?? `${result.stdout}\n${result.stderr}`.trim()}`,
    );
  }
  return JSON.parse(result.stdout.trim()).processes;
}

function assertZeroPowerPoint(label) {
  try {
    const processes = powerPointProcesses();
    check(
      processes.length === 0,
      `${label} left PowerPoint processes: ${JSON.stringify(processes)}`,
    );
    return processes.length === 0;
  } catch (error) {
    failures.push(`${label} process check failed: ${error.message}`);
    return false;
  }
}

async function assertNoStagingPaths(parentDirectory, label) {
  const entries = await readdir(parentDirectory, { withFileTypes: true });
  const stagingPaths = entries
    .filter((entry) => entry.name.includes(".worker-stage"))
    .map((entry) => entry.name);
  check(
    stagingPaths.length === 0,
    `${label} left staging paths: ${stagingPaths.join(", ")}`,
  );
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function workerInvocation(
  specPath,
  specSha256,
  skeletonPath,
  outputPath,
  extraArguments = [],
  environment = {},
) {
  return runPowerShell(
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      workerPath,
      "-Spec",
      specPath,
      "-ExpectedSpecSha256",
      specSha256,
      "-Skeleton",
      skeletonPath,
      "-OutputDirectory",
      outputPath,
      ...extraArguments,
    ],
    environment,
  );
}

function combinedOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function assertCleanupReceipt(result, label) {
  const match = combinedOutput(result).match(
    /PowerPoint cleanup: PID ([0-9]+) start ([^\s]+) exited via (graceful|forced)\./,
  );
  check(Boolean(match), `${label} lacks an exact PowerPoint cleanup receipt`);
}

function assertNoCleanupReceipt(result, label) {
  check(
    !/PowerPoint cleanup: PID [0-9]+ start [^\s]+ exited via (graceful|forced)\./.test(
      combinedOutput(result),
    ),
    `${label} unexpectedly produced a PowerPoint cleanup receipt`,
  );
}

function powerPointAvailable() {
  const result = runPowerShell([
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[bool][type]::GetTypeFromProgID('PowerPoint.Application')",
  ]);
  return {
    available: result.status === 0 && result.stdout.trim() === "True",
    detail: combinedOutput(result),
  };
}

function assertNativeFixtureTopology(plan, spec) {
  const edges = plan.slides.find(
    (slide) => slide.id === "native-connector-workflow",
  ).content.edges;
  check(edges.length === 10, "native fixture must exercise ten routes");
  check(
    edges.some((edge) => edge.from === edge.to),
    "native fixture lacks a self-loop route",
  );
  check(
    edges.some(
      (edge, index) =>
        edges.findIndex(
          (candidate) =>
            candidate.from === edge.from &&
            candidate.to === edge.to &&
            candidate.kind === edge.kind,
        ) !== index,
    ),
    "native fixture lacks duplicate routes",
  );
  check(
    edges.some((edge) =>
      edges.some(
        (candidate) =>
          candidate.from === edge.to && candidate.to === edge.from,
      ),
    ),
    "native fixture lacks reverse routes",
  );
  check(
    edges.some(
      (edge) => edge.from === "decision-b" && edge.to === "source-b",
    ),
    "native fixture lacks the explicit cycle-closing route",
  );
  const routes = expectedConnectorRoutes(spec);
  check(routes.length === 10, "compiled native fixture route count changed");
  check(
    routes.some((route) => route.segmentCount > 1),
    "native fixture lacks a multi-segment route",
  );
}

function assertConnectorReport(report, spec) {
  const expectedRoutes = expectedConnectorRoutes(spec);
  const expectedHashes = connectorHashProjections(spec);
  const expectedSegments = expectedRoutes.reduce(
    (sum, route) => sum + route.segmentCount,
    0,
  );
  const expectedNames = spec.slides.reduce(
    (sum, slide) => sum + slide.primitives.length,
    0,
  );
  const connectorSlide = report.connectors?.slides?.find(
    (slide) => slide.id === "native-connector-workflow",
  );
  const expectedConnectorSlide = expectedHashes.slides.find(
    (slide) => slide.id === "native-connector-workflow",
  );
  check(
    report.worker === "fde-powerpoint-native-shapes/2.0",
    "native worker report version changed",
  );
  check(
    report.cleanup?.exited === true &&
      ["graceful", "forced"].includes(report.cleanup?.mode) &&
      report.cleanup?.contaminationDetected === false &&
      Array.isArray(report.cleanup?.releaseErrors) &&
      report.cleanup.releaseErrors.length === 0,
    "native success report is not bound to completed cleanup",
  );
  check(
    report.connectors?.routeCount === expectedRoutes.length,
    "native connector route count changed",
  );
  check(
    report.connectors?.segmentCount === expectedSegments,
    "native connector segment count changed",
  );
  check(
    report.connectors?.drawingNameCount === expectedNames,
    "native drawing-name count changed",
  );
  check(
    report.connectors?.costStatus ===
      "not-declared-by-fde-drawing-spec/1.0",
    "native connector report synthesized route cost",
  );
  check(
    report.connectors?.primitiveSha256 === expectedHashes.primitiveSha256,
    "native connector aggregate primitive hash differs from the fixture projection",
  );
  check(
    report.connectors?.routeMetadataSha256 ===
      expectedHashes.routeMetadataSha256,
    "native connector aggregate route-metadata hash differs from the fixture projection",
  );
  check(
    report.connectors?.pointSequenceSha256 ===
      expectedHashes.pointSequenceSha256,
    "native connector aggregate point-sequence hash differs from the fixture projection",
  );
  check(
    connectorSlide?.connectorPrimitiveSha256 ===
      expectedConnectorSlide?.connectorPrimitiveSha256,
    "native connector slide primitive hash differs from the fixture projection",
  );
  check(
    connectorSlide?.routeMetadataSha256 ===
      expectedConnectorSlide?.routeMetadataSha256,
    "native connector slide route-metadata hash differs from the fixture projection",
  );
  check(
    connectorSlide?.pointSequenceSha256 ===
      expectedConnectorSlide?.pointSequenceSha256,
    "native connector slide point-sequence hash differs from the fixture projection",
  );
  check(Boolean(connectorSlide), "native connector slide report is missing");
  if (connectorSlide) {
    check(
      connectorSlide.routeCount === expectedRoutes.length,
      "native connector slide route count changed",
    );
    check(
      connectorSlide.segmentCount === expectedSegments,
      "native connector slide segment count changed",
    );
    const actualRoutes = connectorSlide.routes.map((route) => ({
      edgeIndex: route.edgeIndex,
      kind: route.kind,
      sourceNodeId: route.sourceNodeId,
      targetNodeId: route.targetNodeId,
      segmentCount: route.segmentCount,
      points: route.points,
    }));
    check(
      stable(actualRoutes) === stable(expectedRoutes),
      "native connector route metadata or full point sequence changed",
    );
    connectorSlide.routes.forEach((route, index) => {
      const expectedRoute = expectedConnectorSlide.routes[index];
      check(
        route.pointSequenceSha256 === expectedRoute.pointSequenceSha256,
        `native connector route ${route.edgeIndex} point-sequence hash differs from the fixture projection`,
      );
    });
    check(
      connectorSlide.routes.every(
        (route) =>
          route.declaredCost === null &&
          route.costStatus ===
            "not-declared-by-fde-drawing-spec/1.0",
      ),
      "native connector route report added facts for absent cost",
    );
  }
}

async function runNativeConnectorSuite() {
  if (!assertZeroPowerPoint("initial native baseline")) {
    return;
  }
  const availability = powerPointAvailable();
  assertZeroPowerPoint("PowerPoint availability probe");
  if (!availability.available) {
    console.log(
      `PowerPoint worker native connector tests skipped: ${availability.detail}`,
    );
    return;
  }

  const nativeDirectory = await mkdtemp(
    join(tmpdir(), "fde-worker-connectors-native-"),
  );
  try {
    const sourcePlan = JSON.parse(await readFile(samplePath, "utf8"));
    const plan = nativeConnectorFixturePlan(sourcePlan);
    const planPath = join(nativeDirectory, "plan.json");
    const specPath = join(nativeDirectory, "spec.json");
    await writeFile(planPath, stable(plan), "utf8");
    const compileResult = spawnSync(
      process.execPath,
      [
        specCompiler,
        "--plan",
        planPath,
        "--mode",
        "full",
        "--output",
        specPath,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    check(
      compileResult.status === 0 && !compileResult.error,
      `native fixture compile failed: ${combinedOutput(compileResult)}`,
    );
    if (compileResult.status !== 0 || compileResult.error) {
      return;
    }
    const specBytes = await readFile(specPath);
    const spec = JSON.parse(specBytes.toString("utf8"));
    const specSha256 = sha256(specBytes);
    assertNativeFixtureTopology(plan, spec);

    const skeletonPath = join(nativeDirectory, "skeleton.pptx");
    const skeletonResult = runPowerShell([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      skeletonHelper,
      "-Plan",
      planPath,
      "-Output",
      skeletonPath,
    ]);
    check(
      skeletonResult.status === 0 && !skeletonResult.error,
      `native skeleton creation failed: ${combinedOutput(skeletonResult)}`,
    );
    assertZeroPowerPoint("native skeleton creation");
    await assertNoStagingPaths(nativeDirectory, "native skeleton creation");
    if (skeletonResult.status !== 0 || skeletonResult.error) {
      return;
    }

    const successOutput = join(nativeDirectory, "success-bundle");
    const successResult = workerInvocation(
      specPath,
      specSha256,
      skeletonPath,
      successOutput,
    );
    check(
      successResult.status === 0 && !successResult.error,
      `native connector worker failed: ${combinedOutput(successResult)}`,
    );
    assertZeroPowerPoint("native connector success");
    await assertNoStagingPaths(nativeDirectory, "native connector success");
    if (successResult.status === 0 && !successResult.error) {
      let stdoutReport;
      try {
        stdoutReport = JSON.parse(successResult.stdout.trim());
      } catch (error) {
        failures.push(`native connector stdout is not JSON: ${error.message}`);
      }
      if (stdoutReport) {
        assertConnectorReport(stdoutReport, spec);
        const persistedReportPath = join(
          successOutput,
          "worker-report.json",
        );
        check(
          await pathExists(persistedReportPath),
          "native persisted connector report is missing",
        );
        if (await pathExists(persistedReportPath)) {
          const persistedReport = JSON.parse(
            await readFile(persistedReportPath, "utf8"),
          );
          check(
            stable(persistedReport) === stable(stdoutReport),
            "persisted connector report differs from stdout",
          );
          assertConnectorReport(persistedReport, spec);
        }
      }
    }

    const failpointOutput = join(nativeDirectory, "failpoint-bundle");
    const failpointResult = workerInvocation(
      specPath,
      specSha256,
      skeletonPath,
      failpointOutput,
      ["-FailAfter", "connector"],
      { FDE_POWERPOINT_TEST_FAILPOINTS: "1" },
    );
    check(
      failpointResult.status !== 0,
      "connector failpoint unexpectedly succeeded",
    );
    check(
      /Test failpoint after connector/.test(combinedOutput(failpointResult)),
      "connector failpoint did not fail at the connector stage",
    );
    assertCleanupReceipt(failpointResult, "connector failpoint");
    check(
      !(await pathExists(failpointOutput)),
      "connector failpoint published a bundle",
    );
    assertZeroPowerPoint("connector failpoint");
    await assertNoStagingPaths(nativeDirectory, "connector failpoint");

    const mutationOutput = join(nativeDirectory, "mutation-bundle");
    const mutationResult = workerInvocation(
      specPath,
      specSha256,
      skeletonPath,
      mutationOutput,
      [],
      {
        FDE_POWERPOINT_TEST_FAILPOINTS: "1",
        FDE_POWERPOINT_TEST_MUTATE_CONNECTOR_BEFORE_VERIFY: "1",
      },
    );
    check(
      mutationResult.status !== 0,
      "reopened connector mutation unexpectedly succeeded",
    );
    check(
      /Reopened connector geometry changed/.test(
        combinedOutput(mutationResult),
      ),
      "reopened connector mutation was not detected by exact geometry checks",
    );
    assertCleanupReceipt(mutationResult, "reopened connector mutation");
    check(
      !(await pathExists(mutationOutput)),
      "reopened connector mutation published a bundle",
    );
    assertZeroPowerPoint("reopened connector mutation");
    await assertNoStagingPaths(
      nativeDirectory,
      "reopened connector mutation",
    );

    const malformedSpec = clone(spec);
    const malformedSegment = connectorGroups(
      workflowSlide(malformedSpec),
    )[0][0];
    if (malformedSegment.x1 === malformedSegment.x2) {
      malformedSegment.x2 += 1;
    } else {
      malformedSegment.y2 += 1;
    }
    const malformedSpecPath = join(nativeDirectory, "malformed-spec.json");
    const malformedBytes = Buffer.from(stable(malformedSpec), "utf8");
    await writeFile(malformedSpecPath, malformedBytes);
    const malformedOutput = join(nativeDirectory, "malformed-bundle");
    const malformedResult = workerInvocation(
      malformedSpecPath,
      sha256(malformedBytes),
      skeletonPath,
      malformedOutput,
    );
    check(
      malformedResult.status !== 0,
      "malformed connector geometry unexpectedly succeeded",
    );
    check(
      /must be nonzero and orthogonal|workflow connector segment must be orthogonal/.test(
        combinedOutput(malformedResult),
      ),
      "malformed connector geometry did not fail strict pre-COM validation",
    );
    assertNoCleanupReceipt(malformedResult, "malformed pre-COM connector");
    check(
      !(await pathExists(malformedOutput)),
      "malformed connector geometry published a bundle",
    );
    assertZeroPowerPoint("malformed pre-COM connector");
    await assertNoStagingPaths(
      nativeDirectory,
      "malformed pre-COM connector",
    );
  } finally {
    await assertNoStagingPaths(nativeDirectory, "native suite completion");
    await rm(nativeDirectory, { recursive: true, force: true });
  }
}

await runNativeConnectorSuite();

if (failures.length > 0) {
  console.error("PowerPoint worker native connector tests failed:");
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log("PowerPoint worker native connector tests passed.");
