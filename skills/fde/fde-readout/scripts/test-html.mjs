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
    html.includes("__fdeReadoutQa"),
    "HTML must expose a rendered-geometry QA preflight",
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
