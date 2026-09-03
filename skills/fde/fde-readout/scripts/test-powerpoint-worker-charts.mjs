#!/usr/bin/env node

import assert from "node:assert/strict";
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

import {
  compileReadoutPlan,
} from "./powerpoint-layout.mjs";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const skillRoot = resolve(scriptsDir, "..");
const worker = join(scriptsDir, "render-powerpoint-worker.ps1");
const skeletonHelper = join(scriptsDir, "create-powerpoint-skeleton.ps1");
const samplePath = join(
  skillRoot,
  "assets",
  "examples",
  "lattice-harbor-readout-plan.json",
);
const workerSource = await readFile(worker, "utf8");
const failures = [];
const nativeRequested = process.argv.includes("--native");
const nativeUnderMutex = process.argv.includes("--native-under-test-mutex");
let executedPreComMutationCount = 0;

function check(condition, message) {
  if (!condition) failures.push(message);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function valuesFor(categoryCount, seriesIndex) {
  return Array.from({ length: categoryCount }, (_, categoryIndex) => {
    const value = categoryIndex + seriesIndex + 1;
    return categoryIndex % 3 === 0 ? 0 : categoryIndex % 2 ? -value : value;
  });
}

function chartSlide(chartType, categoryCount = 12, seriesCount = 4) {
  return {
    id: `worker-${chartType}-${categoryCount}-${seriesCount}-chart`,
    family: "chart",
    title: `${chartType} worker chart`,
    customerSafe: true,
    notes: `Exact ${chartType} chart notes. Sources: [baseline-001], [eval-001].`,
    evidenceIds: ["baseline-001", "eval-001"],
    judgmentIds: ["judgment-rationale-001"],
    content: {
      chartType,
      categories: Array.from(
        { length: categoryCount },
        (_, index) => `Category ${index + 1}`,
      ),
      series: Array.from({ length: seriesCount }, (_, index) => ({
        name: `Series ${index + 1}`,
        values: valuesFor(categoryCount, index),
        evidenceIds: [index % 2 ? "eval-001" : "baseline-001"],
      })),
      unit: "Exact units / interval",
      insight: {
        statement: "Exact worker chart insight.",
        evidenceIds: ["baseline-001"],
      },
    },
  };
}

function buildPlan(sample, charts = ["bar"]) {
  const plan = {
    ...structuredClone(sample),
    slides: [
      structuredClone(sample.slides.find((slide) => slide.family === "cover")),
      structuredClone(sample.slides.find((slide) => slide.family === "decision")),
      structuredClone(sample.slides.find((slide) => slide.family === "profile")),
      ...charts.map((chart) => (typeof chart === "string" ? chartSlide(chart) : chart)),
      structuredClone(sample.slides.find((slide) => slide.family === "evidence")),
    ],
  };
  let json = JSON.stringify(plan);
  sample.evidence.forEach((entry, index) => {
    json = json.replaceAll(entry.id, `e${index + 1}`);
  });
  return JSON.parse(json);
}

function compile(plan) {
  return compileReadoutPlan(plan, {
    sourcePlanSha256: hash(JSON.stringify(plan)),
    mode: "full",
  });
}

function chartFor(spec) {
  return spec.slides
    .flatMap((slide) => slide.primitives)
    .find((primitive) => primitive.kind === "nativeChart");
}

function primitiveFor(spec, kind, role) {
  const primitive = spec.slides
    .flatMap((slide) => slide.primitives)
    .find(
      (candidate) =>
        candidate.kind === kind && (role === undefined || candidate.role === role),
    );
  assert.ok(primitive, `fixture omits ${role ?? kind} primitive`);
  return primitive;
}

function multiSegmentWorkflowEdge(spec) {
  const groups = new Map();
  for (const primitive of spec.slides.flatMap((slide) => slide.primitives)) {
    if (
      primitive.kind === "line" &&
      primitive.role.startsWith("workflow-edge-")
    ) {
      const segments = groups.get(primitive.role) ?? [];
      segments.push(primitive);
      groups.set(primitive.role, segments);
    }
  }
  const segments = [...groups.values()].find((candidate) => candidate.length > 1);
  assert.ok(segments, "fixture omits a multi-segment workflow edge");
  return segments;
}

function recordNumber(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function roleColor(theme, role) {
  const hex = theme.colors[role].replace(/^#/, "");
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return red + (green << 8) + (blue << 16);
}

const dashStyles = new Map([
  ["solid", 1],
  ["dot", 3],
  ["dash", 4],
  ["dashDot", 5],
]);
const horizontalAlignments = new Map([
  ["left", 1],
  ["center", 2],
  ["right", 3],
]);
const verticalAlignments = new Map([
  ["top", 1],
  ["middle", 3],
  ["bottom", 4],
]);

function lineRecord(line, theme) {
  const horizontalFlip = line.x2 < line.x1 ? -1 : 0;
  const verticalFlip = line.y2 < line.y1 ? -1 : 0;
  return {
    name: line.name,
    geometry: [
      recordNumber(Math.min(line.x1, line.x2)),
      recordNumber(Math.min(line.y1, line.y2)),
      recordNumber(Math.abs(line.x2 - line.x1)),
      recordNumber(Math.abs(line.y2 - line.y1)),
      String(horizontalFlip),
      String(verticalFlip),
    ].join(","),
    content: "",
    style: [
      roleColor(theme, line.colorRole),
      recordNumber(line.transparency),
      recordNumber(line.width),
      dashStyles.get(line.dash),
    ].join(","),
  };
}

function shapeRecord(shape, theme) {
  const fillStyle = shape.fillVisible
    ? `${roleColor(theme, shape.fillColorRole)},${recordNumber(shape.fillTransparency)}`
    : "none";
  const lineStyle = shape.lineVisible
    ? [
        roleColor(theme, shape.lineColorRole),
        recordNumber(shape.lineTransparency),
        recordNumber(shape.lineWidth),
        dashStyles.get(shape.lineDash),
      ].join(",")
    : "none";
  return {
    name: shape.name,
    geometry: [shape.x, shape.y, shape.w, shape.h].map(recordNumber).join(","),
    content: "",
    style: `${fillStyle}|${lineStyle}`,
  };
}

function textRecord(text, theme) {
  return {
    name: text.name,
    geometry: [text.x, text.y, text.w, text.h].map(recordNumber).join(","),
    content: text.text,
    style: [
      theme.fontFamily,
      recordNumber(text.fontSize),
      text.bold ? -1 : 0,
      text.italic ? -1 : 0,
      roleColor(theme, text.colorRole),
      horizontalAlignments.get(text.horizontalAlign),
      verticalAlignments.get(text.verticalAlign),
    ].join(","),
  };
}

function projectLeaf(leaf, theme) {
  if (leaf.kind === "line") return lineRecord(leaf, theme);
  if (leaf.kind === "shape") return shapeRecord(leaf, theme);
  if (leaf.kind === "text") return textRecord(leaf, theme);
  throw new Error(`unsupported projected leaf kind ${leaf.kind}`);
}

function chartTextLeaf(label) {
  return {
    kind: "text",
    ...label,
    italic: false,
    marginLeft: 0,
    marginRight: 0,
    marginTop: 0,
    marginBottom: 0,
    wordWrap: true,
    autoFit: "none",
    maxLines: Math.max(1, Math.floor(label.h / 8)),
  };
}

function chartShapeLeaf({
  name,
  shapeType,
  x,
  y,
  w,
  h,
  fillVisible,
  fillColorRole,
  fillTransparency,
  lineVisible,
  lineColorRole,
  lineTransparency,
  lineWidth,
  lineDash,
}) {
  return {
    kind: "shape",
    name,
    shapeType,
    x,
    y,
    w,
    h,
    fillVisible,
    fillColorRole,
    fillTransparency,
    lineVisible,
    lineColorRole,
    lineTransparency,
    lineWidth,
    lineDash,
  };
}

function chartLineLeaf({
  name,
  x1,
  y1,
  x2,
  y2,
  colorRole,
  width,
  dash,
  transparency,
}) {
  return {
    kind: "line",
    name,
    x1,
    y1,
    x2,
    y2,
    colorRole,
    width,
    dash,
    transparency,
    arrowStart: "none",
    arrowEnd: "none",
  };
}

function chartBoundsName(chartName) {
  if (chartName.endsWith("-native-chart")) {
    return `${chartName.slice(0, -13)}-chart-bounds`;
  }
  return `fde-chart-bounds-${hash(chartName).slice(0, 16)}`;
}

function projectChartLeaves(chart) {
  const leaves = [
    chartShapeLeaf({
      name: chartBoundsName(chart.name),
      shapeType: "rect",
      x: chart.x,
      y: chart.y,
      w: chart.w,
      h: chart.h,
      fillVisible: false,
      fillColorRole: "background",
      fillTransparency: 0,
      lineVisible: false,
      lineColorRole: "line",
      lineTransparency: 0,
      lineWidth: 0.75,
      lineDash: "solid",
    }),
    ...chart.axis.ticks.map(({ gridLine }) =>
      chartLineLeaf({ ...gridLine, dash: gridLine.dash }),
    ),
  ];

  if (chart.chartType === "bar") {
    for (const series of chart.series) {
      for (const bar of series.bars) {
        if (bar.kind === "line") {
          leaves.push(
            chartLineLeaf({
              name: bar.name,
              x1: bar.x,
              y1: bar.y + bar.h / 2,
              x2: bar.x + bar.w,
              y2: bar.y + bar.h / 2,
              colorRole: series.colorRole,
              width: 1,
              dash: "solid",
              transparency: 0,
            }),
          );
        } else {
          leaves.push(
            chartShapeLeaf({
              name: bar.name,
              shapeType: "rect",
              x: bar.x,
              y: bar.y,
              w: bar.w,
              h: bar.h,
              fillVisible: true,
              fillColorRole: series.colorRole,
              fillTransparency: bar.fillTransparency,
              lineVisible: false,
              lineColorRole: series.colorRole,
              lineTransparency: 0,
              lineWidth: 0.75,
              lineDash: "solid",
            }),
          );
        }
      }
    }
  } else {
    for (const series of chart.series) {
      for (const segment of series.segments) {
        leaves.push(
          chartLineLeaf({
            ...segment,
            colorRole: series.colorRole,
            width: 2,
            dash: series.dash,
            transparency: 0,
          }),
        );
      }
    }
  }

  leaves.push(chartLineLeaf({ ...chart.axis.baseline }));

  if (chart.chartType === "line") {
    for (const series of chart.series) {
      for (const marker of series.markers) {
        leaves.push(
          chartShapeLeaf({
            name: marker.name,
            shapeType: "ellipse",
            x: marker.cx - marker.diameter / 2,
            y: marker.cy - marker.diameter / 2,
            w: marker.diameter,
            h: marker.diameter,
            fillVisible: true,
            fillColorRole: series.colorRole,
            fillTransparency: 0,
            lineVisible: true,
            lineColorRole: series.colorRole,
            lineTransparency: 0,
            lineWidth: 0.75,
            lineDash: "solid",
          }),
        );
      }
    }
  }

  for (const entry of chart.legend) {
    const series = chart.series[entry.seriesIndex];
    if (chart.chartType === "bar") {
      leaves.push(
        chartShapeLeaf({
          name: entry.swatchName,
          shapeType: "rect",
          ...entry.swatch,
          fillVisible: true,
          fillColorRole: entry.colorRole,
          fillTransparency: 0,
          lineVisible: false,
          lineColorRole: entry.colorRole,
          lineTransparency: 0,
          lineWidth: 0.75,
          lineDash: "solid",
        }),
      );
    } else {
      leaves.push(
        chartLineLeaf({
          name: entry.swatchName,
          x1: entry.swatch.x,
          y1: entry.swatch.y + entry.swatch.h / 2,
          x2: entry.swatch.x + entry.swatch.w,
          y2: entry.swatch.y + entry.swatch.h / 2,
          colorRole: entry.colorRole,
          width: 2,
          dash: series.dash,
          transparency: 0,
        }),
      );
    }
  }

  leaves.push(
    chartTextLeaf(chart.unitLabel),
    ...chart.axis.ticks.map(({ labelBox }) => chartTextLeaf(labelBox)),
    ...chart.categories.map(({ labelBox }) => chartTextLeaf(labelBox)),
    ...chart.legend.map(({ labelBox }) => chartTextLeaf(labelBox)),
  );
  for (const row of chart.dataGrid.rows) {
    leaves.push(
      chartTextLeaf(row.labelBox),
      ...row.values.map(({ labelBox }) => chartTextLeaf(labelBox)),
    );
  }
  return leaves;
}

function projectSlideRecords(slide, theme) {
  const recursiveRecords = [];
  const nativeChartRecords = [];
  const chartOrders = [];
  for (const primitive of slide.primitives) {
    if (primitive.kind !== "nativeChart") {
      recursiveRecords.push(projectLeaf(primitive, theme));
      continue;
    }
    const groupRecord = {
      name: primitive.name,
      geometry: [primitive.x, primitive.y, primitive.w, primitive.h]
        .map(recordNumber)
        .join(","),
      content: "",
      style: "group",
    };
    const leaves = projectChartLeaves(primitive);
    const leafRecords = leaves.map((leaf) => projectLeaf(leaf, theme));
    recursiveRecords.push(groupRecord, ...leafRecords);
    nativeChartRecords.push(groupRecord, ...leafRecords);
    chartOrders.push({
      group: primitive.name,
      leaves: leaves.map((leaf, index) => ({
        name: leaf.name,
        z: index + 1,
        orientation:
          leaf.kind === "line"
            ? {
                horizontalFlip: leaf.x2 < leaf.x1 ? -1 : 0,
                verticalFlip: leaf.y2 < leaf.y1 ? -1 : 0,
              }
            : null,
      })),
    });
  }
  return { recursiveRecords, nativeChartRecords, chartOrders };
}

function projectionHashes(records) {
  return {
    names: hash(records.map(({ name }) => name).join("\n")),
    geometry: hash(
      records.map(({ name, geometry }) => `${name}|${geometry}`).join("\n"),
    ),
    content: hash(
      records.map(({ name, content }) => `${name}|${content}`).join("\n"),
    ),
    style: hash(
      records.map(({ name, style }) => `${name}|${style}`).join("\n"),
    ),
  };
}

function exactKeys(value, expected, label) {
  try {
    assert.deepStrictEqual(Object.keys(value).sort(), [...expected].sort());
  } catch (error) {
    failures.push(`${label} fields differ: ${error.message}`);
  }
}

function exactValue(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
  } catch (error) {
    failures.push(`${label} differs: ${error.message}`);
  }
}

async function relativeFiles(root, prefix = "") {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await relativeFiles(join(root, entry.name), relative)));
    } else {
      files.push(relative);
    }
  }
  return files.sort();
}

async function assertNoWorkerStage(directory, label) {
  const entries = await readdir(directory);
  check(
    entries.every((entry) => !entry.endsWith(".worker-stage")),
    `${label} left .worker-stage residue: ${entries.join(", ")}`,
  );
}

function runPowerShell(script, args, extraEnv = {}) {
  const effectiveArgs =
    script === worker ? [...args, "-NodeExecutable", process.execPath] : args;
  return spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      ...effectiveArgs,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ...extraEnv },
    },
  );
}

function powerShellPrimitiveHashes(specPath) {
  const escapedPath = specPath.replaceAll("'", "''");
  const command = [
    `$spec = Get-Content -Raw -LiteralPath '${escapedPath}' | ConvertFrom-Json`,
    "$hashes = @()",
    "foreach ($slide in @($spec.slides)) {",
    "  $json = $slide.primitives | ConvertTo-Json -Depth 30 -Compress",
    "  $bytes = [Text.Encoding]::UTF8.GetBytes($json)",
    "  $algorithm = [Security.Cryptography.SHA256]::Create()",
    "  try {",
    "    $hashes += ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()",
    "  } finally {",
    "    $algorithm.Dispose()",
    "  }",
    "}",
    "[Console]::Out.WriteLine(($hashes | ConvertTo-Json -Compress))",
  ].join("\n");
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", command],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || result.stderr !== "") {
    throw new Error(
      `could not derive primitive hashes: ${result.stdout}${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout);
}

function functionSource(name, nextName) {
  const start = workerSource.indexOf(`function ${name} {`);
  const end = workerSource.indexOf(`\nfunction ${nextName} {`, start);
  return start >= 0 && end > start ? workerSource.slice(start, end) : "";
}

for (const [label, pattern] of [
  ["strict native chart validator", /function Assert-NativeChartSpec/],
  ["stable chart leaf manifest", /function Get-NativeChartLeafSpecs/],
  ["editable chart grouping", /function Add-NativeChartPrimitive/],
  ["recursive reopened verification", /function Assert-SlideShapeTree/],
  [
    "top-level collection order verification",
    /\$shape = \$Shapes\.Item\(\$primitiveIndex \+ 1\)[\s\S]*Shape\.Name/,
  ],
  [
    "group-item order verification",
    /GroupItems[\s\S]*chart leaf[\s\S]*z-order does not match[\s\S]*-ExpectedZ 0/,
  ],
  ["recursive geometry hash", /recursiveShapeGeometrySha256/],
  ["recursive content hash", /recursiveShapeContentSha256/],
  ["recursive style hash", /recursiveShapeStyleSha256/],
  ["native chart shape count", /nativeChartShapeCount/],
  ["native chart shape-name hash", /nativeChartShapeNamesSha256/],
  ["cleanup-bound recursive tree hash", /nativeShapesReceipt[\s\S]*recursiveShapeTreeSha256/],
  ["native chart authoring failpoint", /Invoke-TestFailpoint -Stage 'native-chart'/],
  ["native chart reopen failpoint", /Invoke-TestFailpoint -Stage 'chart-reopen'/],
  ["reopen mutation hook", /FDE_POWERPOINT_TEST_MUTATE_NATIVE_CHART_AFTER_REOPEN/],
  [
    "optional mutation hook guard",
    /IsNullOrWhiteSpace\(\$nativeChartMutationMode\)[\s\S]*Invoke-NativeChartTestMutation/,
  ],
  ["line orientation mutation", /'line-orientation'[\s\S]*\.Flip\(1\)/],
  ["nested Shapes release", /nested chart shapes/],
  ["nested Shape release", /nested chart shape/],
  ["nested TextFrame release", /nested legacy text frame/],
  ["nested TextFrame2 release", /nested text frame 2/],
  ["nested TextRange release", /nested text range/],
  ["nested Font release", /nested font/],
  ["nested Fill release", /nested fill/],
  ["nested Line release", /nested line/],
  ["nested Color release", /nested (?:font|fill|line) color/],
]) {
  check(pattern.test(workerSource), `worker omits ${label}`);
}

const chartAuthoringSource = functionSource(
  "Add-NativeChartPrimitive",
  "Format-WorkerRecordNumber",
);
const chartVerificationSource = functionSource(
  "Assert-LeafShape",
  "Get-FiniteTableNumber",
);
check(Boolean(chartAuthoringSource), "chart authoring function could not be isolated");
for (const [label, pattern] of [
  ["native chart object creation", /\bAddChart\b/i],
  ["Excel automation", /\bExcel\b/i],
  ["OLE creation", /\bOLE\b/i],
  ["media creation", /\bAddMediaObject\b|\bMediaFormat\b/i],
  ["picture creation", /\bAddPicture\b/i],
  ["SVG creation", /\bSVG\b/i],
  ["image export", /\.Export\(/],
]) {
  check(!pattern.test(chartAuthoringSource), `chart authoring uses forbidden ${label}`);
}
check(
  !/Release-ComRef[^\r\n]*\$powerPoint|ReleaseComObject\s*\(\s*\$powerPoint/i.test(
    workerSource,
  ),
  "worker must never release the root Application RCW",
);
const workerMutexIndex = workerSource.indexOf("$script:workerMutex.WaitOne");
const nativeChartValidatorDefinitionIndex = workerSource.indexOf(
  "function Assert-NativeChartSpec",
);
const nativeChartValidationIndex = workerSource.lastIndexOf(
  "Assert-NativeChartSpec",
  workerMutexIndex,
);
check(
  nativeChartValidationIndex > nativeChartValidatorDefinitionIndex &&
    nativeChartValidationIndex < workerMutexIndex,
  "native chart validator call must precede the worker mutex and COM activation",
);
for (const validator of [
  "Assert-WorkerDrawingSpecMetadata -SpecObject $specObject",
  "Get-WorkerPublicDrawingSpecJson -SpecJson $specJson",
  "Assert-WorkerSlideMetadata -Slide $slideSpec",
  "Assert-WorkerTextPrimitive",
  "Assert-WorkerShapePrimitive",
  "Assert-WorkerLinePrimitive",
  "Assert-WorkerWorkflowSlideContract -Slide $slideSpec",
]) {
  const validationIndex = workerSource.lastIndexOf(validator, workerMutexIndex);
  check(
    validationIndex >= 0 && validationIndex < workerMutexIndex,
    `${validator} must execute before the worker mutex`,
  );
}
check(
  workerSource.indexOf("$cleanupReceiptObject =") <
    workerSource.indexOf("$recursiveNamesSha256 ="),
  "recursive chart hashes must be computed only after PowerPoint cleanup",
);
check(
  /\$expectedBeginArrowhead[\s\S]*\$Expected\.arrowStart[\s\S]*\$expectedEndArrowhead[\s\S]*\$Expected\.arrowEnd/.test(
    workerSource,
  ),
  "reopened line verification must use expected arrowhead styles",
);
check(
  !/\[int\]\$Expected\.maxLines/.test(workerSource),
  "reopened maxLines verification must not narrow a safe integer to Int32",
);
check(
  !/ZOrderPosition/.test(chartVerificationSource),
  "PowerPoint ZOrderPosition is not stable once grouped shapes exist",
);
check(
  !/(?<!\$)\(\s*if\s*\(/.test(workerSource),
  "worker must not place an if statement in a parenthesized runtime expression",
);

const powershellProbe = spawnSync(
  "powershell",
  ["-NoProfile", "-Command", "exit 0"],
  { encoding: "utf8" },
);
const hasPowerShell = !powershellProbe.error && powershellProbe.status === 0;
if (!hasPowerShell) {
  if (nativeRequested) {
    failures.push("native chart worker tests require Windows PowerShell");
  }
} else {
  const parse = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${worker.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors); if($errors.Count){$errors | ForEach-Object {$_.ToString()}; exit 1}`,
    ],
    { encoding: "utf8" },
  );
  check(
    parse.status === 0,
    `PowerPoint worker does not parse: ${parse.stdout}${parse.stderr}`,
  );
  const topLevelMutation = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$tokens=$null; $errors=$null; $ast=[System.Management.Automation.Language.Parser]::ParseFile('${worker.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors); $target=$ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-NativeChartTestMutation'},$true); if($target.Count -ne 1){exit 1}; $parent=$target[0].Parent; while($null -ne $parent){if($parent -is [System.Management.Automation.Language.FunctionDefinitionAst]){exit 1}; $parent=$parent.Parent}; exit 0`,
    ],
    { encoding: "utf8" },
  );
  check(
    topLevelMutation.status === 0,
    "native chart mutation helper must be defined at script scope",
  );
}

let sample;
if (hasPowerShell) {
  sample = JSON.parse(await readFile(samplePath, "utf8"));
  const directory = await mkdtemp(join(tmpdir(), "fde-chart-worker-static-"));
  const dummySkeleton = join(directory, "dummy-skeleton.pptx");
  await writeFile(dummySkeleton, "no-com-validation-only", "utf8");

  async function validateOnly(
    label,
    spec,
    expectSuccess,
    serialize = JSON.stringify,
  ) {
    const specPath = join(
      directory,
      `${label.replaceAll(/[^a-z0-9]+/gi, "-")}.json`,
    );
    const outputPath = join(
      directory,
      `${label.replaceAll(/[^a-z0-9]+/gi, "-")}-bundle`,
    );
    const bytes = Buffer.from(serialize(spec), "utf8");
    await writeFile(specPath, bytes);
    const result = runPowerShell(worker, [
      "-Spec",
      specPath,
      "-ExpectedSpecSha256",
      hash(bytes),
      "-Skeleton",
      dummySkeleton,
      "-OutputDirectory",
      outputPath,
      "-ValidateSpecOnly",
    ]);
    const outputExists = await access(outputPath).then(
      () => true,
      () => false,
    );
    await assertNoWorkerStage(directory, `${label} validation`);
    if (expectSuccess) {
      let payload;
      const expectedNativeChartCount = spec.slides
        .flatMap((slide) => slide.primitives)
        .filter(({ kind }) => kind === "nativeChart").length;
      try {
        payload = JSON.parse(result.stdout);
      } catch {
        // Reported by the assertion below.
      }
      check(
        result.status === 0 &&
          payload?.status === "SPEC_VALID" &&
          payload.nativeChartCount === expectedNativeChartCount &&
          (expectedNativeChartCount === 0
            ? payload.nativeChartLeafCount === 0
            : payload.nativeChartLeafCount > 0) &&
          result.stderr === "" &&
          !outputExists,
        `${label} did not pass no-COM validation: ${result.stdout}${result.stderr}`,
      );
    } else {
      check(
        result.status !== 0 &&
          result.stdout.trim() === "" &&
          /PowerPoint worker failed:/.test(result.stderr) &&
          !outputExists,
        `${label} mutation did not reject before COM: ${result.stdout}${result.stderr}`,
      );
    }
  }

  try {
    const barSpec = compile(buildPlan(sample, ["bar"]));
    const lineSpec = compile(buildPlan(sample, ["line"]));
    const oneSeriesBarSpec = compile(
      buildPlan(sample, [chartSlide("bar", 2, 1)]),
    );
    const oneSeriesLineSpec = compile(
      buildPlan(sample, [chartSlide("line", 2, 1)]),
    );
    const workflowSpec = compile({
      ...structuredClone(sample),
      slides: ["cover", "decision", "profile", "workflow", "evidence"].map(
        (family) =>
          structuredClone(
            sample.slides.find((slide) => slide.family === family),
          ),
      ),
    });
    await validateOnly("valid-max-bar", barSpec, true);
    await validateOnly("valid-max-line", lineSpec, true);
    await validateOnly("valid-workflow-ordinary", workflowSpec, true);
    const wideMaxLinesSpec = structuredClone(barSpec);
    primitiveFor(wideMaxLinesSpec, "text", "chart-insight").maxLines =
      2_147_483_648;
    await validateOnly("valid-wide-max-lines", wideMaxLinesSpec, true);
    const isoTextChart = chartSlide("bar", 2, 1);
    isoTextChart.content.categories[0] = "2024-01-01T00:00:00Z";
    await validateOnly(
      "valid-iso-text",
      compile(buildPlan(sample, [isoTextChart])),
      true,
    );
    const surrogateTextChart = chartSlide("line", 2, 1);
    surrogateTextChart.content.categories[0] = "\ud800";
    await validateOnly(
      "valid-lone-surrogate-text",
      compile(buildPlan(sample, [surrogateTextChart])),
      true,
    );
    for (const [label, chartType, values] of [
      ["all-zero", "bar", [0, 0]],
      ["subnormal", "line", [Number.MIN_VALUE, 1e-323]],
      ["maximum", "bar", [Number.MAX_VALUE, 1]],
      ["mixed-maximum", "line", [-Number.MAX_VALUE, Number.MAX_VALUE]],
      ["wide-decimal", "bar", [-0.125, 1e20]],
      ["ecmascript-exponent-boundary", "line", [1e21, 1]],
      ["legacy-decimal-parser", "bar", [-22805651213306.066, 1]],
    ]) {
      const chart = chartSlide(chartType, 2, 1);
      chart.content.series[0].values = values;
      await validateOnly(
        `valid-${label}-${chartType}`,
        compile(buildPlan(sample, [chart])),
        true,
      );
    }

    const mutations = [
      ["unknown chart property", barSpec, (chart) => (chart.media = "forbidden")],
      ["wrong-case chart kind", barSpec, (chart) => (chart.kind = "nativechart")],
      ["wrong-case chart type", barSpec, (chart) => (chart.chartType = "BAR")],
      [
        "scalar insight evidence",
        barSpec,
        (chart) => (chart.insightEvidenceIds = chart.insightEvidenceIds[0]),
      ],
      [
        "scalar chart series",
        oneSeriesBarSpec,
        (chart) => (chart.series = chart.series[0]),
      ],
      [
        "scalar series evidence",
        barSpec,
        (chart) =>
          (chart.series[0].evidenceIds = chart.series[0].evidenceIds[0]),
      ],
      [
        "scalar legend",
        oneSeriesBarSpec,
        (chart) => (chart.legend = chart.legend[0]),
      ],
      [
        "scalar data rows",
        oneSeriesBarSpec,
        (chart) => (chart.dataGrid.rows = chart.dataGrid.rows[0]),
      ],
      [
        "scalar line segments",
        oneSeriesLineSpec,
        (chart) => (chart.series[0].segments = chart.series[0].segments[0]),
      ],
      [
        "wrong-case chart alignment",
        barSpec,
        (chart) => (chart.unitLabel.horizontalAlign = "LEFT"),
      ],
      [
        "wrong-case series dash",
        barSpec,
        (chart) => (chart.series[0].dash = "SOLID"),
      ],
      [
        "wrong-case zero bar kind",
        barSpec,
        (chart) => (chart.series[0].bars[0].kind = "LINE"),
      ],
      ["chart bounds", barSpec, (chart) => (chart.w -= 1)],
      [
        "duplicate nested name",
        lineSpec,
        (chart) => (chart.series[0].markers[1].name = chart.series[0].markers[0].name),
      ],
      ["bar outside plot", barSpec, (chart) => (chart.series[0].bars[1].x = 10)],
      [
        "data value mismatch",
        barSpec,
        (chart) => (chart.dataGrid.rows[0].values[1].value += 1),
      ],
      [
        "data label mismatch",
        barSpec,
        (chart) => (chart.dataGrid.rows[0].values[1].labelBox.text = "not-a-number"),
      ],
      [
        "noncanonical numeric label",
        barSpec,
        (chart) =>
          (chart.dataGrid.rows[0].values[2].labelBox.text = "3.0000000000000001"),
      ],
      ["noncanonical axis", barSpec, (chart) => (chart.axis.step *= 2)],
      [
        "near-equal axis value",
        barSpec,
        (chart) =>
          (chart.axis.step += Math.abs(chart.axis.step) * Number.EPSILON),
      ],
      ["missing line segment", lineSpec, (chart) => chart.series[0].segments.pop()],
      [
        "control label",
        lineSpec,
        (chart) => (chart.categories[0].labelBox.text = "bad\u0001"),
      ],
      [
        "undeclared evidence",
        lineSpec,
        (chart) => chart.series[0].evidenceIds.push("not-declared"),
      ],
      ["unknown color role", barSpec, (chart) => (chart.series[0].colorRole = "nope")],
      ["primitive z-order", barSpec, (chart) => (chart.z += 1)],
      ["string primitive z", barSpec, (chart) => (chart.z = String(chart.z))],
      ["string category index", barSpec, (chart) => (chart.categories[0].index = "0")],
      ["fractional series index", barSpec, (chart) => (chart.series[0].index = 0.5)],
      [
        "unsafe mark category index",
        barSpec,
        (chart) => (chart.series[0].bars[0].categoryIndex = Number.MAX_SAFE_INTEGER + 1),
      ],
      [
        "string chart font size",
        barSpec,
        (chart) => (chart.unitLabel.fontSize = "8"),
      ],
      [
        "string chart rotation",
        barSpec,
        (chart) => (chart.unitLabel.rotation = "0"),
      ],
      [
        "string legend series index",
        barSpec,
        (chart) => (chart.legend[0].seriesIndex = "0"),
      ],
      [
        "unsafe data row series index",
        barSpec,
        (chart) =>
          (chart.dataGrid.rows[0].seriesIndex = Number.MAX_SAFE_INTEGER + 1),
      ],
      [
        "fractional data cell category index",
        barSpec,
        (chart) => (chart.dataGrid.rows[0].values[0].categoryIndex = 0.5),
      ],
      [
        "string segment category index",
        lineSpec,
        (chart) => (chart.series[0].segments[0].fromCategoryIndex = "0"),
      ],
      [
        "unsafe marker category index",
        lineSpec,
        (chart) =>
          (chart.series[0].markers[0].categoryIndex = Number.MAX_SAFE_INTEGER + 1),
      ],
      [
        "string nested line width",
        lineSpec,
        (chart) => (chart.axis.baseline.width = "1"),
      ],
      [
        "string data grid row height",
        barSpec,
        (chart) => (chart.dataGrid.rowHeight = String(chart.dataGrid.rowHeight)),
      ],
      [
        "string bar transparency",
        barSpec,
        (chart) => (chart.series[0].bars[0].fillTransparency = "0"),
      ],
    ];
    for (const [label, source, mutate] of mutations) {
      const candidate = structuredClone(source);
      mutate(chartFor(candidate));
      await validateOnly(label, candidate, false);
    }
    executedPreComMutationCount += mutations.length;

    const ordinaryMutations = [
      ["unknown deck property", barSpec, (spec) => (spec.extra = "forbidden")],
      ["numeric schema version", barSpec, (spec) => (spec.schemaVersion = 1)],
      ["string stage width", barSpec, (spec) => (spec.stage.width = "960")],
      ["boolean stage height", barSpec, (spec) => (spec.stage.height = true)],
      ["numeric plan version", barSpec, (spec) => (spec.source.planVersion = 1)],
      ["string unbranded", barSpec, (spec) => (spec.theme.unbranded = "false")],
      ["numeric theme color", barSpec, (spec) => (spec.theme.colors.ink = 0)],
      [
        "scalar selected slide IDs",
        barSpec,
        (spec) => (spec.selectedSlideIds = spec.selectedSlideIds[0]),
      ],
      [
        "string source index",
        barSpec,
        (spec) => (spec.slides[0].sourceIndex = "1"),
      ],
      [
        "fractional source index",
        barSpec,
        (spec) => (spec.slides[0].sourceIndex = 1.5),
      ],
      [
        "unsafe source index",
        barSpec,
        (spec) => (spec.slides[0].sourceIndex = Number.MAX_SAFE_INTEGER + 1),
      ],
      [
        "string customer safe",
        barSpec,
        (spec) => (spec.slides[0].customerSafe = "true"),
      ],
      [
        "boolean background color role",
        barSpec,
        (spec) => (spec.slides[0].backgroundColorRole = false),
      ],
      [
        "wrong-case slide family",
        barSpec,
        (spec) => {
          spec.slides[0].family = "COVER";
          spec.selectedSlideFamilies[0] = "COVER";
        },
      ],
      [
        "scalar evidence IDs",
        barSpec,
        (spec) => (spec.slides[0].evidenceIds = "baseline-001"),
      ],
      [
        "boolean judgment ID",
        barSpec,
        (spec) => (spec.slides[0].judgmentIds[0] = false),
      ],
      [
        "boolean ordinary kind",
        barSpec,
        (spec) => (primitiveFor(spec, "text").kind = false),
      ],
      [
        "wrong-case ordinary kind",
        barSpec,
        (spec) => (primitiveFor(spec, "text").kind = "TEXT"),
      ],
      [
        "unknown ordinary property",
        barSpec,
        (spec) => (primitiveFor(spec, "text").extra = "forbidden"),
      ],
      [
        "uppercase ordinary name",
        barSpec,
        (spec) => (primitiveFor(spec, "text").name = "fde-Uppercase-name"),
      ],
      [
        "boolean ordinary role",
        barSpec,
        (spec) => (primitiveFor(spec, "text").role = false),
      ],
      [
        "string ordinary z",
        barSpec,
        (spec) => (primitiveFor(spec, "text").z = "1"),
      ],
      [
        "fractional ordinary z",
        barSpec,
        (spec) => (primitiveFor(spec, "text").z = 1.5),
      ],
      [
        "string text x",
        barSpec,
        (spec) => (primitiveFor(spec, "text").x = "48"),
      ],
      [
        "boolean text y",
        barSpec,
        (spec) => (primitiveFor(spec, "text").y = true),
      ],
      [
        "string chart insight font size",
        barSpec,
        (spec) => (primitiveFor(spec, "text", "chart-insight").fontSize = "11"),
      ],
      [
        "string chart insight bold",
        barSpec,
        (spec) => (primitiveFor(spec, "text", "chart-insight").bold = "false"),
      ],
      [
        "string text rotation",
        barSpec,
        (spec) => (primitiveFor(spec, "text").rotation = "0"),
      ],
      [
        "wrong-case text alignment",
        barSpec,
        (spec) => (primitiveFor(spec, "text").horizontalAlign = "LEFT"),
      ],
      [
        "string text margin",
        barSpec,
        (spec) => (primitiveFor(spec, "text").marginLeft = "0"),
      ],
      [
        "single-overflow text margin",
        barSpec,
        (spec) => (primitiveFor(spec, "text").marginLeft = 1e308),
      ],
      [
        "fractional max lines",
        barSpec,
        (spec) => (primitiveFor(spec, "text").maxLines = 1.5),
      ],
      [
        "unsafe max lines",
        barSpec,
        (spec) =>
          (primitiveFor(spec, "text").maxLines = Number.MAX_SAFE_INTEGER + 1),
      ],
      [
        "string word wrap",
        barSpec,
        (spec) => (primitiveFor(spec, "text").wordWrap = "true"),
      ],
      [
        "string shape fill visibility",
        barSpec,
        (spec) => (primitiveFor(spec, "shape").fillVisible = "true"),
      ],
      [
        "wrong-case shape type",
        barSpec,
        (spec) => (primitiveFor(spec, "shape").shapeType = "RECT"),
      ],
      [
        "string shape transparency",
        barSpec,
        (spec) => (primitiveFor(spec, "shape").fillTransparency = "0"),
      ],
      [
        "boolean shape line width",
        barSpec,
        (spec) => (primitiveFor(spec, "shape").lineWidth = false),
      ],
      [
        "single-overflow shape line width",
        barSpec,
        (spec) => (primitiveFor(spec, "shape").lineWidth = 1e308),
      ],
      [
        "single-underflow box width",
        barSpec,
        (spec) => (primitiveFor(spec, "shape", "cover-rail").w = 1e-50),
      ],
      [
        "boolean shape dash",
        barSpec,
        (spec) => (primitiveFor(spec, "shape").lineDash = true),
      ],
      [
        "string line x1",
        barSpec,
        (spec) => (primitiveFor(spec, "line").x1 = "48"),
      ],
      [
        "boolean line y1",
        barSpec,
        (spec) => (primitiveFor(spec, "line").y1 = true),
      ],
      [
        "string line width",
        barSpec,
        (spec) => (primitiveFor(spec, "line").width = "1"),
      ],
      [
        "single-overflow line width",
        barSpec,
        (spec) => (primitiveFor(spec, "line").width = 1e308),
      ],
      [
        "single-underflow line width",
        barSpec,
        (spec) => (primitiveFor(spec, "line").width = 1e-50),
      ],
      [
        "single-collapsed line geometry",
        barSpec,
        (spec) => {
          const line = primitiveFor(spec, "line", "accent-rail");
          line.x2 = line.x1 + 0.000001;
          line.y2 = line.y1;
        },
      ],
      [
        "boolean line transparency",
        barSpec,
        (spec) => (primitiveFor(spec, "line").transparency = false),
      ],
      [
        "numeric line dash",
        barSpec,
        (spec) => (primitiveFor(spec, "line").dash = 1),
      ],
      [
        "wrong-case line dash",
        barSpec,
        (spec) => (primitiveFor(spec, "line").dash = "SOLID"),
      ],
      [
        "boolean line arrow end",
        barSpec,
        (spec) => (primitiveFor(spec, "line").arrowEnd = false),
      ],
      [
        "string workflow edge index",
        workflowSpec,
        (spec) =>
          (primitiveFor(spec, "line", "workflow-edge-system-01").edgeIndex =
            "1"),
      ],
      [
        "workflow node style",
        workflowSpec,
        (spec) =>
          (primitiveFor(
            spec,
            "shape",
            "workflow-node-source",
          ).fillColorRole = "risk"),
      ],
      [
        "workflow edge style",
        workflowSpec,
        (spec) =>
          (primitiveFor(spec, "line", "workflow-edge-system-01").width = 2),
      ],
      [
        "intermediate workflow arrow",
        workflowSpec,
        (spec) => (multiSegmentWorkflowEdge(spec)[0].arrowEnd = "open"),
      ],
      [
        "missing terminal workflow arrow",
        workflowSpec,
        (spec) => (multiSegmentWorkflowEdge(spec).at(-1).arrowEnd = "none"),
      ],
      [
        "detached workflow endpoint",
        workflowSpec,
        (spec) => {
          const terminal = multiSegmentWorkflowEdge(spec).at(-1);
          if (terminal.x1 === terminal.x2) {
            terminal.y2 = (terminal.y1 + terminal.y2) / 2;
          } else {
            terminal.x2 = (terminal.x1 + terminal.x2) / 2;
          }
        },
      ],
      [
        "fractional workflow segment index",
        workflowSpec,
        (spec) =>
          (primitiveFor(spec, "line", "workflow-edge-system-01").segmentIndex =
            1.5),
      ],
      [
        "unsafe workflow edge index",
        workflowSpec,
        (spec) =>
          (primitiveFor(spec, "line", "workflow-edge-system-01").edgeIndex =
            Number.MAX_SAFE_INTEGER + 1),
      ],
      [
        "diagonal workflow segment",
        workflowSpec,
        (spec) => {
          const edge = primitiveFor(spec, "line", "workflow-edge-system-01");
          edge.x2 += 1;
          edge.y2 += 1;
        },
      ],
    ];
    for (const [label, source, mutate] of ordinaryMutations) {
      const candidate = structuredClone(source);
      mutate(candidate);
      await validateOnly(label, candidate, false);
    }
    executedPreComMutationCount += ordinaryMutations.length;

    const lexicalFractionSpec = structuredClone(barSpec);
    primitiveFor(lexicalFractionSpec, "text").maxLines = 1;
    await validateOnly(
      "lexical fractional max lines",
      lexicalFractionSpec,
      false,
      (spec) => {
        const json = JSON.stringify(spec);
        const integerToken = '"maxLines":1';
        assert.ok(json.includes(integerToken), "lexical fraction fixture token missing");
        return json.replace(integerToken, '"maxLines":1.00000000000000001e0');
      },
    );
    executedPreComMutationCount += 1;

    await validateOnly(
      "lexical fractional stage width",
      barSpec,
      false,
      (spec) => {
        const json = JSON.stringify(spec);
        const stageToken = '"stage":{"width":960,"height":540}';
        assert.ok(json.includes(stageToken), "stage token fixture missing");
        return json.replace(
          stageToken,
          '"stage":{"width":960.00000000000000001e0,"height":540}',
        );
      },
    );
    executedPreComMutationCount += 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (nativeRequested && !nativeUnderMutex) {
  if (failures.length > 0) {
    console.error("PowerPoint chart worker static tests failed:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  const command = [
    "$mutex = [Threading.Mutex]::new($false, 'Local\\FdeReadoutPowerPointWorkerNativeTest')",
    "$held = $false",
    "$status = 1",
    "try {",
    "  try { $held = $mutex.WaitOne([TimeSpan]::FromSeconds(30)) } catch [Threading.AbandonedMutexException] { $held = $true }",
    "  if (-not $held) { throw 'Timed out waiting for the native worker test mutex.' }",
    `  & '${process.execPath.replaceAll("'", "''")}' '${fileURLToPath(import.meta.url).replaceAll("'", "''")}' --native --native-under-test-mutex`,
    "  $status = $LASTEXITCODE",
    "}",
    "finally {",
    "  if ($held) { $mutex.ReleaseMutex() }",
    "  $mutex.Dispose()",
    "}",
    "exit $status",
  ].join("\n");
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8" },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

if (!nativeRequested) {
  if (failures.length > 0) {
    console.error("PowerPoint chart worker static tests failed:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  const detail = hasPowerShell
    ? `12x4 boundaries, numeric edges, and ${executedPreComMutationCount} pre-COM mutations`
    : "source-only checks; Windows PowerShell parser and pre-COM mutations were unavailable";
  console.log(`PowerPoint chart worker static tests passed (${detail}).`);
  process.exit(0);
}

const nativeDirectory = await mkdtemp(join(tmpdir(), "fde-chart-worker-native-"));
try {
  function powerPointProcessCount() {
    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "@(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue).Count",
      ],
      { encoding: "utf8" },
    );
    return result.status === 0 ? Number(result.stdout.trim()) : Number.NaN;
  }

  const baseline = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "@(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue).Count",
    ],
    { encoding: "utf8" },
  );
  check(
    baseline.status === 0 && Number(baseline.stdout.trim()) === 0,
    "native chart suite requires a fresh zero-PowerPoint baseline",
  );

  const plan = buildPlan(sample, ["bar", "line"]);
  check(
    plan.evidence.every((entry) => entry.id.length <= 3),
    "native chart fixture evidence IDs must remain compact",
  );
  const spec = compile(plan);
  const planPath = join(nativeDirectory, "plan.json");
  const specPath = join(nativeDirectory, "spec.json");
  const skeletonPath = join(nativeDirectory, "skeleton.pptx");
  const specBytes = Buffer.from(JSON.stringify(spec), "utf8");
  const slideProjections = spec.slides.map((slide) => {
    const projection = projectSlideRecords(slide, spec.theme);
    return {
      ...projection,
      recursiveHashes: projectionHashes(projection.recursiveRecords),
      nativeChartHashes: projectionHashes(projection.nativeChartRecords),
    };
  });
  const chartProjections = slideProjections.flatMap(({ chartOrders }) => chartOrders);
  exactValue(chartProjections.length, 2, "projected chart group count");
  for (const [chartIndex, projection] of chartProjections.entries()) {
    const names = [projection.group, ...projection.leaves.map(({ name }) => name)];
    exactValue(
      new Set(names).size,
      names.length,
      `projected chart ${chartIndex + 1} recursive name uniqueness`,
    );
    exactValue(
      projection.leaves.map(({ z }) => z),
      Array.from({ length: projection.leaves.length }, (_, index) => index + 1),
      `projected chart ${chartIndex + 1} leaf z-order`,
    );
    for (const leaf of projection.leaves.filter(({ orientation }) => orientation)) {
      const record = slideProjections
        .flatMap(({ nativeChartRecords }) => nativeChartRecords)
        .find(({ name }) => name === leaf.name);
      exactValue(
        record.geometry.split(",").slice(-2).map(Number),
        [leaf.orientation.horizontalFlip, leaf.orientation.verticalFlip],
        `projected line orientation ${leaf.name}`,
      );
    }
  }
  await writeFile(planPath, JSON.stringify(plan), "utf8");
  await writeFile(specPath, specBytes);
  const expectedPrimitiveHashes = powerShellPrimitiveHashes(specPath);
  exactValue(
    expectedPrimitiveHashes.length,
    spec.slides.length,
    "primitive hash projection count",
  );

  if (failures.length === 0) {
    const skeleton = runPowerShell(skeletonHelper, [
      "-Plan",
      planPath,
      "-Output",
      skeletonPath,
    ]);
    check(
      skeleton.status === 0,
      `native chart skeleton failed: ${skeleton.stdout}${skeleton.stderr}`,
    );
  }

  if (failures.length === 0) {
    const bundle = join(nativeDirectory, "pass-bundle");
    const result = runPowerShell(worker, [
      "-Spec",
      specPath,
      "-ExpectedSpecSha256",
      hash(specBytes),
      "-Skeleton",
      skeletonPath,
      "-OutputDirectory",
      bundle,
    ]);
    await assertNoWorkerStage(nativeDirectory, "native chart success");
    let stdoutReport;
    try {
      stdoutReport = JSON.parse(result.stdout);
    } catch {
      // Reported below.
    }
    check(
      result.status === 0 &&
        result.stderr === "" &&
        stdoutReport?.status === "WORKER_PASS",
      `native chart pass report is invalid: ${result.stdout}${result.stderr}`,
    );
    if (result.status === 0 && stdoutReport?.status === "WORKER_PASS") {
      const reportPath = join(bundle, "worker-report.json");
      const persistedReport = JSON.parse(await readFile(reportPath, "utf8"));
      exactValue(
        persistedReport,
        stdoutReport,
        "stdout and persisted worker reports",
      );
      exactKeys(
        stdoutReport,
        [
          "status",
          "stagingEvidence",
          "worker",
          "spec",
          "specSha256",
          "skeleton",
          "skeletonSha256",
          "presentation",
          "presentationSha256",
          "renderDirectory",
          "report",
          "contactSheet",
          "contactSheetSha256",
          "selectedSlideIds",
          "selectedSlideFamilies",
          "connectors",
          "slides",
          "nativeShapes",
          "cleanup",
          "elapsedMilliseconds",
        ],
        "worker report",
      );
      exactKeys(
        stdoutReport.nativeShapes,
        [
          "recursiveShapeCount",
          "nativeChartShapeCount",
          "recursiveShapeTreeSha256",
        ],
        "native-shapes receipt",
      );
      exactKeys(
        stdoutReport.cleanup,
        [
          "ownedProcessId",
          "ownedProcessStartUtc",
          "ownedProcessPath",
          "exited",
          "mode",
          "graceSeconds",
          "contaminationDetected",
          "releaseErrors",
        ],
        "cleanup receipt",
      );
      const emptyArraySha256 = hash("[]");
      const expectedConnectorSlides = spec.slides.map((slide, index) => ({
        index: index + 1,
        id: slide.id,
        family: slide.family,
        routeCount: 0,
        segmentCount: 0,
        connectorPrimitiveSha256: emptyArraySha256,
        routeMetadataSha256: emptyArraySha256,
        pointSequenceSha256: emptyArraySha256,
        costStatus: "not-declared-by-fde-drawing-spec/1.0",
        routes: [],
      }));
      const expectedConnectors = {
        drawingNameCount: spec.slides.reduce(
          (count, slide) => count + slide.primitives.length,
          0,
        ),
        slideCount: spec.slides.length,
        routeCount: 0,
        segmentCount: 0,
        primitiveSha256: emptyArraySha256,
        routeMetadataSha256: emptyArraySha256,
        pointSequenceSha256: emptyArraySha256,
        costStatus: "not-declared-by-fde-drawing-spec/1.0",
        reopenedExactVerification: true,
        slides: expectedConnectorSlides,
      };
      exactValue(
        stdoutReport.connectors,
        expectedConnectors,
        "exact zero-route connector receipt",
      );

      const expectedBundleFiles = [
        "readout.pptx",
        "worker-report.json",
        "native-render/contact-sheet.png",
        ...spec.slides.map(
          (_, index) => `native-render/slide-${String(index + 1).padStart(3, "0")}.png`,
        ),
      ].sort();
      exactValue(
        await relativeFiles(bundle),
        expectedBundleFiles,
        "published native chart bundle files",
      );

      const expectedSlides = await Promise.all(
        spec.slides.map(async (slide, index) => {
          const projection = slideProjections[index];
          const render = `slide-${String(index + 1).padStart(3, "0")}.png`;
          const renderPath = join(bundle, "native-render", render);
          return {
            index: index + 1,
            id: slide.id,
            family: slide.family,
            backgroundColorRole: slide.backgroundColorRole,
            primitiveCount: slide.primitives.length,
            primitiveSha256: expectedPrimitiveHashes[index],
            shapeCount: slide.primitives.length,
            shapeNamesSha256: hash(
              slide.primitives.map(({ name }) => name).join("\n"),
            ),
            recursiveShapeCount: projection.recursiveRecords.length,
            recursiveShapeNamesSha256: projection.recursiveHashes.names,
            recursiveShapeGeometrySha256: projection.recursiveHashes.geometry,
            recursiveShapeContentSha256: projection.recursiveHashes.content,
            recursiveShapeStyleSha256: projection.recursiveHashes.style,
            nativeChartShapeCount: projection.nativeChartRecords.length,
            nativeChartShapeNamesSha256: projection.nativeChartHashes.names,
            nativeTableCount: 0,
            nativeTableCellCount: 0,
            connectorRouteCount: 0,
            connectorSegmentCount: 0,
            connectorPrimitiveSha256:
              expectedConnectorSlides[index].connectorPrimitiveSha256,
            connectorRouteMetadataSha256:
              expectedConnectorSlides[index].routeMetadataSha256,
            connectorPointSequenceSha256:
              expectedConnectorSlides[index].pointSequenceSha256,
            connectorCostStatus:
              expectedConnectorSlides[index].costStatus,
            render,
            renderSha256: hash(await readFile(renderPath)),
            notesSha256: hash(slide.notesText.replace(/\r\n|\n/g, "\r")),
            overflow: false,
          };
        }),
      );
      for (const [index, slideReport] of stdoutReport.slides.entries()) {
        exactKeys(
          slideReport,
          [
            "index",
            "id",
            "family",
            "backgroundColorRole",
            "primitiveCount",
            "primitiveSha256",
            "shapeCount",
            "shapeNamesSha256",
            "recursiveShapeCount",
            "recursiveShapeNamesSha256",
            "recursiveShapeGeometrySha256",
            "recursiveShapeContentSha256",
            "recursiveShapeStyleSha256",
            "nativeChartShapeCount",
            "nativeChartShapeNamesSha256",
            "nativeTableCount",
            "nativeTableCellCount",
            "connectorRouteCount",
            "connectorSegmentCount",
            "connectorPrimitiveSha256",
            "connectorRouteMetadataSha256",
            "connectorPointSequenceSha256",
            "connectorCostStatus",
            "render",
            "renderSha256",
            "notesSha256",
            "overflow",
          ],
          `slide report ${index + 1}`,
        );
      }
      exactValue(stdoutReport.slides, expectedSlides, "exact slide receipts");

      const expectedNativeShapes = {
        recursiveShapeCount: slideProjections.reduce(
          (total, projection) => total + projection.recursiveRecords.length,
          0,
        ),
        nativeChartShapeCount: slideProjections.reduce(
          (total, projection) => total + projection.nativeChartRecords.length,
          0,
        ),
        recursiveShapeTreeSha256: hash(
          spec.slides
            .map(
              (slide, index) =>
                `${slide.id}|${slideProjections[index].recursiveHashes.names}|${slideProjections[index].recursiveHashes.geometry}|${slideProjections[index].recursiveHashes.content}|${slideProjections[index].recursiveHashes.style}`,
            )
            .join("\n"),
        ),
      };
      exactValue(
        stdoutReport.nativeShapes,
        expectedNativeShapes,
        "exact native-shapes receipt",
      );

      const readoutPath = join(bundle, "readout.pptx");
      const contactSheetPath = join(bundle, "native-render", "contact-sheet.png");
      exactValue(stdoutReport.status, "WORKER_PASS", "worker status");
      exactValue(stdoutReport.stagingEvidence, true, "staging evidence");
      exactValue(
        stdoutReport.worker,
        "fde-powerpoint-native-shapes/2.0",
        "worker identity",
      );
      exactValue(stdoutReport.spec, specPath, "worker spec path");
      exactValue(stdoutReport.specSha256, hash(specBytes), "worker spec hash");
      exactValue(stdoutReport.skeleton, skeletonPath, "worker skeleton path");
      exactValue(
        stdoutReport.skeletonSha256,
        hash(await readFile(skeletonPath)),
        "worker skeleton hash",
      );
      exactValue(stdoutReport.presentation, readoutPath, "presentation path");
      exactValue(
        stdoutReport.presentationSha256,
        hash(await readFile(readoutPath)),
        "presentation hash",
      );
      exactValue(
        stdoutReport.renderDirectory,
        join(bundle, "native-render"),
        "render directory",
      );
      exactValue(stdoutReport.report, reportPath, "persisted report path");
      exactValue(
        stdoutReport.contactSheet,
        contactSheetPath,
        "contact-sheet path",
      );
      exactValue(
        stdoutReport.contactSheetSha256,
        hash(await readFile(contactSheetPath)),
        "contact-sheet hash",
      );
      exactValue(
        stdoutReport.selectedSlideIds,
        spec.selectedSlideIds,
        "selected slide IDs",
      );
      exactValue(
        stdoutReport.selectedSlideFamilies,
        spec.selectedSlideFamilies,
        "selected slide families",
      );
      check(
        Number.isSafeInteger(stdoutReport.cleanup.ownedProcessId) &&
          stdoutReport.cleanup.ownedProcessId > 0 &&
          /^\d{4}-\d{2}-\d{2}T.*Z$/.test(
            stdoutReport.cleanup.ownedProcessStartUtc,
          ) &&
          /^[A-Za-z]:\\.+\\POWERPNT\.EXE$/i.test(
            stdoutReport.cleanup.ownedProcessPath,
          ) &&
          stdoutReport.cleanup.exited === true &&
          ["graceful", "forced"].includes(stdoutReport.cleanup.mode) &&
          stdoutReport.cleanup.graceSeconds === 5 &&
          stdoutReport.cleanup.contaminationDetected === false &&
          Array.isArray(stdoutReport.cleanup.releaseErrors) &&
          stdoutReport.cleanup.releaseErrors.length === 0 &&
          Number.isSafeInteger(stdoutReport.elapsedMilliseconds) &&
          stdoutReport.elapsedMilliseconds >= 0,
        `cleanup or elapsed receipt is invalid: ${JSON.stringify(stdoutReport.cleanup)}`,
      );
    }
  }

  if (failures.length === 0) {
    for (const stage of ["native-chart", "chart-reopen"]) {
      const bundle = join(nativeDirectory, `fail-${stage}`);
      const result = runPowerShell(
        worker,
        [
          "-Spec",
          specPath,
          "-ExpectedSpecSha256",
          hash(specBytes),
          "-Skeleton",
          skeletonPath,
          "-OutputDirectory",
          bundle,
          "-FailAfter",
          stage,
        ],
        { FDE_POWERPOINT_TEST_FAILPOINTS: "1" },
      );
      await assertNoWorkerStage(
        nativeDirectory,
        `native chart failpoint ${stage}`,
      );
      check(
        result.status !== 0 &&
          result.stdout.trim() === "" &&
          result.stderr.includes(`Test failpoint after ${stage}`) &&
          /PowerPoint cleanup: PID \d+ start [^ ]+ exited via (?:graceful|forced)\./.test(
            result.stderr,
          ) &&
          !result.stderr.includes("Cleanup failed:") &&
          powerPointProcessCount() === 0 &&
          !(await access(bundle).then(
            () => true,
            () => false,
          )),
        `native chart failpoint ${stage} did not fail cleanly: ${result.stdout}${result.stderr}`,
      );
    }
  }

  if (failures.length === 0) {
    const mutations = new Map([
      ["geometry", /Native chart left differs/],
      ["content", /text content differs/],
      ["style", /(?:line|fill) style differs/],
      ["nested-name", /name or z-order does not match/],
      ["z-order", /name or z-order does not match/],
      ["line-orientation", /line orientation differs/],
    ]);
    for (const [mode, expectedError] of mutations) {
      const bundle = join(nativeDirectory, `mutation-${mode}`);
      const result = runPowerShell(
        worker,
        [
          "-Spec",
          specPath,
          "-ExpectedSpecSha256",
          hash(specBytes),
          "-Skeleton",
          skeletonPath,
          "-OutputDirectory",
          bundle,
        ],
        {
          FDE_POWERPOINT_TEST_FAILPOINTS: "1",
          FDE_POWERPOINT_TEST_MUTATE_NATIVE_CHART_AFTER_REOPEN: mode,
        },
      );
      await assertNoWorkerStage(
        nativeDirectory,
        `native chart ${mode} mutation`,
      );
      check(
        result.status !== 0 &&
          result.stdout.trim() === "" &&
          expectedError.test(result.stderr) &&
          /PowerPoint cleanup: PID \d+ start [^ ]+ exited via (?:graceful|forced)\./.test(
            result.stderr,
          ) &&
          !result.stderr.includes("Cleanup failed:") &&
          powerPointProcessCount() === 0 &&
          !(await access(bundle).then(
            () => true,
            () => false,
          )),
        `native chart ${mode} mutation escaped reopen verification: ${result.stdout}${result.stderr}`,
      );
    }
  }
} finally {
  await rm(nativeDirectory, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("PowerPoint chart worker native tests failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(
  "PowerPoint chart worker native suite passed (12x4 bar/line, failpoints, and reopen mutations).",
);
