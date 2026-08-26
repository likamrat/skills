#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createReadoutServer } from "./serve.mjs";

const skillRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const examplePlan = join(
  skillRoot,
  "assets",
  "examples",
  "lattice-harbor-readout-plan.json",
);
const renderer = join(skillRoot, "scripts", "render-html.mjs");
const directory = await mkdtemp(join(tmpdir(), "fde-readout-html-"));
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

try {
  const result = spawnSync(process.execPath, [renderer, examplePlan, directory], {
    encoding: "utf8",
  });
  check(result.status === 0, `renderer failed:\n${result.stdout}${result.stderr}`);
  const html = await readFile(join(directory, "index.html"), "utf8");
  check(
    (html.match(/<article id=/g) ?? []).length === 11,
    "example HTML must contain 11 slides",
  );
  check(
    html.includes('data-plan-version="1.0"') &&
      /data-plan-hash="[a-f0-9]{64}"/.test(html),
    "HTML must embed plan version and hash",
  );
  check(
    html.includes("1600px") &&
      html.includes("?export=1") === false &&
      html.includes("export-mode"),
    "HTML must use a fixed stage and export mode",
  );
  check(
    !/https?:\/\//i.test(html),
    "HTML must not require remote runtime assets",
  );
  check(
    !/(?:#FF7A45|#FFE5D8|#FFF8F5|#EAF3FF)/i.test(html),
    "HTML must not use the rejected palette",
  );
  check(
    html.includes("ArrowRight") &&
      html.includes("requestFullscreen") &&
      html.includes("data-pptx-notes"),
    "HTML must support navigation, fullscreen, and notes",
  );
  check(
    html.includes("workflow-map") &&
      html.includes("marker-end") &&
      html.includes("edge--decision"),
    "HTML must render exact workflow connectors",
  );
  check(
    html.includes('markerWidth="8"') &&
      html.includes('d="M1,1 L7,4 L1,7"') &&
      html.includes("stroke-width:2;opacity:.72") &&
      html.includes(".flow-arrow:before"),
    "HTML workflow connectors must use restrained open arrowheads and thin rails",
  );
  check(
    html.includes("grid-template-columns:repeat(5,minmax(0,1fr))") &&
      html.includes(".responsibility-step p{font-size:18px") &&
    html.includes(".responsibility-step{min-height:0") &&
    html.includes(".authority{background:transparent;border:0") &&
    html.includes(".risk{background:#f5f7f8;min-height:0") &&
    html.includes(".risk--dark{background:#e8f0ea"),
    "HTML responsibility and risk surfaces must use readable measures and soft neutral colors",
  );
  check(
    html.includes("linear-gradient(90deg,#2563eb,#6d5bd0)") &&
    html.includes("box-shadow:0 14px 34px #1f334814") &&
    html.includes(".responsibility-step:last-child{border-right:0}"),
    "HTML must compose related content into integrated editorial panels",
  );
  check(
    html.includes("__fdeReadoutQa"),
    "HTML must expose a rendered-geometry QA preflight",
  );
  check(
    html.includes("innerWidth<=760") &&
      html.includes("min-height:44px") &&
      html.includes("grid-template-columns:repeat(4,1fr)"),
    "HTML must reflow on phones with usable controls and four-up desktop metrics",
  );
  check(
    html.includes('faultMode=params.get("fault")') &&
      html.includes("Injected initialization fault.") &&
      html.includes("ReadoutPlan and rendered slide counts do not match."),
    "HTML must validate initialization and expose an isolated fault state",
  );
  check(
    html.includes("{J:judgment-rationale-001}") &&
      html.includes("Human context: judgment-rationale-001"),
    "HTML must preserve visible and speaker-note human-context provenance",
  );
  check(
    html.includes("milestone:not(:last-child):after") &&
      html.includes("--milestone-count:4"),
    "timeline rails must connect milestone centers without endpoint overhang",
  );

  const extendedPlan = JSON.parse(await readFile(examplePlan, "utf8"));
  extendedPlan.slides.splice(
    extendedPlan.slides.length - 1,
    0,
    {
      id: "routing-trend",
      family: "chart",
      title: "Routing time declines in the fictional sample",
      customerSafe: true,
      notes: "Fictional chart sourced from [baseline-001].",
      evidenceIds: ["baseline-001"],
      judgmentIds: ["judgment-surprise-001"],
      content: {
        chartType: "line",
        categories: ["W1", "W2", "W3", "W4"],
        unit: "minutes",
        series: [
          {
            name: "Median routing",
            values: [47, 39, 31, 24],
            evidenceIds: ["baseline-001"],
          },
        ],
        insight: {
          statement: "The fictional median declines across the sample.",
          evidenceIds: ["baseline-001"],
        },
      },
    },
    {
      id: "control-table",
      family: "table",
      title: "Pilot controls remain explicit",
      customerSafe: true,
      notes: "Fictional control table sourced from [authority-001].",
      evidenceIds: ["authority-001"],
      judgmentIds: ["judgment-rationale-001"],
      content: {
        columns: ["Control", "Owner"],
        rows: [
          {
            cells: ["Queue confirmation", "Exception dispatcher"],
            evidenceIds: ["authority-001"],
          },
          {
            cells: ["Commitment authority", "Duty manager"],
            evidenceIds: ["authority-001"],
          },
        ],
        insight: {
          statement: "The pilot does not transfer commitment authority.",
          evidenceIds: ["authority-001"],
        },
      },
    },
  );
  const extendedPlanPath = join(directory, "extended-plan.json");
  const extendedDirectory = join(directory, "extended");
  await writeFile(extendedPlanPath, JSON.stringify(extendedPlan));
  const extendedResult = spawnSync(
    process.execPath,
    [renderer, extendedPlanPath, extendedDirectory],
    { encoding: "utf8" },
  );
  check(
    extendedResult.status === 0,
    `extended renderer failed:\n${extendedResult.stdout}${extendedResult.stderr}`,
  );
  if (extendedResult.status === 0) {
    const extendedHtml = await readFile(
      join(extendedDirectory, "index.html"),
      "utf8",
    );
    check(
      extendedHtml.includes("chart-layout") &&
        extendedHtml.includes("data-table") &&
        extendedHtml.includes("Routing time declines"),
      "HTML renderer must execute chart and table families",
    );
  }

  let server;
  try {
    const running = await createReadoutServer({
      directory,
      port: 0,
    });
    server = running.server;
    const page = await fetch(running.url);
    const body = await page.text();
    check(page.status === 200, "localhost server must return the deck");
    check(body.includes("Lattice Harbor"), "served deck must contain the example");
  } finally {
    await new Promise((close) => server?.close(close));
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("HTML renderer validation failed:");
  failures.forEach((failure, index) =>
    console.error(`${index + 1}. ${failure}`),
  );
  process.exit(1);
}

console.log("HTML renderer validation passed.");
