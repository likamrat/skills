#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [planPath, outputDirectory] = process.argv.slice(2);

if (!planPath || !outputDirectory || process.argv.includes("--help")) {
  console.log(
    "Usage: node scripts/render-html.mjs <readout-plan.json> <output-directory>",
  );
  process.exit(planPath && outputDirectory ? 0 : 2);
}

const validator = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "validate-readout-plan.mjs",
);
const validation = spawnSync(process.execPath, [validator, planPath], {
  encoding: "utf8",
});
if (validation.status !== 0) {
  process.stderr.write(`${validation.stdout}${validation.stderr}`);
  process.exit(validation.status ?? 1);
}

const sourceText = await readFile(resolve(planPath), "utf8");
const plan = JSON.parse(sourceText);
const planHash = createHash("sha256").update(sourceText).digest("hex");
const target = resolve(outputDirectory);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("\n", "&#10;");
}

function evidence(ids) {
  return ids.map((id) => `[${escapeHtml(id)}]`).join(" ");
}

function judgment(ids) {
  return ids.map((id) => `{J:${escapeHtml(id)}}`).join(" ");
}

function compactProvenance(ids, formatter, maximum) {
  const visible = ids.slice(0, maximum);
  const remainder = ids.length - visible.length;
  return `${formatter(visible)}${remainder > 0 ? ` +${remainder} in notes` : ""}`;
}

function footer(slide) {
  return `
    <footer class="slide-footer">
      <strong>${escapeHtml(plan.brand.requiredFooter)}</strong>
      <span>${evidence(slide.evidenceIds)}</span>
      <span>${escapeHtml(plan.confidentiality)}</span>
    </footer>`;
}

function factMarkup(items) {
  return items
    .map(
      (item) => `
        <div class="fact">
          <strong>${escapeHtml(item.label)}</strong>
          <span>${escapeHtml(item.value)}</span>
          <small>${evidence(item.evidenceIds)}</small>
        </div>`,
    )
    .join("");
}

function workflowMarkup(slide) {
  const nodes = slide.content.nodes;
  const edges = slide.content.edges;
  const width = 1436;
  const height = 520;
  const positions = new Map();
  const groups = {
    source: nodes.filter((node) => node.role === "source"),
    middle: nodes.filter((node) => ["actor", "system"].includes(node.role)),
    decision: nodes.filter((node) => node.role === "decision"),
  };

  function place(items, x, nodeWidth) {
    const nodeHeight = 106;
    const gap =
      items.length <= 1
        ? 0
        : Math.min(78, (height - nodeHeight * items.length) / (items.length - 1));
    const total = nodeHeight * items.length + gap * Math.max(0, items.length - 1);
    const start = Math.max(0, (height - total) / 2);
    items.forEach((item, index) => {
      positions.set(item.id, {
        x,
        y: start + index * (nodeHeight + gap),
        width: nodeWidth,
        height: nodeHeight,
      });
    });
  }

  place(groups.source, 0, 300);
  place(groups.middle, 610, 360);
  place(groups.decision, 1170, 266);

  const systemMarker = `system-${slide.id}`;
  const decisionMarker = `decision-${slide.id}`;
  const lines = [
    `<defs>
      <marker id="${systemMarker}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M1,1 L7,4 L1,7" fill="none" stroke="var(--system)" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></marker>
      <marker id="${decisionMarker}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M1,1 L7,4 L1,7" fill="none" stroke="var(--decision)" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></marker>
    </defs>`,
  ];
  const handled = new Set();

  for (const targetNode of groups.middle) {
    const incoming = edges.filter(
      (edge) =>
        edge.kind === "system" &&
        edge.to === targetNode.id &&
        positions.get(edge.from) &&
        nodes.find((node) => node.id === edge.from)?.role === "source",
    );
    if (incoming.length < 2) continue;

    const targetPosition = positions.get(targetNode.id);
    const sourcePositions = incoming.map((edge) => positions.get(edge.from));
    const spineX =
      (Math.max(...sourcePositions.map((position) => position.x + position.width)) +
        targetPosition.x) /
      2;
    const centers = sourcePositions.map(
      (position) => position.y + position.height / 2,
    );
    const targetCenter = targetPosition.y + targetPosition.height / 2;

    for (const [index, edge] of incoming.entries()) {
      const source = sourcePositions[index];
      const center = source.y + source.height / 2;
      lines.push(
        `<path d="M${source.x + source.width} ${center} H${spineX}" class="edge edge--system"/>`,
      );
      handled.add(edge);
    }
    lines.push(
      `<path d="M${spineX} ${Math.min(...centers)} V${Math.max(...centers)}" class="edge edge--system"/>`,
      `<path d="M${spineX} ${targetCenter} H${targetPosition.x}" class="edge edge--system" marker-end="url(#${systemMarker})"/>`,
    );
  }

  for (const edge of edges) {
    if (handled.has(edge)) continue;
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const fromX = from.x + from.width;
    const fromY = from.y + from.height / 2;
    const toX = to.x;
    const toY = to.y + to.height / 2;
    const midX = (fromX + toX) / 2;
    const marker = edge.kind === "decision" ? decisionMarker : systemMarker;
    lines.push(
      `<path d="M${fromX} ${fromY} H${midX} V${toY} H${toX}" class="edge edge--${edge.kind}" marker-end="url(#${marker})"/>`,
    );
  }

  const nodeMarkup = nodes
    .map((node) => {
      const position = positions.get(node.id);
      return `
        <div class="workflow-node workflow-node--${escapeHtml(node.role)}"
             style="left:${position.x}px;top:${position.y}px;width:${position.width}px;height:${position.height}px">
          <strong>${escapeHtml(node.label)}</strong>
          <span>${escapeHtml(node.detail)}</span>
        </div>`;
    })
    .join("");

  return `
    <div class="workflow-map">
      <svg viewBox="0 0 ${width} ${height}" aria-hidden="true">${lines.join("")}</svg>
      ${nodeMarkup}
    </div>`;
}

function chartMarkup(content) {
  const width = 1436;
  const height = 470;
  const margin = { left: 82, right: 42, top: 34, bottom: 82 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const values = content.series.flatMap((series) => series.values);
  const maximum = Math.max(1, ...values);
  const palette = [
    plan.brand.colors.system,
    plan.brand.colors.decision,
    plan.brand.colors.ink,
    plan.brand.colors.muted,
  ];
  const elements = [
    `<line x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${
      margin.left + plotWidth
    }" y2="${margin.top + plotHeight}" stroke="${plan.brand.colors.line}" stroke-width="2"/>`,
  ];

  if (content.chartType === "bar") {
    const groupWidth = plotWidth / content.categories.length;
    const barSlot = groupWidth / (content.series.length + 1);
    content.series.forEach((series, seriesIndex) => {
      series.values.forEach((value, valueIndex) => {
        const barHeight = (value / maximum) * plotHeight;
        const x =
          margin.left +
          valueIndex * groupWidth +
          (seriesIndex + 0.5) * barSlot;
        const y = margin.top + plotHeight - barHeight;
        elements.push(
          `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(
            barSlot * 0.72
          ).toFixed(1)}" height="${barHeight.toFixed(1)}" fill="${
            palette[seriesIndex]
          }"/>`,
        );
      });
    });
  } else {
    content.series.forEach((series, seriesIndex) => {
      const points = series.values.map((value, valueIndex) => {
        const x =
          margin.left +
          (valueIndex / Math.max(1, content.categories.length - 1)) * plotWidth;
        const y = margin.top + plotHeight - (value / maximum) * plotHeight;
        return { x, y };
      });
      elements.push(
        `<path d="${points
          .map(
            (point, pointIndex) =>
              `${pointIndex === 0 ? "M" : "L"}${point.x.toFixed(
                1,
              )} ${point.y.toFixed(1)}`,
          )
          .join(" ")}" fill="none" stroke="${
          palette[seriesIndex]
        }" stroke-width="6"/>`,
        ...points.map(
          (point) =>
            `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(
              1,
            )}" r="7" fill="${palette[seriesIndex]}"/>`,
        ),
      );
    });
  }

  content.categories.forEach((category, index) => {
    const x =
      margin.left +
      ((index + 0.5) / content.categories.length) * plotWidth;
    elements.push(
      `<text x="${x.toFixed(1)}" y="${
        margin.top + plotHeight + 38
      }" text-anchor="middle" font-size="16" fill="${
        plan.brand.colors.muted
      }">${escapeHtml(category)}</text>`,
    );
  });

  const legend = content.series
    .map(
      (series, index) => `
        <span><i style="background:${palette[index]}"></i>${escapeHtml(
          series.name,
        )} ${evidence(series.evidenceIds)}</span>`,
    )
    .join("");

  return `
    <div class="chart-layout">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttribute(
        `${content.chartType} chart in ${content.unit}`,
      )}">${elements.join("")}</svg>
      <div class="chart-legend">${legend}</div>
    </div>
    <div class="chart-insight">${escapeHtml(
      content.insight.statement,
    )} <small>${evidence(content.insight.evidenceIds)}</small></div>`;
}

function familyContent(slide) {
  const content = slide.content;
  switch (slide.family) {
    case "cover":
      return `
        <section class="cover-main">
          <div class="wordmark">${escapeHtml(plan.brand.wordmark)}</div>
          <h1>${escapeHtml(slide.title)}</h1>
          <p>${escapeHtml(content.subtitle)}</p>
          <div class="cover-decision">${escapeHtml(content.decision)}</div>
        </section>
        <aside class="cover-rail">
          <div class="cover-bars"><span></span><span></span></div>
          <strong>01</strong>
          <p>Decision<br/>readout</p>
          <small>${escapeHtml(plan.brand.requiredFooter)}</small>
        </aside>`;
    case "decision":
      return `
        <h1 class="slide-title">${escapeHtml(slide.title)}</h1>
        <div class="decision-grid">
          <section class="decision-main">
            <strong>RECOMMENDATION</strong>
            <h2>${escapeHtml(content.recommendation)}</h2>
            <ul>${content.bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
          </section>
          <aside class="decision-facts">${factMarkup(content.facts)}</aside>
        </div>`;
    case "profile":
      return `
        <h1 class="slide-title">${escapeHtml(slide.title)}</h1>
        <div class="profile-grid">
          <section>
            <h2>${escapeHtml(content.company)}</h2>
            <p>${escapeHtml(content.businessModel)}</p>
            <div class="profile-facts">${factMarkup(content.facts)}</div>
          </section>
          <aside class="profile-value">
            <strong>HOW VALUE IS CREATED</strong>
            <p>${escapeHtml(content.valueStatement.statement)}</p>
            <small>${evidence(content.valueStatement.evidenceIds)}</small>
            <ul>${content.contexts.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
          </aside>
        </div>`;
    case "metrics":
      return `
        <h1 class="slide-title">${escapeHtml(slide.title)}</h1>
        <div class="metrics">${content.metrics
          .map(
            (item) => `
              <div class="metric">
                <strong>${escapeHtml(item.label)}</strong>
                <b>${escapeHtml(item.value)}</b>
                <span>${escapeHtml(item.context)}</span>
                <small>${evidence(item.evidenceIds)}</small>
              </div>`,
          )
          .join("")}</div>
        <div class="outcome">${escapeHtml(content.outcome.statement)} <small>${evidence(content.outcome.evidenceIds)}</small></div>`;
    case "chart":
      return `
        <h1 class="slide-title">${escapeHtml(slide.title)}</h1>
        ${chartMarkup(content)}`;
    case "table":
      return `
        <h1 class="slide-title">${escapeHtml(slide.title)}</h1>
        <table class="data-table">
          <thead><tr>${content.columns
            .map((column) => `<th>${escapeHtml(column)}</th>`)
            .join("")}<th>Evidence</th></tr></thead>
          <tbody>${content.rows
            .map(
              (row) => `
                <tr>${row.cells
                  .map((cell) => `<td>${escapeHtml(cell)}</td>`)
                  .join("")}<td>${evidence(row.evidenceIds)}</td></tr>`,
            )
            .join("")}</tbody>
        </table>
        <div class="table-insight">${escapeHtml(
          content.insight.statement,
        )} <small>${evidence(content.insight.evidenceIds)}</small></div>`;
    case "workflow":
      return `
        <h1 class="slide-title">${escapeHtml(slide.title)}</h1>
        ${workflowMarkup(slide)}`;
    case "findings":
      return `
        <h1 class="slide-title">${escapeHtml(slide.title)}</h1>
        <div class="findings">${content.items
          .map(
            (item, index) => `
              <div class="finding">
                <span>${index + 1}</span>
                <h2>${escapeHtml(item.title)}</h2>
                <p>${escapeHtml(item.consequence)}</p>
                <small>${evidence(item.evidenceIds)}</small>
              </div>`,
          )
          .join("")}</div>`;
    case "responsibility":
      return `
        <h1 class="slide-title">${escapeHtml(slide.title)}</h1>
        <div class="responsibility">${content.steps
          .map(
            (step, index) => `
              ${index > 0 ? '<span class="flow-arrow">&rarr;</span>' : ""}
              <div class="responsibility-step responsibility-step--${escapeHtml(step.type)}">
                <strong>${escapeHtml(step.type.toUpperCase())}</strong>
                <p>${escapeHtml(step.statement)}</p>
                <small>${evidence(step.evidenceIds)}</small>
              </div>`,
          )
          .join("")}</div>
        <div class="authority">${escapeHtml(content.excludedAuthority.statement)} <small>${evidence(content.excludedAuthority.evidenceIds)}</small></div>`;
    case "evaluation":
      return `
        <h1 class="slide-title">${escapeHtml(slide.title)}</h1>
        <table class="evaluation">
          <thead><tr><th>Cohort</th><th>Expected control</th><th>Result</th><th>Evidence</th></tr></thead>
          <tbody>${content.cases
            .map(
              (item) => `
                <tr class="result--${escapeHtml(item.result)}">
                  <td>${escapeHtml(item.cohort)}</td>
                  <td>${escapeHtml(item.expected)}</td>
                  <td>${escapeHtml(item.result.toUpperCase())}</td>
                  <td>${evidence(item.evidenceIds)}</td>
                </tr>`,
            )
            .join("")}</tbody>
        </table>
        <div class="release">${escapeHtml(content.releaseImplication.statement)} <small>${evidence(content.releaseImplication.evidenceIds)}</small></div>`;
    case "risks":
      return `
        <h1 class="slide-title">${escapeHtml(slide.title)}</h1>
        <div class="risks">${content.items
          .map(
            (item, index) => `
              <section class="risk ${index === 1 ? "risk--dark" : ""}">
                <h2>${escapeHtml(item.risk)}</h2>
                <dl>
                  <dt>Impact</dt><dd>${escapeHtml(item.impact)}</dd>
                  <dt>Control</dt><dd>${escapeHtml(item.control)}</dd>
                  <dt>Residual</dt><dd>${escapeHtml(item.residualRisk)}</dd>
                </dl>
                <small>${evidence(item.evidenceIds)}</small>
              </section>`,
          )
          .join("")}</div>
        <div class="stop">${escapeHtml(content.stopCondition.statement)} <small>${evidence(content.stopCondition.evidenceIds)}</small></div>`;
    case "timeline":
      return `
        <h1 class="slide-title">${escapeHtml(slide.title)}</h1>
        <div class="timeline-decision">
          <div><strong>DECISION - ${escapeHtml(content.decision.due)}</strong><p>${escapeHtml(content.decision.statement)}</p><small>${escapeHtml(content.decision.owner)} ${evidence(content.decision.evidenceIds)}</small></div>
        </div>
        <div class="timeline" style="--milestone-count:${content.milestones.length}">${content.milestones
          .map(
            (item, index) => `
              <div class="milestone">
                <span>${index + 1}</span>
                <strong>${escapeHtml(item.due)}</strong>
                <p>${escapeHtml(item.label)}</p>
                <small>${escapeHtml(item.owner)}<br/>${escapeHtml(item.outcome)}<br/>${evidence(item.evidenceIds)}</small>
              </div>`,
          )
          .join("")}</div>`;
    case "evidence":
      return `
        <h1 class="slide-title">${escapeHtml(slide.title)}</h1>
        <div class="evidence-groups">${content.groups
          .map(
            (group, index) => `
              <section class="evidence-group ${index === content.groups.length - 1 ? "evidence-group--dark" : ""}">
                <h2>${escapeHtml(group.label)}</h2>
                <ul>${group.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
                <small>${evidence(group.evidenceIds)}</small>
              </section>`,
          )
          .join("")}</div>
        <div class="controls">${content.controls.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>`;
  }
}

function renderSlide(slide, index) {
  const cover = slide.family === "cover";
  const notes = `${slide.notes}\nEvidence: ${slide.evidenceIds.join(
    ", ",
  )}\nHuman context: ${slide.judgmentIds.join(", ")}`;
  const provenance = [
    compactProvenance(slide.evidenceIds, evidence, 4),
    compactProvenance(slide.judgmentIds, judgment, 2),
  ]
    .filter((item) => item.trim().length > 0)
    .join(" ");
  return `
    <article id="${escapeAttribute(slide.id)}"
             class="slide slide--${escapeAttribute(slide.family)}"
             aria-label="${escapeAttribute(slide.title)}"
             data-pptx-notes="${escapeAttribute(notes)}"
             data-slide-index="${index}">
      ${familyContent(slide)}
      ${
        cover
          ? ""
          : `<footer class="slide-footer"><strong>${escapeHtml(
              plan.brand.requiredFooter,
            )}</strong><span>${provenance}</span><span>${escapeHtml(
              plan.confidentiality,
            )}</span></footer>`
      }
    </article>`;
}

const css = `
:root{--stage-width:1600px;--stage-height:900px;--scale:1;--ink:${plan.brand.colors.ink};--system:${plan.brand.colors.system};--decision:${plan.brand.colors.decision};--risk:${plan.brand.colors.risk};--paper:${plan.brand.colors.paper};--muted:${plan.brand.colors.muted};--line:${plan.brand.colors.line};--font:${JSON.stringify(plan.brand.fontFamily)},Arial,sans-serif}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:var(--ink);font-family:var(--font);overflow:hidden}button{background:#ffffff12;border:1px solid #ffffff33;border-radius:4px;color:#fff;cursor:pointer;font:600 13px/1 var(--font);min-height:38px;padding:0 14px}button:focus-visible{outline:3px solid #fff;outline-offset:3px}.sr-only{clip:rect(0 0 0 0);clip-path:inset(50%);height:1px;overflow:hidden;position:absolute;white-space:nowrap;width:1px}.app{align-items:center;display:grid;grid-template-rows:1fr auto;height:100svh;justify-items:center;min-height:420px;padding:22px 24px 18px}.shell{height:calc(var(--stage-height)*var(--scale));position:relative;width:calc(var(--stage-width)*var(--scale))}.stage{background:var(--paper);box-shadow:0 24px 70px #00000047;height:var(--stage-height);overflow:hidden;position:absolute;transform:scale(var(--scale));transform-origin:left top;width:var(--stage-width)}.slide{background:var(--paper);color:var(--ink);display:grid;height:900px;inset:0;opacity:0;overflow:hidden;padding:70px 82px 54px;pointer-events:none;position:absolute;transform:translateX(42px);transition:opacity .22s ease-out,transform .3s cubic-bezier(.2,.8,.2,1);visibility:hidden;width:1600px}.slide.is-active{opacity:1;pointer-events:auto;transform:none;visibility:visible;z-index:2}.slide.is-before{transform:translateX(-42px)}h1,h2,p{margin:0}.slide-title{font-size:44px;font-weight:500;letter-spacing:-.032em;line-height:1.08;max-width:1260px}.slide-footer{align-items:end;border-top:1px solid var(--line);bottom:22px;color:var(--muted);display:flex;font-size:13px;justify-content:space-between;left:82px;padding-top:13px;position:absolute;right:82px}.slide-footer strong{color:var(--decision);font-size:12px;letter-spacing:.08em}.slide--cover{grid-template-columns:2.15fr 1fr;padding:0}.cover-main{background:var(--ink);color:#fff;display:flex;flex-direction:column;justify-content:center;padding:92px 96px;position:relative}.cover-main:before{background:var(--decision);content:"";height:580px;left:54px;position:absolute;top:160px;width:6px}.wordmark{font-size:18px;font-weight:700;letter-spacing:.08em;margin-bottom:82px}.cover-main h1{font-size:62px;font-weight:500;letter-spacing:-.04em;line-height:1.25}.cover-main p{color:#d1d5db;font-size:25px;line-height:1.35;margin-top:42px}.cover-decision{border:1px solid var(--system);font-size:16px;font-weight:700;margin-top:54px;padding:18px 22px;width:fit-content}.cover-rail{background:#fff;display:flex;flex-direction:column;justify-content:center;padding:70px 76px}.cover-bars{display:grid;gap:24px;margin-bottom:90px}.cover-bars span{background:var(--system);height:36px}.cover-bars span:last-child{background:var(--decision);margin-left:42px}.cover-rail>strong{font-size:72px;font-weight:400}.cover-rail p{font-size:29px;line-height:1.1;margin-top:20px}.cover-rail small{color:var(--decision);font-size:13px;font-weight:700;letter-spacing:.1em;margin-top:110px}.decision-grid{display:grid;gap:36px;grid-template-columns:2.2fr 1fr;margin-top:52px}.decision-main{background:var(--ink);color:#fff;min-height:500px;padding:58px 62px}.decision-main>strong{color:var(--decision);display:block;font-size:14px;letter-spacing:.1em;margin-bottom:44px}.decision-main h2{font-size:64px;letter-spacing:-.035em}.decision-main ul{display:grid;font-size:23px;gap:18px;list-style:none;margin:48px 0 0;padding:0}.decision-facts{display:grid;gap:22px}.fact{border:1px solid var(--line);display:grid;gap:18px;padding:28px}.fact strong{color:var(--system);font-size:13px;letter-spacing:.08em}.fact span{font-size:24px;font-weight:650}.fact small,small{color:var(--system)}.profile-grid{display:grid;gap:58px;grid-template-columns:1.3fr .9fr;margin-top:54px}.profile-grid>section{border-top:1px solid var(--line);padding-top:34px}.profile-grid h2{font-size:36px}.profile-grid>section>p{color:var(--muted);font-size:22px;line-height:1.45;margin-top:24px}.profile-facts{display:grid;grid-template-columns:1fr 1fr;margin-top:30px}.profile-value{background:var(--ink);color:#fff;padding:46px}.profile-value>strong{color:var(--decision);font-size:13px;letter-spacing:.08em}.profile-value p{font-size:30px;font-weight:650;line-height:1.2;margin-top:42px}.profile-value ul{border-top:1px solid #ffffff33;display:flex;gap:24px;list-style:none;margin:54px 0 0;padding:24px 0 0}.metrics{display:grid;gap:26px;grid-template-columns:repeat(3,1fr);margin-top:56px}.metric{border:1px solid var(--line);display:grid;min-height:250px;padding:38px 40px}.metric:nth-child(2){background:var(--system);border-color:var(--system);color:#fff}.metric strong{color:var(--system);font-size:13px;letter-spacing:.08em}.metric:nth-child(2) strong,.metric:nth-child(2) small{color:#fff}.metric b{font-size:58px;letter-spacing:-.045em;margin-top:30px}.metric span{color:var(--muted);font-size:16px}.metric small{align-self:end}.outcome{background:#f3f4f6;font-size:25px;font-weight:650;margin-top:34px;padding:30px 36px}.workflow-map{height:520px;margin-top:46px;position:relative}.workflow-map svg{height:100%;inset:0;overflow:visible;position:absolute;width:100%}.edge{fill:none;stroke-linecap:square;stroke-width:6}.edge--system{stroke:var(--system)}.edge--decision{stroke:var(--decision);stroke-width:8}.workflow-node{background:#fff;border:1px solid var(--line);display:flex;flex-direction:column;justify-content:center;padding:22px 26px;position:absolute}.workflow-node strong{font-size:19px}.workflow-node span{color:var(--muted);font-size:15px;margin-top:8px}.workflow-node--actor,.workflow-node--system{background:var(--ink);border-color:var(--ink);color:#fff}.workflow-node--actor span,.workflow-node--system span{color:#d1d5db}.workflow-node--decision{border:2px solid var(--decision)}.findings{border-top:1px solid var(--line);margin-top:52px}.finding{align-items:start;border-bottom:1px solid var(--line);display:grid;gap:34px;grid-template-columns:46px 420px 1fr 150px;min-height:150px;padding:28px 0}.finding>span:first-child{align-items:center;background:var(--ink);border-radius:50%;color:#fff;display:flex;font-weight:700;height:38px;justify-content:center;width:38px}.finding:nth-child(2)>span:first-child{background:var(--system)}.finding:nth-child(3)>span:first-child{background:var(--decision)}.finding h2{font-size:24px}.finding p{color:var(--muted);font-size:18px;line-height:1.4}.responsibility{align-items:stretch;display:flex;margin-top:62px}.responsibility-step{border:1px solid var(--line);flex:1;min-height:270px;padding:42px}.responsibility-step--model{background:var(--system);border-color:var(--system);color:#fff}.responsibility-step--human{background:var(--ink);border-color:var(--ink);color:#fff}.responsibility-step strong{color:var(--system);font-size:13px;letter-spacing:.08em}.responsibility-step--model strong,.responsibility-step--human strong{color:#fff}.responsibility-step p{font-size:25px;font-weight:650;line-height:1.25;margin-top:35px}.responsibility-step small{display:block;margin-top:24px}.flow-arrow{align-items:center;color:var(--system);display:flex;flex:0 0 72px;font-size:48px;justify-content:center}.authority{border:2px solid var(--risk);color:var(--risk);font-size:19px;font-weight:700;margin-top:38px;padding:24px 30px}.evaluation{border-collapse:collapse;font-size:18px;margin-top:50px;width:100%}.evaluation th{border-bottom:2px solid var(--ink);color:var(--muted);font-size:13px;letter-spacing:.08em;padding:0 20px 16px;text-align:left}.evaluation td{border-bottom:1px solid var(--line);padding:21px 20px}.evaluation td:first-child{font-weight:700}.evaluation td:nth-child(3){color:var(--system);font-weight:800}.evaluation .result--fail td,.evaluation .result--fail td:nth-child(3){color:var(--risk)}.release{border-top:2px solid var(--decision);font-size:19px;font-weight:700;margin-top:34px;padding-top:20px}.risks{display:grid;gap:34px;grid-template-columns:repeat(2,1fr);margin-top:52px}.risk{border:1px solid var(--line);min-height:390px;padding:44px}.risk--dark{background:var(--ink);color:#fff}.risk h2{font-size:28px}.risk dl{display:grid;gap:8px;grid-template-columns:110px 1fr;margin-top:40px}.risk dt{color:var(--system);font-size:14px;font-weight:700}.risk--dark dt{color:var(--decision)}.risk dd{color:var(--muted);font-size:18px;line-height:1.35;margin:0 0 18px}.risk--dark dd{color:#d1d5db}.risk small{display:block}.stop{border-top:4px solid var(--risk);color:var(--risk);font-size:18px;font-weight:800;margin-top:36px;padding-top:20px}.timeline-decision{border:2px solid var(--decision);margin-top:48px;padding:28px;width:420px}.timeline-decision strong{color:var(--decision);font-size:13px;letter-spacing:.08em}.timeline-decision p{font-size:23px;font-weight:700;margin-top:20px}.timeline-decision small{display:block;margin-top:16px}.timeline{display:grid;grid-template-columns:repeat(var(--milestone-count),1fr);margin-top:70px;position:relative}.milestone{padding:0 24px;position:relative;text-align:center}.milestone:not(:last-child):after{background:var(--line);content:"";height:3px;left:50%;position:absolute;top:24px;width:100%;z-index:0}.milestone>span{align-items:center;background:var(--system);border-radius:50%;color:#fff;display:inline-flex;font-weight:700;height:50px;justify-content:center;position:relative;width:50px;z-index:1}.milestone:nth-child(3)>span{background:var(--decision)}.milestone:last-child>span{background:var(--ink)}.milestone strong{display:block;margin-top:22px}.milestone p{font-size:17px;font-weight:650;margin-top:8px}.milestone small{display:block;margin-top:8px}.evidence-groups{display:grid;gap:28px;grid-template-columns:repeat(3,1fr);margin-top:52px}.evidence-group{border-top:5px solid var(--system);padding:28px 10px 0}.evidence-group:nth-child(2){border-color:var(--decision)}.evidence-group--dark{background:var(--ink);border-color:var(--ink);color:#fff;padding:30px}.evidence-group h2{font-size:21px}.evidence-group ul{color:var(--muted);display:grid;font-size:17px;gap:16px;list-style:none;margin:32px 0 0;padding:0}.evidence-group--dark ul{color:#d1d5db}.evidence-group small{display:block;margin-top:28px}.controls{border:1px solid var(--risk);color:var(--risk);display:flex;font-size:15px;font-weight:700;gap:28px;margin-top:36px;padding:18px 24px}.deck-controls{align-items:center;display:flex;gap:10px;margin-top:16px;width:min(100%,980px)}.deck-position{color:#fff;font-size:13px;min-width:58px}.progress{background:#ffffff24;flex:1;height:3px}.progress span{background:var(--system);display:block;height:100%;transform-origin:left}.notes{background:#fff;border:1px solid var(--line);bottom:80px;box-shadow:0 24px 70px #00000047;color:var(--ink);max-width:560px;padding:24px;position:fixed;right:28px;z-index:20}.notes p{color:var(--muted);line-height:1.5}.message{background:#fff;color:var(--ink);left:50%;padding:28px;position:fixed;top:50%;transform:translate(-50%,-50%);z-index:30}.message[hidden]{display:none}.message--error{border-top:5px solid var(--risk)}.export-mode{overflow:auto}.export-mode .app{display:block;height:auto;padding:0}.export-mode .shell,.export-mode .stage{height:auto;position:static;transform:none;width:1600px}.export-mode .slide{opacity:1;page-break-after:always;pointer-events:auto;position:relative;transform:none;visibility:visible}.export-mode .deck-controls,.export-mode .notes{display:none}@media(prefers-reduced-motion:reduce){.slide{transition:none}}@media(max-width:760px){.app{padding:10px}.deck-controls{flex-wrap:wrap;justify-content:center}.notes{bottom:100px;left:12px;right:12px}}@media print{@page{margin:0;size:13.333in 7.5in}body{background:#fff;overflow:visible}.app{display:block;height:auto;padding:0}.shell,.stage{height:auto;position:static;transform:none;width:1600px}.slide{opacity:1;page-break-after:always;pointer-events:auto;position:relative;transform:none;visibility:visible}.deck-controls,.notes{display:none}}
`;

const dataCss = `
.slide-footer span:nth-child(2){max-width:760px;text-align:center;white-space:normal}.chart-layout{margin-top:38px}.chart-layout svg{display:block;height:470px;width:100%}.chart-legend{display:flex;gap:28px;margin-top:-34px;padding-left:82px}.chart-legend span{align-items:center;color:var(--muted);display:flex;font-size:14px;gap:10px}.chart-legend i{display:inline-block;height:10px;width:28px}.chart-insight,.table-insight{border-top:2px solid var(--decision);font-size:19px;font-weight:700;margin-top:28px;padding-top:18px}.data-table{border-collapse:collapse;font-size:18px;margin-top:52px;width:100%}.data-table th{border-bottom:2px solid var(--ink);color:var(--muted);font-size:13px;letter-spacing:.08em;padding:0 20px 16px;text-align:left}.data-table td{border-bottom:1px solid var(--line);padding:22px 20px}.data-table td:last-child{color:var(--system);font-size:14px;font-weight:700}.slide-title{padding-bottom:6px}.cover-rail p{padding-bottom:4px}
.notes button{background:var(--ink);border-color:var(--ink);color:#fff;margin-bottom:12px}.metrics{grid-template-columns:repeat(4,1fr)}.metric:nth-child(4){background:var(--ink);border-color:var(--ink);color:#fff}.metric:nth-child(4) b,.metric:nth-child(4) small,.metric:nth-child(4) span,.metric:nth-child(4) strong{color:#fff}
.edge{stroke-linecap:round;stroke-linejoin:round;stroke-width:2;opacity:.72}.edge--decision{stroke-width:2.25;opacity:.78}.flow-arrow{flex:0 0 44px;font-size:0;position:relative}.flow-arrow:before{background:var(--line);content:"";height:1px;width:24px}.flow-arrow:after{border-right:1px solid var(--muted);border-top:1px solid var(--muted);content:"";height:6px;margin-left:-7px;transform:rotate(45deg);width:6px}
.stage,.slide{background:#fcfbf8}.metric:nth-child(2){background:#e5eef7;border-color:#d3e0ec;color:var(--ink)}.metric:nth-child(2) strong,.metric:nth-child(2) small{color:#315f88}.metric:nth-child(2) span{color:var(--muted)}.metric:nth-child(4){background:#e7efe5;border-color:#d5e2d1;color:var(--ink)}.metric:nth-child(4) strong,.metric:nth-child(4) small{color:#476b4d}.metric:nth-child(4) span{color:var(--muted)}.responsibility{display:grid;gap:18px;grid-template-columns:repeat(5,minmax(0,1fr))}.responsibility-step{min-height:270px;padding:30px 24px}.responsibility-step--model{background:#e5eef7;border-color:#d3e0ec;color:var(--ink)}.responsibility-step--human{background:#eceef2;border-color:#d9dde4;color:var(--ink)}.responsibility-step--model strong{color:#315f88}.responsibility-step--human strong{color:#4b5563}.responsibility-step p{font-size:18px;font-weight:550;line-height:1.35;margin-top:24px}.responsibility-step--model small,.responsibility-step--human small,.risk--dark small,.evidence-group--dark small{color:#315f88}.flow-arrow{display:none}.authority{background:#f4efe7;border:0;color:#74453b;font-size:17px;font-weight:650;margin-top:28px;padding:22px 26px}.risk--dark{background:#e8eef3;border-color:#d7e1e8;color:var(--ink)}.risk--dark dt{color:#735d4d}.risk--dark dd{color:var(--muted)}.stop{background:#f4efe7;border:0;color:#74453b;font-size:17px;font-weight:650;margin-top:26px;padding:18px 24px}.evidence-group--dark{background:#e8eef3;border-color:#d7e1e8;color:var(--ink)}.evidence-group--dark ul{color:var(--muted)}
@media(max-width:760px){
html,body{height:100%;overflow:hidden}body{background:#f3f4f6}.app{display:grid;grid-template-rows:minmax(0,1fr) auto;height:100svh;min-height:0;padding:8px}.shell{height:calc(100svh - 118px);max-width:100%;width:100%}.stage{box-shadow:none;height:100%;overflow:hidden;position:relative;transform:none;width:100%}.slide{display:block;height:100%;overflow-x:hidden;overflow-y:auto;padding:28px 20px 74px;transform:none!important;width:100%}.slide-title{font-size:30px;line-height:1.12;max-width:none}.slide-footer{display:grid;gap:8px;left:auto;margin-top:32px;padding-top:12px;position:static;right:auto}.slide-footer span:nth-child(2){max-width:none;text-align:left}.slide--cover{display:grid;grid-template-columns:1fr;grid-template-rows:auto auto;padding:0}.cover-main{justify-content:flex-start;min-height:560px;padding:62px 34px 44px}.cover-main:before{height:360px;left:18px;top:88px;width:4px}.wordmark{font-size:14px;margin-bottom:70px}.cover-main h1{font-size:44px}.cover-main p{font-size:20px;margin-top:28px}.cover-decision{font-size:14px;margin-top:34px}.cover-rail{padding:34px}.cover-bars{gap:10px;margin-bottom:34px}.cover-bars span{height:16px}.cover-rail>strong{font-size:48px}.cover-rail p{font-size:23px}.cover-rail small{margin-top:34px}.decision-grid,.profile-grid,.metrics,.risks,.evidence-groups{grid-template-columns:1fr;margin-top:26px}.decision-main{min-height:0;padding:30px 26px}.decision-main>strong{margin-bottom:24px}.decision-main h2{font-size:34px}.decision-main ul{font-size:17px;gap:14px;margin-top:28px}.decision-facts{gap:12px}.fact{gap:8px;padding:20px}.fact span{font-size:20px}.metrics{gap:14px}.metric{min-height:0;padding:24px}.metric b{font-size:46px;margin-top:18px}.metric small{margin-top:20px}.outcome{font-size:19px;margin-top:18px;padding:22px}.workflow-map{display:grid;gap:12px;height:auto;margin-top:26px}.workflow-map svg{display:none}.workflow-node{height:auto!important;left:auto!important;min-height:86px;position:static!important;top:auto!important;width:auto!important}.findings{margin-top:26px}.finding{gap:10px 16px;grid-template-columns:40px 1fr;min-height:0;padding:22px 0}.finding>span:first-child{grid-column:1;grid-row:1 / span 3}.finding h2,.finding p,.finding small{grid-column:2}.finding h2{font-size:21px}.finding p{font-size:17px}.responsibility{display:grid;gap:12px;grid-template-columns:1fr;margin-top:28px}.responsibility-step{min-height:0;padding:24px}.responsibility-step p{font-size:20px;margin-top:18px}.flow-arrow{display:none}.authority{font-size:16px;margin-top:20px;padding:20px}.evaluation,.data-table{font-size:14px;margin-top:26px;table-layout:fixed}.evaluation th,.data-table th{font-size:12px;padding:0 6px 10px}.evaluation td,.data-table td{overflow-wrap:anywhere;padding:10px 6px;vertical-align:top}.evaluation th:nth-child(4),.evaluation td:nth-child(4),.data-table th:nth-child(4),.data-table td:nth-child(4){display:none}.release,.table-insight{font-size:16px;margin-top:20px}.risks{gap:14px}.risk{min-height:0;padding:26px}.risk h2{font-size:24px}.risk dl{grid-template-columns:82px 1fr;margin-top:24px}.risk dd{font-size:16px}.stop{font-size:16px;margin-top:22px}.timeline-decision{margin-top:26px;padding:22px;width:auto}.timeline{gap:16px;grid-template-columns:1fr;margin-top:28px}.milestone{border-left:3px solid var(--line);padding:4px 0 20px 24px;text-align:left}.milestone:not(:last-child):after{display:none}.milestone>span{height:38px;width:38px}.milestone strong{margin-top:14px}.evidence-groups{gap:18px}.evidence-group{padding-top:18px}.evidence-group--dark{padding:24px}.controls{flex-wrap:wrap;gap:12px;margin-top:22px}.deck-controls{gap:8px;justify-content:center;margin-top:8px;width:100%}.deck-controls button{min-height:44px;padding:0 12px}.progress{flex-basis:120px}.notes{bottom:112px;max-height:60svh;overflow:auto}
}
`;

const js = `
const slides=[...document.querySelectorAll(".slide")];const app=document.querySelector("#app");const notes=document.querySelector("#notes");const notesText=document.querySelector("#notes-text");const error=document.querySelector("#error");const params=new URLSearchParams(location.search);const exportMode=params.has("export");const faultMode=params.get("fault");let current=0,touch=null;
function scale(){if(exportMode)return;if(innerWidth<=760){document.documentElement.style.setProperty("--scale","1");return}const value=Math.min((innerWidth-48)/1600,(innerHeight-78)/900);document.documentElement.style.setProperty("--scale",String(Math.max(.1,value)))}
function show(index,hash=true){current=Math.max(0,Math.min(index,slides.length-1));slides.forEach((slide,i)=>{slide.classList.toggle("is-active",i===current);slide.classList.toggle("is-before",i<current);slide.setAttribute("aria-hidden",i===current?"false":"true")});slides[current].scrollTop=0;document.querySelector("#current").textContent=current+1;document.querySelector("#total").textContent=slides.length;document.querySelector("#bar").style.transform="scaleX("+((current+1)/slides.length)+")";notesText.textContent=slides[current].dataset.pptxNotes||"";document.querySelector("#status").textContent="Slide "+(current+1)+" of "+slides.length+": "+slides[current].getAttribute("aria-label");if(hash)history.replaceState(null,"","#slide="+(current+1))}
function notesToggle(){notes.hidden=!notes.hidden}async function fullscreen(){document.fullscreenElement?await document.exitFullscreen():await app.requestFullscreen()}
function initial(){const value=Number.parseInt(new URLSearchParams(location.hash.slice(1)).get("slide"),10);return Number.isInteger(value)?value-1:0}
window.__fdeReadoutQa=()=>slides.flatMap((slide,slideIndex)=>{const bounds=slide.getBoundingClientRect();const mobile=innerWidth<=760;return[...slide.querySelectorAll("h1,h2,h3,p,li,td,th,.slide-footer span,.workflow-node,.fact,.metric,.finding,.responsibility-step,.risk,.evidence-group")].flatMap(element=>{const rect=element.getBoundingClientRect();if(rect.width===0||rect.height===0)return[];const problems=[];if(rect.left<bounds.left-2||rect.right>bounds.right+2||(!mobile&&(rect.top<bounds.top-2||rect.bottom>bounds.bottom+2)))problems.push({slide:slideIndex+1,type:"out-of-bounds",element:element.className||element.tagName});if(element.scrollWidth>element.clientWidth+2||(!mobile&&element.scrollHeight>element.clientHeight+2))problems.push({slide:slideIndex+1,type:"overflow",element:element.className||element.tagName});return problems})});
function validate(){const plan=JSON.parse(document.querySelector("#readout-plan").textContent);const required=Number(app.dataset.requiredSlideCount);if(!app.dataset.planHash)throw new Error("Missing frozen plan hash.");if(plan.slides.length!==required||slides.length!==required)throw new Error("ReadoutPlan and rendered slide counts do not match.");if(faultMode==="init")throw new Error("Injected initialization fault.")}
try{validate();if(exportMode){document.body.classList.add("export-mode");slides.forEach(slide=>slide.setAttribute("aria-hidden","false"))}else{document.querySelector("#prev").onclick=()=>show(current-1);document.querySelector("#next").onclick=()=>show(current+1);document.querySelector("#notes-button").onclick=notesToggle;document.querySelector("#fullscreen").onclick=fullscreen;document.querySelector("#close-notes").onclick=notesToggle;addEventListener("keydown",event=>{if(["ArrowRight","PageDown"," "].includes(event.key)){event.preventDefault();show(current+1)}else if(["ArrowLeft","PageUp"].includes(event.key)){event.preventDefault();show(current-1)}else if(event.key==="Home")show(0);else if(event.key==="End")show(slides.length-1);else if(event.key.toLowerCase()==="f")fullscreen();else if(event.key.toLowerCase()==="n")notesToggle()});document.querySelector("#stage").addEventListener("touchstart",event=>touch=event.changedTouches[0]?.clientX??null);document.querySelector("#stage").addEventListener("touchend",event=>{if(touch===null)return;const delta=(event.changedTouches[0]?.clientX??touch)-touch;if(Math.abs(delta)>60)show(current+(delta<0?1:-1));touch=null});addEventListener("resize",scale);addEventListener("hashchange",()=>show(initial(),false));scale();show(initial(),false)}document.querySelector("#loading").hidden=true;document.body.dataset.ready="true"}catch(problem){document.querySelector("#loading").hidden=true;error.hidden=false;document.querySelector("#error-text").textContent=problem.message;document.body.dataset.ready="error";console.error(problem)}
`;

const embeddedPlan = JSON.stringify(plan).replaceAll("<", "\\u003c");
const html = `<!doctype html>
<!-- Generated by fde-readout from ReadoutPlan ${escapeHtml(plan.version)} (${planHash}). -->
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
  <title>${escapeHtml(plan.title)}</title>
  <link rel="icon" type="image/png" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="/>
  <style>${css}${dataCss}</style>
</head>
<body>
  <div id="app" class="app" data-plan-version="${escapeAttribute(plan.version)}" data-plan-hash="${planHash}" data-required-slide-count="${plan.slides.length}">
    <div id="status" class="sr-only" aria-live="polite"></div>
    <div class="shell"><main id="stage" class="stage" tabindex="0" aria-label="${escapeAttribute(plan.title)}">${plan.slides.map(renderSlide).join("")}</main></div>
    <nav class="deck-controls" aria-label="Presentation controls">
      <button id="prev" type="button" aria-label="Previous slide">&larr;</button>
      <span class="deck-position"><span id="current">1</span> / <span id="total">${plan.slides.length}</span></span>
      <span class="progress" aria-hidden="true"><span id="bar"></span></span>
      <button id="notes-button" type="button">Notes</button>
      <button id="fullscreen" type="button">Fullscreen</button>
      <button id="next" type="button" aria-label="Next slide">&rarr;</button>
    </nav>
    <aside id="notes" class="notes" hidden><button id="close-notes" type="button">Close</button><p id="notes-text"></p></aside>
    <div id="loading" class="message">Initializing presentation...</div>
    <div id="error" class="message message--error" hidden><strong>Presentation initialization failed.</strong><p id="error-text"></p></div>
    <script type="application/json" id="readout-plan">${embeddedPlan}</script>
  </div>
  <script>${js}</script>
</body>
</html>`.replace(/[ \t]+$/gm, "");

await mkdir(target, { recursive: true });
await writeFile(join(target, "index.html"), html);
console.log(`Wrote ${join(target, "index.html")}`);
console.log(`ReadoutPlan SHA-256: ${planHash}`);
