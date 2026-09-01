#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compileReadoutPlan,
  stableSerialize,
  validateDrawingSpec,
} from "./powerpoint-layout.mjs";
import { selectSmokeSlides } from "./powerpoint-smoke-contract.mjs";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const skillRoot = resolve(scriptsDir, "..");
const validator = join(scriptsDir, "validate-readout-plan.mjs");
const cli = join(scriptsDir, "render-powerpoint-spec.mjs");
const samplePath = join(
  skillRoot,
  "assets",
  "examples",
  "lattice-harbor-readout-plan.json",
);
const failures = [];
const directory = await mkdtemp(join(tmpdir(), "fde-powerpoint-layout-"));

function check(condition, message) {
  if (!condition) failures.push(message);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function clone(value) {
  return structuredClone(value);
}

function buildPlan(sample, { unbranded = false } = {}) {
  const cover = clone(sample.slides.find((slide) => slide.family === "cover"));
  const decision = clone(sample.slides.find((slide) => slide.family === "decision"));
  const metrics = clone(sample.slides.find((slide) => slide.family === "metrics"));
  metrics.evidenceIds = [...new Set([...metrics.evidenceIds, "authority-001"])];
  const metricsSecond = clone(metrics);
  metricsSecond.id = "target-metrics";
  metricsSecond.title = "The target keeps speed and reclassification visible";
  metricsSecond.notes = "Fictional target restatement. Sources: [target-001], [authority-001].";
  metricsSecond.content.metrics = metricsSecond.content.metrics.slice(0, 2);
  metricsSecond.content.metrics[0].label = "Target median";
  metricsSecond.content.metrics[0].value = "<=20 min";
  metricsSecond.content.metrics[0].context = "four-week target";
  metricsSecond.content.metrics[0].evidenceIds = ["target-001"];
  metricsSecond.content.metrics[1].label = "Target reclassified";
  metricsSecond.content.metrics[1].value = "<=10%";
  metricsSecond.content.metrics[1].context = "four-week target";
  metricsSecond.content.metrics[1].evidenceIds = ["target-001"];
  const evidence = clone(sample.slides.find((slide) => slide.family === "evidence"));
  const plan = {
    ...clone(sample),
    slides: [cover, decision, metrics, metricsSecond, evidence],
  };
  if (unbranded) {
    plan.brand.source = "unbranded";
    plan.brand.wordmark = "";
    plan.brand.styleReference = {
      source: "",
      authorized: false,
      scope: "none",
      reusedAssets: [],
    };
  }
  return plan;
}

function runNode(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
  });
}

function assertThrowsCode(label, code, mutate, baseSpec) {
  const candidate = clone(baseSpec);
  mutate(candidate);
  try {
    validateDrawingSpec(candidate);
    failures.push(`${label}: expected ${code}`);
  } catch (error) {
    check(error.code === code, `${label}: expected ${code}, got ${error.code}: ${error.message}`);
    check(error.path?.startsWith("$"), `${label}: error requires JSON path`);
  }
}

function contentStrings(value, key = "") {
  if (typeof value === "string") return key === "evidenceIds" ? [] : [value];
  if (Array.isArray(value)) return value.flatMap((item) => contentStrings(item, key));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([childKey, child]) =>
      contentStrings(child, childKey),
    );
  }
  return [];
}

function boxesOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

try {
  const sample = JSON.parse(await readFile(samplePath, "utf8"));
  const plan = buildPlan(sample);
  const planPath = join(directory, "plan.json");
  const rawPlan = JSON.stringify(plan);
  await writeFile(planPath, rawPlan);
  const planValidation = runNode(validator, [planPath]);
  check(
    planValidation.status === 0,
    `generated five-slide plan must pass canonical validator:\n${planValidation.stdout}${planValidation.stderr}`,
  );

  const sourcePlanSha256 = hash(rawPlan);
  const full = compileReadoutPlan(plan, { sourcePlanSha256, mode: "full" });
  const fullAgain = compileReadoutPlan(plan, { sourcePlanSha256, mode: "full" });
  const smoke = compileReadoutPlan(plan, { sourcePlanSha256, mode: "smoke" });
  check(stableSerialize(full) === stableSerialize(fullAgain), "two compiles must be byte-identical");
  check(
    JSON.stringify(smoke.selectedSlideIds) ===
      JSON.stringify(selectSmokeSlides(plan).map((slide) => slide.id)),
    "smoke selection must exactly match Layer 1",
  );
  check(
    JSON.stringify(full.selectedSlideIds) === JSON.stringify(plan.slides.map((slide) => slide.id)),
    "full mode must preserve slide order",
  );
  check(full.theme.colors.ink === plan.brand.colors.ink.toUpperCase(), "theme colors must normalize uppercase");
  check(JSON.stringify(plan) === rawPlan, "compile must not mutate the plan");

  const names = full.slides.flatMap((slide) => slide.primitives.map((primitive) => primitive.name));
  check(new Set(names.map((name) => name.toLowerCase())).size === names.length, "names must be globally case-insensitively unique");
  check(names.every((name) => /^fde-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 120), "names must use stable ASCII kebab-case");
  for (const [slideIndex, slide] of full.slides.entries()) {
    check(
      slide.primitives.every((primitive, index) => primitive.z === index + 1),
      `slide ${slide.id} z values must be contiguous`,
    );
    for (const primitive of slide.primitives) {
      if (primitive.kind === "line") {
        check(
          [primitive.x1, primitive.x2].every((value) => value >= 0 && value <= 960) &&
            [primitive.y1, primitive.y2].every((value) => value >= 0 && value <= 540),
          `slide ${slide.id} line must be in bounds`,
        );
      } else {
        check(
          primitive.x >= 0 &&
            primitive.y >= 0 &&
            primitive.w > 0 &&
            primitive.h > 0 &&
            primitive.x + primitive.w <= 960 &&
            primitive.y + primitive.h <= 540,
          `slide ${slide.id} primitive must be in bounds`,
        );
      }
      check(
        full.slides[2].primitives.filter((primitive) => primitive.role === "metric-divider").length ===
          plan.slides[2].content.metrics.length - 1,
        "metrics strip must emit every internal divider",
      );
    }
    const source = plan.slides[slide.sourceIndex - 1];
    const renderedTexts = new Set(
      slide.primitives
        .filter((primitive) => primitive.kind === "text")
        .map((primitive) => primitive.text),
    );
    for (const text of [source.title, ...contentStrings(source.content)]) {
      check(renderedTexts.has(text), `slide ${source.id} must preserve exact string ${JSON.stringify(text)}`);
    }
    check(
      slide.notesText ===
        `${source.notes}\r\nEvidence: ${source.evidenceIds.join(", ")}\r\nHuman context: ${source.judgmentIds.join(", ")}`,
      `slide ${source.id} notes must be exact`,
    );
    for (const role of ["decision-fact-card", "metric-cell", "evidence-card"]) {
      const peers = slide.primitives.filter((item) => item.kind === "shape" && item.role === role);
      peers.forEach((left, index) =>
        peers.slice(index + 1).forEach((right) =>
          check(!boxesOverlap(left, right), `${slide.id} ${role} peers must not overlap`),
        ),
      );
    }
    check(slideIndex < full.slides.length, "slide traversal must complete");
  }

  for (const count of [1, 2, 3, 4]) {
    const candidate = buildPlan(sample);
    candidate.slides[1].content.bullets = candidate.slides[1].content.bullets
      .concat(["Additional pilot condition"])
      .slice(0, count);
    compileReadoutPlan(candidate, { sourcePlanSha256, mode: "full" });
  }
  for (const count of [1, 2, 3]) {
    const candidate = buildPlan(sample);
    const facts = candidate.slides[1].content.facts;
    candidate.slides[1].content.facts = Array.from({ length: count }, (_, index) =>
      clone(facts[index % facts.length]),
    );
    compileReadoutPlan(candidate, { sourcePlanSha256, mode: "full" });
  }
  for (const count of [2, 3, 4]) {
    const candidate = buildPlan(sample);
    const metrics = candidate.slides[2].content.metrics;
    candidate.slides[2].content.metrics = Array.from({ length: count }, (_, index) =>
      clone(metrics[index % metrics.length]),
    );
    compileReadoutPlan(candidate, { sourcePlanSha256, mode: "full" });
  }
  for (const count of [2, 3, 4, 5]) {
    const candidate = buildPlan(sample);
    const groups = candidate.slides.at(-1).content.groups;
    candidate.slides.at(-1).content.groups = Array.from({ length: count }, (_, index) =>
      clone(groups[index % groups.length]),
    );
    compileReadoutPlan(candidate, { sourcePlanSha256, mode: "full" });
  }
  const denseEvidencePlan = buildPlan(sample);
  denseEvidencePlan.slides.at(-1).content.groups[0].items = Array.from(
    { length: 12 },
    (_, index) => `Evidence item ${index + 1}`,
  );
  const denseEvidenceSpec = compileReadoutPlan(denseEvidencePlan, {
    sourcePlanSha256,
    mode: "full",
  });
  const denseItemBoxes = denseEvidenceSpec.slides
    .at(-1)
    .primitives.filter((primitive) => primitive.role === "evidence-group-item");
  denseItemBoxes.forEach((left, index) =>
    denseItemBoxes.slice(index + 1).forEach((right) => {
      if (left.x === right.x && left.w === right.w) {
        check(!boxesOverlap(left, right), "dense evidence items must not overlap");
      }
    }),
  );

  const unbrandedPlan = buildPlan(sample, { unbranded: true });
  const unbranded = compileReadoutPlan(unbrandedPlan, { sourcePlanSha256, mode: "full" });
  check(
    !unbranded.slides.flatMap((slide) => slide.primitives).some((primitive) => primitive.role === "wordmark"),
    "unbranded cover must emit no wordmark",
  );
  check(
    full.slides[0].primitives.some(
      (primitive) => primitive.role === "wordmark" && primitive.text === plan.brand.wordmark,
    ),
    "branded cover must emit the supplied wordmark",
  );

  assertThrowsCode("unknown deck key", "E_SPEC_SCHEMA", (spec) => {
    spec.extra = true;
  }, full);
  assertThrowsCode("unknown primitive kind", "E_SPEC_SCHEMA", (spec) => {
    spec.slides[0].primitives[0].kind = "image";
  }, full);
  assertThrowsCode("unknown family", "E_UNSUPPORTED_FAMILY", (spec) => {
    spec.slides[0].family = "chart";
  }, full);
  assertThrowsCode("null", "E_SPEC_SCHEMA", (spec) => {
    spec.theme.requiredFooter = null;
  }, full);
  assertThrowsCode("sparse array", "E_SPEC_SCHEMA", (spec) => {
    delete spec.slides[0].primitives[1];
  }, full);
  assertThrowsCode("nonfinite", "E_GEOMETRY_NONFINITE", (spec) => {
    spec.slides[0].primitives[0].x = Number.NaN;
  }, full);
  assertThrowsCode("out of bounds", "E_GEOMETRY_BOUNDS", (spec) => {
    spec.slides[0].primitives[0].x = 1;
  }, full);
  assertThrowsCode("negative size", "E_GEOMETRY_BOUNDS", (spec) => {
    spec.slides[1].primitives.find((primitive) => primitive.kind === "shape").w = -1;
  }, full);
  assertThrowsCode("peer overlap", "E_GEOMETRY_OVERLAP", (spec) => {
    const peers = spec.slides[1].primitives.filter((primitive) => primitive.role === "decision-fact-card");
    peers[1].x = peers[0].x;
    peers[1].y = peers[0].y;
  }, full);
  assertThrowsCode("duplicate name", "E_NAME_DUPLICATE", (spec) => {
    spec.slides[0].primitives[1].name = spec.slides[0].primitives[0].name;
  }, full);
  assertThrowsCode("invalid name", "E_NAME_INVALID", (spec) => {
    spec.slides[0].primitives[0].name = "not a valid name";
  }, full);
  assertThrowsCode("bad z", "E_NONDETERMINISTIC_OUTPUT", (spec) => {
    spec.slides[0].primitives[1].z = 99;
  }, full);
  assertThrowsCode("empty text", "E_TEXT_EMPTY", (spec) => {
    spec.slides[0].primitives.find((primitive) => primitive.kind === "text").text = " ";
  }, full);
  assertThrowsCode("control text", "E_TEXT_CONTROL_CHAR", (spec) => {
    spec.slides[0].primitives.find((primitive) => primitive.kind === "text").text = "bad\u0001text";
  }, full);
  assertThrowsCode("control notes", "E_TEXT_CONTROL_CHAR", (spec) => {
    spec.slides[0].notesText = `bad\u0001notes\r\nEvidence: ${spec.slides[0].evidenceIds.join(", ")}\r\nHuman context: ${spec.slides[0].judgmentIds.join(", ")}`;
  }, full);
  assertThrowsCode("unknown color role", "E_COLOR_INVALID", (spec) => {
    spec.slides[0].backgroundColorRole = "brand";
  }, full);
  assertThrowsCode("notes mismatch", "E_EVIDENCE_NOT_DECLARED", (spec) => {
    spec.slides[0].evidenceIds = ["different"];
  }, full);
  assertThrowsCode("unbranded wordmark", "E_SPEC_SCHEMA", (spec) => {
    spec.theme.unbranded = true;
  }, full);

  const unsupportedPlan = buildPlan(sample);
  unsupportedPlan.slides[2] = clone(sample.slides.find((slide) => slide.family === "workflow"));
  try {
    compileReadoutPlan(unsupportedPlan, { sourcePlanSha256, mode: "full" });
    failures.push("unsupported selected family must fail");
  } catch (error) {
    check(error.code === "E_UNSUPPORTED_FAMILY", "unsupported selected family requires E_UNSUPPORTED_FAMILY");
  }
  const mediaPlan = buildPlan(sample);
  mediaPlan.brand.logo = "logo.svg";
  try {
    compileReadoutPlan(mediaPlan, { sourcePlanSha256, mode: "full" });
    failures.push("media must fail");
  } catch (error) {
    check(error.code === "E_UNSUPPORTED_MEDIA", "media requires E_UNSUPPORTED_MEDIA");
  }
  const paddedFontPlan = buildPlan(sample);
  paddedFontPlan.brand.fontFamily = " Segoe UI";
  try {
    compileReadoutPlan(paddedFontPlan, { sourcePlanSha256, mode: "full" });
    failures.push("padded font must fail");
  } catch (error) {
    check(error.code === "E_FONT_INVALID", "padded font requires E_FONT_INVALID");
  }
  const undeclaredEvidencePlan = buildPlan(sample);
  undeclaredEvidencePlan.slides[1].content.facts[0].evidenceIds = ["customer-001"];
  try {
    compileReadoutPlan(undeclaredEvidencePlan, { sourcePlanSha256, mode: "full" });
    failures.push("nested undeclared evidence must fail");
  } catch (error) {
    check(error.code === "E_EVIDENCE_NOT_DECLARED", "nested evidence requires E_EVIDENCE_NOT_DECLARED");
  }
  const unknownContentPlan = buildPlan(sample);
  unknownContentPlan.slides[0].content.caveat = "This must not disappear";
  try {
    compileReadoutPlan(unknownContentPlan, { sourcePlanSha256, mode: "full" });
    failures.push("unknown supported-family content must not be dropped");
  } catch (error) {
    check(error.code === "E_SPEC_SCHEMA", "unknown content requires E_SPEC_SCHEMA");
  }

  const outputA = join(directory, "spec-a.json");
  const outputB = join(directory, "spec-b.json");
  const successA = runNode(cli, ["--plan", planPath, "--mode", "full", "--output", outputA]);
  const successB = runNode(cli, ["--plan", planPath, "--mode", "full", "--output", outputB]);
  check(successA.status === 0 && successB.status === 0, `CLI success failed:\n${successA.stderr}${successB.stderr}`);
  const bytesA = await readFile(outputA);
  const bytesB = await readFile(outputB);
  check(bytesA.equals(bytesB), "CLI output bytes must be deterministic");
  check(!bytesA.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), "CLI output must have no BOM");
  const successJson = JSON.parse(successA.stdout);
  check(successJson.status === "PASS" && successJson.outputSha256 === hash(bytesA), "CLI success JSON must report output hash");

  const badArgs = runNode(cli, ["--plan", planPath, "--plan", planPath]);
  check(badArgs.status === 2 && badArgs.stdout === "" && /^1\. /m.test(badArgs.stderr), "bad CLI args must use numbered stderr and no stdout");
  const badModeOutput = join(directory, "bad-mode.json");
  const badMode = runNode(cli, ["--plan", planPath, "--mode", "wide", "--output", badModeOutput]);
  check(badMode.status === 2 && badMode.stdout === "", "bad mode must fail as usage");
  const originalPlanBytes = await readFile(planPath);
  const samePath = runNode(cli, [
    "--plan",
    planPath,
    "--mode",
    "full",
    "--output",
    planPath,
  ]);
  check(
    samePath.status === 2 &&
      samePath.stdout === "" &&
      (await readFile(planPath)).equals(originalPlanBytes),
    "CLI must reject output aliases without modifying the plan",
  );
  const badPlanPath = join(directory, "bad-plan.json");
  const badPlanOutput = join(directory, "bad-plan-output.json");
  await writeFile(badPlanPath, JSON.stringify({ version: "1.0" }));
  const badPlan = runNode(cli, ["--plan", badPlanPath, "--mode", "full", "--output", badPlanOutput]);
  check(badPlan.status === 1 && badPlan.stdout === "", "bad plan must fail without stdout");
  const malformedPlanPath = join(directory, "malformed-plan.json");
  await writeFile(malformedPlanPath, "{");
  const malformedPlan = runNode(cli, [
    "--plan",
    malformedPlanPath,
    "--mode",
    "full",
    "--output",
    join(directory, "malformed-output.json"),
  ]);
  check(malformedPlan.status === 2 && malformedPlan.stdout === "", "malformed JSON must exit 2");
  const leftovers = (await readdir(directory)).filter((name) => name.endsWith(".powerpoint-spec.tmp"));
  check(leftovers.length === 0, "CLI failures must clean temporary files");
} finally {
  await rm(directory, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("PowerPoint layout tests failed:");
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log("PowerPoint layout tests passed.");
