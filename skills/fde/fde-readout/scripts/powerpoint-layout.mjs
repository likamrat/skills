import { createHash } from "node:crypto";

import { selectSmokeSlides } from "./powerpoint-smoke-contract.mjs";

const SCHEMA_VERSION = "fde-drawing-spec/1.0";
const COLOR_ROLES = ["ink", "system", "decision", "risk", "paper", "muted", "line"];
const SUPPORTED_FAMILIES = new Set([
  "cover",
  "decision",
  "profile",
  "metrics",
  "findings",
  "responsibility",
  "risks",
  "timeline",
  "chart",
  "table",
  "evaluation",
  "evidence",
]);
const TEXT_SIZES = new Set([8, 11, 28, 34]);
const RESPONSIBILITY_TYPES = new Set([
  "deterministic",
  "model",
  "human",
  "hybrid",
]);
const EVALUATION_RESULTS = new Set(["pass", "escalate", "fail"]);
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
const TABLE_KEYS = [
  ...BASE_KEYS,
  "x",
  "y",
  "w",
  "h",
  "headers",
  "rows",
  "rowEvidenceIds",
  "columnWidths",
  "rowHeights",
  "headerFillColorRole",
  "headerFillTransparency",
  "bodyFillColorRole",
  "alternateFillColorRole",
  "alternateFillTransparency",
  "lineColorRole",
  "lineWidth",
  "headerFontSize",
  "bodyFontSize",
  "headerFontColorRole",
  "bodyFontColorRole",
  "cellMargin",
];
const CHART_KEYS = [
  ...BASE_KEYS,
  "chartType",
  "x",
  "y",
  "w",
  "h",
  "unit",
  "insightEvidenceIds",
  "unitLabel",
  "plot",
  "axis",
  "categories",
  "legend",
  "dataGrid",
  "series",
];
const CHART_LABEL_KEYS = [
  "name",
  "text",
  "x",
  "y",
  "w",
  "h",
  "fontSize",
  "bold",
  "colorRole",
  "horizontalAlign",
  "verticalAlign",
  "rotation",
];
const NAMED_LINE_KEYS = [
  "name",
  "x1",
  "y1",
  "x2",
  "y2",
  "colorRole",
  "width",
  "dash",
  "transparency",
];
const CHART_SERIES_STYLES = Object.freeze([
  Object.freeze({ colorRole: "system", dash: "solid" }),
  Object.freeze({ colorRole: "decision", dash: "dash" }),
  Object.freeze({ colorRole: "ink", dash: "dot" }),
  Object.freeze({ colorRole: "muted", dash: "dashDot" }),
]);

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

function tablePrimitive(
  ctx,
  semanticPath,
  role,
  box,
  headers,
  rows,
  rowEvidenceIds,
  columnWidths,
  rowHeights,
) {
  return ctx.add({
    kind: "table",
    name: primitiveName(ctx.sourceIndex, ctx.id, semanticPath),
    role,
    ...box,
    headers,
    rows,
    rowEvidenceIds,
    columnWidths,
    rowHeights,
    headerFillColorRole: "system",
    headerFillTransparency: 0,
    bodyFillColorRole: "paper",
    alternateFillColorRole: "system",
    alternateFillTransparency: 0.92,
    lineColorRole: "line",
    lineWidth: 0.75,
    headerFontSize: 8,
    bodyFontSize: 8,
    headerFontColorRole: "ink",
    bodyFontColorRole: "ink",
    cellMargin: 6,
  });
}

function chartName(ctx, semanticPath) {
  return primitiveName(ctx.sourceIndex, ctx.id, `chart-${semanticPath}`);
}

function chartLabel(ctx, semanticPath, text, box, options = {}) {
  return {
    name: chartName(ctx, semanticPath),
    text,
    ...Object.fromEntries(
      Object.entries(box).map(([key, value]) => [key, round3(value)]),
    ),
    fontSize: options.fontSize ?? 8,
    bold: options.bold ?? false,
    colorRole: options.colorRole ?? "ink",
    horizontalAlign: options.horizontalAlign ?? "left",
    verticalAlign: options.verticalAlign ?? "middle",
    rotation: options.rotation ?? 0,
  };
}

function namedChartLine(ctx, semanticPath, points, options = {}) {
  return {
    name: chartName(ctx, semanticPath),
    ...Object.fromEntries(
      Object.entries(points).map(([key, value]) => [key, round3(value)]),
    ),
    colorRole: options.colorRole ?? "line",
    width: options.width ?? 0.75,
    dash: options.dash ?? "solid",
    transparency: options.transparency ?? 0,
  };
}

function cleanNumber(value) {
  const cleaned = Number.parseFloat(value.toPrecision(12));
  return Object.is(cleaned, -0) ? 0 : cleaned;
}

function nextNiceStep(step) {
  const power = 10 ** Math.floor(Math.log10(step));
  const mantissa = cleanNumber(step / power);
  if (mantissa < 2) return 2 * power;
  if (mantissa < 5) return 5 * power;
  return 10 * power;
}

function niceBounds(domainMin, domainMax, step) {
  let min = Math.floor(domainMin / step) * step;
  let max = Math.ceil(domainMax / step) * step;
  if (Number.isFinite(min) && min > domainMin) {
    const extended = min - step;
    min = Number.isFinite(extended) ? extended : domainMin;
  }
  if (Number.isFinite(max) && max < domainMax) {
    const extended = max + step;
    max = Number.isFinite(extended) ? extended : domainMax;
  }
  return { min, max };
}

function niceAxis(values) {
  const domainMin = Math.min(0, ...values);
  const domainMax = Math.max(0, ...values);
  const adjustedMax =
    domainMin === domainMax ? (domainMin === 0 ? 1 : domainMin + 1) : domainMax;
  const rough = (adjustedMax - domainMin) / 4;
  if (rough === 0) {
    const step = Number.MIN_VALUE;
    const min = Math.floor(domainMin / step) * step;
    const max = Math.ceil(adjustedMax / step) * step;
    const count = Math.round((max - min) / step);
    return {
      min,
      max,
      step,
      ticks: Array.from({ length: count + 1 }, (_, index) =>
        cleanNumber(min + index * step),
      ),
    };
  }
  const power = 10 ** Math.floor(Math.log10(rough));
  const mantissa = rough / power;
  let step = (mantissa <= 1 ? 1 : mantissa <= 2 ? 2 : mantissa <= 5 ? 5 : 10) * power;
  let { min, max } = niceBounds(domainMin, adjustedMax, step);
  while (Math.round((max - min) / step) + 1 > 6) {
    step = nextNiceStep(step);
    ({ min, max } = niceBounds(domainMin, adjustedMax, step));
  }
  if (![min, max, step].every(Number.isFinite)) {
    const step = Math.max(Math.abs(domainMin), Math.abs(adjustedMax));
    const mixed = domainMin < 0 && adjustedMax > 0;
    const min = mixed ? -step : domainMin;
    const max = mixed ? step : adjustedMax;
    const ticks = [min, 0, max]
      .filter((value, index, array) => array.indexOf(value) === index)
      .sort((left, right) => left - right);
    return { min, max, step, ticks };
  }
  min = cleanNumber(min);
  max = cleanNumber(max);
  step = cleanNumber(step);
  const count = Math.round((max - min) / step);
  const ticks = Array.from({ length: count + 1 }, (_, index) =>
    cleanNumber(min + index * step),
  );
  return { min, max, step, ticks };
}

function scaleChartY(value, axis, plot) {
  const range = axis.max - axis.min;
  let ratio;
  if (Number.isFinite(range)) {
    ratio = (axis.max - value) / range;
  } else {
    const scale = Math.max(Math.abs(axis.min), Math.abs(axis.max));
    ratio =
      (axis.max / scale - value / scale) /
      (axis.max / scale - axis.min / scale);
  }
  return round3(plot.y + ratio * plot.h);
}

function compileChart(ctx, slide) {
  addStandardHeader(ctx, slide);
  const content = slide.content;
  const categoryCount = content.categories.length;
  const seriesCount = content.series.length;
  const plot = { x: 112, y: 160, w: 800, h: 180 };
  const axisValues = content.series.flatMap((series) => series.values);
  const axisShape = niceAxis(axisValues);
  const scaleY = (value) => scaleChartY(value, axisShape, plot);
  const zeroY = scaleY(0);
  const tickLabelX = 48;
  const tickLabelW = 56;
  const axis = {
    min: axisShape.min,
    max: axisShape.max,
    step: axisShape.step,
    zeroY,
    baseline: namedChartLine(
      ctx,
      "axis-baseline",
      { x1: plot.x, y1: zeroY, x2: plot.x + plot.w, y2: zeroY },
      { colorRole: "ink", width: 1 },
    ),
    ticks: axisShape.ticks
      .slice()
      .reverse()
      .map((value, index) => {
        const y = scaleY(value);
        return {
          value,
          label: String(value),
          gridLine: namedChartLine(
            ctx,
            `axis-tick-${String(index + 1).padStart(2, "0")}-grid`,
            { x1: plot.x, y1: y, x2: plot.x + plot.w, y2: y },
            { transparency: 0.35 },
          ),
          labelBox: chartLabel(
            ctx,
            `axis-tick-${String(index + 1).padStart(2, "0")}-label`,
            String(value),
            {
              x: tickLabelX,
              y: Math.max(plot.y, Math.min(plot.y + plot.h - 12, y - 6)),
              w: tickLabelW,
              h: 12,
            },
            { colorRole: "muted", horizontalAlign: "right" },
          ),
        };
      }),
  };
  const categoryWidth = plot.w / categoryCount;
  const categories = content.categories.map((label, index) => ({
    index,
    label,
    labelBox: chartLabel(
      ctx,
      `category-${String(index + 1).padStart(2, "0")}-label`,
      label,
      { x: plot.x + index * categoryWidth, y: 344, w: categoryWidth, h: 28 },
      { horizontalAlign: "center" },
    ),
  }));
  const legendWidth = 864 / seriesCount;
  const legend = content.series.map((series, index) => ({
    seriesIndex: index,
    colorRole: CHART_SERIES_STYLES[index].colorRole,
    swatchName: chartName(ctx, `legend-${String(index + 1).padStart(2, "0")}-swatch`),
    swatch: {
      x: round3(48 + index * legendWidth + 8),
      y: 128,
      w: 16,
      h: 4,
    },
    labelBox: chartLabel(
      ctx,
      `legend-${String(index + 1).padStart(2, "0")}-label`,
      series.name,
      { x: 48 + index * legendWidth + 30, y: 120, w: legendWidth - 38, h: 20 },
      { bold: true },
    ),
  }));
  const rowHeight = 60 / seriesCount;
  const valueWidth = 800 / categoryCount;
  const dataGrid = {
    x: 48,
    y: 376,
    w: 864,
    h: 60,
    seriesLabelWidth: 64,
    rowHeight: round3(rowHeight),
    rows: content.series.map((series, seriesIndex) => ({
      seriesIndex,
      labelBox: chartLabel(
        ctx,
        `data-row-${String(seriesIndex + 1).padStart(2, "0")}-series`,
        series.name,
        { x: 48, y: 376 + seriesIndex * rowHeight, w: 64, h: rowHeight },
        { bold: true },
      ),
      values: series.values.map((value, categoryIndex) => ({
        categoryIndex,
        value,
        labelBox: chartLabel(
          ctx,
          `data-row-${String(seriesIndex + 1).padStart(2, "0")}-value-${String(categoryIndex + 1).padStart(2, "0")}`,
          String(value),
          {
            x: 112 + categoryIndex * valueWidth,
            y: 376 + seriesIndex * rowHeight,
            w: valueWidth,
            h: rowHeight,
          },
          { horizontalAlign: "center" },
        ),
      })),
    })),
  };
  const groupW = plot.w / categoryCount;
  const usableW = groupW * 0.84;
  const barGap = Math.max(1, groupW * 0.02);
  const barW = (usableW - barGap * (seriesCount - 1)) / seriesCount;
  const series = content.series.map((sourceSeries, seriesIndex) => {
    const style = CHART_SERIES_STYLES[seriesIndex];
    const base = {
      index: seriesIndex,
      name: sourceSeries.name,
      evidenceIds: [...sourceSeries.evidenceIds],
      colorRole: style.colorRole,
      dash: style.dash,
    };
    if (content.chartType === "bar") {
      return {
        ...base,
        bars: sourceSeries.values.map((value, categoryIndex) => {
          const groupX =
            plot.x + categoryIndex * groupW + (groupW - usableW) / 2;
          const x = groupX + seriesIndex * (barW + barGap);
          const valueY = scaleY(value);
          const isZero = value === 0;
          const height = round3(Math.abs(valueY - zeroY));
          const visibleHeight = isZero ? 1 : Math.max(1, height);
          const y =
            value > 0
              ? Math.max(plot.y, zeroY - visibleHeight)
              : Math.min(zeroY, plot.y + plot.h - visibleHeight);
          return {
            kind: isZero ? "line" : "rect",
            name: chartName(
              ctx,
              `series-${String(seriesIndex + 1).padStart(2, "0")}-bar-${String(categoryIndex + 1).padStart(2, "0")}`,
            ),
            categoryIndex,
            value,
            x: round3(x),
            y: isZero
              ? round3(
                  Math.max(
                    plot.y,
                    Math.min(plot.y + plot.h - 1, zeroY - 0.5),
                  ),
                )
              : round3(y),
            w: round3(barW),
            h: visibleHeight,
            fillTransparency: 0,
          };
        }),
      };
    }
    const points = sourceSeries.values.map((value, categoryIndex) => ({
      categoryIndex,
      value,
      x: round3(plot.x + (categoryIndex + 0.5) * groupW),
      y: scaleY(value),
    }));
    return {
      ...base,
      segments: points.slice(1).map((point, index) => ({
        name: chartName(
          ctx,
          `series-${String(seriesIndex + 1).padStart(2, "0")}-segment-${String(index + 1).padStart(2, "0")}`,
        ),
        fromCategoryIndex: index,
        toCategoryIndex: index + 1,
        x1: points[index].x,
        y1: points[index].y,
        x2: point.x,
        y2: point.y,
      })),
      markers: points.map((point) => ({
        name: chartName(
          ctx,
          `series-${String(seriesIndex + 1).padStart(2, "0")}-marker-${String(point.categoryIndex + 1).padStart(2, "0")}`,
        ),
        categoryIndex: point.categoryIndex,
        value: point.value,
        cx: point.x,
        cy: point.y,
        diameter: 6,
      })),
    };
  });
  ctx.add({
    kind: "nativeChart",
    name: primitiveName(ctx.sourceIndex, ctx.id, "native-chart"),
    role: "native-chart",
    chartType: content.chartType,
    x: 48,
    y: 120,
    w: 864,
    h: 318,
    unit: content.unit,
    insightEvidenceIds: [...content.insight.evidenceIds],
    unitLabel: chartLabel(
      ctx,
      "unit-label",
      content.unit,
      { x: 48, y: 142, w: 864, h: 14 },
      { bold: true, colorRole: "muted" },
    ),
    plot,
    axis,
    categories,
    legend,
    dataGrid,
    series,
  });
  linePrimitive(
    ctx,
    "insight-rule",
    "chart-insight-rule",
    { x1: 48, y1: 446, x2: 912, y2: 446 },
    { colorRole: "decision", width: 2 },
  );
  textPrimitive(
    ctx,
    "insight",
    "chart-insight",
    { x: 48, y: 454, w: 704, h: 24 },
    content.insight.statement,
    { fontSize: 11, bold: true, verticalAlign: "middle", maxLines: 2 },
  );
  textPrimitive(
    ctx,
    "insight-evidence",
    "chart-insight-evidence",
    { x: 768, y: 454, w: 144, h: 24 },
    content.insight.evidenceIds.join(", "),
    {
      fontSize: 8,
      colorRole: "muted",
      horizontalAlign: "right",
      verticalAlign: "middle",
      maxLines: 2,
    },
  );
  addFooter(ctx, slide);
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

function gridCells(region, count, columns, horizontalGap, verticalGap) {
  const rows = Math.ceil(count / columns);
  const width = (region.w - horizontalGap * (columns - 1)) / columns;
  const height = (region.h - verticalGap * (rows - 1)) / rows;
  return Array.from({ length: count }, (_, index) => ({
    x: region.x + (index % columns) * (width + horizontalGap),
    y: region.y + Math.floor(index / columns) * (height + verticalGap),
    w: width,
    h: height,
  }));
}

function itemToken(label, index) {
  return `${label}-${String(index + 1).padStart(2, "0")}`;
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

function compileProfile(ctx, slide) {
  addStandardHeader(ctx, slide);
  textPrimitive(
    ctx,
    "company",
    "profile-company",
    { x: 48, y: 124, w: 536, h: 30 },
    slide.content.company,
    { fontSize: 11, bold: true, verticalAlign: "middle", maxLines: 2 },
  );
  textPrimitive(
    ctx,
    "business-model",
    "profile-business-model",
    { x: 48, y: 162, w: 536, h: 48 },
    slide.content.businessModel,
    { fontSize: 11, maxLines: 3 },
  );
  const factCells = gridCells(
    { x: 48, y: 224, w: 536, h: 246 },
    slide.content.facts.length,
    slide.content.facts.length <= 3 ? 1 : 2,
    8,
    8,
  );
  slide.content.facts.forEach((fact, index) => {
    const box = factCells[index];
    const token = itemToken("fact", index);
    shapePrimitive(ctx, `${token}-card`, "profile-fact-card", box, {
      fillColorRole: "system",
      fillTransparency: 0.92,
      lineVisible: false,
    });
    textPrimitive(
      ctx,
      `${token}-label`,
      "profile-fact-label",
      { x: box.x + 12, y: box.y + 9, w: box.w - 24, h: 16 },
      fact.label,
      { fontSize: 8, bold: true, colorRole: "system", maxLines: 1 },
    );
    textPrimitive(
      ctx,
      `${token}-value`,
      "profile-fact-value",
      {
        x: box.x + 12,
        y: box.y + 29,
        w: box.w - 24,
        h: Math.max(14, box.h - 50),
      },
      fact.value,
      { fontSize: 11, bold: true, verticalAlign: "middle", maxLines: 3 },
    );
    textPrimitive(
      ctx,
      `${token}-evidence`,
      "profile-fact-evidence",
      { x: box.x + 12, y: box.y + box.h - 17, w: box.w - 24, h: 11 },
      fact.evidenceIds.join(", "),
      { fontSize: 8, colorRole: "muted", maxLines: 1 },
    );
  });
  shapePrimitive(
    ctx,
    "value-card",
    "profile-value-card",
    { x: 600, y: 124, w: 312, h: 200 },
    {
      fillColorRole: "decision",
      fillTransparency: 0.92,
      lineColorRole: "decision",
      lineWidth: 2,
    },
  );
  textPrimitive(
    ctx,
    "value-label",
    "profile-value-label",
    { x: 614, y: 138, w: 284, h: 16 },
    "VALUE",
    { fontSize: 8, bold: true, colorRole: "decision", maxLines: 1 },
  );
  textPrimitive(
    ctx,
    "value-statement",
    "profile-value-statement",
    { x: 614, y: 162, w: 284, h: 126 },
    slide.content.valueStatement.statement,
    { fontSize: 11, bold: true, verticalAlign: "middle", maxLines: 7 },
  );
  textPrimitive(
    ctx,
    "value-evidence",
    "profile-value-evidence",
    { x: 614, y: 298, w: 284, h: 14 },
    slide.content.valueStatement.evidenceIds.join(", "),
    { fontSize: 8, colorRole: "muted", maxLines: 1 },
  );
  const contextCells = gridCells(
    { x: 600, y: 338, w: 312, h: 132 },
    slide.content.contexts.length,
    1,
    0,
    6,
  );
  slide.content.contexts.forEach((context, index) => {
    const box = contextCells[index];
    const token = itemToken("context", index);
    shapePrimitive(ctx, `${token}-cell`, "profile-context-cell", box, {
      fillVisible: false,
    });
    textPrimitive(
      ctx,
      `${token}-text`,
      "profile-context",
      { x: box.x + 10, y: box.y + 2, w: box.w - 20, h: box.h - 4 },
      context,
      { fontSize: 8, bold: true, verticalAlign: "middle", maxLines: 2 },
    );
  });
  addFooter(ctx, slide);
}

function compileFindings(ctx, slide) {
  addStandardHeader(ctx, slide);
  const rowHeight = 346 / slide.content.items.length;
  slide.content.items.forEach((item, index) => {
    const y = 124 + index * rowHeight;
    const token = itemToken("finding", index);
    shapePrimitive(
      ctx,
      `${token}-row`,
      "finding-row",
      { x: 48, y, w: 864, h: rowHeight },
      { fillVisible: false, lineVisible: false },
    );
    textPrimitive(
      ctx,
      `${token}-number`,
      "finding-number",
      { x: 48, y: y + 8, w: 36, h: rowHeight - 16 },
      String(index + 1).padStart(2, "0"),
      {
        fontSize: 11,
        bold: true,
        colorRole: "system",
        verticalAlign: "middle",
        maxLines: 1,
      },
    );
    textPrimitive(
      ctx,
      `${token}-title`,
      "finding-title",
      { x: 100, y: y + 8, w: 236, h: Math.max(24, rowHeight - 30) },
      item.title,
      { fontSize: 11, bold: true, verticalAlign: "middle", maxLines: 4 },
    );
    textPrimitive(
      ctx,
      `${token}-evidence`,
      "finding-evidence",
      { x: 100, y: y + rowHeight - 18, w: 236, h: 12 },
      item.evidenceIds.join(", "),
      { fontSize: 8, colorRole: "muted", maxLines: 1 },
    );
    textPrimitive(
      ctx,
      `${token}-statement`,
      "finding-statement",
      { x: 352, y: y + 8, w: 248, h: rowHeight - 16 },
      item.statement,
      { fontSize: 11, verticalAlign: "middle", maxLines: 5 },
    );
    textPrimitive(
      ctx,
      `${token}-consequence`,
      "finding-consequence",
      { x: 616, y: y + 8, w: 296, h: rowHeight - 16 },
      item.consequence,
      { fontSize: 11, bold: true, verticalAlign: "middle", maxLines: 5 },
    );
    if (index < slide.content.items.length - 1) {
      linePrimitive(
        ctx,
        `${token}-divider`,
        "finding-divider",
        { x1: 48, y1: y + rowHeight, x2: 912, y2: y + rowHeight },
      );
    }
  });
  addFooter(ctx, slide);
}

function compileResponsibility(ctx, slide) {
  addStandardHeader(ctx, slide);
  const width = 864 / slide.content.steps.length;
  slide.content.steps.forEach((step, index) => {
    const x = 48 + index * width;
    const token = itemToken("step", index);
    shapePrimitive(
      ctx,
      `${token}-cell`,
      "responsibility-cell",
      { x, y: 144, w: width, h: 222 },
      {
        fillColorRole: index % 2 === 0 ? "system" : "decision",
        fillTransparency: 0.92,
        lineVisible: index === 0,
      },
    );
    textPrimitive(
      ctx,
      `${token}-type`,
      "responsibility-type",
      { x: x + 14, y: 158, w: width - 28, h: 24 },
      step.type,
      {
        fontSize: 8,
        bold: true,
        colorRole: index % 2 === 0 ? "system" : "decision",
        maxLines: 1,
      },
    );
    textPrimitive(
      ctx,
      `${token}-statement`,
      "responsibility-statement",
      { x: x + 14, y: 190, w: width - 28, h: 136 },
      step.statement,
      { fontSize: 11, bold: true, verticalAlign: "middle", maxLines: 7 },
    );
    textPrimitive(
      ctx,
      `${token}-evidence`,
      "responsibility-evidence",
      { x: x + 14, y: 338, w: width - 28, h: 14 },
      step.evidenceIds.join(", "),
      { fontSize: 8, colorRole: "muted", maxLines: 1 },
    );
  });
  for (let index = 1; index < slide.content.steps.length; index += 1) {
    const x = 48 + index * width;
    linePrimitive(
      ctx,
      `step-divider-${String(index).padStart(2, "0")}`,
      "responsibility-divider",
      { x1: x, y1: 144, x2: x, y2: 366 },
    );
  }
  linePrimitive(
    ctx,
    "excluded-authority-rule",
    "responsibility-excluded-rule",
    { x1: 48, y1: 410, x2: 912, y2: 410 },
    { colorRole: "risk", width: 2 },
  );
  textPrimitive(
    ctx,
    "excluded-authority",
    "responsibility-excluded-authority",
    { x: 48, y: 424, w: 864, h: 32 },
    slide.content.excludedAuthority.statement,
    { fontSize: 11, bold: true, colorRole: "risk", verticalAlign: "middle", maxLines: 3 },
  );
  textPrimitive(
    ctx,
    "excluded-authority-evidence",
    "responsibility-excluded-evidence",
    { x: 48, y: 460, w: 864, h: 14 },
    slide.content.excludedAuthority.evidenceIds.join(", "),
    { fontSize: 8, colorRole: "muted", maxLines: 1 },
  );
  addFooter(ctx, slide);
}

function riskCardBoxes(count) {
  if (count === 1) return [{ x: 192, y: 124, w: 576, h: 314 }];
  if (count === 2) return gridCells({ x: 48, y: 124, w: 864, h: 314 }, 2, 2, 16, 0);
  if (count === 3) return gridCells({ x: 48, y: 124, w: 864, h: 314 }, 3, 3, 16, 0);
  return gridCells({ x: 48, y: 124, w: 864, h: 314 }, 4, 2, 16, 10);
}

function compileRisks(ctx, slide) {
  addStandardHeader(ctx, slide);
  const boxes = riskCardBoxes(slide.content.items.length);
  slide.content.items.forEach((item, index) => {
    const box = boxes[index];
    const token = itemToken("risk", index);
    shapePrimitive(ctx, `${token}-card`, "risk-card", box, {
      shapeType: "roundRect",
      fillColorRole: "risk",
      fillTransparency: 0.94,
      lineColorRole: "risk",
      lineWidth: 2,
    });
    textPrimitive(
      ctx,
      `${token}-title`,
      "risk-title",
      { x: box.x + 12, y: box.y + 8, w: box.w - 24, h: 24 },
      item.risk,
      { fontSize: 11, bold: true, colorRole: "risk", maxLines: 2 },
    );
    const compact = box.h < 200;
    const blockHeight = compact ? 30 : 56;
    const firstBlockY = box.y + (compact ? 38 : 50);
    [
      ["impact", "IMPACT", item.impact],
      ["control", "CONTROL", item.control],
      ["residual", "RESIDUAL", item.residualRisk],
    ].forEach(([pathToken, label, value], blockIndex) => {
      const y = firstBlockY + blockIndex * blockHeight;
      textPrimitive(
        ctx,
        `${token}-${pathToken}-label`,
        `risk-${pathToken}-label`,
        { x: box.x + 12, y, w: box.w - 24, h: 11 },
        label,
        { fontSize: 8, bold: true, colorRole: "risk", maxLines: 1 },
      );
      textPrimitive(
        ctx,
        `${token}-${pathToken}`,
        `risk-${pathToken}`,
        { x: box.x + 12, y: y + 12, w: box.w - 24, h: blockHeight - 13 },
        value,
        { fontSize: 8, maxLines: compact ? 2 : 4 },
      );
    });
    textPrimitive(
      ctx,
      `${token}-evidence`,
      "risk-evidence",
      { x: box.x + 12, y: box.y + box.h - 14, w: box.w - 24, h: 10 },
      item.evidenceIds.join(", "),
      { fontSize: 8, colorRole: "muted", maxLines: 1 },
    );
  });
  linePrimitive(
    ctx,
    "stop-rule",
    "risk-stop-rule",
    { x1: 48, y1: 454, x2: 912, y2: 454 },
    { colorRole: "risk", width: 2 },
  );
  textPrimitive(
    ctx,
    "stop-condition",
    "risk-stop-condition",
    { x: 48, y: 462, w: 640, h: 16 },
    slide.content.stopCondition.statement,
    { fontSize: 8, bold: true, colorRole: "risk", verticalAlign: "middle", maxLines: 1 },
  );
  textPrimitive(
    ctx,
    "stop-evidence",
    "risk-stop-evidence",
    { x: 704, y: 462, w: 208, h: 16 },
    slide.content.stopCondition.evidenceIds.join(", "),
    { fontSize: 8, colorRole: "muted", horizontalAlign: "right", maxLines: 1 },
  );
  addFooter(ctx, slide);
}

function compileTimeline(ctx, slide) {
  addStandardHeader(ctx, slide);
  shapePrimitive(
    ctx,
    "decision-strip",
    "timeline-decision-strip",
    { x: 48, y: 122, w: 864, h: 66 },
    {
      fillColorRole: "decision",
      fillTransparency: 0.92,
      lineColorRole: "decision",
      lineWidth: 2,
    },
  );
  textPrimitive(
    ctx,
    "decision-statement",
    "timeline-decision-statement",
    { x: 62, y: 134, w: 548, h: 36 },
    slide.content.decision.statement,
    { fontSize: 11, bold: true, verticalAlign: "middle", maxLines: 2 },
  );
  textPrimitive(
    ctx,
    "decision-owner",
    "timeline-decision-owner",
    { x: 626, y: 132, w: 174, h: 20 },
    slide.content.decision.owner,
    { fontSize: 8, bold: true, horizontalAlign: "right", maxLines: 1 },
  );
  textPrimitive(
    ctx,
    "decision-due",
    "timeline-decision-due",
    { x: 814, y: 132, w: 84, h: 20 },
    slide.content.decision.due,
    { fontSize: 8, bold: true, colorRole: "decision", horizontalAlign: "right", maxLines: 1 },
  );
  textPrimitive(
    ctx,
    "decision-evidence",
    "timeline-decision-evidence",
    { x: 626, y: 160, w: 272, h: 14 },
    slide.content.decision.evidenceIds.join(", "),
    { fontSize: 8, colorRole: "muted", horizontalAlign: "right", maxLines: 1 },
  );
  const slotWidth = 864 / slide.content.milestones.length;
  const firstCenter = 48 + slotWidth / 2;
  const lastCenter = 48 + (slide.content.milestones.length - 0.5) * slotWidth;
  linePrimitive(
    ctx,
    "milestone-line",
    "timeline-milestone-line",
    { x1: firstCenter, y1: 245, x2: lastCenter, y2: 245 },
    { colorRole: "system", width: 2 },
  );
  slide.content.milestones.forEach((milestone, index) => {
    const x = 48 + index * slotWidth;
    const center = x + slotWidth / 2;
    const token = itemToken("milestone", index);
    shapePrimitive(
      ctx,
      `${token}-slot`,
      "timeline-slot",
      { x, y: 231, w: slotWidth, h: 227 },
      { fillVisible: false, lineVisible: false },
    );
    shapePrimitive(
      ctx,
      `${token}-marker`,
      "timeline-marker",
      { x: center - 14, y: 231, w: 28, h: 28 },
      {
        shapeType: "ellipse",
        fillColorRole: index === 0 ? "decision" : "system",
        lineVisible: false,
      },
    );
    const textBox = (y, h) => ({ x: x + 6, y, w: slotWidth - 12, h });
    textPrimitive(
      ctx,
      `${token}-due`,
      "timeline-due",
      textBox(274, 16),
      milestone.due,
      { fontSize: 8, bold: true, colorRole: "system", horizontalAlign: "center", maxLines: 1 },
    );
    textPrimitive(
      ctx,
      `${token}-label`,
      "timeline-label",
      textBox(296, 34),
      milestone.label,
      { fontSize: 11, bold: true, horizontalAlign: "center", maxLines: 3 },
    );
    textPrimitive(
      ctx,
      `${token}-owner`,
      "timeline-owner",
      textBox(336, 30),
      milestone.owner,
      { fontSize: 8, horizontalAlign: "center", maxLines: 3 },
    );
    textPrimitive(
      ctx,
      `${token}-outcome`,
      "timeline-outcome",
      textBox(374, 54),
      milestone.outcome,
      { fontSize: 8, bold: true, horizontalAlign: "center", maxLines: 4 },
    );
    textPrimitive(
      ctx,
      `${token}-evidence`,
      "timeline-evidence",
      textBox(438, 20),
      milestone.evidenceIds.join(", "),
      { fontSize: 8, colorRole: "muted", horizontalAlign: "center", maxLines: 2 },
    );
  });
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

function compileTable(ctx, slide) {
  addStandardHeader(ctx, slide);
  const rowCount = slide.content.rows.length;
  const columnCount = slide.content.columns.length;
  const availableH = 350;
  const headerH = 28;
  const insightH = 46;
  const gap = 14;
  const rowH = Math.min(32, (availableH - headerH - insightH - gap) / rowCount);
  const rowHeights = [
    headerH,
    ...Array.from({ length: rowCount }, () => round3(rowH)),
  ];
  const tableH = rowHeights.reduce((sum, height) => sum + height, 0);
  const totalH = tableH + gap + insightH;
  const blockY = 122 + (availableH - totalH) / 2;
  const tableW = 816;
  const markerX = 872;
  const markerW = 40;
  const columnW = tableW / columnCount;
  tablePrimitive(
    ctx,
    "table",
    "native-table",
    { x: 48, y: blockY, w: tableW, h: tableH },
    [...slide.content.columns],
    slide.content.rows.map((row) => [...row.cells]),
    slide.content.rows.map((row) => [...row.evidenceIds]),
    Array.from({ length: columnCount }, () => round3(columnW)),
    rowHeights,
  );
  slide.content.rows.forEach((row, index) => {
    textPrimitive(
      ctx,
      `row-${String(index + 1).padStart(2, "0")}-evidence-marker`,
      "table-row-evidence-marker",
      {
        x: markerX,
        y:
          blockY +
          rowHeights
            .slice(0, index + 1)
            .reduce((sum, height) => sum + height, 0),
        w: markerW,
        h: rowHeights[index + 1],
      },
      `E${index + 1}`,
      {
        fontSize: 8,
        bold: true,
        colorRole: "muted",
        horizontalAlign: "center",
        verticalAlign: "middle",
        maxLines: 1,
      },
    );
  });
  textPrimitive(
    ctx,
    "insight",
    "table-insight",
    { x: 48, y: blockY + tableH + gap, w: 704, h: insightH },
    slide.content.insight.statement,
    { fontSize: 11, bold: true, verticalAlign: "middle", maxLines: 3 },
  );
  textPrimitive(
    ctx,
    "insight-evidence",
    "table-insight-evidence",
    { x: 768, y: blockY + tableH + gap, w: 144, h: insightH },
    slide.content.insight.evidenceIds.join(", "),
    {
      fontSize: 8,
      colorRole: "muted",
      horizontalAlign: "right",
      verticalAlign: "middle",
      maxLines: 2,
    },
  );
  addFooter(ctx, slide);
}

function compileEvaluation(ctx, slide) {
  addStandardHeader(ctx, slide);
  const rowCount = slide.content.cases.length;
  const availableH = 352;
  const headerH = 28;
  const releaseH = 46;
  const gap = 14;
  const rowH = Math.min(34, (availableH - headerH - releaseH - gap) / rowCount);
  const rowHeights = [
    headerH,
    ...Array.from({ length: rowCount }, () => round3(rowH)),
  ];
  const tableH = rowHeights.reduce((sum, height) => sum + height, 0);
  const totalH = tableH + gap + releaseH;
  const blockY = 122 + (availableH - totalH) / 2;
  const tableW = 816;
  const markerX = 872;
  const markerW = 40;
  const evaluationWidths = [190, 484, 190].map((width) =>
    round3((width * tableW) / 864),
  );
  evaluationWidths[1] = round3(
    tableW - evaluationWidths[0] - evaluationWidths[2],
  );
  tablePrimitive(
    ctx,
    "evaluation-table",
    "native-evaluation-table",
    { x: 48, y: blockY, w: tableW, h: tableH },
    ["Cohort", "Expected behavior", "Result"],
    slide.content.cases.map((item) => [item.cohort, item.expected, item.result]),
    slide.content.cases.map((item) => [...item.evidenceIds]),
    evaluationWidths,
    rowHeights,
  );
  slide.content.cases.forEach((item, index) => {
    textPrimitive(
      ctx,
      `case-${String(index + 1).padStart(2, "0")}-evidence-marker`,
      "evaluation-case-evidence-marker",
      {
        x: markerX,
        y:
          blockY +
          rowHeights
            .slice(0, index + 1)
            .reduce((sum, height) => sum + height, 0),
        w: markerW,
        h: rowHeights[index + 1],
      },
      `E${index + 1}`,
      {
        fontSize: 8,
        bold: true,
        colorRole: "muted",
        horizontalAlign: "center",
        verticalAlign: "middle",
        maxLines: 2,
      },
    );
  });
  textPrimitive(
    ctx,
    "release-implication",
    "evaluation-release-implication",
    { x: 48, y: blockY + tableH + gap, w: 704, h: releaseH },
    slide.content.releaseImplication.statement,
    { fontSize: 11, bold: true, verticalAlign: "middle", maxLines: 3 },
  );
  textPrimitive(
    ctx,
    "release-evidence",
    "evaluation-release-evidence",
    { x: 768, y: blockY + tableH + gap, w: 144, h: releaseH },
    slide.content.releaseImplication.evidenceIds.join(", "),
    {
      fontSize: 8,
      colorRole: "muted",
      horizontalAlign: "right",
      verticalAlign: "middle",
      maxLines: 2,
    },
  );
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
    case "profile":
      compileProfile(ctx, slide);
      break;
    case "metrics":
      compileMetrics(ctx, slide);
      break;
    case "findings":
      compileFindings(ctx, slide);
      break;
    case "responsibility":
      compileResponsibility(ctx, slide);
      break;
    case "risks":
      compileRisks(ctx, slide);
      break;
    case "timeline":
      compileTimeline(ctx, slide);
      break;
    case "chart":
      compileChart(ctx, slide);
      break;
    case "table":
      compileTable(ctx, slide);
      break;
    case "evaluation":
      compileEvaluation(ctx, slide);
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
  const path = `$.slides[${slideIndex}].content`;
  const entries = (items, field) =>
    items.map((item, index) => ({
      item,
      path: `${path}.${field}[${index}]`,
    }));
  let nested = [];
  switch (slide.family) {
    case "decision":
      nested = entries(slide.content.facts, "facts");
      break;
    case "profile":
      nested = [
        ...entries(slide.content.facts, "facts"),
        { item: slide.content.valueStatement, path: `${path}.valueStatement` },
      ];
      break;
    case "metrics":
      nested = [
        ...entries(slide.content.metrics, "metrics"),
        { item: slide.content.outcome, path: `${path}.outcome` },
      ];
      break;
    case "findings":
    case "risks":
      nested = entries(slide.content.items, "items");
      if (slide.family === "risks") {
        nested.push({
          item: slide.content.stopCondition,
          path: `${path}.stopCondition`,
        });
      }
      break;
    case "responsibility":
      nested = [
        ...entries(slide.content.steps, "steps"),
        { item: slide.content.excludedAuthority, path: `${path}.excludedAuthority` },
      ];
      break;
    case "timeline":
      nested = [
        { item: slide.content.decision, path: `${path}.decision` },
        ...entries(slide.content.milestones, "milestones"),
      ];
      break;
    case "chart":
      nested = [
        ...entries(slide.content.series, "series"),
        { item: slide.content.insight, path: `${path}.insight` },
      ];
      break;
    case "table":
      nested = [
        ...entries(slide.content.rows, "rows"),
        { item: slide.content.insight, path: `${path}.insight` },
      ];
      break;
    case "evaluation":
      nested = [
        ...entries(slide.content.cases, "cases"),
        {
          item: slide.content.releaseImplication,
          path: `${path}.releaseImplication`,
        },
      ];
      break;
    case "evidence":
      nested = entries(slide.content.groups, "groups");
      break;
  }
  nested.forEach(({ item, path: itemPath }) => {
    item.evidenceIds.forEach((evidenceId, evidenceIndex) => {
      if (!declared.has(evidenceId)) {
        fail(
          "E_EVIDENCE_NOT_DECLARED",
          `${itemPath}.evidenceIds[${evidenceIndex}]`,
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

function validateContentString(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("E_TEXT_EMPTY", path, "expected a nonempty string");
  }
  if (STRICT_CONTROL_PATTERN.test(value)) {
    fail("E_TEXT_CONTROL_CHAR", path, "text contains a control character");
  }
}

function validateContentArray(value, path, min, max) {
  if (!isDenseArray(value) || value.length < min || value.length > max) {
    fail("E_SPEC_SCHEMA", path, `expected a dense array with ${min}-${max} items`);
  }
}

function validateEvidenceArray(value, path) {
  validateContentArray(value, path, 1, Number.MAX_SAFE_INTEGER);
  value.forEach((evidenceId, index) =>
    validateContentString(evidenceId, `${path}[${index}]`),
  );
}

function validateClaimContent(value, path) {
  allowedKeys(value, ["statement", "evidenceIds"], ["statement", "evidenceIds"], path);
  validateContentString(value.statement, `${path}.statement`);
  validateEvidenceArray(value.evidenceIds, `${path}.evidenceIds`);
}

function validateFactContent(value, path) {
  allowedKeys(
    value,
    ["label", "value", "evidenceIds"],
    ["label", "value", "evidenceIds"],
    path,
  );
  validateContentString(value.label, `${path}.label`);
  validateContentString(value.value, `${path}.value`);
  validateEvidenceArray(value.evidenceIds, `${path}.evidenceIds`);
}

function validateSupportedContent(slide, slideIndex) {
  const path = `$.slides[${slideIndex}].content`;
  if (!isPlainObject(slide.content)) {
    fail("E_SPEC_SCHEMA", path, "expected a content object");
  }
  switch (slide.family) {
    case "cover":
      allowedKeys(slide.content, ["subtitle", "decision"], ["subtitle", "decision"], path);
      validateContentString(slide.content.subtitle, `${path}.subtitle`);
      validateContentString(slide.content.decision, `${path}.decision`);
      break;
    case "decision":
      allowedKeys(
        slide.content,
        ["recommendation", "bullets", "facts"],
        ["recommendation", "bullets", "facts"],
        path,
      );
      validateContentString(slide.content.recommendation, `${path}.recommendation`);
      validateContentArray(slide.content.bullets, `${path}.bullets`, 1, 4);
      slide.content.bullets.forEach((bullet, index) =>
        validateContentString(bullet, `${path}.bullets[${index}]`),
      );
      validateContentArray(slide.content.facts, `${path}.facts`, 1, 3);
      slide.content.facts.forEach((fact, index) =>
        validateFactContent(fact, `${path}.facts[${index}]`),
      );
      break;
    case "profile":
      allowedKeys(
        slide.content,
        ["company", "businessModel", "facts", "valueStatement", "contexts"],
        ["company", "businessModel", "facts", "valueStatement", "contexts"],
        path,
      );
      validateContentString(slide.content.company, `${path}.company`);
      validateContentString(slide.content.businessModel, `${path}.businessModel`);
      validateContentArray(slide.content.facts, `${path}.facts`, 2, 6);
      slide.content.facts.forEach((fact, index) =>
        validateFactContent(fact, `${path}.facts[${index}]`),
      );
      validateClaimContent(slide.content.valueStatement, `${path}.valueStatement`);
      validateContentArray(slide.content.contexts, `${path}.contexts`, 1, 5);
      slide.content.contexts.forEach((context, index) =>
        validateContentString(context, `${path}.contexts[${index}]`),
      );
      break;
    case "metrics":
      allowedKeys(slide.content, ["metrics", "outcome"], ["metrics", "outcome"], path);
      validateContentArray(slide.content.metrics, `${path}.metrics`, 2, 4);
      slide.content.metrics.forEach((metric, index) => {
        allowedKeys(
          metric,
          ["label", "value", "context", "evidenceIds"],
          ["label", "value", "evidenceIds"],
          `${path}.metrics[${index}]`,
        );
        validateContentString(metric.label, `${path}.metrics[${index}].label`);
        validateContentString(metric.value, `${path}.metrics[${index}].value`);
        validateEvidenceArray(
          metric.evidenceIds,
          `${path}.metrics[${index}].evidenceIds`,
        );
        validateMetricContext(metric, `${path}.metrics[${index}].context`);
      });
      validateClaimContent(slide.content.outcome, `${path}.outcome`);
      break;
    case "findings":
      allowedKeys(slide.content, ["items"], ["items"], path);
      validateContentArray(slide.content.items, `${path}.items`, 2, 5);
      slide.content.items.forEach((item, index) => {
        const itemPath = `${path}.items[${index}]`;
        allowedKeys(
          item,
          ["title", "statement", "consequence", "evidenceIds"],
          ["title", "statement", "consequence", "evidenceIds"],
          itemPath,
        );
        for (const field of ["title", "statement", "consequence"]) {
          validateContentString(item[field], `${itemPath}.${field}`);
        }
        validateEvidenceArray(item.evidenceIds, `${itemPath}.evidenceIds`);
      });
      break;
    case "responsibility":
      allowedKeys(
        slide.content,
        ["steps", "excludedAuthority"],
        ["steps", "excludedAuthority"],
        path,
      );
      validateContentArray(slide.content.steps, `${path}.steps`, 3, 5);
      slide.content.steps.forEach((step, index) => {
        const stepPath = `${path}.steps[${index}]`;
        allowedKeys(
          step,
          ["type", "statement", "evidenceIds"],
          ["type", "statement", "evidenceIds"],
          stepPath,
        );
        if (!RESPONSIBILITY_TYPES.has(step.type)) {
          fail("E_SPEC_SCHEMA", `${stepPath}.type`, "invalid responsibility type");
        }
        validateContentString(step.statement, `${stepPath}.statement`);
        validateEvidenceArray(step.evidenceIds, `${stepPath}.evidenceIds`);
      });
      validateClaimContent(
        slide.content.excludedAuthority,
        `${path}.excludedAuthority`,
      );
      break;
    case "risks":
      allowedKeys(
        slide.content,
        ["items", "stopCondition"],
        ["items", "stopCondition"],
        path,
      );
      validateContentArray(slide.content.items, `${path}.items`, 1, 4);
      slide.content.items.forEach((item, index) => {
        const itemPath = `${path}.items[${index}]`;
        allowedKeys(
          item,
          ["risk", "impact", "control", "residualRisk", "evidenceIds"],
          ["risk", "impact", "control", "residualRisk", "evidenceIds"],
          itemPath,
        );
        for (const field of ["risk", "impact", "control", "residualRisk"]) {
          validateContentString(item[field], `${itemPath}.${field}`);
        }
        validateEvidenceArray(item.evidenceIds, `${itemPath}.evidenceIds`);
      });
      validateClaimContent(slide.content.stopCondition, `${path}.stopCondition`);
      break;
    case "timeline":
      allowedKeys(
        slide.content,
        ["decision", "milestones"],
        ["decision", "milestones"],
        path,
      );
      allowedKeys(
        slide.content.decision,
        ["statement", "owner", "due", "evidenceIds"],
        ["statement", "owner", "due", "evidenceIds"],
        `${path}.decision`,
      );
      for (const field of ["statement", "owner", "due"]) {
        validateContentString(
          slide.content.decision[field],
          `${path}.decision.${field}`,
        );
      }
      validateEvidenceArray(
        slide.content.decision.evidenceIds,
        `${path}.decision.evidenceIds`,
      );
      validateContentArray(slide.content.milestones, `${path}.milestones`, 2, 6);
      slide.content.milestones.forEach((milestone, index) => {
        const milestonePath = `${path}.milestones[${index}]`;
        allowedKeys(
          milestone,
          ["label", "owner", "due", "outcome", "evidenceIds"],
          ["label", "owner", "due", "outcome", "evidenceIds"],
          milestonePath,
        );
        for (const field of ["label", "owner", "due", "outcome"]) {
          validateContentString(milestone[field], `${milestonePath}.${field}`);
        }
        validateEvidenceArray(
          milestone.evidenceIds,
          `${milestonePath}.evidenceIds`,
        );
      });
      break;
    case "chart":
      allowedKeys(
        slide.content,
        ["chartType", "categories", "series", "unit", "insight"],
        ["chartType", "categories", "series", "unit", "insight"],
        path,
      );
      if (!["bar", "line"].includes(slide.content.chartType)) {
        fail("E_SPEC_SCHEMA", `${path}.chartType`, "chart type must be bar or line");
      }
      validateContentArray(slide.content.categories, `${path}.categories`, 2, 12);
      slide.content.categories.forEach((category, index) =>
        validateContentString(category, `${path}.categories[${index}]`),
      );
      validateContentString(slide.content.unit, `${path}.unit`);
      validateContentArray(slide.content.series, `${path}.series`, 1, 4);
      slide.content.series.forEach((series, seriesIndex) => {
        const seriesPath = `${path}.series[${seriesIndex}]`;
        allowedKeys(
          series,
          ["name", "values", "evidenceIds"],
          ["name", "values", "evidenceIds"],
          seriesPath,
        );
        validateContentString(series.name, `${seriesPath}.name`);
        validateContentArray(
          series.values,
          `${seriesPath}.values`,
          slide.content.categories.length,
          slide.content.categories.length,
        );
        series.values.forEach((value, valueIndex) => {
          if (!Number.isFinite(value)) {
            fail(
              "E_GEOMETRY_NONFINITE",
              `${seriesPath}.values[${valueIndex}]`,
              "chart value must be finite",
            );
          }
        });
        validateEvidenceArray(series.evidenceIds, `${seriesPath}.evidenceIds`);
      });
      validateClaimContent(slide.content.insight, `${path}.insight`);
      break;
    case "table":
      allowedKeys(slide.content, ["columns", "rows", "insight"], ["columns", "rows", "insight"], path);
      validateContentArray(slide.content.columns, `${path}.columns`, 2, 6);
      slide.content.columns.forEach((column, index) =>
        validateContentString(column, `${path}.columns[${index}]`),
      );
      validateContentArray(slide.content.rows, `${path}.rows`, 1, 10);
      slide.content.rows.forEach((row, rowIndex) => {
        const rowPath = `${path}.rows[${rowIndex}]`;
        allowedKeys(row, ["cells", "evidenceIds"], ["cells", "evidenceIds"], rowPath);
        validateContentArray(
          row.cells,
          `${rowPath}.cells`,
          slide.content.columns.length,
          slide.content.columns.length,
        );
        row.cells.forEach((cell, cellIndex) =>
          validateContentString(cell, `${rowPath}.cells[${cellIndex}]`),
        );
        validateEvidenceArray(row.evidenceIds, `${rowPath}.evidenceIds`);
      });
      validateClaimContent(slide.content.insight, `${path}.insight`);
      break;
    case "evaluation":
      allowedKeys(
        slide.content,
        ["cases", "releaseImplication"],
        ["cases", "releaseImplication"],
        path,
      );
      validateContentArray(slide.content.cases, `${path}.cases`, 3, 8);
      slide.content.cases.forEach((item, caseIndex) => {
        const casePath = `${path}.cases[${caseIndex}]`;
        allowedKeys(
          item,
          ["cohort", "expected", "result", "evidenceIds"],
          ["cohort", "expected", "result", "evidenceIds"],
          casePath,
        );
        for (const field of ["cohort", "expected", "result"]) {
          validateContentString(item[field], `${casePath}.${field}`);
        }
        if (!EVALUATION_RESULTS.has(item.result)) {
          fail("E_SPEC_SCHEMA", `${casePath}.result`, "invalid evaluation result");
        }
        validateEvidenceArray(item.evidenceIds, `${casePath}.evidenceIds`);
      });
      validateClaimContent(
        slide.content.releaseImplication,
        `${path}.releaseImplication`,
      );
      break;
    case "evidence":
      allowedKeys(slide.content, ["groups", "controls"], ["groups", "controls"], path);
      validateContentArray(slide.content.groups, `${path}.groups`, 2, 5);
      slide.content.groups.forEach((group, index) => {
        const groupPath = `${path}.groups[${index}]`;
        allowedKeys(
          group,
          ["label", "items", "evidenceIds"],
          ["label", "items", "evidenceIds"],
          groupPath,
        );
        validateContentString(group.label, `${groupPath}.label`);
        validateContentArray(
          group.items,
          `${groupPath}.items`,
          1,
          Number.MAX_SAFE_INTEGER,
        );
        group.items.forEach((item, index) =>
          validateContentString(item, `${groupPath}.items[${index}]`),
        );
        validateEvidenceArray(group.evidenceIds, `${groupPath}.evidenceIds`);
      });
      validateContentArray(
        slide.content.controls,
        `${path}.controls`,
        1,
        Number.MAX_SAFE_INTEGER,
      );
      slide.content.controls.forEach((control, index) =>
        validateContentString(control, `${path}.controls[${index}]`),
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
    if (SUPPORTED_FAMILIES.has(slide.family)) {
      validateSupportedContent(slide, slideIndex);
      validateNestedEvidence(slide, slideIndex);
    }
  }
  const selected = mode === "smoke" ? selectSmokeSlides(plan) : plan.slides;
  const sourceIndexes = new Map(plan.slides.map((slide, index) => [slide, index + 1]));
  selected.forEach((slide) => {
    if (!SUPPORTED_FAMILIES.has(slide.family)) {
      fail("E_UNSUPPORTED_FAMILY", `$.slides[${sourceIndexes.get(slide) - 1}].family`, slide.family);
    }
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

function assertTableText(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("E_TEXT_EMPTY", path, "table text is blank");
  }
  if (STRICT_CONTROL_PATTERN.test(value)) {
    fail("E_TEXT_CONTROL_CHAR", path, "table text contains a control character");
  }
}

function assertPositiveNumberArray(value, path) {
  if (!isDenseArray(value) || value.length === 0) {
    fail("E_SPEC_SCHEMA", path, "expected a nonempty dense array");
  }
  value.forEach((item, index) => {
    if (!Number.isFinite(item)) {
      fail("E_GEOMETRY_NONFINITE", `${path}[${index}]`, "expected finite number");
    }
    if (item <= 0) {
      fail("E_GEOMETRY_BOUNDS", `${path}[${index}]`, "expected positive number");
    }
  });
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
  const tolerance = 0.0005;
  return (
    a.x < b.x + b.w - tolerance &&
    b.x < a.x + a.w - tolerance &&
    a.y < b.y + b.h - tolerance &&
    b.y < a.y + a.h - tolerance
  );
}

function registerDrawingName(value, path, names) {
  if (!NAME_PATTERN.test(value) || value.length > 120) {
    fail(
      "E_NAME_INVALID",
      path,
      "name must be <=120 characters of ASCII lowercase kebab-case",
    );
  }
  const folded = value.toLowerCase();
  if (names.has(folded)) fail("E_NAME_DUPLICATE", path, value);
  names.add(folded);
}

function closeEnough(left, right) {
  return Math.abs(left - right) <= 0.001;
}

function assertChartText(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("E_TEXT_EMPTY", path, "chart text is blank");
  }
  if (STRICT_CONTROL_PATTERN.test(value)) {
    fail("E_TEXT_CONTROL_CHAR", path, "chart text contains a control character");
  }
}

function boxWithin(inner, outer) {
  const tolerance = 0.001;
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.w <= outer.x + outer.w + tolerance &&
    inner.y + inner.h <= outer.y + outer.h + tolerance
  );
}

function validateChartLabel(label, path, stage, names, container) {
  exactKeys(label, CHART_LABEL_KEYS, path);
  registerDrawingName(label.name, `${path}.name`, names);
  assertChartText(label.text, `${path}.text`);
  assertGeometryBox(label, path, stage);
  if (container && !boxWithin(label, container)) {
    fail("E_GEOMETRY_BOUNDS", path, "chart label must remain inside its region");
  }
  if (label.fontSize !== 8 || typeof label.bold !== "boolean") {
    fail("E_SPEC_SCHEMA", path, "chart labels require 8-point text and boolean bold");
  }
  assertColorRole(label.colorRole, `${path}.colorRole`);
  if (!["left", "center", "right"].includes(label.horizontalAlign)) {
    fail("E_SPEC_SCHEMA", `${path}.horizontalAlign`, "invalid chart label alignment");
  }
  if (!["top", "middle", "bottom"].includes(label.verticalAlign)) {
    fail("E_SPEC_SCHEMA", `${path}.verticalAlign`, "invalid chart label alignment");
  }
  if (label.rotation !== 0) {
    fail("E_SPEC_SCHEMA", `${path}.rotation`, "chart labels cannot be rotated");
  }
}

function validateNamedChartLine(line, path, stage, names, container) {
  exactKeys(line, NAMED_LINE_KEYS, path);
  registerDrawingName(line.name, `${path}.name`, names);
  for (const key of ["x1", "y1", "x2", "y2", "width", "transparency"]) {
    if (!Number.isFinite(line[key])) {
      fail("E_GEOMETRY_NONFINITE", `${path}.${key}`, "expected finite number");
    }
  }
  if (
    line.width <= 0 ||
    line.transparency < 0 ||
    line.transparency > 1 ||
    (line.x1 === line.x2 && line.y1 === line.y2)
  ) {
    fail("E_GEOMETRY_BOUNDS", path, "chart line geometry is invalid");
  }
  const pointBox = {
    x: Math.min(line.x1, line.x2),
    y: Math.min(line.y1, line.y2),
    w: Math.abs(line.x2 - line.x1),
    h: Math.abs(line.y2 - line.y1),
  };
  const target = container ?? { x: 0, y: 0, w: stage.width, h: stage.height };
  if (
    pointBox.x < target.x - 0.001 ||
    pointBox.y < target.y - 0.001 ||
    pointBox.x + pointBox.w > target.x + target.w + 0.001 ||
    pointBox.y + pointBox.h > target.y + target.h + 0.001
  ) {
    fail("E_GEOMETRY_BOUNDS", path, "chart line must remain inside its region");
  }
  assertColorRole(line.colorRole, `${path}.colorRole`);
  if (!["solid", "dash", "dot", "dashDot"].includes(line.dash)) {
    fail("E_SPEC_SCHEMA", `${path}.dash`, "invalid chart line dash");
  }
}

function validateNativeChart(primitive, path, stage, names, family, slideEvidenceIds) {
  if (family !== "chart" || primitive.role !== "native-chart") {
    fail("E_SPEC_SCHEMA", path, "nativeChart is supported only by chart slides");
  }
  assertGeometryBox(primitive, path, stage);
  for (const [key, value] of Object.entries({ x: 48, y: 120, w: 864, h: 318 })) {
    if (primitive[key] !== value) {
      fail("E_GEOMETRY_BOUNDS", `${path}.${key}`, "native chart bounds are fixed");
    }
  }
  if (!["bar", "line"].includes(primitive.chartType)) {
    fail("E_SPEC_SCHEMA", `${path}.chartType`, "chart type must be bar or line");
  }
  assertChartText(primitive.unit, `${path}.unit`);
  if (
    !isDenseArray(primitive.insightEvidenceIds) ||
    primitive.insightEvidenceIds.length === 0 ||
    new Set(primitive.insightEvidenceIds).size !==
      primitive.insightEvidenceIds.length
  ) {
    fail(
      "E_SPEC_SCHEMA",
      `${path}.insightEvidenceIds`,
      "expected a nonempty duplicate-free dense evidence array",
    );
  }
  const declaredEvidence = new Set(slideEvidenceIds);
  primitive.insightEvidenceIds.forEach((evidenceId, evidenceIndex) => {
    assertChartText(
      evidenceId,
      `${path}.insightEvidenceIds[${evidenceIndex}]`,
    );
    if (!declaredEvidence.has(evidenceId)) {
      fail(
        "E_EVIDENCE_NOT_DECLARED",
        `${path}.insightEvidenceIds[${evidenceIndex}]`,
        `${evidenceId} is absent from slide.evidenceIds`,
      );
    }
  });
  const chartBounds = { x: primitive.x, y: primitive.y, w: primitive.w, h: primitive.h };
  validateChartLabel(
    primitive.unitLabel,
    `${path}.unitLabel`,
    stage,
    names,
    chartBounds,
  );
  if (
    primitive.unitLabel.text !== primitive.unit ||
    primitive.unitLabel.x !== 48 ||
    primitive.unitLabel.y !== 142 ||
    primitive.unitLabel.w !== 864 ||
    primitive.unitLabel.h !== 14
  ) {
    fail("E_SPEC_SCHEMA", `${path}.unitLabel`, "unit label must match the fixed contract");
  }
  exactKeys(primitive.plot, ["x", "y", "w", "h"], `${path}.plot`);
  assertGeometryBox(primitive.plot, `${path}.plot`, stage);
  for (const [key, value] of Object.entries({ x: 112, y: 160, w: 800, h: 180 })) {
    if (primitive.plot[key] !== value) {
      fail("E_GEOMETRY_BOUNDS", `${path}.plot.${key}`, "plot bounds are fixed");
    }
  }
  if (!boxWithin(primitive.plot, chartBounds)) {
    fail("E_GEOMETRY_BOUNDS", `${path}.plot`, "plot must remain inside chart");
  }
  if (
    !isDenseArray(primitive.categories) ||
    primitive.categories.length < 2 ||
    primitive.categories.length > 12
  ) {
    fail("E_SPEC_SCHEMA", `${path}.categories`, "expected 2-12 dense categories");
  }
  const categoryWidth = primitive.plot.w / primitive.categories.length;
  primitive.categories.forEach((category, index) => {
    const categoryPath = `${path}.categories[${index}]`;
    exactKeys(category, ["index", "label", "labelBox"], categoryPath);
    if (category.index !== index) {
      fail("E_SPEC_SCHEMA", `${categoryPath}.index`, "category indexes must be contiguous");
    }
    assertChartText(category.label, `${categoryPath}.label`);
    validateChartLabel(
      category.labelBox,
      `${categoryPath}.labelBox`,
      stage,
      names,
      chartBounds,
    );
    if (
      category.labelBox.text !== category.label ||
      !closeEnough(category.labelBox.x, primitive.plot.x + index * categoryWidth) ||
      category.labelBox.y !== 344 ||
      !closeEnough(category.labelBox.w, categoryWidth) ||
      category.labelBox.h !== 28
    ) {
      fail("E_GEOMETRY_BOUNDS", `${categoryPath}.labelBox`, "category label geometry is invalid");
    }
  });
  if (
    !isDenseArray(primitive.series) ||
    primitive.series.length < 1 ||
    primitive.series.length > 4
  ) {
    fail("E_SPEC_SCHEMA", `${path}.series`, "expected 1-4 dense chart series");
  }
  const allValues = [];
  primitive.series.forEach((series, seriesIndex) => {
    const seriesPath = `${path}.series[${seriesIndex}]`;
    exactKeys(
      series,
      primitive.chartType === "bar"
        ? ["index", "name", "evidenceIds", "colorRole", "dash", "bars"]
        : ["index", "name", "evidenceIds", "colorRole", "dash", "segments", "markers"],
      seriesPath,
    );
    if (series.index !== seriesIndex) {
      fail("E_SPEC_SCHEMA", `${seriesPath}.index`, "series indexes must be contiguous");
    }
    assertChartText(series.name, `${seriesPath}.name`);
    const expectedStyle = CHART_SERIES_STYLES[seriesIndex];
    if (
      series.colorRole !== expectedStyle.colorRole ||
      series.dash !== expectedStyle.dash
    ) {
      fail("E_SPEC_SCHEMA", seriesPath, "series style does not match its stable index");
    }
    if (
      !isDenseArray(series.evidenceIds) ||
      series.evidenceIds.length === 0 ||
      new Set(series.evidenceIds).size !== series.evidenceIds.length
    ) {
      fail("E_SPEC_SCHEMA", `${seriesPath}.evidenceIds`, "invalid series evidence array");
    }
    series.evidenceIds.forEach((evidenceId, evidenceIndex) => {
      assertChartText(evidenceId, `${seriesPath}.evidenceIds[${evidenceIndex}]`);
      if (!declaredEvidence.has(evidenceId)) {
        fail(
          "E_EVIDENCE_NOT_DECLARED",
          `${seriesPath}.evidenceIds[${evidenceIndex}]`,
          `${evidenceId} is absent from slide.evidenceIds`,
        );
      }
    });
    const marks = primitive.chartType === "bar" ? series.bars : series.markers;
    if (!isDenseArray(marks) || marks.length !== primitive.categories.length) {
      fail("E_SPEC_SCHEMA", seriesPath, "chart mark count must match categories");
    }
    marks.forEach((mark, categoryIndex) => {
      if (!Number.isFinite(mark.value)) {
        fail("E_GEOMETRY_NONFINITE", `${seriesPath}.value`, "chart value must be finite");
      }
      allValues.push(mark.value);
      if (mark.categoryIndex !== categoryIndex) {
        fail("E_SPEC_SCHEMA", `${seriesPath}.categoryIndex`, "mark indexes must be contiguous");
      }
    });
  });
  const expectedAxis = niceAxis(allValues);
  exactKeys(
    primitive.axis,
    ["min", "max", "step", "zeroY", "baseline", "ticks"],
    `${path}.axis`,
  );
  for (const key of ["min", "max", "step", "zeroY"]) {
    if (!Number.isFinite(primitive.axis[key])) {
      fail("E_GEOMETRY_NONFINITE", `${path}.axis.${key}`, "axis value must be finite");
    }
  }
  const expectedZeroY = scaleChartY(0, expectedAxis, primitive.plot);
  if (
    primitive.axis.min !== expectedAxis.min ||
    primitive.axis.max !== expectedAxis.max ||
    primitive.axis.step !== expectedAxis.step ||
    !closeEnough(primitive.axis.zeroY, expectedZeroY) ||
    primitive.axis.min > 0 ||
    primitive.axis.max < 0 ||
    primitive.axis.min >= primitive.axis.max ||
    primitive.axis.step <= 0
  ) {
    fail("E_SPEC_SCHEMA", `${path}.axis`, "axis is not the zero-inclusive nice domain");
  }
  if (
    allValues.some(
      (value) => value < primitive.axis.min || value > primitive.axis.max,
    )
  ) {
    fail(
      "E_GEOMETRY_BOUNDS",
      `${path}.axis`,
      "axis must contain zero and every chart value",
    );
  }
  validateNamedChartLine(
    primitive.axis.baseline,
    `${path}.axis.baseline`,
    stage,
    names,
    primitive.plot,
  );
  if (
    primitive.axis.baseline.x1 !== primitive.plot.x ||
    primitive.axis.baseline.x2 !== primitive.plot.x + primitive.plot.w ||
    !closeEnough(primitive.axis.baseline.y1, primitive.axis.zeroY) ||
    !closeEnough(primitive.axis.baseline.y2, primitive.axis.zeroY)
  ) {
    fail("E_GEOMETRY_BOUNDS", `${path}.axis.baseline`, "baseline must represent zero");
  }
  const expectedTicks = expectedAxis.ticks.slice().reverse();
  if (
    !isDenseArray(primitive.axis.ticks) ||
    primitive.axis.ticks.length !== expectedTicks.length ||
    primitive.axis.ticks.length > 6
  ) {
    fail("E_SPEC_SCHEMA", `${path}.axis.ticks`, "axis requires at most six exact ticks");
  }
  primitive.axis.ticks.forEach((tick, index) => {
    const tickPath = `${path}.axis.ticks[${index}]`;
    exactKeys(tick, ["value", "label", "gridLine", "labelBox"], tickPath);
    const expectedValue = expectedTicks[index];
    const expectedY = scaleChartY(expectedValue, primitive.axis, primitive.plot);
    const expectedLabelY = round3(
      Math.max(
        primitive.plot.y,
        Math.min(primitive.plot.y + primitive.plot.h - 12, expectedY - 6),
      ),
    );
    if (
      tick.value !== expectedValue ||
      tick.label !== String(expectedValue)
    ) {
      fail("E_SPEC_SCHEMA", tickPath, "tick value and label are inconsistent");
    }
    validateNamedChartLine(
      tick.gridLine,
      `${tickPath}.gridLine`,
      stage,
      names,
      primitive.plot,
    );
    validateChartLabel(
      tick.labelBox,
      `${tickPath}.labelBox`,
      stage,
      names,
      chartBounds,
    );
    if (
      !closeEnough(tick.gridLine.y1, expectedY) ||
      !closeEnough(tick.gridLine.y2, expectedY) ||
      tick.gridLine.x1 !== primitive.plot.x ||
      tick.gridLine.x2 !== primitive.plot.x + primitive.plot.w ||
      tick.labelBox.text !== tick.label ||
      tick.labelBox.x !== 48 ||
      tick.labelBox.y !== expectedLabelY ||
      tick.labelBox.w !== 56 ||
      tick.labelBox.h !== 12
    ) {
      fail("E_GEOMETRY_BOUNDS", tickPath, "tick geometry is inconsistent");
    }
  });
  if (
    !isDenseArray(primitive.legend) ||
    primitive.legend.length !== primitive.series.length
  ) {
    fail("E_SPEC_SCHEMA", `${path}.legend`, "legend must match chart series");
  }
  const legendWidth = primitive.w / primitive.series.length;
  primitive.legend.forEach((entry, index) => {
    const entryPath = `${path}.legend[${index}]`;
    exactKeys(
      entry,
      ["seriesIndex", "colorRole", "swatchName", "swatch", "labelBox"],
      entryPath,
    );
    if (
      entry.seriesIndex !== index ||
      entry.colorRole !== primitive.series[index].colorRole
    ) {
      fail("E_SPEC_SCHEMA", entryPath, "legend entry must match series");
    }
    registerDrawingName(entry.swatchName, `${entryPath}.swatchName`, names);
    exactKeys(entry.swatch, ["x", "y", "w", "h"], `${entryPath}.swatch`);
    assertGeometryBox(entry.swatch, `${entryPath}.swatch`, stage);
    validateChartLabel(
      entry.labelBox,
      `${entryPath}.labelBox`,
      stage,
      names,
      chartBounds,
    );
    if (
      !boxWithin(entry.swatch, chartBounds) ||
      !closeEnough(entry.swatch.x, 48 + index * legendWidth + 8) ||
      entry.swatch.y !== 128 ||
      entry.swatch.w !== 16 ||
      entry.swatch.h !== 4 ||
      entry.labelBox.text !== primitive.series[index].name ||
      !closeEnough(entry.labelBox.x, 48 + index * legendWidth + 30) ||
      entry.labelBox.y !== 120 ||
      !closeEnough(entry.labelBox.w, legendWidth - 38) ||
      entry.labelBox.h !== 20
    ) {
      fail("E_GEOMETRY_BOUNDS", entryPath, "legend geometry is invalid");
    }
  });
  exactKeys(
    primitive.dataGrid,
    ["x", "y", "w", "h", "seriesLabelWidth", "rowHeight", "rows"],
    `${path}.dataGrid`,
  );
  for (const [key, value] of Object.entries({
    x: 48,
    y: 376,
    w: 864,
    h: 60,
    seriesLabelWidth: 64,
  })) {
    if (primitive.dataGrid[key] !== value) {
      fail("E_GEOMETRY_BOUNDS", `${path}.dataGrid.${key}`, "data grid bounds are fixed");
    }
  }
  assertGeometryBox(primitive.dataGrid, `${path}.dataGrid`, stage);
  if (!boxWithin(primitive.dataGrid, chartBounds)) {
    fail("E_GEOMETRY_BOUNDS", `${path}.dataGrid`, "data grid must remain inside chart");
  }
  const expectedRowHeight = round3(60 / primitive.series.length);
  if (
    primitive.dataGrid.rowHeight !== expectedRowHeight ||
    !isDenseArray(primitive.dataGrid.rows) ||
    primitive.dataGrid.rows.length !== primitive.series.length
  ) {
    fail("E_SPEC_SCHEMA", `${path}.dataGrid`, "data grid rows must match series");
  }
  primitive.dataGrid.rows.forEach((row, seriesIndex) => {
    const rowPath = `${path}.dataGrid.rows[${seriesIndex}]`;
    exactKeys(row, ["seriesIndex", "labelBox", "values"], rowPath);
    if (
      row.seriesIndex !== seriesIndex ||
      !isDenseArray(row.values) ||
      row.values.length !== primitive.categories.length
    ) {
      fail("E_SPEC_SCHEMA", rowPath, "data row dimensions are invalid");
    }
    validateChartLabel(row.labelBox, `${rowPath}.labelBox`, stage, names, primitive.dataGrid);
    const expectedRowY = round3(376 + seriesIndex * (60 / primitive.series.length));
    if (
      row.labelBox.text !== primitive.series[seriesIndex].name ||
      row.labelBox.x !== 48 ||
      row.labelBox.y !== expectedRowY ||
      row.labelBox.w !== 64 ||
      !closeEnough(row.labelBox.h, 60 / primitive.series.length)
    ) {
      fail("E_GEOMETRY_BOUNDS", `${rowPath}.labelBox`, "series label geometry is invalid");
    }
    row.values.forEach((cell, categoryIndex) => {
      const cellPath = `${rowPath}.values[${categoryIndex}]`;
      exactKeys(cell, ["categoryIndex", "value", "labelBox"], cellPath);
      if (
        cell.categoryIndex !== categoryIndex ||
        cell.value !== allValues[seriesIndex * primitive.categories.length + categoryIndex]
      ) {
        fail("E_SPEC_SCHEMA", cellPath, "data grid value must match chart mark");
      }
      validateChartLabel(
        cell.labelBox,
        `${cellPath}.labelBox`,
        stage,
        names,
        primitive.dataGrid,
      );
      const expectedValueWidth = 800 / primitive.categories.length;
      if (
        cell.labelBox.text !== String(cell.value) ||
        !closeEnough(cell.labelBox.x, 112 + categoryIndex * expectedValueWidth) ||
        cell.labelBox.y !== expectedRowY ||
        !closeEnough(cell.labelBox.w, expectedValueWidth) ||
        !closeEnough(cell.labelBox.h, 60 / primitive.series.length)
      ) {
        fail("E_GEOMETRY_BOUNDS", `${cellPath}.labelBox`, "value label geometry is invalid");
      }
    });
  });
  const groupW = primitive.plot.w / primitive.categories.length;
  const usableW = groupW * 0.84;
  const barGap = Math.max(1, groupW * 0.02);
  const barW = (usableW - barGap * (primitive.series.length - 1)) / primitive.series.length;
  const scaleY = (value) => scaleChartY(value, primitive.axis, primitive.plot);
  primitive.series.forEach((series, seriesIndex) => {
    const seriesPath = `${path}.series[${seriesIndex}]`;
    if (primitive.chartType === "bar") {
      series.bars.forEach((bar, categoryIndex) => {
        const barPath = `${seriesPath}.bars[${categoryIndex}]`;
        exactKeys(
          bar,
          ["kind", "name", "categoryIndex", "value", "x", "y", "w", "h", "fillTransparency"],
          barPath,
        );
        registerDrawingName(bar.name, `${barPath}.name`, names);
        const groupX =
          primitive.plot.x + categoryIndex * groupW + (groupW - usableW) / 2;
        const expectedX = round3(groupX + seriesIndex * (barW + barGap));
        const valueY = scaleY(bar.value);
        const zeroLineY = round3(
          Math.max(
            primitive.plot.y,
            Math.min(primitive.plot.y + primitive.plot.h - 1, primitive.axis.zeroY - 0.5),
          ),
        );
        const height = round3(Math.abs(valueY - primitive.axis.zeroY));
        const visibleHeight = bar.value === 0 ? 1 : Math.max(1, height);
        const expected = {
          kind: bar.value === 0 ? "line" : "rect",
          x: expectedX,
          y:
            bar.value === 0
              ? zeroLineY
              : round3(
                  bar.value > 0
                    ? Math.max(primitive.plot.y, primitive.axis.zeroY - visibleHeight)
                    : Math.min(
                        primitive.axis.zeroY,
                        primitive.plot.y + primitive.plot.h - visibleHeight,
                      ),
                ),
          w: round3(barW),
          h: visibleHeight,
        };
        if (
          bar.kind !== expected.kind ||
          !closeEnough(bar.x, expected.x) ||
          !closeEnough(bar.y, expected.y) ||
          !closeEnough(bar.w, expected.w) ||
          !closeEnough(bar.h, expected.h) ||
          bar.fillTransparency !== 0 ||
          !boxWithin(bar, primitive.plot)
        ) {
          fail("E_GEOMETRY_BOUNDS", barPath, "bar geometry is invalid");
        }
      });
    } else {
      if (
        !isDenseArray(series.segments) ||
        series.segments.length !== primitive.categories.length - 1
      ) {
        fail("E_SPEC_SCHEMA", `${seriesPath}.segments`, "line segments must join categories");
      }
      series.markers.forEach((marker, categoryIndex) => {
        const markerPath = `${seriesPath}.markers[${categoryIndex}]`;
        exactKeys(
          marker,
          ["name", "categoryIndex", "value", "cx", "cy", "diameter"],
          markerPath,
        );
        registerDrawingName(marker.name, `${markerPath}.name`, names);
        const expectedX = round3(
          primitive.plot.x + (categoryIndex + 0.5) * groupW,
        );
        if (
          marker.diameter !== 6 ||
          !closeEnough(marker.cx, expectedX) ||
          !closeEnough(marker.cy, scaleY(marker.value)) ||
          marker.cx < primitive.plot.x ||
          marker.cx > primitive.plot.x + primitive.plot.w ||
          marker.cy < primitive.plot.y ||
          marker.cy > primitive.plot.y + primitive.plot.h
        ) {
          fail("E_GEOMETRY_BOUNDS", markerPath, "line marker geometry is invalid");
        }
      });
      series.segments.forEach((segment, segmentIndex) => {
        const segmentPath = `${seriesPath}.segments[${segmentIndex}]`;
        exactKeys(
          segment,
          ["name", "fromCategoryIndex", "toCategoryIndex", "x1", "y1", "x2", "y2"],
          segmentPath,
        );
        registerDrawingName(segment.name, `${segmentPath}.name`, names);
        const left = series.markers[segmentIndex];
        const right = series.markers[segmentIndex + 1];
        if (
          segment.fromCategoryIndex !== segmentIndex ||
          segment.toCategoryIndex !== segmentIndex + 1 ||
          !closeEnough(segment.x1, left.cx) ||
          !closeEnough(segment.y1, left.cy) ||
          !closeEnough(segment.x2, right.cx) ||
          !closeEnough(segment.y2, right.cy) ||
          (segment.x1 === segment.x2 && segment.y1 === segment.y2)
        ) {
          fail("E_GEOMETRY_BOUNDS", segmentPath, "line segment geometry is invalid");
        }
      });
    }
  });
  if (primitive.chartType === "bar") {
    const bars = primitive.series.flatMap((series) => series.bars);
    bars.forEach((left, index) => {
      bars.slice(index + 1).forEach((right) => {
        if (overlap(left, right)) {
          fail("E_GEOMETRY_OVERLAP", path, "native chart bars overlap");
        }
      });
    });
  }
}

function validatePrimitive(
  primitive,
  path,
  stage,
  names,
  family,
  slideEvidenceIds,
) {
  if (!isPlainObject(primitive)) fail("E_SPEC_SCHEMA", path, "expected primitive object");
  const keys =
    primitive.kind === "text"
      ? TEXT_KEYS
      : primitive.kind === "shape"
        ? SHAPE_KEYS
        : primitive.kind === "line"
          ? LINE_KEYS
          : primitive.kind === "table"
            ? TABLE_KEYS
            : primitive.kind === "nativeChart"
              ? CHART_KEYS
              : undefined;
  if (!keys) fail("E_SPEC_SCHEMA", `${path}.kind`, "primitive kind is not supported");
  exactKeys(primitive, keys, path);
  registerDrawingName(primitive.name, `${path}.name`, names);
  assertString(primitive.role, `${path}.role`);
  if (!Number.isInteger(primitive.z) || primitive.z < 1) fail("E_NONDETERMINISTIC_OUTPUT", `${path}.z`, "z must be positive integer");
  if (primitive.kind === "text") {
    assertGeometryBox(primitive, path, stage);
    assertText(primitive.text, `${path}.text`);
    if (STRICT_CONTROL_PATTERN.test(primitive.text)) {
      fail(
        "E_TEXT_CONTROL_CHAR",
        `${path}.text`,
        "text contains a control character",
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
  } else if (primitive.kind === "line") {
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
  } else if (primitive.kind === "table") {
    assertGeometryBox(primitive, path, stage);
    if (!isDenseArray(primitive.headers) || primitive.headers.length === 0) {
      fail("E_SPEC_SCHEMA", `${path}.headers`, "expected nonempty dense string array");
    }
    primitive.headers.forEach((header, index) =>
      assertTableText(header, `${path}.headers[${index}]`),
    );
    if (!isDenseArray(primitive.rows) || primitive.rows.length === 0) {
      fail("E_SPEC_SCHEMA", `${path}.rows`, "expected nonempty dense row array");
    }
    primitive.rows.forEach((row, rowIndex) => {
      const rowPath = `${path}.rows[${rowIndex}]`;
      if (!isDenseArray(row) || row.length !== primitive.headers.length) {
        fail("E_SPEC_SCHEMA", rowPath, "row width must match headers");
      }
      row.forEach((cell, cellIndex) =>
        assertTableText(cell, `${rowPath}[${cellIndex}]`),
      );
    });
    if (
      !isDenseArray(primitive.rowEvidenceIds) ||
      primitive.rowEvidenceIds.length !== primitive.rows.length
    ) {
      fail(
        "E_SPEC_SCHEMA",
        `${path}.rowEvidenceIds`,
        "row evidence arrays must match rows",
      );
    }
    const declaredEvidence = new Set(slideEvidenceIds);
    primitive.rowEvidenceIds.forEach((evidenceIds, rowIndex) => {
      const evidencePath = `${path}.rowEvidenceIds[${rowIndex}]`;
      if (
        !isDenseArray(evidenceIds) ||
        evidenceIds.length === 0 ||
        !evidenceIds.every(
          (evidenceId) =>
            typeof evidenceId === "string" && evidenceId.length > 0,
        ) ||
        new Set(evidenceIds).size !== evidenceIds.length
      ) {
        fail(
          "E_SPEC_SCHEMA",
          evidencePath,
          "expected a nonempty duplicate-free dense string array",
        );
      }
      evidenceIds.forEach((evidenceId, evidenceIndex) => {
        if (!declaredEvidence.has(evidenceId)) {
          fail(
            "E_EVIDENCE_NOT_DECLARED",
            `${evidencePath}[${evidenceIndex}]`,
            `${evidenceId} is absent from slide.evidenceIds`,
          );
        }
      });
    });
    if (family === "table") {
      if (
        primitive.role !== "native-table" ||
        primitive.headers.length < 2 ||
        primitive.headers.length > 6 ||
        primitive.rows.length < 1 ||
        primitive.rows.length > 10
      ) {
        fail(
          "E_SPEC_SCHEMA",
          path,
          "ordinary native table requires 2-6 columns and 1-10 rows",
        );
      }
    } else if (family === "evaluation") {
      if (
        primitive.role !== "native-evaluation-table" ||
        primitive.headers.length !== 3 ||
        primitive.rows.length < 3 ||
        primitive.rows.length > 8 ||
        primitive.headers.some(
          (header, index) =>
            header !== ["Cohort", "Expected behavior", "Result"][index],
        )
      ) {
        fail(
          "E_SPEC_SCHEMA",
          path,
          "evaluation native table requires its exact headers and 3-8 rows",
        );
      }
      primitive.rows.forEach((row, rowIndex) => {
        if (!EVALUATION_RESULTS.has(row[2])) {
          fail(
            "E_SPEC_SCHEMA",
            `${path}.rows[${rowIndex}][2]`,
            "invalid evaluation result",
          );
        }
      });
    } else {
      fail(
        "E_SPEC_SCHEMA",
        path,
        "native tables are supported only on table and evaluation slides",
      );
    }
    assertPositiveNumberArray(primitive.columnWidths, `${path}.columnWidths`);
    assertPositiveNumberArray(primitive.rowHeights, `${path}.rowHeights`);
    if (primitive.columnWidths.length !== primitive.headers.length) {
      fail("E_SPEC_SCHEMA", `${path}.columnWidths`, "column widths must match headers");
    }
    if (primitive.rowHeights.length !== primitive.rows.length + 1) {
      fail("E_SPEC_SCHEMA", `${path}.rowHeights`, "row heights must include header and every row");
    }
    const widthSum = primitive.columnWidths.reduce((sum, value) => sum + value, 0);
    const heightSum = primitive.rowHeights.reduce((sum, value) => sum + value, 0);
    if (Math.abs(widthSum - primitive.w) > 0.01) {
      fail("E_GEOMETRY_BOUNDS", `${path}.columnWidths`, "column widths must sum to table width");
    }
    if (Math.abs(heightSum - primitive.h) > 0.01) {
      fail("E_GEOMETRY_BOUNDS", `${path}.rowHeights`, "row heights must sum to table height");
    }
    for (const key of [
      "headerFillColorRole",
      "bodyFillColorRole",
      "alternateFillColorRole",
      "lineColorRole",
      "headerFontColorRole",
      "bodyFontColorRole",
    ]) {
      assertColorRole(primitive[key], `${path}.${key}`);
    }
    for (const key of ["headerFillTransparency", "alternateFillTransparency"]) {
      if (
        !Number.isFinite(primitive[key]) ||
        primitive[key] < 0 ||
        primitive[key] > 1
      ) {
        fail("E_SPEC_SCHEMA", `${path}.${key}`, "expected number from 0 to 1");
      }
    }
    for (const key of ["lineWidth", "cellMargin"]) {
      if (!Number.isFinite(primitive[key]) || primitive[key] <= 0) {
        fail("E_GEOMETRY_BOUNDS", `${path}.${key}`, "expected positive number");
      }
    }
    for (const key of ["headerFontSize", "bodyFontSize"]) {
      if (primitive[key] !== 8) {
        fail("E_SPEC_SCHEMA", `${path}.${key}`, "table font size must be 8");
      }
    }
  } else {
    validateNativeChart(
      primitive,
      path,
      stage,
      names,
      family,
      slideEvidenceIds,
    );
  }
}

function validateFooterContract(slide, path, theme) {
  const cover = slide.family === "cover";
  const contracts = [
    {
      role: "footer-rule",
      kind: "line",
      geometry: { x1: 48, y1: 498, x2: 912, y2: 498 },
      colorRole: cover ? "paper" : "line",
    },
    {
      role: "footer-required",
      kind: "text",
      geometry: { x: 48, y: 506, w: 220, h: 18 },
      text: theme.requiredFooter,
      colorRole: cover ? "paper" : "muted",
    },
    {
      role: "footer-evidence",
      kind: "text",
      geometry: { x: 276, y: 506, w: 408, h: 18 },
      text: compactEvidence(slide.evidenceIds, slide.judgmentIds),
      colorRole: cover ? "paper" : "muted",
    },
    {
      role: "footer-position",
      kind: "text",
      geometry: { x: 692, y: 506, w: 220, h: 18 },
      text: String(slide.sourceIndex),
      colorRole: cover ? "paper" : "muted",
    },
  ];
  const recognizedRoles = new Set(contracts.map((contract) => contract.role));
  for (const contract of contracts) {
    const matches = slide.primitives.filter(
      (primitive) => primitive.role === contract.role,
    );
    if (matches.length !== 1) {
      fail(
        "E_SPEC_SCHEMA",
        `${path}.primitives`,
        `expected exactly one ${contract.role} primitive`,
      );
    }
    const primitive = matches[0];
    if (
      primitive.kind !== contract.kind ||
      primitive.name !==
        primitiveName(slide.sourceIndex, slide.id, contract.role)
    ) {
      fail(
        "E_SPEC_SCHEMA",
        `${path}.primitives`,
        `${contract.role} kind or name does not match the footer contract`,
      );
    }
    for (const [key, value] of Object.entries(contract.geometry)) {
      if (primitive[key] !== value) {
        fail(
          "E_GEOMETRY_BOUNDS",
          `${path}.primitives`,
          `${contract.role}.${key} does not match the footer contract`,
        );
      }
    }
    if (
      primitive.colorRole !== contract.colorRole ||
      (contract.kind === "text" && primitive.text !== contract.text)
    ) {
      fail(
        "E_SPEC_SCHEMA",
        `${path}.primitives`,
        `${contract.role} content does not match the footer contract`,
      );
    }
  }
  if (!cover) {
    slide.primitives.forEach((primitive, primitiveIndex) => {
      if (recognizedRoles.has(primitive.role)) return;
      const primitivePath = `${path}.primitives[${primitiveIndex}]`;
      if (primitive.kind === "line") {
        if (primitive.y1 > 478 || primitive.y2 > 478) {
          fail(
            "E_GEOMETRY_BOUNDS",
            primitivePath,
            "non-footer line enters the reserved footer band",
          );
        }
      } else if (primitive.y + primitive.h > 478) {
        fail(
          "E_GEOMETRY_BOUNDS",
          primitivePath,
          "non-footer box enters the reserved footer band",
        );
      }
    });
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
    slide.primitives.forEach((primitive, primitiveIndex) =>
      validatePrimitive(
        primitive,
        `${path}.primitives[${primitiveIndex}]`,
        spec.stage,
        names,
        slide.family,
        slide.evidenceIds,
      ),
    );
    slide.primitives.forEach((primitive, primitiveIndex) => {
      if (primitive.z !== primitiveIndex + 1) fail("E_NONDETERMINISTIC_OUTPUT", `${path}.primitives[${primitiveIndex}].z`, "z must be contiguous from 1");
      if (spec.theme.unbranded && primitive.role === "wordmark") fail("E_SPEC_SCHEMA", `${path}.primitives[${primitiveIndex}].role`, "unbranded spec cannot emit wordmark");
    });
    if (["table", "evaluation"].includes(slide.family)) {
      const tableCount = slide.primitives.filter(
        (primitive) => primitive.kind === "table",
      ).length;
      if (tableCount !== 1) {
        fail(
          "E_SPEC_SCHEMA",
          `${path}.primitives`,
          "table families require exactly one native table primitive",
        );
      }
    }
    if (slide.family === "chart") {
      const charts = slide.primitives.filter(
        (primitive) => primitive.kind === "nativeChart",
      );
      if (charts.length !== 1) {
        fail(
          "E_SPEC_SCHEMA",
          `${path}.primitives`,
          "chart family requires exactly one nativeChart primitive",
        );
      }
      const insightRule = slide.primitives.filter(
        (primitive) => primitive.role === "chart-insight-rule",
      );
      const insightText = slide.primitives.filter(
        (primitive) => primitive.role === "chart-insight",
      );
      const insightEvidence = slide.primitives.filter(
        (primitive) => primitive.role === "chart-insight-evidence",
      );
      if (
        insightRule.length !== 1 ||
        insightRule[0].kind !== "line" ||
        insightRule[0].x1 !== 48 ||
        insightRule[0].y1 !== 446 ||
        insightRule[0].x2 !== 912 ||
        insightRule[0].y2 !== 446 ||
        insightText.length !== 1 ||
        insightText[0].kind !== "text" ||
        insightText[0].x !== 48 ||
        insightText[0].y !== 454 ||
        insightText[0].w !== 704 ||
        insightText[0].h !== 24 ||
        insightEvidence.length !== 1 ||
        insightEvidence[0].kind !== "text" ||
        insightEvidence[0].x !== 768 ||
        insightEvidence[0].y !== 454 ||
        insightEvidence[0].w !== 144 ||
        insightEvidence[0].h !== 24 ||
        insightEvidence[0].text !== charts[0].insightEvidenceIds.join(", ")
      ) {
        fail(
          "E_GEOMETRY_BOUNDS",
          `${path}.primitives`,
          "chart insight geometry does not match the fixed contract",
        );
      }
    }
    validateFooterContract(slide, path, spec.theme);
    for (const role of [
      "decision-fact-card",
      "profile-fact-card",
      "profile-context-cell",
      "metric-cell",
      "finding-row",
      "responsibility-cell",
      "risk-card",
      "timeline-slot",
      "timeline-marker",
      "evidence-card",
    ]) {
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
