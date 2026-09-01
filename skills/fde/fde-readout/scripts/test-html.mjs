#!/usr/bin/env node

import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { browserCandidates } from "./browser-candidates.mjs";
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

async function findBrowser() {
  for (const candidate of browserCandidates()) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next supported local browser.
    }
  }
  return null;
}

async function waitForDevtoolsPort(profile) {
  const path = join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const [port] = (await readFile(path, "utf8")).split(/\r?\n/);
      if (port) return Number.parseInt(port, 10);
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  throw new Error("Timed out waiting for the browser debugging port.");
}

async function createCdpClient(port) {
  const targets = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json();
  const target = targets.find((candidate) => candidate.type === "page");
  if (!target) throw new Error("Browser did not expose a page target.");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((open, reject) => {
    socket.addEventListener("open", open, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  return {
    close: () => socket.close(),
    send(method, params = {}) {
      const id = (sequence += 1);
      return new Promise((resolveRequest, reject) => {
        pending.set(id, { resolve: resolveRequest, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

async function inspectPage(client, url, width, height) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 760,
  });
  await client.send("Page.navigate", { url });
  const expectedUrl = url.split("#")[0];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await client.send("Runtime.evaluate", {
      expression: `location.href.startsWith(${JSON.stringify(expectedUrl)}) && document.body?.dataset.ready`,
      returnByValue: true,
    });
    if (ready.result.value === "true") break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  const inspected = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const riskText = [...document.querySelectorAll(".slide--risks .risk h2, .slide--risks .risk dt, .slide--risks .risk dd, .slide--risks .risk small")];
      const risks = [...document.querySelectorAll(".slide--risks .risk")];
      const controls = [...document.querySelectorAll(".deck-controls button")];
      const riskRects = risks.map((element) => element.getBoundingClientRect());
      return {
        qa: window.__fdeReadoutQa(),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        riskColumnCount: getComputedStyle(document.querySelector(".slide--risks .risks")).gridTemplateColumns.split(" ").length,
        riskClipping: risks.some((element) => element.scrollHeight > element.clientHeight + 2),
        riskOverlap: riskRects.some((rect, index) => index > 0 && rect.top < riskRects[index - 1].bottom - 2),
        minimumRiskTextPx: Math.min(...riskText.map((element) => Number.parseFloat(getComputedStyle(element).fontSize))),
        minimumControlHeight: Math.min(...controls.map((element) => element.getBoundingClientRect().height)),
      };
    })()`,
    returnByValue: true,
  });
  return inspected.result.value;
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
    html.includes(".responsibility-step:last-child{border-right:0}") &&
    html.includes(".decision-grid{border:1px solid #d8e0e7") &&
    html.includes(".evidence-groups{border:1px solid #d8e0e7") &&
    html.includes("radial-gradient(circle at 104% 31%"),
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

  const riskPlan = JSON.parse(await readFile(examplePlan, "utf8"));
  const riskSlide = riskPlan.slides.find((slide) => slide.family === "risks");
  const riskSlideNumber = riskPlan.slides.indexOf(riskSlide) + 1;
  const riskEvidenceIds = riskSlide.content.items[0].evidenceIds;
  const reproducedRiskItems = [
    {
      risk: "Conflicting or stale evidence produces a plausible queue",
      impact: "The claim may be routed on outdated ownership guidance.",
      control: "Suppress the recommendation and use the named human route.",
      residualRisk: "Source precedence remains unresolved.",
    },
    {
      risk: "Missing identity is filled probabilistically",
      impact: "A recommendation may attach to the wrong claim.",
      control: "Keep missing identity visible and require clarification.",
      residualRisk: "Manual clarification still adds review time.",
    },
    {
      risk: "Queue routing is treated as financial authority",
      impact: "The workflow could cross the duty-manager boundary.",
      control:
        "Keep the model to one explained recommendation and preserve adjuster authority.",
      residualRisk: "Production remains unauthorized.",
    },
    {
      risk: "A recovery failure leaves the recommendation path active",
      impact: "Adjusters may continue relying on a degraded workflow.",
      control:
        "Disable the recommendation path and return every claim to manual triage.",
      residualRisk: "Manual triage increases review time during recovery.",
    },
  ].map((item) => ({ ...item, evidenceIds: riskEvidenceIds }));
  for (const count of [1, 2, 3, 4]) {
    const countPlan = structuredClone(riskPlan);
    countPlan.slides.find(
      (slide) => slide.family === "risks",
    ).content.items = reproducedRiskItems.slice(0, count);
    const countPlanPath = join(directory, `risk-${count}-plan.json`);
    const countDirectory = join(directory, `risk-${count}`);
    await writeFile(countPlanPath, JSON.stringify(countPlan));
    const countResult = spawnSync(
      process.execPath,
      [renderer, countPlanPath, countDirectory],
      { encoding: "utf8" },
    );
    check(
      countResult.status === 0,
      `${count}-risk renderer failed:\n${countResult.stdout}${countResult.stderr}`,
    );
    if (countResult.status === 0) {
      const countHtml = await readFile(join(countDirectory, "index.html"), "utf8");
      check(
        countHtml.includes(
          `class="risks risks--count-${count}" style="--risk-count:${count}"`,
        ),
        `${count}-risk HTML must expose its explicit count`,
      );
    }
  }

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
    const browser = await findBrowser();
    if (browser) {
      const profile = await mkdtemp(join(tmpdir(), "fde-readout-browser-"));
      const processHandle = spawn(
        browser,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          "--remote-debugging-port=0",
          `--user-data-dir=${profile}`,
          "about:blank",
        ],
        { stdio: "ignore" },
      );
      let client;
      try {
        const port = await waitForDevtoolsPort(profile);
        client = await createCdpClient(port);
        await client.send("Page.enable");
        await client.send("Runtime.enable");
        for (const count of [1, 2, 3, 4]) {
          const desktop = await inspectPage(
            client,
            `${running.url}risk-${count}/#slide=${riskSlideNumber}`,
            1600,
            1000,
          );
          check(
            desktop.qa.length === 0,
            `${count}-risk desktop QA failed: ${JSON.stringify(desktop.qa)}`,
          );
        }
        const phone = await inspectPage(
          client,
          `${running.url}risk-4/#slide=${riskSlideNumber}`,
          390,
          844,
        );
        check(
          phone.qa.length === 0 &&
            !phone.horizontalOverflow &&
            phone.riskColumnCount === 1 &&
            !phone.riskClipping &&
            !phone.riskOverlap,
          `phone risk layout failed: ${JSON.stringify(phone)}`,
        );
        check(
          phone.minimumRiskTextPx >= 12 && phone.minimumControlHeight >= 44,
          `phone risk text and controls must remain usable: ${JSON.stringify(phone)}`,
        );
        const exported = await inspectPage(
          client,
          `${running.url}risk-4/?export=1`,
          1600,
          1000,
        );
        check(
          exported.qa.length === 0,
          `four-risk export QA failed: ${JSON.stringify(exported.qa)}`,
        );
      } finally {
        client?.close();
        if (processHandle.exitCode === null) {
          processHandle.kill();
          await new Promise((exit) => processHandle.once("exit", exit));
        }
        await rm(profile, { recursive: true, force: true, maxRetries: 5 });
      }
    } else {
      console.warn(
        "Skipping rendered geometry checks: set FDE_READOUT_BROWSER to a Chromium executable.",
      );
    }
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
