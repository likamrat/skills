#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compileReadoutPlan,
  stableSerialize,
  validateDrawingSpec,
} from "./powerpoint-layout.mjs";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const skillRoot = resolve(scriptsDir, "..");
const validator = join(scriptsDir, "validate-readout-plan.mjs");
const samplePath = join(
  skillRoot,
  "assets",
  "examples",
  "lattice-harbor-readout-plan.json",
);
const directory = await mkdtemp(join(tmpdir(), "fde-powerpoint-charts-"));
const failures = [];
const cases = ["positive", "negative", "mixed", "zero", "decimals", "equal"];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function clone(value) {
  return structuredClone(value);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function valuesFor(kind, categoryCount, seriesIndex) {
  return Array.from({ length: categoryCount }, (_, categoryIndex) => {
    const value = categoryIndex + 1 + seriesIndex;
    switch (kind) {
      case "positive":
        return value;
      case "negative":
        return -value;
      case "mixed":
        return categoryIndex % 3 === 0 ? 0 : categoryIndex % 2 ? -value : value;
      case "zero":
        return 0;
      case "decimals":
        return (categoryIndex % 2 ? -1 : 1) * (value / 10 + 0.025);
      case "equal":
        return 7.25;
    }
  });
}

function chartSlide(chartType, categoryCount, seriesCount, dataCase = "mixed") {
  return {
    id: `chart-${chartType}-${categoryCount}-${seriesCount}-${dataCase}`,
    family: "chart",
    title: `${chartType} chart ${categoryCount} by ${seriesCount}`,
    customerSafe: true,
    notes: "Exact fictional chart notes. Sources: [baseline-001], [eval-001].",
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
        values: valuesFor(dataCase, categoryCount, index),
        evidenceIds: [index % 2 ? "eval-001" : "baseline-001"],
      })),
      unit: "Exact units / interval",
      insight: {
        statement: "Exact insight statement; source wording is preserved.",
        evidenceIds: ["baseline-001"],
      },
    },
  };
}

function buildPlan(sample, chart) {
  return {
    ...clone(sample),
    slides: [
      clone(sample.slides.find((slide) => slide.family === "cover")),
      clone(sample.slides.find((slide) => slide.family === "decision")),
      clone(sample.slides.find((slide) => slide.family === "profile")),
      chart,
      clone(sample.slides.find((slide) => slide.family === "evidence")),
    ],
  };
}

function compile(plan, mode = "full") {
  return compileReadoutPlan(plan, {
    sourcePlanSha256: hash(JSON.stringify(plan)),
    mode,
  });
}

function chartFor(spec) {
  const slide = spec.slides.find((item) => item.family === "chart");
  return {
    slide,
    chart: slide?.primitives.find((primitive) => primitive.kind === "nativeChart"),
  };
}

function allNames(value, names = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => allNames(item, names));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if ((key === "name" || key === "swatchName") && typeof item === "string") {
        names.push(item);
      } else {
        allNames(item, names);
      }
    }
  }
  return names;
}

function overlaps(left, right) {
  return (
    left.x < right.x + right.w - 0.0005 &&
    right.x < left.x + left.w - 0.0005 &&
    left.y < right.y + right.h - 0.0005 &&
    right.y < left.y + left.h - 0.0005
  );
}

function assertChart(spec, source, label) {
  const { slide, chart } = chartFor(spec);
  check(Boolean(chart), `${label}: nativeChart missing`);
  if (!chart) return;
  const values = source.content.series.flatMap((series) => series.values);
  check(
    chart.x === 48 &&
      chart.y === 120 &&
      chart.w === 864 &&
      chart.h === 318 &&
      chart.plot.x === 112 &&
      chart.plot.y === 160 &&
      chart.plot.w === 800 &&
      chart.plot.h === 180,
    `${label}: fixed chart geometry changed`,
  );
  check(
    chart.axis.min <= 0 &&
      chart.axis.max >= 0 &&
      chart.axis.ticks.length <= 6 &&
      Number.isFinite(chart.axis.min) &&
      Number.isFinite(chart.axis.max) &&
      Number.isFinite(chart.axis.step),
    `${label}: axis must be finite, zero-inclusive, and at most six ticks`,
  );
  check(
    values.every((value) => value >= chart.axis.min && value <= chart.axis.max),
    `${label}: axis must contain every source value`,
  );
  check(
    chart.unit === source.content.unit &&
      chart.unitLabel.text === source.content.unit &&
      JSON.stringify(chart.insightEvidenceIds) ===
        JSON.stringify(source.content.insight.evidenceIds) &&
      JSON.stringify(chart.categories.map((item) => item.label)) ===
        JSON.stringify(source.content.categories) &&
      JSON.stringify(chart.series.map((item) => item.name)) ===
        JSON.stringify(source.content.series.map((item) => item.name)),
    `${label}: source strings must remain exact`,
  );
  check(
    chart.dataGrid.rows.length === source.content.series.length &&
      chart.dataGrid.rows.every(
        (row) => row.values.length === source.content.categories.length,
      ),
    `${label}: data grid dimensions are incomplete`,
  );
  chart.dataGrid.rows.forEach((row, seriesIndex) =>
    row.values.forEach((cell, categoryIndex) => {
      const expected = source.content.series[seriesIndex].values[categoryIndex];
      check(
        cell.value === expected && cell.labelBox.text === String(expected),
        `${label}: data value ${seriesIndex}/${categoryIndex} was rounded`,
      );
    }),
  );
  if (chart.chartType === "bar") {
    const bars = chart.series.flatMap((series) => series.bars);
    check(
      bars.length === source.content.categories.length * source.content.series.length,
      `${label}: bar count mismatch`,
    );
    bars.forEach((bar) => {
      check(
        bar.x >= chart.plot.x &&
          bar.y >= chart.plot.y &&
          bar.x + bar.w <= chart.plot.x + chart.plot.w + 0.001 &&
          bar.y + bar.h <= chart.plot.y + chart.plot.h + 0.001,
        `${label}: bar outside plot`,
      );
      check(
        bar.value !== 0 || (bar.kind === "line" && bar.h === 1),
        `${label}: zero bar must remain visible`,
      );
      check(bar.value === 0 || bar.h >= 1, `${label}: nonzero bar must remain visible`);
    });
    bars.forEach((left, index) =>
      bars.slice(index + 1).forEach((right) =>
        check(!overlaps(left, right), `${label}: bars overlap`),
      ),
    );
  } else {
    chart.series.forEach((series) => {
      check(
        series.markers.length === source.content.categories.length &&
          series.segments.length === source.content.categories.length - 1,
        `${label}: line marks mismatch`,
      );
      check(
        series.markers.every(
          (marker) =>
            marker.diameter === 6 &&
            marker.cx >= chart.plot.x &&
            marker.cx <= chart.plot.x + chart.plot.w &&
            marker.cy >= chart.plot.y &&
            marker.cy <= chart.plot.y + chart.plot.h,
        ),
        `${label}: marker outside plot`,
      );
      check(
        series.segments.every(
          (segment) => segment.x1 !== segment.x2 || segment.y1 !== segment.y2,
        ),
        `${label}: zero-length line segment`,
      );
    });
  }
  const names = allNames(slide);
  check(
    names.length === new Set(names.map((name) => name.toLowerCase())).size,
    `${label}: names are not globally case-insensitively unique`,
  );
  check(
    slide.notesText ===
      `${source.notes}\r\nEvidence: ${source.evidenceIds.join(", ")}\r\nHuman context: ${source.judgmentIds.join(", ")}`,
    `${label}: notes changed`,
  );
  check(
    slide.primitives.some(
      (primitive) =>
        primitive.role === "chart-insight" &&
        primitive.text === source.content.insight.statement,
    ) &&
      slide.primitives.some(
        (primitive) =>
          primitive.role === "chart-insight-evidence" &&
          primitive.text === source.content.insight.evidenceIds.join(", "),
      ),
    `${label}: insight or evidence changed`,
  );
}

function expectInvalid(label, spec, mutate) {
  const candidate = clone(spec);
  mutate(candidate, chartFor(candidate));
  try {
    validateDrawingSpec(candidate);
    failures.push(`${label}: malformed spec was accepted`);
  } catch (error) {
    check(error.path?.startsWith("$"), `${label}: rejection must include JSON path`);
  }
}

try {
  const sample = JSON.parse(await readFile(samplePath, "utf8"));
  const boundaryPlans = [
    buildPlan(sample, chartSlide("bar", 12, 4, "mixed")),
    buildPlan(sample, chartSlide("line", 12, 4, "mixed")),
  ];
  for (const [index, plan] of boundaryPlans.entries()) {
    const fixturePath = join(directory, `boundary-${index}.json`);
    await writeFile(fixturePath, JSON.stringify(plan));
    const result = spawnSync(process.execPath, [validator, fixturePath], {
      encoding: "utf8",
    });
    check(
      result.status === 0,
      `12x4 ${index ? "line" : "bar"} plan must pass canonical validation:\n${result.stdout}${result.stderr}`,
    );
  }

  let combination = 0;
  for (const chartType of ["bar", "line"]) {
    for (let categoryCount = 2; categoryCount <= 12; categoryCount += 1) {
      for (let seriesCount = 1; seriesCount <= 4; seriesCount += 1) {
        const dataCase = cases[combination % cases.length];
        const source = chartSlide(chartType, categoryCount, seriesCount, dataCase);
        const plan = buildPlan(sample, source);
        const before = JSON.stringify(plan);
        const spec = compile(plan);
        const label = `${chartType} ${categoryCount}x${seriesCount} ${dataCase}`;
        assertChart(spec, source, label);
        check(
          stableSerialize(spec) === stableSerialize(compile(plan)),
          `${label}: serialized bytes are not deterministic`,
        );
        check(JSON.stringify(plan) === before, `${label}: compiler mutated source plan`);
        combination += 1;
      }
    }
  }
  check(combination === 88, "matrix must cover all 88 chart dimensions");

  for (const dataCase of cases) {
    for (const chartType of ["bar", "line"]) {
      const source = chartSlide(chartType, 6, 3, dataCase);
      assertChart(compile(buildPlan(sample, source)), source, `${chartType} ${dataCase}`);
    }
  }
  for (const [label, values] of [
    ["subnormal", [Number.MIN_VALUE, 1e-323]],
    ["negative subnormal", [-Number.MIN_VALUE, 10]],
    ["maximum", [Number.MAX_VALUE, 1]],
    ["mixed maximum", [-Number.MAX_VALUE, Number.MAX_VALUE]],
    ["wide tiny", [1e-20, 1e20]],
  ]) {
    for (const chartType of ["bar", "line"]) {
      const source = chartSlide(chartType, 2, 1, "positive");
      source.content.series[0].values = values;
      assertChart(
        compile(buildPlan(sample, source)),
        source,
        `${chartType} ${label}`,
      );
    }
  }
  for (const [label, values, smallIndex] of [
    ["maximum with tiny negative", [Number.MAX_VALUE, -1], 1],
    ["minimum with tiny positive", [-Number.MAX_VALUE, 1], 1],
  ]) {
    const source = chartSlide("bar", 2, 1, "mixed");
    source.content.series[0].values = values;
    const spec = compile(buildPlan(sample, source));
    assertChart(spec, source, `bar ${label}`);
    const { chart } = chartFor(spec);
    const smallBar = chart.series[0].bars[smallIndex];
    check(
      smallBar.value < 0
        ? smallBar.y >= chart.axis.zeroY - 0.001
        : smallBar.y + smallBar.h <= chart.axis.zeroY + 0.001,
      `${label}: one-point bar must remain on the correct side of zero`,
    );
  }

  const denseSource = chartSlide("bar", 12, 4, "mixed");
  const densePlan = buildPlan(sample, denseSource);
  const smoke = compile(densePlan, "smoke");
  check(
    smoke.selectedSlideFamilies[2] === "chart" &&
      smoke.selectedSlideIds[2] === denseSource.id,
    "smoke selection must choose the deterministically densest chart",
  );

  const barSpec = compile(buildPlan(sample, chartSlide("bar", 12, 4, "mixed")));
  const lineSpec = compile(buildPlan(sample, chartSlide("line", 12, 4, "equal")));
  const mutations = [
    ["unknown chart key", barSpec, (_, { chart }) => (chart.AddChart = true)],
    ["nonfinite value", barSpec, (_, { chart }) => (chart.series[0].bars[0].value = NaN)],
    ["bad axis step", barSpec, (_, { chart }) => (chart.axis.step *= 2)],
    ["bad axis range", barSpec, (_, { chart }) => (chart.axis.min = 1)],
    ["bad zeroY", barSpec, (_, { chart }) => (chart.axis.zeroY += 2)],
    ["value outside domain", barSpec, (_, { chart }) => {
      chart.series[0].bars[0].value = chart.axis.max + 1;
      chart.dataGrid.rows[0].values[0].value = chart.axis.max + 1;
      chart.dataGrid.rows[0].values[0].labelBox.text = String(chart.axis.max + 1);
    }],
    ["data mismatch", barSpec, (_, { chart }) => (chart.dataGrid.rows[0].values[0].value += 1)],
    ["wrong bar kind", barSpec, (_, { chart }) => (chart.series[0].bars[0].kind = "marker")],
    ["wrong bar count", barSpec, (_, { chart }) => chart.series[0].bars.pop()],
    ["bar overlap", barSpec, (_, { chart }) => (chart.series[0].bars[0].x = chart.series[1].bars[0].x)],
    ["bar outside plot", barSpec, (_, { chart }) => (chart.series[0].bars[0].x = 10)],
    ["missing marker", lineSpec, (_, { chart }) => chart.series[0].markers.pop()],
    ["missing segment", lineSpec, (_, { chart }) => chart.series[0].segments.pop()],
    ["duplicate nested name", lineSpec, (_, { chart }) => {
      chart.series[0].markers[1].name = chart.series[0].markers[0].name;
    }],
    ["empty label", lineSpec, (_, { chart }) => (chart.categories[0].labelBox.text = "")],
    ["control label", lineSpec, (_, { chart }) => (chart.categories[0].labelBox.text = "bad\u0001")],
    ["relocated tick label", lineSpec, (_, { chart }) => {
      chart.axis.ticks[0].labelBox.x = 800;
      chart.axis.ticks[0].labelBox.y = 400;
    }],
    ["overlapping data label", lineSpec, (_, { chart }) => {
      chart.dataGrid.rows[0].values[1].labelBox.x =
        chart.dataGrid.rows[0].values[0].labelBox.x;
    }],
    ["unsupported media field", lineSpec, (_, { chart }) => (chart.oleObject = "forbidden")],
    ["undeclared evidence", lineSpec, (_, { chart }) => chart.series[0].evidenceIds.push("not-declared")],
    ["undeclared insight evidence", lineSpec, (_, { chart }) => chart.insightEvidenceIds.push("not-declared")],
    ["insight evidence text mismatch", lineSpec, (_, { slide }) => {
      slide.primitives.find((item) => item.role === "chart-insight-evidence").text =
        "eval-001";
    }],
    ["content footer overlap", lineSpec, (_, { slide }) => {
      slide.primitives.find((item) => item.role === "chart-insight").h = 40;
    }],
  ];
  mutations.forEach(([label, spec, mutate]) => expectInvalid(label, spec, mutate));
} finally {
  await rm(directory, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`PowerPoint chart-family tests failed (${failures.length}):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("PowerPoint chart-family tests passed (88 matrix combinations plus boundary and mutation coverage).");
