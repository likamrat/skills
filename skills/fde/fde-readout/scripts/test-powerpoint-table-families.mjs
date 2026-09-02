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
const directory = await mkdtemp(join(tmpdir(), "fde-powerpoint-tables-"));
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function clone(value) {
  return structuredClone(value);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function tableSlide(columnCount, rowCount) {
  return {
    id: `native-table-${columnCount}-${rowCount}`,
    family: "table",
    title: `Native table ${columnCount} by ${rowCount}`,
    customerSafe: true,
    notes: "Fictional table source. Sources: [baseline-001], [eval-001].",
    evidenceIds: ["baseline-001", "eval-001"],
    judgmentIds: ["judgment-rationale-001"],
    content: {
      columns: Array.from(
        { length: columnCount },
        (_, index) => `Column ${index + 1}`,
      ),
      rows: Array.from({ length: rowCount }, (_, rowIndex) => ({
        cells: Array.from(
          { length: columnCount },
          (_, columnIndex) => `R${rowIndex + 1}C${columnIndex + 1}`,
        ),
        evidenceIds: [rowIndex % 2 ? "eval-001" : "baseline-001"],
      })),
      insight: {
        statement: `Insight for ${columnCount} columns and ${rowCount} rows.`,
        evidenceIds: ["baseline-001"],
      },
    },
  };
}

function evaluationSlide(sample, caseCount) {
  const source = clone(sample.slides.find((slide) => slide.family === "evaluation"));
  source.id = `native-evaluation-${caseCount}`;
  source.content.cases = Array.from({ length: caseCount }, (_, index) => {
    const item = clone(
      source.content.cases[index % source.content.cases.length],
    );
    item.cohort = `${item.cohort} ${index + 1}`;
    item.expected = `${item.expected} ${index + 1}`;
    return item;
  });
  return source;
}

function buildPlan(sample, table, evaluation) {
  return {
    ...clone(sample),
    slides: [
      clone(sample.slides.find((slide) => slide.family === "cover")),
      clone(sample.slides.find((slide) => slide.family === "decision")),
      table,
      evaluation,
      clone(sample.slides.find((slide) => slide.family === "evidence")),
    ],
  };
}

function compile(plan, mode = "full") {
  const raw = JSON.stringify(plan);
  return compileReadoutPlan(plan, {
    sourcePlanSha256: hash(raw),
    mode,
  });
}

function assertSpecCode(label, expectedCode, spec, mutate) {
  const candidate = clone(spec);
  mutate(candidate);
  try {
    validateDrawingSpec(candidate);
    failures.push(`${label}: expected ${expectedCode}`);
  } catch (error) {
    check(
      error.code === expectedCode,
      `${label}: expected ${expectedCode}, got ${error.code}: ${error.message}`,
    );
    check(error.path?.startsWith("$"), `${label}: error must include a JSON path`);
  }
}

function tablePrimitiveFor(spec, family) {
  const slide = spec.slides.find((item) => item.family === family);
  return {
    slide,
    table: slide.primitives.find((primitive) => primitive.kind === "table"),
  };
}

function checkTableGeometry(table, label) {
  check(table.x === 48 && table.w === 816, `${label}: table must span 48..864`);
  check(table.y + table.h <= 478, `${label}: table must remain above footer`);
  check(
    Math.abs(table.columnWidths.reduce((sum, value) => sum + value, 0) - table.w) <=
      0.01,
    `${label}: column widths must sum to width`,
  );
  check(
    Math.abs(table.rowHeights.reduce((sum, value) => sum + value, 0) - table.h) <=
      0.01,
    `${label}: row heights must sum to height`,
  );
}

function checkEvidenceMarkers(slide, table, role, rowCount, label) {
  const markers = slide.primitives.filter((primitive) => primitive.role === role);
  check(markers.length === rowCount, `${label}: marker count must match row count`);
  check(
    JSON.stringify(markers.map((marker) => marker.text)) ===
      JSON.stringify(Array.from({ length: rowCount }, (_, index) => `E${index + 1}`)),
    `${label}: markers must use compact deterministic labels`,
  );
  markers.forEach((marker, index) => {
    const rowY =
      table.y +
      table.rowHeights.slice(0, index + 1).reduce((sum, height) => sum + height, 0);
    check(marker.x >= table.x + table.w, `${label}: marker ${index + 1} must not overlap table`);
    check(marker.x + marker.w <= 912, `${label}: marker ${index + 1} must remain inside safe content`);
    check(
      Math.abs(marker.y - rowY) <= 0.001 &&
        Math.abs(marker.h - table.rowHeights[index + 1]) <= 0.001,
      `${label}: marker ${index + 1} must align vertically with its row`,
    );
    check(marker.y + marker.h <= 478, `${label}: marker ${index + 1} must not enter footer`);
  });
}

try {
  const sample = JSON.parse(await readFile(samplePath, "utf8"));
  const representative = buildPlan(
    sample,
    tableSlide(6, 10),
    evaluationSlide(sample, 8),
  );
  const representativePath = join(directory, "representative.json");
  await writeFile(representativePath, JSON.stringify(representative));
  const planValidation = spawnSync(process.execPath, [validator, representativePath], {
    encoding: "utf8",
  });
  check(
    planValidation.status === 0,
    `representative table plan must pass canonical validation:\n${planValidation.stdout}${planValidation.stderr}`,
  );

  for (let columnCount = 2; columnCount <= 6; columnCount += 1) {
    for (let rowCount = 1; rowCount <= 10; rowCount += 1) {
      const tableSource = tableSlide(columnCount, rowCount);
      const plan = buildPlan(sample, tableSource, evaluationSlide(sample, 3));
      const before = JSON.stringify(plan);
      const spec = compile(plan);
      const { slide, table } = tablePrimitiveFor(spec, "table");
      const label = `table ${columnCount}x${rowCount}`;
      check(
        slide.primitives.filter((primitive) => primitive.kind === "table").length ===
          1,
        `${label}: must emit one native table`,
      );
      checkTableGeometry(table, label);
      check(
        JSON.stringify(table.headers) ===
          JSON.stringify(tableSource.content.columns),
        `${label}: headers must remain exact`,
      );
      check(
        JSON.stringify(table.rows) ===
          JSON.stringify(tableSource.content.rows.map((row) => row.cells)),
        `${label}: cells must remain exact`,
      );
      check(
        JSON.stringify(table.rowEvidenceIds) ===
          JSON.stringify(tableSource.content.rows.map((row) => row.evidenceIds)),
        `${label}: row evidence IDs must remain exact`,
      );
      check(
        table.columnWidths.every(
          (width) => Math.abs(width - 816 / columnCount) < 0.001,
        ),
        `${label}: columns must be equal width`,
      );
      check(
        table.rowHeights.length === rowCount + 1 &&
          table.rowHeights[0] === 28,
        `${label}: row heights must include the 28-point header`,
      );
      checkEvidenceMarkers(
        slide,
        table,
        "table-row-evidence-marker",
        rowCount,
        label,
      );
      check(
        slide.primitives.some(
          (primitive) =>
            primitive.role === "table-insight" &&
            primitive.text === tableSource.content.insight.statement,
        ) &&
          slide.primitives.some(
            (primitive) =>
              primitive.role === "table-insight-evidence" &&
              primitive.text === tableSource.content.insight.evidenceIds.join(", "),
          ),
        `${label}: insight statement and evidence must remain exact`,
      );
      check(
        slide.notesText ===
          `${tableSource.notes}\r\nEvidence: ${tableSource.evidenceIds.join(", ")}\r\nHuman context: ${tableSource.judgmentIds.join(", ")}`,
        `${label}: notes must remain exact`,
      );
      check(
        stableSerialize(spec) === stableSerialize(compile(plan)),
        `${label}: compilation must be deterministic`,
      );
      check(JSON.stringify(plan) === before, `${label}: compiler must not mutate plan`);
    }
  }

  for (let caseCount = 3; caseCount <= 8; caseCount += 1) {
    const evaluationSource = evaluationSlide(sample, caseCount);
    const plan = buildPlan(sample, tableSlide(2, 1), evaluationSource);
    const before = JSON.stringify(plan);
    const spec = compile(plan);
    const { slide, table } = tablePrimitiveFor(spec, "evaluation");
    const label = `evaluation ${caseCount}`;
    check(
      slide.primitives.filter((primitive) => primitive.kind === "table").length ===
        1,
      `${label}: must emit one native table`,
    );
    checkTableGeometry(table, label);
    check(
      JSON.stringify(table.headers) ===
        JSON.stringify(["Cohort", "Expected behavior", "Result"]),
      `${label}: headers must match the evaluation contract`,
    );
    check(
      JSON.stringify(table.columnWidths) ===
        JSON.stringify([179.444, 457.112, 179.444]),
      `${label}: column widths must match the proportional evaluation contract`,
    );
    check(
      JSON.stringify(table.rows) ===
        JSON.stringify(
          evaluationSource.content.cases.map((item) => [
            item.cohort,
            item.expected,
            item.result,
          ]),
        ),
      `${label}: case strings, including result casing, must remain exact`,
    );
    check(
      JSON.stringify(table.rowEvidenceIds) ===
        JSON.stringify(
          evaluationSource.content.cases.map((item) => item.evidenceIds),
        ),
      `${label}: case evidence IDs must remain exact`,
    );
    checkEvidenceMarkers(
      slide,
      table,
      "evaluation-case-evidence-marker",
      caseCount,
      label,
    );
    check(
      slide.primitives.some(
        (primitive) =>
          primitive.role === "evaluation-release-implication" &&
          primitive.text ===
            evaluationSource.content.releaseImplication.statement,
      ) &&
        slide.primitives.some(
          (primitive) =>
            primitive.role === "evaluation-release-evidence" &&
            primitive.text ===
              evaluationSource.content.releaseImplication.evidenceIds.join(", "),
        ),
      `${label}: release implication and evidence must remain exact`,
    );
    check(
      stableSerialize(spec) === stableSerialize(compile(plan)),
      `${label}: compilation must be deterministic`,
    );
    check(JSON.stringify(plan) === before, `${label}: compiler must not mutate plan`);
  }

  const full = compile(representative);
  const smoke = compile(representative, "smoke");
  const inverseSmoke = compile(
    buildPlan(sample, tableSlide(2, 1), evaluationSlide(sample, 8)),
    "smoke",
  );
  check(
    full.selectedSlideFamilies.includes("table") &&
      full.selectedSlideFamilies.includes("evaluation"),
    "full compilation must include table and evaluation",
  );
  check(
    smoke.selectedSlideFamilies[2] === "table" &&
      smoke.selectedSlideIds[2] === "native-table-6-10",
    "smoke compilation must select the 16-density ordinary table",
  );
  check(
    inverseSmoke.selectedSlideFamilies[2] === "evaluation" &&
      inverseSmoke.selectedSlideIds[2] === "native-evaluation-8",
    "smoke compilation must select the 8-density evaluation over a 3-density table",
  );
  const { slide: tableSlideSpec, table: baseTable } = tablePrimitiveFor(full, "table");
  const { slide: evaluationSlideSpec } = tablePrimitiveFor(full, "evaluation");
  for (const slide of [tableSlideSpec, evaluationSlideSpec]) {
    for (const primitive of slide.primitives) {
      if (!primitive.role.startsWith("footer-")) {
        check(
          primitive.kind === "line"
            ? primitive.y1 <= 478 && primitive.y2 <= 478
            : primitive.y + primitive.h <= 478,
          `${slide.family}: content must not overlap the footer`,
        );
      }
    }
    check(
      slide.primitives.every((primitive, index) => primitive.z === index + 1),
      `${slide.family}: z values must be contiguous`,
    );
    check(
      slide.primitives.every(
        (primitive) =>
          /^fde-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(primitive.name) &&
          primitive.name.length <= 120,
      ),
      `${slide.family}: names must be deterministic ASCII kebab-case`,
    );
  }
  const maxTableSource = representative.slides.find(
    (slide) => slide.family === "table",
  );
  const maxEvaluationSource = representative.slides.find(
    (slide) => slide.family === "evaluation",
  );
  check(
    JSON.stringify(tableSlideSpec.evidenceIds) ===
      JSON.stringify(maxTableSource.evidenceIds) &&
      tableSlideSpec.notesText ===
        `${maxTableSource.notes}\r\nEvidence: ${maxTableSource.evidenceIds.join(", ")}\r\nHuman context: ${maxTableSource.judgmentIds.join(", ")}`,
    "max table notes and evidence must remain exact",
  );
  check(
    JSON.stringify(evaluationSlideSpec.evidenceIds) ===
      JSON.stringify(maxEvaluationSource.evidenceIds) &&
      evaluationSlideSpec.notesText ===
        `${maxEvaluationSource.notes}\r\nEvidence: ${maxEvaluationSource.evidenceIds.join(", ")}\r\nHuman context: ${maxEvaluationSource.judgmentIds.join(", ")}`,
    "max evaluation notes and evidence must remain exact",
  );

  assertSpecCode("row width mismatch", "E_SPEC_SCHEMA", full, (candidate) => {
    tablePrimitiveFor(candidate, "table").table.rows[0].pop();
  });
  assertSpecCode("header width mismatch", "E_SPEC_SCHEMA", full, (candidate) => {
    tablePrimitiveFor(candidate, "table").table.columnWidths.pop();
  });
  assertSpecCode("ordinary table column count", "E_SPEC_SCHEMA", full, (candidate) => {
    const table = tablePrimitiveFor(candidate, "table").table;
    table.headers = table.headers.slice(0, 1);
    table.rows = table.rows.map((row) => row.slice(0, 1));
    table.columnWidths = [table.w];
  });
  assertSpecCode("evaluation case count", "E_SPEC_SCHEMA", full, (candidate) => {
    const table = tablePrimitiveFor(candidate, "evaluation").table;
    table.rows = table.rows.slice(0, 2);
    table.rowEvidenceIds = table.rowEvidenceIds.slice(0, 2);
    table.rowHeights = [table.rowHeights[0], table.h / 2, table.h / 2];
  });
  assertSpecCode("evaluation headers", "E_SPEC_SCHEMA", full, (candidate) => {
    tablePrimitiveFor(candidate, "evaluation").table.headers[1] = "Expected control";
  });
  assertSpecCode("evaluation uppercase result", "E_SPEC_SCHEMA", full, (candidate) => {
    tablePrimitiveFor(candidate, "evaluation").table.rows[0][2] = "PASS";
  });
  assertSpecCode("evaluation invalid result", "E_SPEC_SCHEMA", full, (candidate) => {
    tablePrimitiveFor(candidate, "evaluation").table.rows[0][2] = "unknown";
  });
  assertSpecCode("row evidence count", "E_SPEC_SCHEMA", full, (candidate) => {
    tablePrimitiveFor(candidate, "table").table.rowEvidenceIds.pop();
  });
  assertSpecCode("sparse row evidence", "E_SPEC_SCHEMA", full, (candidate) => {
    delete tablePrimitiveFor(candidate, "table").table.rowEvidenceIds[0][0];
  });
  assertSpecCode("empty row evidence", "E_SPEC_SCHEMA", full, (candidate) => {
    tablePrimitiveFor(candidate, "table").table.rowEvidenceIds[0] = [];
  });
  assertSpecCode("duplicate row evidence", "E_SPEC_SCHEMA", full, (candidate) => {
    tablePrimitiveFor(candidate, "table").table.rowEvidenceIds[0] = [
      "baseline-001",
      "baseline-001",
    ];
  });
  assertSpecCode(
    "undeclared primitive row evidence",
    "E_EVIDENCE_NOT_DECLARED",
    full,
    (candidate) => {
      tablePrimitiveFor(candidate, "table").table.rowEvidenceIds[0] = [
        "authority-001",
      ];
    },
  );
  assertSpecCode("row height mismatch", "E_SPEC_SCHEMA", full, (candidate) => {
    tablePrimitiveFor(candidate, "table").table.rowHeights.pop();
  });
  assertSpecCode("column sum mismatch", "E_GEOMETRY_BOUNDS", full, (candidate) => {
    tablePrimitiveFor(candidate, "table").table.columnWidths[0] += 1;
  });
  assertSpecCode("row sum mismatch", "E_GEOMETRY_BOUNDS", full, (candidate) => {
    tablePrimitiveFor(candidate, "table").table.rowHeights[0] += 1;
  });
  assertSpecCode("negative table width", "E_GEOMETRY_BOUNDS", full, (candidate) => {
    tablePrimitiveFor(candidate, "table").table.w = -1;
  });
  assertSpecCode("nonfinite table height", "E_GEOMETRY_NONFINITE", full, (candidate) => {
    tablePrimitiveFor(candidate, "table").table.h = Number.NaN;
  });
  assertSpecCode("negative column width", "E_GEOMETRY_BOUNDS", full, (candidate) => {
    tablePrimitiveFor(candidate, "table").table.columnWidths[0] = -1;
  });
  assertSpecCode("nonfinite row height", "E_GEOMETRY_NONFINITE", full, (candidate) => {
    tablePrimitiveFor(candidate, "table").table.rowHeights[1] = Number.POSITIVE_INFINITY;
  });
  assertSpecCode("sparse table headers", "E_SPEC_SCHEMA", full, (candidate) => {
    delete tablePrimitiveFor(candidate, "table").table.headers[0];
  });
  assertSpecCode("empty table text", "E_TEXT_EMPTY", full, (candidate) => {
    tablePrimitiveFor(candidate, "table").table.rows[0][0] = " ";
  });
  assertSpecCode("control table text", "E_TEXT_CONTROL_CHAR", full, (candidate) => {
    tablePrimitiveFor(candidate, "table").table.headers[0] = "bad\u0085header";
  });
  assertSpecCode("wrong table color", "E_COLOR_INVALID", full, (candidate) => {
    tablePrimitiveFor(candidate, "table").table.headerFillColorRole = "brand";
  });
  assertSpecCode("wrong table font size", "E_SPEC_SCHEMA", full, (candidate) => {
    tablePrimitiveFor(candidate, "table").table.bodyFontSize = 9;
  });
  assertSpecCode("wrong table transparency", "E_SPEC_SCHEMA", full, (candidate) => {
    tablePrimitiveFor(candidate, "table").table.alternateFillTransparency = 2;
  });
  assertSpecCode("unexpected table key", "E_SPEC_SCHEMA", full, (candidate) => {
    tablePrimitiveFor(candidate, "table").table.extra = true;
  });
  assertSpecCode("table enters footer", "E_GEOMETRY_BOUNDS", full, (candidate) => {
    tablePrimitiveFor(candidate, "table").table.y = 477;
  });

  const undeclared = clone(representative);
  undeclared.slides.find((slide) => slide.family === "table").content.rows[0]
    .evidenceIds = ["authority-001"];
  try {
    compile(undeclared);
    failures.push("nested undeclared row evidence must fail");
  } catch (error) {
    check(
      error.code === "E_EVIDENCE_NOT_DECLARED",
      `nested undeclared row evidence: expected E_EVIDENCE_NOT_DECLARED, got ${error.code}`,
    );
  }
  const undeclaredEvaluation = clone(representative);
  undeclaredEvaluation.slides.find(
    (slide) => slide.family === "evaluation",
  ).content.releaseImplication.evidenceIds = ["baseline-001"];
  try {
    compile(undeclaredEvaluation);
    failures.push("nested undeclared release evidence must fail");
  } catch (error) {
    check(
      error.code === "E_EVIDENCE_NOT_DECLARED",
      `nested undeclared release evidence: expected E_EVIDENCE_NOT_DECLARED, got ${error.code}`,
    );
  }

  check(baseTable.headers.length === 6 && baseTable.rows.length === 10, "max table fixture must be 6x10");
} finally {
  await rm(directory, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("PowerPoint table-family tests failed:");
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log("PowerPoint table-family tests passed: 50 table layouts and 6 evaluation layouts.");
