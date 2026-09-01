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
const directory = await mkdtemp(join(tmpdir(), "fde-powerpoint-shapes-"));
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

function repeatToCount(items, count) {
  return Array.from({ length: count }, (_, index) => clone(items[index % items.length]));
}

function shapeSlide(sample, family, id, countMode) {
  const slide = clone(sample.slides.find((item) => item.family === family));
  slide.id = id;
  if (family === "profile") {
    slide.content.facts = repeatToCount(
      slide.content.facts,
      countMode === "max" ? 6 : 2,
    );
    slide.content.contexts = repeatToCount(
      slide.content.contexts,
      countMode === "max" ? 5 : 1,
    );
  } else {
    const field = family === "responsibility" ? "steps" : family === "timeline" ? "milestones" : "items";
    const counts = {
      findings: [2, 5],
      responsibility: [3, 5],
      risks: [1, 4],
      timeline: [2, 6],
    };
    slide.content[field] = repeatToCount(
      slide.content[field],
      counts[family][countMode === "max" ? 1 : 0],
    );
  }
  return slide;
}

function allFamilyPlan(sample, modes = {}) {
  const cover = clone(sample.slides.find((slide) => slide.family === "cover"));
  const decision = clone(sample.slides.find((slide) => slide.family === "decision"));
  const evidence = clone(sample.slides.find((slide) => slide.family === "evidence"));
  return {
    ...clone(sample),
    slides: [
      cover,
      decision,
      shapeSlide(sample, "profile", "profile-shape", modes.profile ?? "min"),
      shapeSlide(sample, "findings", "findings-shape", modes.findings ?? "min"),
      shapeSlide(
        sample,
        "responsibility",
        "responsibility-shape",
        modes.responsibility ?? "min",
      ),
      shapeSlide(sample, "risks", "risks-shape", modes.risks ?? "min"),
      shapeSlide(sample, "timeline", "timeline-shape", modes.timeline ?? "min"),
      evidence,
    ],
  };
}

function minMaxPlan(sample) {
  const cover = clone(sample.slides.find((slide) => slide.family === "cover"));
  const decision = clone(sample.slides.find((slide) => slide.family === "decision"));
  const evidence = clone(sample.slides.find((slide) => slide.family === "evidence"));
  return {
    ...clone(sample),
    slides: [
      cover,
      decision,
      shapeSlide(sample, "profile", "profile-min", "min"),
      shapeSlide(sample, "profile", "profile-max", "max"),
      shapeSlide(sample, "findings", "findings-min", "min"),
      shapeSlide(sample, "findings", "findings-max", "max"),
      shapeSlide(sample, "responsibility", "responsibility-min", "min"),
      shapeSlide(sample, "responsibility", "responsibility-max", "max"),
      shapeSlide(sample, "risks", "risks-min", "min"),
      shapeSlide(sample, "risks", "risks-max", "max"),
      shapeSlide(sample, "timeline", "timeline-min", "min"),
      shapeSlide(sample, "timeline", "timeline-max", "max"),
      evidence,
    ],
  };
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

function nestedEvidenceStrings(value, key = "") {
  if (key === "evidenceIds" && Array.isArray(value)) return [value.join(", ")];
  if (Array.isArray(value)) return value.flatMap((item) => nestedEvidenceStrings(item));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([childKey, child]) =>
      nestedEvidenceStrings(child, childKey),
    );
  }
  return [];
}

function boxesOverlap(left, right) {
  const tolerance = 0.0005;
  return (
    left.x < right.x + right.w - tolerance &&
    right.x < left.x + left.w - tolerance &&
    left.y < right.y + right.h - tolerance &&
    right.y < left.y + left.h - tolerance
  );
}

function makeEntriesUnique(items, family) {
  return items.map((item, index) => {
    if (typeof item === "string") return `${item} ${index + 1}`;
    const result = clone(item);
    const fields = {
      profile: ["label", "value"],
      findings: ["title", "statement", "consequence"],
      responsibility: ["statement"],
      risks: ["risk", "impact", "control", "residualRisk"],
      timeline: ["label", "owner", "due", "outcome"],
    }[family];
    for (const field of fields) result[field] = `${result[field]} ${index + 1}`;
    return result;
  });
}

function assertPeerNonOverlap(slide, role, label) {
  const peers = slide.primitives.filter(
    (primitive) => primitive.kind === "shape" && primitive.role === role,
  );
  peers.forEach((left, index) =>
    peers.slice(index + 1).forEach((right) =>
      check(!boxesOverlap(left, right), `${label} ${role} peers must not overlap`),
    ),
  );
  return peers;
}

function assertFamilyGeometry(spec, plan, family, field, count, label) {
  const slide = spec.slides.find((item) => item.family === family);
  const source = plan.slides[slide.sourceIndex - 1];
  const renderedTexts = new Set(
    slide.primitives
      .filter((primitive) => primitive.kind === "text")
      .map((primitive) => primitive.text),
  );
  for (const text of contentStrings(source.content)) {
    check(renderedTexts.has(text), `${label} must preserve ${JSON.stringify(text)}`);
  }
  for (const primitive of slide.primitives) {
    if (primitive.kind !== "line" && !primitive.role.startsWith("footer-")) {
      check(primitive.y + primitive.h <= 478, `${label} content must remain above footer`);
    }
  }

  if (family === "profile") {
    const role = field === "facts" ? "profile-fact-card" : "profile-context-cell";
    const peers = assertPeerNonOverlap(slide, role, label);
    check(peers.length === count, `${label} must emit ${count} ${role} shapes`);
    if (field === "facts") {
      check(
        peers.every(
          (box) =>
            box.x >= 48 &&
            box.y >= 224 &&
            box.x + box.w <= 584 &&
            box.y + box.h <= 470,
        ),
        `${label} facts must remain inside the 48,224,536,246 region`,
      );
      check(
        new Set(peers.map((box) => box.x)).size === (count <= 3 ? 1 : 2),
        `${label} facts must use the required column count`,
      );
    } else {
      check(
        peers.every(
          (box) =>
            box.x === 600 &&
            box.w === 312 &&
            box.y >= 338 &&
            box.y + box.h <= 470,
        ),
        `${label} contexts must remain inside the 600,338,312,132 region`,
      );
    }
  } else if (family === "findings") {
    const peers = assertPeerNonOverlap(slide, "finding-row", label);
    check(peers.length === count, `${label} must emit ${count} finding rows`);
    check(
      peers.every(
        (box) =>
          box.x === 48 &&
          box.w === 864 &&
          box.y >= 124 &&
          Math.abs(peers.at(-1).y + peers.at(-1).h - 470) < 0.001,
      ),
      `${label} rows must fill the 48,124,864,346 region`,
    );
  } else if (family === "responsibility") {
    const peers = assertPeerNonOverlap(slide, "responsibility-cell", label);
    check(peers.length === count, `${label} must emit ${count} responsibility cells`);
    check(
      peers[0].x === 48 &&
        peers.every((box) => box.y === 144 && box.h === 222) &&
        Math.abs(peers.at(-1).x + peers.at(-1).w - 912) < 0.001,
      `${label} cells must fill the 48,144,864,222 strip`,
    );
  } else if (family === "risks") {
    const peers = assertPeerNonOverlap(slide, "risk-card", label);
    check(peers.length === count, `${label} must emit ${count} risk cards`);
    check(
      peers.every(
        (box) =>
          box.x >= 48 &&
          box.y >= 124 &&
          box.x + box.w <= 912 &&
          box.y + box.h <= 438,
      ),
      `${label} cards must remain inside the 48,124,864,314 region`,
    );
    if (count === 1) {
      check(
        peers[0].x === 192 && peers[0].w === 576,
        `${label} single risk card must be centered at width 576`,
      );
    } else if (count < 4) {
      check(
        new Set(peers.map((box) => box.x)).size === count &&
          new Set(peers.map((box) => box.y)).size === 1,
        `${label} risks must use one row of ${count} columns`,
      );
    } else {
      check(
        new Set(peers.map((box) => box.x)).size === 2 &&
          new Set(peers.map((box) => box.y)).size === 2,
        `${label} four risks must use a 2x2 grid`,
      );
    }
  } else if (family === "timeline") {
    const slots = assertPeerNonOverlap(slide, "timeline-slot", label);
    const markers = assertPeerNonOverlap(slide, "timeline-marker", label);
    check(
      slots.length === count && markers.length === count,
      `${label} must emit ${count} slots and markers`,
    );
    check(
      slots[0].x === 48 &&
        slots.every(
          (box) =>
            box.y === 231 &&
            box.h === 227 &&
            Math.abs(box.w - 864 / count) < 0.001,
        ) &&
        Math.abs(slots.at(-1).x + slots.at(-1).w - 912) < 0.001,
      `${label} slots must fill the safe horizontal bounds`,
    );
  }
}

async function validatePlan(plan, label) {
  const path = join(directory, `${label}.json`);
  await writeFile(path, JSON.stringify(plan));
  const result = spawnSync(process.execPath, [validator, path], {
    encoding: "utf8",
  });
  check(
    result.status === 0,
    `${label} must pass canonical validation:\n${result.stdout}${result.stderr}`,
  );
}

function compile(plan, mode = "full") {
  const raw = JSON.stringify(plan);
  return compileReadoutPlan(plan, {
    sourcePlanSha256: hash(raw),
    mode,
  });
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
    check(error.path?.startsWith("$"), `${label}: error must include a JSON path`);
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
  const plan = minMaxPlan(sample);
  const originalPlan = JSON.stringify(plan);
  await validatePlan(plan, "all-family-min-max");

  const full = compile(plan);
  const fullAgain = compile(plan);
  check(
    stableSerialize(full) === stableSerialize(fullAgain),
    "all-family compilation must be deterministic",
  );
  check(JSON.stringify(plan) === originalPlan, "compilation must not mutate the plan");

  const names = full.slides.flatMap((slide) =>
    slide.primitives.map((primitive) => primitive.name),
  );
  check(
    names.length === new Set(names.map((name) => name.toLowerCase())).size,
    "primitive names must be globally unique",
  );
  for (const slide of full.slides) {
    check(
      slide.primitives.every((primitive, index) => primitive.z === index + 1),
      `${slide.id} must have contiguous z values`,
    );
    const source = plan.slides[slide.sourceIndex - 1];
    const renderedTexts = new Set(
      slide.primitives
        .filter((primitive) => primitive.kind === "text")
        .map((primitive) => primitive.text),
    );
    for (const text of [source.title, ...contentStrings(source.content)]) {
      check(
        renderedTexts.has(text),
        `${slide.id} must preserve exact content ${JSON.stringify(text)}`,
      );
    }
    if (["profile", "findings", "responsibility", "risks", "timeline"].includes(slide.family)) {
      for (const evidence of nestedEvidenceStrings(source.content)) {
        check(
          renderedTexts.has(evidence),
          `${slide.id} must render nested evidence ${JSON.stringify(evidence)}`,
        );
      }
      for (const primitive of slide.primitives) {
        if (primitive.kind === "line") {
          check(
            [primitive.x1, primitive.x2].every((value) => value >= 0 && value <= 960) &&
              [primitive.y1, primitive.y2].every((value) => value >= 0 && value <= 540),
            `${slide.id} line must remain in stage bounds`,
          );
        } else {
          check(
            primitive.x >= 0 &&
              primitive.y >= 0 &&
              primitive.w > 0 &&
              primitive.h > 0 &&
              primitive.x + primitive.w <= 960 &&
              primitive.y + primitive.h <= 540,
            `${slide.id} box must remain in stage bounds`,
          );
          if (!primitive.role.startsWith("footer-")) {
            check(
              primitive.y + primitive.h <= 478,
              `${slide.id} content box must remain above the footer`,
            );
          }
        }
      }
    }
  }

  const peerRoles = [
    "profile-fact-card",
    "profile-context-cell",
    "finding-row",
    "responsibility-cell",
    "risk-card",
    "timeline-slot",
    "timeline-marker",
  ];
  for (const slide of full.slides) {
    for (const role of peerRoles) {
      const peers = slide.primitives.filter(
        (primitive) => primitive.kind === "shape" && primitive.role === role,
      );
      peers.forEach((left, index) =>
        peers.slice(index + 1).forEach((right) =>
          check(!boxesOverlap(left, right), `${slide.id} ${role} peers must not overlap`),
        ),
      );
    }
  }

  const riskMax = full.slides.find((slide) => slide.id === "risks-max");
  const fourRiskCards = riskMax.primitives.filter(
    (primitive) => primitive.role === "risk-card",
  );
  check(fourRiskCards.length === 4, "four-risk layout must emit four cards");
  check(
    new Set(fourRiskCards.map((card) => card.x)).size === 2 &&
      new Set(fourRiskCards.map((card) => card.y)).size === 2,
    "four-risk layout must use a 2x2 grid",
  );
  const timelineMax = full.slides.find((slide) => slide.id === "timeline-max");
  const sixSlots = timelineMax.primitives.filter(
    (primitive) => primitive.role === "timeline-slot",
  );
  check(sixSlots.length === 6, "six-milestone layout must emit six slots");
  check(
    sixSlots[0].x === 48 &&
      Math.abs(sixSlots.at(-1).x + sixSlots.at(-1).w - 912) < 0.001,
    "six timeline slots must span exactly the safe horizontal bounds",
  );

  const sweeps = [
    ["profile-facts", "profile", "facts", [2, 3, 4, 5, 6]],
    ["profile-contexts", "profile", "contexts", [1, 2, 3, 4, 5]],
    ["findings", "findings", "items", [2, 3, 4, 5]],
    ["responsibility", "responsibility", "steps", [3, 4, 5]],
    ["risks", "risks", "items", [1, 2, 3, 4]],
    ["timeline", "timeline", "milestones", [2, 3, 4, 5, 6]],
  ];
  for (const [label, family, field, counts] of sweeps) {
    for (const count of counts) {
      const candidate = allFamilyPlan(sample);
      const slide = candidate.slides.find((item) => item.family === family);
      slide.content[field] = makeEntriesUnique(
        repeatToCount(slide.content[field], count),
        family,
      );
      await validatePlan(candidate, `${label}-${count}`);
      const candidateBefore = JSON.stringify(candidate);
      const spec = compile(candidate);
      assertFamilyGeometry(spec, candidate, family, field, count, `${label}-${count}`);
      check(
        stableSerialize(spec) === stableSerialize(compile(candidate)),
        `${label} count ${count} must serialize deterministically`,
      );
      check(
        JSON.stringify(candidate) === candidateBefore,
        `${label} count ${count} must not mutate the plan`,
      );
    }
  }

  for (const family of [
    "profile",
    "findings",
    "responsibility",
    "risks",
    "timeline",
  ]) {
    const smokePlan = allFamilyPlan(sample, { [family]: "max" });
    const smoke = compile(smokePlan, "smoke");
    check(
      smoke.selectedSlideFamilies.includes(family),
      `smoke selection must change to the densest ${family} slide`,
    );
  }

  const basePlan = allFamilyPlan(sample);
  assertCompileCode("malformed profile contexts", "E_SPEC_SCHEMA", basePlan, (candidate) => {
    candidate.slides.find((slide) => slide.family === "profile").content.contexts = {};
  });
  assertCompileCode("unknown finding field", "E_SPEC_SCHEMA", basePlan, (candidate) => {
    candidate.slides.find((slide) => slide.family === "findings").content.items[0].extra =
      "not allowed";
  });
  assertCompileCode("missing risk control", "E_SPEC_SCHEMA", basePlan, (candidate) => {
    delete candidate.slides.find((slide) => slide.family === "risks").content.items[0]
      .control;
  });
  assertCompileCode("invalid responsibility type", "E_SPEC_SCHEMA", basePlan, (candidate) => {
    candidate.slides.find((slide) => slide.family === "responsibility").content.steps[0].type =
      "autonomous";
  });
  assertCompileCode("control character in timeline owner", "E_TEXT_CONTROL_CHAR", basePlan, (candidate) => {
    candidate.slides.find((slide) => slide.family === "timeline").content.milestones[0].owner =
      "bad\u0085owner";
  });
  assertCompileCode("undeclared profile evidence", "E_EVIDENCE_NOT_DECLARED", basePlan, (candidate) => {
    candidate.slides.find((slide) => slide.family === "profile").content.facts[0].evidenceIds =
      ["baseline-001"];
  });
  for (const [family, field, invalidCount] of [
    ["profile", "facts", 1],
    ["profile", "contexts", 6],
    ["findings", "items", 1],
    ["responsibility", "steps", 6],
    ["risks", "items", 5],
    ["timeline", "milestones", 1],
  ]) {
    assertCompileCode(`${family} invalid count`, "E_SPEC_SCHEMA", basePlan, (candidate) => {
      const slide = candidate.slides.find((item) => item.family === family);
      slide.content[field] = repeatToCount(slide.content[field], invalidCount);
    });
  }

  const baseSpec = compile(basePlan);
  assertSpecCode("shape-family overlap", "E_GEOMETRY_OVERLAP", baseSpec, (candidate) => {
    const slide = candidate.slides.find((item) => item.family === "timeline");
    const slots = slide.primitives.filter((primitive) => primitive.role === "timeline-slot");
    slots[1].x = slots[0].x;
  });
  assertSpecCode("shape-family bounds", "E_GEOMETRY_BOUNDS", baseSpec, (candidate) => {
    const slide = candidate.slides.find((item) => item.family === "risks");
    slide.primitives.find((primitive) => primitive.role === "risk-card").x = -1;
  });
  assertSpecCode("shape-family duplicate name", "E_NAME_DUPLICATE", baseSpec, (candidate) => {
    const slide = candidate.slides.find((item) => item.family === "findings");
    slide.primitives[1].name = slide.primitives[0].name;
  });
  assertSpecCode("cover footer text required", "E_SPEC_SCHEMA", baseSpec, (candidate) => {
    const slide = candidate.slides.find((item) => item.family === "cover");
    slide.primitives = slide.primitives.filter(
      (primitive) => primitive.role !== "footer-position",
    );
  });
  assertSpecCode("risk footer rule required", "E_SPEC_SCHEMA", baseSpec, (candidate) => {
    const slide = candidate.slides.find((item) => item.family === "risks");
    slide.primitives = slide.primitives.filter(
      (primitive) => primitive.role !== "footer-rule",
    );
    slide.primitives.forEach((primitive, index) => {
      primitive.z = index + 1;
    });
  });
  for (const [family, role] of [
    ["profile", "profile-company"],
    ["risks", "risk-evidence"],
    ["timeline", "timeline-owner"],
  ]) {
    assertSpecCode(`${family} footer-band intrusion`, "E_GEOMETRY_BOUNDS", baseSpec, (candidate) => {
      const slide = candidate.slides.find((item) => item.family === family);
      slide.primitives.find((primitive) => primitive.role === role).y = 480;
    });
  }
  for (const [family, role] of [
    ["profile", "profile-business-model"],
    ["timeline", "timeline-owner"],
  ]) {
    assertSpecCode(`${family} C1 text`, "E_TEXT_CONTROL_CHAR", baseSpec, (candidate) => {
      const slide = candidate.slides.find((item) => item.family === family);
      slide.primitives.find((primitive) => primitive.role === role).text =
        "bad\u0085text";
    });
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("PowerPoint shape-family tests failed:");
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log("PowerPoint shape-family tests passed.");
