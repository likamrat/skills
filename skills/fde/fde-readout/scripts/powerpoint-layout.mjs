import { createHash } from "node:crypto";

import { selectSmokeSlides } from "./powerpoint-smoke-contract.mjs";

const SCHEMA_VERSION = "fde-drawing-spec/1.0";
const COLOR_ROLES = ["ink", "system", "decision", "risk", "paper", "muted", "line"];
const SUPPORTED_FAMILIES = new Set(["cover", "decision", "metrics", "evidence"]);
const TEXT_SIZES = new Set([8, 11, 28, 34]);
const NAME_PATTERN = /^fde-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const STRICT_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const DECK_KEYS = [
  "schemaVersion",
  "units",
  "stage",
  "source",
  "theme",
  "selectedSlideIds",
  "selectedSlideFamilies",
  "slides",
];
const SLIDE_KEYS = [
  "sourceIndex",
  "id",
  "family",
  "title",
  "customerSafe",
  "backgroundColorRole",
  "notesText",
  "evidenceIds",
  "judgmentIds",
  "primitives",
];
const BASE_KEYS = ["kind", "name", "role", "z"];
const TEXT_KEYS = [
  ...BASE_KEYS,
  "x",
  "y",
  "w",
  "h",
  "text",
  "fontSize",
  "bold",
  "italic",
  "colorRole",
  "horizontalAlign",
  "verticalAlign",
  "rotation",
  "marginLeft",
  "marginRight",
  "marginTop",
  "marginBottom",
  "wordWrap",
  "autoFit",
  "maxLines",
];
const SHAPE_KEYS = [
  ...BASE_KEYS,
  "shapeType",
  "x",
  "y",
  "w",
  "h",
  "fillVisible",
  "fillColorRole",
  "fillTransparency",
  "lineVisible",
  "lineColorRole",
  "lineTransparency",
  "lineWidth",
  "lineDash",
];
const LINE_KEYS = [
  ...BASE_KEYS,
  "x1",
  "y1",
  "x2",
  "y2",
  "colorRole",
  "transparency",
  "width",
  "dash",
  "arrowStart",
  "arrowEnd",
];

export class DrawingSpecError extends Error {
  constructor(code, path, message) {
    super(`${code} at ${path}: ${message}`);
    this.name = "DrawingSpecError";
    this.code = code;
    this.path = path;
  }
}

function assertFont(value, path) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    STRICT_CONTROL_PATTERN.test(value)
  ) {
    fail("E_FONT_INVALID", path, "font must be nonblank, unpadded, and control-free");
  }
}

function fail(code, path, message) {
  throw new DrawingSpecError(code, path, message);
}

function sha(value, length) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function round3(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function slug(value) {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "item"
  );
}

function slideToken(id) {
  const token = slug(id);
  return token.length <= 40 ? token : `${token.slice(0, 31)}-${sha(token, 8)}`;
}

function primitiveName(sourceIndex, id, semanticPath) {
  const prefix = `fde-s${String(sourceIndex).padStart(2, "0")}-${slideToken(id)}-`;
  let result = `${prefix}${semanticPath}`;
  if (result.length > 120) result = `${prefix}${sha(semanticPath, 12)}`;
  return result;
}

function exactKeys(value, expected, path) {
  if (!isPlainObject(value)) fail("E_SPEC_SCHEMA", path, "expected plain object");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("E_SPEC_SCHEMA", path, `expected keys ${wanted.join(", ")}`);
  }
}

function allowedKeys(value, allowed, required, path) {
  if (!isPlainObject(value)) fail("E_SPEC_SCHEMA", path, "expected plain object");
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail("E_SPEC_SCHEMA", `${path}.${key}`, "unknown content field");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("E_SPEC_SCHEMA", `${path}.${key}`, "missing content field");
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function descriptorFor(value, key, path) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch (error) {
    fail("E_SPEC_SCHEMA", path, `property inspection failed: ${error.message}`);
  }
  if (
    !descriptor ||
    !Object.hasOwn(descriptor, "value") ||
    descriptor.enumerable !== true ||
    descriptor.writable !== true
  ) {
    fail(
      "E_SPEC_SCHEMA",
      path,
      "properties must be enumerable writable data properties",
    );
  }
  return descriptor;
}

function snapshotPlainData(value, path = "$") {
  if (value === null) fail("E_SPEC_SCHEMA", path, "null is not allowed");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("E_GEOMETRY_NONFINITE", path, "number must be finite");
    }
    return value;
  }
  if (["string", "boolean"].includes(typeof value)) return value;
  if (typeof value !== "object") {
    fail("E_SPEC_SCHEMA", path, "value must be plain JSON data");
  }

  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch (error) {
    fail("E_SPEC_SCHEMA", path, `property inspection failed: ${error.message}`);
  }
  if (keys.some((key) => typeof key === "symbol")) {
    fail("E_SPEC_SCHEMA", path, "symbol properties are not allowed");
  }

  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      fail("E_SPEC_SCHEMA", path, "array prototype must be Array.prototype");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor?.value;
    if (
      !lengthDescriptor ||
      !Object.hasOwn(lengthDescriptor, "value") ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      lengthDescriptor.writable !== true
    ) {
      fail("E_SPEC_SCHEMA", `${path}.length`, "array length descriptor is invalid");
    }
    const indexKeys = keys.filter((key) => key !== "length");
    if (
      indexKeys.length !== length ||
      indexKeys.some((key, index) => key !== String(index))
    ) {
      fail("E_SPEC_SCHEMA", path, "array must contain only dense owned indexes");
    }
    const snapshot = new Array(length);
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptorFor(value, String(index), `${path}[${index}]`);
      snapshot[index] = snapshotPlainData(descriptor.value, `${path}[${index}]`);
    }
    return snapshot;
  }

  if (prototype !== Object.prototype && prototype !== null) {
    fail(
      "E_SPEC_SCHEMA",
      path,
      "object prototype must be Object.prototype or null",
    );
  }
  const snapshot =
    prototype === null ? Object.create(null) : Object.create(Object.prototype);
  for (const key of keys) {
    const descriptor = descriptorFor(value, key, `${path}.${key}`);
    Object.defineProperty(snapshot, key, {
      value: snapshotPlainData(descriptor.value, `${path}.${key}`),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return snapshot;
}

function isDenseArray(value) {
  return (
    Array.isArray(value) &&
    Object.getPrototypeOf(value) === Array.prototype &&
    Object.keys(value).length === value.length
  );
}

function normalizeColor(value, path) {
  if (!/^#[0-9a-f]{6}$/i.test(value ?? "")) {
    fail("E_COLOR_INVALID", path, "expected #RRGGBB");
  }
  return value.toUpperCase();
}

function textPrimitive(ctx, semanticPath, role, box, text, options = {}) {
  return ctx.add({
    kind: "text",
    name: primitiveName(ctx.sourceIndex, ctx.id, semanticPath),
    role,
    ...box,
    text,
    fontSize: options.fontSize ?? 11,
    bold: options.bold ?? false,
    italic: options.italic ?? false,
    colorRole: options.colorRole ?? "ink",
    horizontalAlign: options.horizontalAlign ?? "left",
    verticalAlign: options.verticalAlign ?? "top",
    rotation: options.rotation ?? 0,
    marginLeft: options.marginLeft ?? 0,
    marginRight: options.marginRight ?? 0,
    marginTop: options.marginTop ?? 0,
    marginBottom: options.marginBottom ?? 0,
    wordWrap: true,
    autoFit: "none",
    maxLines: options.maxLines ?? 6,
  });
}

function shapePrimitive(ctx, semanticPath, role, box, options = {}) {
  return ctx.add({
    kind: "shape",
    name: primitiveName(ctx.sourceIndex, ctx.id, semanticPath),
    role,
    shapeType: options.shapeType ?? "rect",
    ...box,
    fillVisible: options.fillVisible ?? true,
    fillColorRole: options.fillColorRole ?? "paper",
    fillTransparency: options.fillTransparency ?? 0,
    lineVisible: options.lineVisible ?? true,
    lineColorRole: options.lineColorRole ?? "line",
    lineTransparency: options.lineTransparency ?? 0,
    lineWidth: options.lineWidth ?? 0.75,
    lineDash: options.lineDash ?? "solid",
  });
}

function linePrimitive(ctx, semanticPath, role, points, options = {}) {
  return ctx.add({
    kind: "line",
    name: primitiveName(ctx.sourceIndex, ctx.id, semanticPath),
    role,
    ...points,
    colorRole: options.colorRole ?? "line",
    transparency: options.transparency ?? 0,
    width: options.width ?? 0.75,
    dash: options.dash ?? "solid",
    arrowStart: "none",
    arrowEnd: options.arrowEnd ?? "none",
  });
}

function createContext(slide, sourceIndex) {
  const primitives = [];
  return {
    id: slide.id,
    sourceIndex,
    primitives,
    add(primitive) {
      for (const [key, value] of Object.entries(primitive)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          primitive[key] = round3(value);
        }
      }
      primitive.z = primitives.length + 1;
      primitives.push(primitive);
      return primitive;
    },
  };
}

function addStandardHeader(ctx, slide) {
  linePrimitive(
    ctx,
    "accent-rail",
    "accent-rail",
    { x1: 48, y1: 28, x2: 160, y2: 28 },
    { colorRole: "system", width: 2 },
  );
  textPrimitive(
    ctx,
    "slide-title",
    "slide-title",
    { x: 48, y: 40, w: 864, h: 68 },
    slide.title,
    { fontSize: 28, bold: true, maxLines: 2 },
  );
}

function compactEvidence(evidenceIds, judgmentIds) {
  const evidence = evidenceIds.slice(0, 4).map((id) => `[${id}]`).join(" ");
  const evidenceMore =
    evidenceIds.length > 4 ? ` +${evidenceIds.length - 4} in notes` : "";
  const judgments = judgmentIds.slice(0, 2).map((id) => `{${id}}`).join(" ");
  const judgmentMore =
    judgmentIds.length > 2 ? ` +${judgmentIds.length - 2} in notes` : "";
  return `E${evidence ? ` ${evidence}` : ""}${evidenceMore}${
    judgments ? `  J ${judgments}${judgmentMore}` : ""
  }`;
}

function addFooter(ctx, slide, cover = false) {
  const colorRole = cover ? "paper" : "muted";
  linePrimitive(
    ctx,
    "footer-rule",
    "footer-rule",
    { x1: 48, y1: 498, x2: 912, y2: 498 },
    { colorRole: cover ? "paper" : "line", width: 0.75 },
  );
  textPrimitive(
    ctx,
    "footer-required",
    "footer-required",
    { x: 48, y: 506, w: 220, h: 18 },
    ctx.requiredFooter,
    { fontSize: 8, bold: true, colorRole, maxLines: 1 },
  );
  textPrimitive(
    ctx,
    "footer-evidence",
    "footer-evidence",
    { x: 276, y: 506, w: 408, h: 18 },
    compactEvidence(slide.evidenceIds, slide.judgmentIds),
    { fontSize: 8, colorRole, horizontalAlign: "center", maxLines: 1 },
  );
  textPrimitive(
    ctx,
    "footer-position",
    "footer-position",
    { x: 692, y: 506, w: 220, h: 18 },
    `${ctx.sourceIndex}`,
    { fontSize: 8, colorRole, horizontalAlign: "right", maxLines: 1 },
  );
}

function compileCover(ctx, slide, plan) {
  shapePrimitive(
    ctx,
    "background",
    "cover-background",
    { x: 0, y: 0, w: 960, h: 540 },
    { fillColorRole: "ink", lineVisible: false },
  );
  shapePrimitive(
    ctx,
    "vertical-rail",
    "cover-rail",
    { x: 48, y: 72, w: 4, h: 340 },
    { fillColorRole: "decision", lineVisible: false },
  );
  if (plan.brand.source !== "unbranded") {
    textPrimitive(
      ctx,
      "wordmark",
      "wordmark",
      { x: 72, y: 72, w: 600, h: 22 },
      plan.brand.wordmark,
      { fontSize: 11, bold: true, colorRole: "paper", maxLines: 1 },
    );
  }
  textPrimitive(
    ctx,
    "cover-title",
    "cover-title",
    { x: 72, y: 150, w: 640, h: 82 },
    slide.title,
    { fontSize: 34, bold: true, colorRole: "paper", maxLines: 2 },
  );
  textPrimitive(
    ctx,
    "subtitle",
    "cover-subtitle",
    { x: 72, y: 250, w: 620, h: 56 },
    slide.content.subtitle,
    { fontSize: 11, colorRole: "paper", maxLines: 3 },
  );
  shapePrimitive(
    ctx,
    "decision-outline",
    "cover-decision-outline",
    { x: 72, y: 330, w: 620, h: 60 },
    { fillVisible: false, lineColorRole: "system", lineWidth: 2 },
  );
  textPrimitive(
    ctx,
    "decision",
    "cover-decision",
    { x: 88, y: 346, w: 588, h: 28 },
    slide.content.decision,
    { fontSize: 11, bold: true, colorRole: "paper", verticalAlign: "middle", maxLines: 2 },
  );
  addFooter(ctx, slide, true);
}

function compileDecision(ctx, slide) {
  addStandardHeader(ctx, slide);
  shapePrimitive(
    ctx,
    "main",
    "decision-main",
    { x: 48, y: 124, w: 596, h: 346 },
    { fillColorRole: "ink", lineVisible: false },
  );
  textPrimitive(
    ctx,
    "recommendation-label",
    "decision-recommendation-label",
    { x: 72, y: 148, w: 548, h: 18 },
    "RECOMMENDATION",
    { fontSize: 8, bold: true, colorRole: "decision", maxLines: 1 },
  );
  textPrimitive(
    ctx,
    "recommendation",
    "decision-recommendation",
    { x: 72, y: 174, w: 548, h: 58 },
    slide.content.recommendation,
    { fontSize: 34, bold: true, colorRole: "paper", maxLines: 2 },
  );
  const bulletGap = 6;
  const bulletHeight = (190 - bulletGap * (slide.content.bullets.length - 1)) / slide.content.bullets.length;
  slide.content.bullets.forEach((bullet, index) => {
    textPrimitive(
      ctx,
      `bullet-${String(index + 1).padStart(2, "0")}`,
      "decision-bullet",
      { x: 72, y: 250 + index * (bulletHeight + bulletGap), w: 548, h: bulletHeight },
      bullet,
      { fontSize: 11, colorRole: "paper", verticalAlign: "middle", maxLines: 3 },
    );
  });
  const factGap = 8;
  const factHeight = (346 - factGap * (slide.content.facts.length - 1)) / slide.content.facts.length;
  slide.content.facts.forEach((fact, index) => {
    const y = 124 + index * (factHeight + factGap);
    const token = `fact-${String(index + 1).padStart(2, "0")}`;
    shapePrimitive(
      ctx,
      `${token}-card`,
      "decision-fact-card",
      { x: 660, y, w: 252, h: factHeight },
      { fillVisible: false },
    );
    textPrimitive(
      ctx,
      `${token}-label`,
      "decision-fact-label",
      { x: 674, y: y + 14, w: 224, h: 22 },
      fact.label,
      { fontSize: 8, bold: true, colorRole: "system", maxLines: 2 },
    );
    textPrimitive(
      ctx,
      `${token}-value`,
      "decision-fact-value",
      { x: 674, y: y + 42, w: 224, h: Math.max(18, factHeight - 56) },
      fact.value,
      { fontSize: 11, bold: true, verticalAlign: "middle", maxLines: 5 },
    );
  });
  addFooter(ctx, slide);
}

function compileMetrics(ctx, slide) {
  addStandardHeader(ctx, slide);
  const width = 864 / slide.content.metrics.length;
  slide.content.metrics.forEach((metric, index) => {
    const x = 48 + index * width;
    const token = `metric-${String(index + 1).padStart(2, "0")}`;
    shapePrimitive(
      ctx,
      `${token}-cell`,
      "metric-cell",
      { x, y: 142, w: width, h: 214 },
      {
        fillColorRole: index === 1 ? "system" : "paper",
        fillTransparency: index === 1 ? 0 : 1,
        lineVisible: index === 0,
      },
    );
    const textColor = index === 1 ? "paper" : "ink";
    textPrimitive(
      ctx,
      `${token}-label`,
      "metric-label",
      { x: x + 14, y: 158, w: width - 28, h: 24 },
      metric.label,
      { fontSize: 8, bold: true, colorRole: textColor, maxLines: 2 },
    );
    textPrimitive(
      ctx,
      `${token}-value`,
      "metric-value",
      { x: x + 14, y: 192, w: width - 28, h: 70 },
      metric.value,
      { fontSize: 34, bold: true, colorRole: textColor, verticalAlign: "middle", maxLines: 2 },
    );
    if (typeof metric.context === "string" && metric.context.length > 0) {
      textPrimitive(
        ctx,
        `${token}-context`,
        "metric-context",
        { x: x + 14, y: 278, w: width - 28, h: 58 },
        metric.context,
        { fontSize: 11, colorRole: textColor, verticalAlign: "bottom", maxLines: 4 },
      );
    }
  });
  for (let index = 1; index < slide.content.metrics.length; index += 1) {
    const x = 48 + index * width;
    linePrimitive(
      ctx,
      `metric-divider-${String(index).padStart(2, "0")}`,
      "metric-divider",
      { x1: x, y1: 142, x2: x, y2: 356 },
    );
  }
  linePrimitive(
    ctx,
    "outcome-rule",
    "metrics-outcome-rule",
    { x1: 48, y1: 392, x2: 912, y2: 392 },
    { colorRole: "decision", width: 2 },
  );
  textPrimitive(
    ctx,
    "outcome",
    "metrics-outcome",
    { x: 48, y: 408, w: 864, h: 60 },
    slide.content.outcome.statement,
    { fontSize: 11, bold: true, verticalAlign: "middle", maxLines: 4 },
  );
  addFooter(ctx, slide);
}

function evidenceRows(count) {
  if (count <= 3) return [count];
  return count === 4 ? [2, 2] : [3, 2];
}

function compileEvidence(ctx, slide) {
  addStandardHeader(ctx, slide);
  const rows = evidenceRows(slide.content.groups.length);
  let groupIndex = 0;
  const rowGap = 10;
  const rowHeight = (300 - rowGap * (rows.length - 1)) / rows.length;
  rows.forEach((columnCount, rowIndex) => {
    const gap = 12;
    const width = (864 - gap * (columnCount - 1)) / columnCount;
    const usedWidth = width * columnCount + gap * (columnCount - 1);
    const startX = 48 + (864 - usedWidth) / 2;
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const group = slide.content.groups[groupIndex];
      const x = startX + columnIndex * (width + gap);
      const y = 124 + rowIndex * (rowHeight + rowGap);
      const token = `group-${String(groupIndex + 1).padStart(2, "0")}`;
      shapePrimitive(
        ctx,
        `${token}-card`,
        "evidence-card",
        { x, y, w: width, h: rowHeight },
        { fillVisible: false, lineColorRole: groupIndex % 2 ? "decision" : "system", lineWidth: 2 },
      );
      textPrimitive(
        ctx,
        `${token}-label`,
        "evidence-group-label",
        { x: x + 14, y: y + 12, w: width - 28, h: 22 },
        group.label,
        { fontSize: 11, bold: true, maxLines: 2 },
      );
      const itemTop = y + 40;
      const itemBottom = y + rowHeight - 24;
      group.items.forEach((item, itemIndex) => {
        const itemY = round3(
          itemTop + ((itemBottom - itemTop) * itemIndex) / group.items.length,
        );
        const nextItemY = round3(
          itemTop +
            ((itemBottom - itemTop) * (itemIndex + 1)) / group.items.length,
        );
        textPrimitive(
          ctx,
          `${token}-item-${String(itemIndex + 1).padStart(2, "0")}`,
          "evidence-group-item",
          {
            x: x + 14,
            y: itemY,
            w: width - 28,
            h: Math.max(0.001, nextItemY - itemY - 0.001),
          },
          item,
          { fontSize: 8, maxLines: 2 },
        );
      });
      textPrimitive(
        ctx,
        `${token}-evidence`,
        "evidence-group-ids",
        { x: x + 14, y: y + rowHeight - 22, w: width - 28, h: 14 },
        group.evidenceIds.join(", "),
        { fontSize: 8, colorRole: "muted", maxLines: 1 },
      );
      groupIndex += 1;
    }
  });
  linePrimitive(
    ctx,
    "controls-rule",
    "evidence-controls-rule",
    { x1: 48, y1: 438, x2: 912, y2: 438 },
    { colorRole: "risk", width: 2 },
  );
  const controlWidth = 864 / slide.content.controls.length;
  slide.content.controls.forEach((control, index) => {
    textPrimitive(
      ctx,
      `control-${String(index + 1).padStart(2, "0")}`,
      "evidence-control",
      { x: 48 + index * controlWidth, y: 448, w: controlWidth, h: 30 },
      control,
      { fontSize: 8, bold: true, colorRole: "risk", horizontalAlign: "center", maxLines: 2 },
    );
  });
  addFooter(ctx, slide);
}

function compileSlide(plan, slide, sourceIndex) {
  const ctx = createContext(slide, sourceIndex);
  ctx.requiredFooter = plan.brand.requiredFooter;
  switch (slide.family) {
    case "cover":
      compileCover(ctx, slide, plan);
      break;
    case "decision":
      compileDecision(ctx, slide);
      break;
    case "metrics":
      compileMetrics(ctx, slide);
      break;
    case "evidence":
      compileEvidence(ctx, slide);
      break;
    default:
      fail("E_UNSUPPORTED_FAMILY", `$.slides[${sourceIndex - 1}].family`, slide.family);
  }
  return {
    sourceIndex,
    id: slide.id,
    family: slide.family,
    title: slide.title,
    customerSafe: slide.customerSafe,
    backgroundColorRole: slide.family === "cover" ? "ink" : "paper",
    notesText: `${slide.notes}\r\nEvidence: ${slide.evidenceIds.join(", ")}\r\nHuman context: ${slide.judgmentIds.join(", ")}`,
    evidenceIds: [...slide.evidenceIds],
    judgmentIds: [...slide.judgmentIds],
    primitives: ctx.primitives,
  };
}

function validateNestedEvidence(slide, slideIndex) {
  const declared = new Set(slide.evidenceIds);
  const nested =
    slide.family === "decision"
      ? slide.content.facts
      : slide.family === "metrics"
        ? [...slide.content.metrics, slide.content.outcome]
        : slide.family === "evidence"
          ? slide.content.groups
          : [];
  nested.forEach((item, itemIndex) => {
    item.evidenceIds.forEach((evidenceId, evidenceIndex) => {
      if (!declared.has(evidenceId)) {
        fail(
          "E_EVIDENCE_NOT_DECLARED",
          `$.slides[${slideIndex}].content.${slide.family === "decision" ? "facts" : slide.family === "metrics" && itemIndex === nested.length - 1 ? "outcome" : slide.family === "metrics" ? "metrics" : "groups"}${slide.family === "metrics" && itemIndex === nested.length - 1 ? "" : `[${itemIndex}]`}.evidenceIds[${evidenceIndex}]`,
          `${evidenceId} is absent from slide.evidenceIds`,
        );
      }
    });
  });
}

function validateMetricContext(metric, path) {
  if (!Object.hasOwn(metric, "context")) return;
  if (typeof metric.context !== "string" || metric.context.trim().length === 0) {
    fail("E_TEXT_EMPTY", path, "metric context must be a nonempty string");
  }
  if (STRICT_CONTROL_PATTERN.test(metric.context)) {
    fail(
      "E_TEXT_CONTROL_CHAR",
      path,
      "metric context contains a control character",
    );
  }
}

function validateSupportedContent(slide, slideIndex) {
  const path = `$.slides[${slideIndex}].content`;
  switch (slide.family) {
    case "cover":
      allowedKeys(slide.content, ["subtitle", "decision"], ["subtitle", "decision"], path);
      break;
    case "decision":
      allowedKeys(
        slide.content,
        ["recommendation", "bullets", "facts"],
        ["recommendation", "bullets", "facts"],
        path,
      );
      slide.content.facts.forEach((fact, index) =>
        allowedKeys(
          fact,
          ["label", "value", "evidenceIds"],
          ["label", "value", "evidenceIds"],
          `${path}.facts[${index}]`,
        ),
      );
      break;
    case "metrics":
      allowedKeys(slide.content, ["metrics", "outcome"], ["metrics", "outcome"], path);
      if (!isDenseArray(slide.content.metrics)) {
        fail("E_SPEC_SCHEMA", `${path}.metrics`, "expected a dense metrics array");
      }
      slide.content.metrics.forEach((metric, index) =>
        isPlainObject(metric)
          ? allowedKeys(
              metric,
              ["label", "value", "context", "evidenceIds"],
              ["label", "value", "evidenceIds"],
              `${path}.metrics[${index}]`,
            )
          : fail(
              "E_SPEC_SCHEMA",
              `${path}.metrics[${index}]`,
              "expected a metric object",
            ),
      );
      slide.content.metrics.forEach((metric, index) => {
        validateMetricContext(metric, `${path}.metrics[${index}].context`);
      });
      allowedKeys(
        slide.content.outcome,
        ["statement", "evidenceIds"],
        ["statement", "evidenceIds"],
        `${path}.outcome`,
      );
      break;
    case "evidence":
      allowedKeys(slide.content, ["groups", "controls"], ["groups", "controls"], path);
      slide.content.groups.forEach((group, index) =>
        allowedKeys(
          group,
          ["label", "items", "evidenceIds"],
          ["label", "items", "evidenceIds"],
          `${path}.groups[${index}]`,
        ),
      );
      break;
  }
}

export function compileReadoutPlan(inputPlan, { sourcePlanSha256, mode } = {}) {
  const plan = snapshotPlainData(inputPlan);
  if (!isPlainObject(plan)) fail("E_SPEC_SCHEMA", "$", "plan must be a plain object");
  if (!["smoke", "full"].includes(mode)) fail("E_SPEC_SCHEMA", "$.mode", "expected smoke or full");
  if (!/^[a-f0-9]{64}$/.test(sourcePlanSha256 ?? "")) {
    fail("E_SPEC_SCHEMA", "$.sourcePlanSha256", "expected lowercase SHA-256");
  }
  assertFont(plan.brand?.fontFamily, "$.brand.fontFamily");
  if (plan.brand?.logo) fail("E_UNSUPPORTED_MEDIA", "$.brand.logo", "media is not supported");
  for (const [slideIndex, slide] of plan.slides.entries()) {
    if (slide.family !== "metrics") continue;
    const metricsPath = `$.slides[${slideIndex}].content.metrics`;
    if (
      !isPlainObject(slide.content) ||
      !isDenseArray(slide.content.metrics)
    ) {
      fail("E_SPEC_SCHEMA", metricsPath, "expected a dense metrics array");
    }
    for (const [metricIndex, metric] of slide.content.metrics.entries()) {
      if (!isPlainObject(metric)) {
        fail(
          "E_SPEC_SCHEMA",
          `${metricsPath}[${metricIndex}]`,
          "expected a metric object",
        );
      }
      validateMetricContext(
        metric,
        `${metricsPath}[${metricIndex}].context`,
      );
    }
  }
  const selected = mode === "smoke" ? selectSmokeSlides(plan) : plan.slides;
  const sourceIndexes = new Map(plan.slides.map((slide, index) => [slide, index + 1]));
  selected.forEach((slide) => {
    if (!SUPPORTED_FAMILIES.has(slide.family)) {
      fail("E_UNSUPPORTED_FAMILY", `$.slides[${sourceIndexes.get(slide) - 1}].family`, slide.family);
    }
    validateSupportedContent(slide, sourceIndexes.get(slide) - 1);
    validateNestedEvidence(slide, sourceIndexes.get(slide) - 1);
  });
  const colors = Object.fromEntries(
    COLOR_ROLES.map((role) => [role, normalizeColor(plan.brand?.colors?.[role], `$.brand.colors.${role}`)]),
  );
  const spec = {
    schemaVersion: SCHEMA_VERSION,
    units: "points",
    stage: { width: 960, height: 540 },
    source: {
      planId: plan.id,
      planVersion: plan.version,
      planSha256: sourcePlanSha256,
    },
    theme: {
      fontFamily: plan.brand.fontFamily,
      colors,
      requiredFooter: plan.brand.requiredFooter,
      unbranded: plan.brand.source === "unbranded",
    },
    selectedSlideIds: selected.map((slide) => slide.id),
    selectedSlideFamilies: selected.map((slide) => slide.family),
    slides: selected.map((slide) => compileSlide(plan, slide, sourceIndexes.get(slide))),
  };
  return validateDrawingSpec(spec);
}

function assertString(value, path, { nonempty = true } = {}) {
  if (typeof value !== "string" || (nonempty && value.trim().length === 0)) {
    fail("E_SPEC_SCHEMA", path, "expected nonempty string");
  }
}

function assertStringArray(value, path) {
  if (!isDenseArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    fail("E_SPEC_SCHEMA", path, "expected string array");
  }
}

function assertColorRole(value, path) {
  if (!COLOR_ROLES.includes(value)) fail("E_COLOR_INVALID", path, "unknown theme color role");
}

function assertText(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) fail("E_TEXT_EMPTY", path, "text is blank");
  if (CONTROL_PATTERN.test(value)) fail("E_TEXT_CONTROL_CHAR", path, "text contains a control character");
}

function assertGeometryBox(item, path, stage) {
  for (const key of ["x", "y", "w", "h"]) {
    if (typeof item[key] !== "number" || !Number.isFinite(item[key])) {
      fail("E_GEOMETRY_NONFINITE", `${path}.${key}`, "expected finite number");
    }
  }
  if (item.w <= 0 || item.h <= 0) fail("E_GEOMETRY_BOUNDS", path, "width and height must be positive");
  if (item.x < 0 || item.y < 0 || item.x + item.w > stage.width || item.y + item.h > stage.height) {
    fail("E_GEOMETRY_BOUNDS", path, "box must remain inside stage");
  }
}

function overlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function validatePrimitive(primitive, path, stage, names) {
  if (!isPlainObject(primitive)) fail("E_SPEC_SCHEMA", path, "expected primitive object");
  const keys =
    primitive.kind === "text"
      ? TEXT_KEYS
      : primitive.kind === "shape"
        ? SHAPE_KEYS
        : primitive.kind === "line"
          ? LINE_KEYS
          : undefined;
  if (!keys) fail("E_SPEC_SCHEMA", `${path}.kind`, "primitive kind is not supported");
  exactKeys(primitive, keys, path);
  if (!NAME_PATTERN.test(primitive.name) || primitive.name.length > 120) {
    fail("E_NAME_INVALID", `${path}.name`, "name must be <=120 characters of ASCII lowercase kebab-case");
  }
  const folded = primitive.name.toLowerCase();
  if (names.has(folded)) fail("E_NAME_DUPLICATE", `${path}.name`, primitive.name);
  names.add(folded);
  assertString(primitive.role, `${path}.role`);
  if (!Number.isInteger(primitive.z) || primitive.z < 1) fail("E_NONDETERMINISTIC_OUTPUT", `${path}.z`, "z must be positive integer");
  if (primitive.kind === "text") {
    assertGeometryBox(primitive, path, stage);
    assertText(primitive.text, `${path}.text`);
    if (
      primitive.role === "metric-context" &&
      STRICT_CONTROL_PATTERN.test(primitive.text)
    ) {
      fail(
        "E_TEXT_CONTROL_CHAR",
        `${path}.text`,
        "metric context contains a control character",
      );
    }
    if (!TEXT_SIZES.has(primitive.fontSize)) fail("E_SPEC_SCHEMA", `${path}.fontSize`, "unsupported text size");
    for (const key of ["bold", "italic", "wordWrap"]) {
      if (typeof primitive[key] !== "boolean") fail("E_SPEC_SCHEMA", `${path}.${key}`, "expected boolean");
    }
    assertColorRole(primitive.colorRole, `${path}.colorRole`);
    if (!["left", "center", "right"].includes(primitive.horizontalAlign)) fail("E_SPEC_SCHEMA", `${path}.horizontalAlign`, "invalid alignment");
    if (!["top", "middle", "bottom"].includes(primitive.verticalAlign)) fail("E_SPEC_SCHEMA", `${path}.verticalAlign`, "invalid alignment");
    if (![0, 270].includes(primitive.rotation)) fail("E_SPEC_SCHEMA", `${path}.rotation`, "invalid rotation");
    for (const key of ["marginLeft", "marginRight", "marginTop", "marginBottom"]) {
      if (!Number.isFinite(primitive[key]) || primitive[key] < 0) fail("E_GEOMETRY_BOUNDS", `${path}.${key}`, "margin must be nonnegative");
    }
    if (primitive.wordWrap !== true || primitive.autoFit !== "none" || !Number.isInteger(primitive.maxLines) || primitive.maxLines < 1) {
      fail("E_SPEC_SCHEMA", path, "text wrapping contract is invalid");
    }
  } else if (primitive.kind === "shape") {
    assertGeometryBox(primitive, path, stage);
    if (!["rect", "roundRect", "ellipse", "diamond"].includes(primitive.shapeType)) fail("E_SPEC_SCHEMA", `${path}.shapeType`, "invalid shape");
    for (const key of ["fillVisible", "lineVisible"]) if (typeof primitive[key] !== "boolean") fail("E_SPEC_SCHEMA", `${path}.${key}`, "expected boolean");
    assertColorRole(primitive.fillColorRole, `${path}.fillColorRole`);
    assertColorRole(primitive.lineColorRole, `${path}.lineColorRole`);
    for (const key of ["fillTransparency", "lineTransparency"]) {
      if (!Number.isFinite(primitive[key]) || primitive[key] < 0 || primitive[key] > 1) fail("E_SPEC_SCHEMA", `${path}.${key}`, "expected number from 0 to 1");
    }
    if (!Number.isFinite(primitive.lineWidth) || primitive.lineWidth <= 0) fail("E_GEOMETRY_BOUNDS", `${path}.lineWidth`, "line width must be positive");
    if (!["solid", "dash", "dot", "dashDot"].includes(primitive.lineDash)) fail("E_SPEC_SCHEMA", `${path}.lineDash`, "invalid line dash");
  } else {
    for (const key of ["x1", "y1", "x2", "y2", "width", "transparency"]) {
      if (!Number.isFinite(primitive[key])) fail("E_GEOMETRY_NONFINITE", `${path}.${key}`, "expected finite number");
    }
    if ([primitive.x1, primitive.x2].some((x) => x < 0 || x > stage.width) || [primitive.y1, primitive.y2].some((y) => y < 0 || y > stage.height) || (primitive.x1 === primitive.x2 && primitive.y1 === primitive.y2) || primitive.width <= 0) {
      fail("E_GEOMETRY_BOUNDS", path, "line must be nonzero and inside stage");
    }
    assertColorRole(primitive.colorRole, `${path}.colorRole`);
    if (primitive.transparency < 0 || primitive.transparency > 1) fail("E_SPEC_SCHEMA", `${path}.transparency`, "expected number from 0 to 1");
    if (!["solid", "dash", "dot", "dashDot"].includes(primitive.dash) || primitive.arrowStart !== "none" || !["none", "open"].includes(primitive.arrowEnd)) {
      fail("E_SPEC_SCHEMA", path, "line style is invalid");
    }
  }
}

function validateDrawingSpecSnapshot(spec) {
  exactKeys(spec, DECK_KEYS, "$");
  if (spec.schemaVersion !== SCHEMA_VERSION || spec.units !== "points") fail("E_SPEC_SCHEMA", "$", "invalid schema version or units");
  exactKeys(spec.stage, ["width", "height"], "$.stage");
  if (spec.stage.width !== 960 || spec.stage.height !== 540) fail("E_SPEC_SCHEMA", "$.stage", "stage must be 960x540");
  exactKeys(spec.source, ["planId", "planVersion", "planSha256"], "$.source");
  assertString(spec.source.planId, "$.source.planId");
  if (spec.source.planVersion !== "1.0" || !/^[a-f0-9]{64}$/.test(spec.source.planSha256)) fail("E_SPEC_SCHEMA", "$.source", "invalid plan version or hash");
  exactKeys(spec.theme, ["fontFamily", "colors", "requiredFooter", "unbranded"], "$.theme");
  assertFont(spec.theme.fontFamily, "$.theme.fontFamily");
  assertString(spec.theme.requiredFooter, "$.theme.requiredFooter");
  if (typeof spec.theme.unbranded !== "boolean") fail("E_SPEC_SCHEMA", "$.theme.unbranded", "expected boolean");
  exactKeys(spec.theme.colors, COLOR_ROLES, "$.theme.colors");
  for (const role of COLOR_ROLES) if (!/^#[0-9A-F]{6}$/.test(spec.theme.colors[role])) fail("E_COLOR_INVALID", `$.theme.colors.${role}`, "expected uppercase #RRGGBB");
  assertStringArray(spec.selectedSlideIds, "$.selectedSlideIds");
  assertStringArray(spec.selectedSlideFamilies, "$.selectedSlideFamilies");
  if (!isDenseArray(spec.slides) || spec.slides.length === 0 || spec.selectedSlideIds.length !== spec.slides.length || spec.selectedSlideFamilies.length !== spec.slides.length) {
    fail("E_SPEC_SCHEMA", "$.slides", "selection arrays must match slides");
  }
  const names = new Set();
  spec.slides.forEach((slide, slideIndex) => {
    const path = `$.slides[${slideIndex}]`;
    exactKeys(slide, SLIDE_KEYS, path);
    if (!Number.isInteger(slide.sourceIndex) || slide.sourceIndex < 1) fail("E_SPEC_SCHEMA", `${path}.sourceIndex`, "expected 1-based integer");
    assertString(slide.id, `${path}.id`);
    assertString(slide.title, `${path}.title`);
    if (!SUPPORTED_FAMILIES.has(slide.family)) fail("E_UNSUPPORTED_FAMILY", `${path}.family`, slide.family);
    if (typeof slide.customerSafe !== "boolean") fail("E_SPEC_SCHEMA", `${path}.customerSafe`, "expected boolean");
    assertColorRole(slide.backgroundColorRole, `${path}.backgroundColorRole`);
    assertStringArray(slide.evidenceIds, `${path}.evidenceIds`);
    if (!isDenseArray(slide.judgmentIds) || !slide.judgmentIds.every((item) => typeof item === "string" && item.length > 0)) fail("E_SPEC_SCHEMA", `${path}.judgmentIds`, "expected string array");
    assertText(slide.notesText, `${path}.notesText`);
    const suffix = `\r\nEvidence: ${slide.evidenceIds.join(", ")}\r\nHuman context: ${slide.judgmentIds.join(", ")}`;
    if (typeof slide.notesText !== "string" || !slide.notesText.endsWith(suffix)) fail("E_EVIDENCE_NOT_DECLARED", `${path}.notesText`, "notes evidence does not match slide IDs");
    if (spec.selectedSlideIds[slideIndex] !== slide.id || spec.selectedSlideFamilies[slideIndex] !== slide.family) fail("E_SPEC_SCHEMA", path, "selection metadata does not match slide");
    if (!isDenseArray(slide.primitives) || slide.primitives.length === 0) fail("E_SPEC_SCHEMA", `${path}.primitives`, "expected nonempty primitive array");
    slide.primitives.forEach((primitive, primitiveIndex) => validatePrimitive(primitive, `${path}.primitives[${primitiveIndex}]`, spec.stage, names));
    slide.primitives.forEach((primitive, primitiveIndex) => {
      if (primitive.z !== primitiveIndex + 1) fail("E_NONDETERMINISTIC_OUTPUT", `${path}.primitives[${primitiveIndex}].z`, "z must be contiguous from 1");
      if (spec.theme.unbranded && primitive.role === "wordmark") fail("E_SPEC_SCHEMA", `${path}.primitives[${primitiveIndex}].role`, "unbranded spec cannot emit wordmark");
    });
    for (const role of ["decision-fact-card", "metric-cell", "evidence-card"]) {
      const peers = slide.primitives.filter((primitive) => primitive.kind === "shape" && primitive.role === role);
      peers.forEach((left, leftIndex) => peers.slice(leftIndex + 1).forEach((right) => {
        if (overlap(left, right)) fail("E_GEOMETRY_OVERLAP", path, `${role} peers overlap`);
      }));
    }
  });
  return spec;
}

export function validateDrawingSpec(spec) {
  return validateDrawingSpecSnapshot(snapshotPlainData(spec));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function stableSerialize(spec) {
  const snapshot = snapshotPlainData(spec);
  validateDrawingSpecSnapshot(snapshot);
  return JSON.stringify(canonical(snapshot));
}
