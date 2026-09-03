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
const directory = await mkdtemp(join(tmpdir(), "fde-powerpoint-workflow-"));
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

function repeatUnique(items, count, fields = []) {
  return Array.from({ length: count }, (_, index) => {
    const item = clone(items[index % items.length]);
    if (typeof item === "string") return `${item} ${index + 1}`;
    for (const field of fields) {
      if (typeof item[field] === "string") item[field] = `${item[field]} ${index + 1}`;
    }
    return item;
  });
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
      Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
    }
  }
  visit(slide.content);
  slide.evidenceIds = [...new Set([...slide.evidenceIds, ...ids])];
  return slide;
}

function maximizeSampleSlide(source) {
  const slide = clone(source);
  switch (slide.family) {
    case "decision":
      slide.content.bullets = repeatUnique(slide.content.bullets, 4);
      slide.content.facts = repeatUnique(slide.content.facts, 3, ["label", "value"]);
      break;
    case "profile":
      slide.content.facts = repeatUnique(slide.content.facts, 6, ["label", "value"]);
      slide.content.contexts = repeatUnique(slide.content.contexts, 5);
      break;
    case "metrics":
      slide.content.metrics = repeatUnique(slide.content.metrics, 4, [
        "label",
        "value",
        "context",
      ]);
      break;
    case "findings":
      slide.content.items = repeatUnique(slide.content.items, 5, [
        "title",
        "statement",
        "consequence",
      ]);
      break;
    case "responsibility":
      slide.content.steps = repeatUnique(slide.content.steps, 5, ["statement"]);
      break;
    case "evaluation":
      slide.content.cases = repeatUnique(slide.content.cases, 8, [
        "cohort",
        "expected",
      ]);
      break;
    case "risks":
      slide.content.items = repeatUnique(slide.content.items, 4, [
        "risk",
        "impact",
        "control",
        "residualRisk",
      ]);
      break;
    case "timeline":
      slide.content.milestones = repeatUnique(slide.content.milestones, 6, [
        "label",
        "owner",
        "due",
        "outcome",
      ]);
      break;
    case "evidence":
      slide.content.groups = repeatUnique(slide.content.groups, 5, ["label"]);
      break;
  }
  return declareNestedEvidence(slide);
}

function chartSlide() {
  return {
    id: "maximum-native-chart",
    family: "chart",
    title: "Maximum native chart remains evidence-bound",
    customerSafe: true,
    notes: "Fictional maximum chart. Sources: [baseline-001], [eval-001].",
    evidenceIds: ["baseline-001", "eval-001"],
    judgmentIds: ["judgment-rationale-001"],
    content: {
      chartType: "line",
      categories: Array.from({ length: 12 }, (_, index) => `Period ${index + 1}`),
      series: Array.from({ length: 4 }, (_, seriesIndex) => ({
        name: `Series ${seriesIndex + 1}`,
        values: Array.from(
          { length: 12 },
          (_, categoryIndex) =>
            (categoryIndex % 3 === 0 ? -1 : 1) * (categoryIndex + seriesIndex + 1),
        ),
        evidenceIds: [seriesIndex % 2 ? "eval-001" : "baseline-001"],
      })),
      unit: "fictional units / period",
      insight: {
        statement: "The maximum chart preserves exact editable series geometry.",
        evidenceIds: ["baseline-001"],
      },
    },
  };
}

function tableSlide() {
  return {
    id: "maximum-native-table",
    family: "table",
    title: "Maximum native table remains editable",
    customerSafe: true,
    notes: "Fictional maximum table. Sources: [baseline-001], [eval-001].",
    evidenceIds: ["baseline-001", "eval-001"],
    judgmentIds: ["judgment-rationale-001"],
    content: {
      columns: Array.from({ length: 6 }, (_, index) => `Column ${index + 1}`),
      rows: Array.from({ length: 10 }, (_, rowIndex) => ({
        cells: Array.from(
          { length: 6 },
          (_, columnIndex) => `R${rowIndex + 1}C${columnIndex + 1}`,
        ),
        evidenceIds: [rowIndex % 2 ? "eval-001" : "baseline-001"],
      })),
      insight: {
        statement: "The maximum table preserves exact row evidence.",
        evidenceIds: ["eval-001"],
      },
    },
  };
}

function workflowSlide(id, nodes, edges) {
  return {
    id,
    family: "workflow",
    title: `Editable workflow ${id}`,
    customerSafe: true,
    notes: "Fictional workflow topology. Source: [workflow-001].",
    evidenceIds: ["workflow-001"],
    judgmentIds: [
      "judgment-observation-001",
      "judgment-failed-attempt-001",
    ],
    content: { nodes, edges },
  };
}

function maximumWorkflow() {
  return workflowSlide(
    "maximum-workflow",
    [
      { id: "source-a", label: "SOURCE A", detail: "first source", role: "source" },
      { id: "source-b", label: "SOURCE B", detail: "second source", role: "source" },
      { id: "actor-a", label: "ACTOR A", detail: "first operator", role: "actor" },
      { id: "actor-b", label: "ACTOR B", detail: "second operator", role: "actor" },
      { id: "system-a", label: "SYSTEM A", detail: "first service", role: "system" },
      { id: "system-b", label: "SYSTEM B", detail: "second service", role: "system" },
      { id: "decision-a", label: "DECISION A", detail: "first gate", role: "decision" },
      { id: "decision-b", label: "DECISION B", detail: "second gate", role: "decision" },
    ],
    [
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
  );
}

function allFamilyMaximumPlan(sample) {
  const slides = sample.slides.map(maximizeSampleSlide);
  const evidence = slides.pop();
  slides.push(chartSlide(), tableSlide(), maximumWorkflow(), evidence);
  return { ...clone(sample), slides };
}

function compile(plan) {
  const raw = JSON.stringify(plan);
  return compileReadoutPlan(plan, {
    sourcePlanSha256: hash(raw),
    mode: "full",
  });
}

function workflowFor(spec, id) {
  return spec.slides.find((slide) => slide.id === id);
}

function edgeGroups(slide) {
  const groups = new Map();
  for (const primitive of slide.primitives) {
    const match = /^workflow-edge-(system|decision)-(\d{2})$/.exec(primitive.role);
    if (!match) continue;
    const group = groups.get(primitive.role) ?? {
      kind: match[1],
      index: Number(match[2]),
      lines: [],
    };
    group.lines.push(primitive);
    groups.set(primitive.role, group);
  }
  return [...groups.values()].sort((left, right) => left.index - right.index);
}

function anchorMatches(x, y, box) {
  return (
    (x === box.x && y === box.y + box.h / 2) ||
    (x === box.x + box.w && y === box.y + box.h / 2) ||
    (x === box.x + box.w / 2 && y === box.y) ||
    (x === box.x + box.w / 2 && y === box.y + box.h)
  );
}

function crossesOpenBox(line, box) {
  if (line.y1 === line.y2) {
    return (
      line.y1 > box.y &&
      line.y1 < box.y + box.h &&
      Math.max(Math.min(line.x1, line.x2), box.x) <
        Math.min(Math.max(line.x1, line.x2), box.x + box.w)
    );
  }
  return (
    line.x1 > box.x &&
    line.x1 < box.x + box.w &&
    Math.max(Math.min(line.y1, line.y2), box.y) <
      Math.min(Math.max(line.y1, line.y2), box.y + box.h)
  );
}

function positiveOverlap(left, right) {
  if (left.y1 === left.y2 && right.y1 === right.y2 && left.y1 === right.y1) {
    return (
      Math.max(Math.min(left.x1, left.x2), Math.min(right.x1, right.x2)) <
      Math.min(Math.max(left.x1, left.x2), Math.max(right.x1, right.x2))
    );
  }
  if (left.x1 === left.x2 && right.x1 === right.x2 && left.x1 === right.x1) {
    return (
      Math.max(Math.min(left.y1, left.y2), Math.min(right.y1, right.y2)) <
      Math.min(Math.max(left.y1, left.y2), Math.max(right.y1, right.y2))
    );
  }
  return false;
}

function assertWorkflow(spec, source) {
  const slide = workflowFor(spec, source.id);
  const shapes = slide.primitives.filter(
    (primitive) =>
      primitive.kind === "shape" && primitive.role.startsWith("workflow-node-"),
  );
  const labels = slide.primitives.filter(
    (primitive) => primitive.role === "workflow-node-label",
  );
  const details = slide.primitives.filter(
    (primitive) => primitive.role === "workflow-node-detail",
  );
  const groups = edgeGroups(slide);
  const boxes = new Map(
    source.content.nodes.map((node, index) => [node.id, shapes[index]]),
  );

  check(shapes.length === source.content.nodes.length, `${source.id}: node shape count`);
  check(labels.length === shapes.length, `${source.id}: editable label count`);
  check(details.length === shapes.length, `${source.id}: editable detail count`);
  check(groups.length === source.content.edges.length, `${source.id}: edge route count`);
  check(
    labels.every((label, index) => label.text === source.content.nodes[index].label),
    `${source.id}: labels preserve exact source text`,
  );
  check(
    details.every((detail, index) => detail.text === source.content.nodes[index].detail),
    `${source.id}: details preserve exact source text`,
  );

  groups.forEach((group, groupIndex) => {
    const edge = source.content.edges[groupIndex];
    check(group.kind === edge.kind, `${source.id}: edge ${group.index} semantic kind`);
    group.lines.forEach((line, segmentIndex) => {
      check(
        (line.x1 === line.x2) !== (line.y1 === line.y2),
        `${source.id}: edge ${group.index} segment ${segmentIndex + 1} is orthogonal`,
      );
      check(
        [line.x1, line.x2].every((value) => value >= 48 && value <= 912) &&
          [line.y1, line.y2].every((value) => value >= 116 && value <= 478),
        `${source.id}: edge ${group.index} segment stays in workflow stage`,
      );
      check(
        line.colorRole === edge.kind &&
          line.sourceNodeId === edge.from &&
          line.targetNodeId === edge.to &&
          line.edgeIndex === group.index &&
          line.segmentIndex === segmentIndex + 1 &&
          line.arrowEnd ===
            (segmentIndex === group.lines.length - 1 ? "open" : "none"),
        `${source.id}: edge ${group.index} metadata, semantic color, and arrow`,
      );
      if (segmentIndex > 0) {
        const previous = group.lines[segmentIndex - 1];
        check(
          previous.x2 === line.x1 && previous.y2 === line.y1,
          `${source.id}: edge ${group.index} shares exact segment anchors`,
        );
      }
      check(
        !shapes.some((shape) => crossesOpenBox(line, shape)),
        `${source.id}: edge ${group.index} avoids node interiors`,
      );
    });
    const first = group.lines[0];
    const last = group.lines.at(-1);
    check(
      anchorMatches(first.x1, first.y1, boxes.get(edge.from)),
      `${source.id}: edge ${group.index} exact source anchor`,
    );
    check(
      anchorMatches(last.x2, last.y2, boxes.get(edge.to)),
      `${source.id}: edge ${group.index} exact target anchor`,
    );
  });

  const bandWidth = 216;
  const roles = ["source", "actor", "system", "decision"];
  shapes.forEach((shape, index) => {
    const bandIndex = roles.indexOf(source.content.nodes[index].role);
    check(
      shape.x >= 48 + bandIndex * bandWidth &&
        shape.x + shape.w <= 48 + (bandIndex + 1) * bandWidth,
      `${source.id}: node ${index + 1} stays in its role band`,
    );
  });
  check(
    slide.notesText ===
      `${source.notes}\r\nEvidence: ${source.evidenceIds.join(", ")}\r\nHuman context: ${source.judgmentIds.join(", ")}`,
    `${source.id}: notes preserve evidence convention`,
  );
  check(
    slide.primitives.some(
      (primitive) =>
        primitive.role === "footer-evidence" &&
        primitive.text.includes("[workflow-001]"),
    ),
    `${source.id}: footer preserves compact evidence`,
  );
}

function assertCompileCode(label, expectedCode, plan, mutate) {
  const candidate = clone(plan);
  mutate(candidate);
  try {
    compile(candidate);
    failures.push(`${label}: expected ${expectedCode}`);
  } catch (error) {
    check(
      error.code === expectedCode,
      `${label}: expected ${expectedCode}, got ${error.code}: ${error.message}`,
    );
  }
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
  }
}

try {
  const sample = JSON.parse(await readFile(samplePath, "utf8"));
  const plan = allFamilyMaximumPlan(sample);
  const rawPlan = JSON.stringify(plan);
  const planPath = join(directory, "all-family-maximum.json");
  await writeFile(planPath, rawPlan);
  const validation = spawnSync(process.execPath, [validator, planPath], {
    encoding: "utf8",
  });
  check(
    validation.status === 0,
    `14-slide all-family maximum fixture must validate:\n${validation.stdout}${validation.stderr}`,
  );

  const spec = compile(plan);
  const again = compile(plan);
  check(spec.slides.length === 14, "all-family maximum fixture must compile 14 slides");
  check(
    new Set(spec.slides.map((slide) => slide.family)).size === 13,
    "all-family maximum fixture must cover all 13 families",
  );
  check(
    stableSerialize(spec) === stableSerialize(again),
    "all-family maximum compilation must be byte-deterministic",
  );
  check(JSON.stringify(plan) === rawPlan, "workflow compilation must not mutate the plan");
  const names = spec.slides.flatMap((slide) =>
    slide.primitives.map((primitive) => primitive.name),
  );
  check(
    names.every(
      (name) =>
        /^fde-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 120,
    ) &&
      new Set(names.map((name) => name.toLowerCase())).size === names.length,
    "all native primitive names must be stable, unique fde-* names",
  );

  const workflowSources = plan.slides.filter((slide) => slide.family === "workflow");
  workflowSources.forEach((source) => assertWorkflow(spec, source));

  const maximumSource = workflowSources.find((slide) => slide.id === "maximum-workflow");
  const maximumSlide = workflowFor(spec, maximumSource.id);
  const maximumGroups = edgeGroups(maximumSlide);
  check(
    JSON.stringify(maximumGroups[0].lines) !== JSON.stringify(maximumGroups[7].lines),
    "duplicate edges must receive distinct routed geometry",
  );
  check(
    !maximumGroups[0].lines.some((left) =>
      maximumGroups[7].lines.some((right) => positiveOverlap(left, right)),
    ),
    "duplicate edges must avoid positive-length segment overlap",
  );
  const maximumShapes = maximumSlide.primitives.filter(
    (primitive) =>
      primitive.kind === "shape" && primitive.role.startsWith("workflow-node-"),
  );
  const actorA = maximumShapes[2];
  check(
    anchorMatches(
      maximumGroups[8].lines[0].x1,
      maximumGroups[8].lines[0].y1,
      actorA,
    ) &&
      anchorMatches(
        maximumGroups[8].lines.at(-1).x2,
        maximumGroups[8].lines.at(-1).y2,
        actorA,
      ),
    "self-loop must leave and return to exact anchors on the same node",
  );

  const minimum = workflowSlide(
    "minimum-workflow",
    [
      { id: "source", label: "SOURCE", detail: "input", role: "source" },
      { id: "actor", label: "ACTOR", detail: "review", role: "actor" },
      { id: "decision", label: "DECISION", detail: "gate", role: "decision" },
    ],
    [
      { from: "source", to: "actor", kind: "system" },
      { from: "actor", to: "decision", kind: "decision" },
    ],
  );
  const minimumPlan = {
    ...clone(sample),
    slides: [
      clone(plan.slides[0]),
      clone(plan.slides[1]),
      minimum,
      clone(plan.slides.at(-1)),
    ],
  };
  const minimumSpec = compile(minimumPlan);
  assertWorkflow(minimumSpec, minimum);

  const singleBand = workflowSlide(
    "single-band-workflow",
    Array.from({ length: 8 }, (_, index) => ({
      id: `actor-${index + 1}`,
      label: `ACTOR ${index + 1}`,
      detail: `single role node ${index + 1}`,
      role: "actor",
    })),
    [
      { from: "actor-1", to: "actor-2", kind: "system" },
      { from: "actor-2", to: "actor-3", kind: "system" },
      { from: "actor-3", to: "actor-4", kind: "system" },
      { from: "actor-4", to: "actor-5", kind: "system" },
      { from: "actor-5", to: "actor-6", kind: "system" },
      { from: "actor-6", to: "actor-7", kind: "system" },
      { from: "actor-7", to: "actor-8", kind: "decision" },
      { from: "actor-8", to: "actor-1", kind: "decision" },
      { from: "actor-4", to: "actor-4", kind: "decision" },
      { from: "actor-1", to: "actor-2", kind: "system" },
    ],
  );
  const singleBandPlan = {
    ...clone(sample),
    slides: [
      clone(plan.slides[0]),
      clone(plan.slides[1]),
      singleBand,
      clone(plan.slides.at(-1)),
    ],
  };
  const singleBandSpec = compile(singleBandPlan);
  assertWorkflow(singleBandSpec, singleBand);

  const denseDecision = workflowSlide(
    "dense-decision-workflow",
    Array.from({ length: 8 }, (_, index) => ({
      id: `decision-${index + 1}`,
      label: `DECISION ${index + 1}`,
      detail: `rightmost role node ${index + 1}`,
      role: "decision",
    })),
    [
      { from: "decision-4", to: "decision-4", kind: "decision" },
      { from: "decision-1", to: "decision-2", kind: "system" },
    ],
  );
  const denseDecisionPlan = {
    ...clone(sample),
    slides: [
      clone(plan.slides[0]),
      clone(plan.slides[1]),
      clone(plan.slides.find((slide) => slide.family === "profile")),
      denseDecision,
      clone(plan.slides.at(-1)),
    ],
  };
  const denseDecisionPath = join(directory, "dense-decision-workflow.json");
  await writeFile(denseDecisionPath, JSON.stringify(denseDecisionPlan));
  const denseDecisionValidation = spawnSync(
    process.execPath,
    [validator, denseDecisionPath],
    { encoding: "utf8" },
  );
  check(
    denseDecisionValidation.status === 0,
    `dense rightmost-band self-loop must be canonically valid:\n${denseDecisionValidation.stdout}${denseDecisionValidation.stderr}`,
  );
  const denseDecisionSpec = compile(denseDecisionPlan);
  assertWorkflow(denseDecisionSpec, denseDecision);

  assertCompileCode("two nodes", "E_SPEC_SCHEMA", minimumPlan, (candidate) => {
    candidate.slides[2].content.nodes.pop();
  });
  assertCompileCode("eleven edges", "E_SPEC_SCHEMA", minimumPlan, (candidate) => {
    candidate.slides[2].content.edges = Array.from(
      { length: 11 },
      () => clone(candidate.slides[2].content.edges[0]),
    );
  });
  assertCompileCode("duplicate node ID", "E_SPEC_SCHEMA", minimumPlan, (candidate) => {
    candidate.slides[2].content.nodes[1].id =
      candidate.slides[2].content.nodes[0].id;
  });
  assertCompileCode("unknown endpoint", "E_SPEC_SCHEMA", minimumPlan, (candidate) => {
    candidate.slides[2].content.edges[0].to = "missing";
  });
  assertCompileCode("missing decision edge", "E_SPEC_SCHEMA", minimumPlan, (candidate) => {
    candidate.slides[2].content.edges.forEach((edge) => {
      edge.kind = "system";
    });
  });

  assertSpecCode("mutated shared anchor", "E_GEOMETRY_BOUNDS", spec, (candidate) => {
    const workflow = workflowFor(candidate, "current-workflow");
    const group = edgeGroups(workflow).find((item) => item.lines.length > 1);
    group.lines[1].x1 += 1;
  });
  assertSpecCode("mutated semantic color", "E_SPEC_SCHEMA", spec, (candidate) => {
    const workflow = workflowFor(candidate, "maximum-workflow");
    edgeGroups(workflow)[4].lines[0].colorRole = "system";
  });
  assertSpecCode("mutated intermediate arrow", "E_SPEC_SCHEMA", spec, (candidate) => {
    const workflow = workflowFor(candidate, "current-workflow");
    const group = edgeGroups(workflow).find((item) => item.lines.length > 1);
    group.lines[0].arrowEnd = "open";
  });
  assertSpecCode("node outside role band", "E_GEOMETRY_BOUNDS", spec, (candidate) => {
    const workflow = workflowFor(candidate, "maximum-workflow");
    const sourceShape = workflow.primitives.find(
      (primitive) => primitive.role === "workflow-node-source",
    );
    sourceShape.x = 300;
  });
  assertSpecCode("connector bound to wrong source", "E_GEOMETRY_BOUNDS", spec, (candidate) => {
    const workflow = workflowFor(candidate, "current-workflow");
    const group = edgeGroups(workflow)[0];
    group.lines.forEach((line) => {
      line.sourceNodeId = "shared-inbox";
    });
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("PowerPoint workflow family tests failed:");
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log("PowerPoint workflow family tests passed.");
