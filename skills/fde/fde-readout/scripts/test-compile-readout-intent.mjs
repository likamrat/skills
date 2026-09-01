#!/usr/bin/env node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const skillRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const compiler = join(skillRoot, "scripts", "compile-readout-intent.mjs");
const example = JSON.parse(
  await readFile(
    join(skillRoot, "assets", "examples", "lattice-harbor-readout-plan.json"),
    "utf8",
  ),
);
const brandIds = new Set(example.brand.evidenceIds);
const compactSource = {
  evidence: example.evidence.filter((record) => !brandIds.has(record.id)),
  humanContext: example.humanContext,
};
const authorization = {
  evidence: example.evidence.filter((record) => brandIds.has(record.id)),
  brandDefaults: example.brand,
};
const { evidence: _evidence, humanContext: _human, brand, ...normalFields } = example;
const intentBrand = structuredClone(brand);
delete intentBrand.authorized;
delete intentBrand.evidenceIds;
delete intentBrand.styleReference.authorized;
const intent = {
  ...normalFields,
  brand: intentBrand,
  selectedEvidenceIds: compactSource.evidence.map((record) => record.id),
  selectedHumanContextIds: compactSource.humanContext.map((record) => record.id),
};

function run(directory, overrides = {}, output = join(directory, "readout-plan.json")) {
  const inputs = {
    source: structuredClone(overrides.source ?? compactSource),
    authorization: structuredClone(overrides.authorization ?? authorization),
    intent: structuredClone(overrides.intent ?? intent),
  };
  for (const [name, value] of Object.entries(inputs)) {
    writeFileSync(join(directory, `${name}.json`), JSON.stringify(value));
  }
  return {
    result: spawnSync(
      process.execPath,
      [
        compiler,
        "--source",
        join(directory, "source.json"),
        "--authorization",
        join(directory, "authorization.json"),
        "--intent",
        join(directory, "intent.json"),
        "--output",
        output,
      ],
      { encoding: "utf8" },
    ),
    output,
  };
}

const directory = await mkdtemp(join(process.cwd(), ".readout-compiler-test-"));
let failed = false;

async function test(name, execute) {
  try {
    await execute();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL: ${name}\n${error.message}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await test("valid compile preserves source order and exact records", async () => {
    const source = structuredClone(compactSource);
    delete source.evidence[0].sourceId;
    const selected = source.evidence.map((record) => record.id).reverse();
    const testIntent = { ...structuredClone(intent), selectedEvidenceIds: selected };
    const { result, output } = run(directory, { source, intent: testIntent });
    expect(result.status === 0, `${result.stdout}${result.stderr}`);
    const plan = JSON.parse(await readFile(output, "utf8"));
    expect(plan.evidence[0].id === source.evidence[0].id, "source order changed");
    expect(plan.evidence[0].sourceId === source.evidence[0].id, "sourceId not derived");
    expect(plan.evidence[0].class === source.evidence[0].class, "class changed");
    const preserved = plan.evidence.find((record) => record.id === source.evidence[1].id);
    expect(
      JSON.stringify(preserved) === JSON.stringify(source.evidence[1]),
      "supplied evidence fields or sourceId changed",
    );
    expect(
      JSON.stringify(plan.humanContext[0]) === JSON.stringify(source.humanContext[0]),
      "human context fields or sourceId changed",
    );
    expect(!("selectedEvidenceIds" in plan), "selection field leaked");
    expect(JSON.parse(result.stdout).sha256.length === 64, "missing SHA-256");
  });

  await test("materializes evidence required by selected human context", async () => {
    const dependency = compactSource.humanContext[0].evidenceIds[0];
    const testIntent = structuredClone(intent);
    testIntent.selectedEvidenceIds = testIntent.selectedEvidenceIds.filter(
      (id) => id !== dependency,
    );
    const output = join(directory, "human-context-evidence-closure.json");
    const { result } = run(directory, { intent: testIntent }, output);
    expect(result.status === 0, `${result.stdout}${result.stderr}`);
    const plan = JSON.parse(await readFile(output, "utf8"));
    expect(
      plan.evidence.some((record) => record.id === dependency),
      "human-context evidence dependency was not materialized",
    );
    const contextId = compactSource.humanContext[0].id;
    for (const slide of plan.slides.filter((item) =>
      item.judgmentIds.includes(contextId),
    )) {
      expect(
        slide.evidenceIds.includes(dependency),
        `slide ${slide.id} omitted its human-context evidence dependency`,
      );
    }
    expect(
      JSON.parse(result.stdout).selectedEvidenceIds.includes(dependency),
      "compiler summary omitted the materialized dependency",
    );
  });

  for (const [name, mutate, text] of [
    [
      "missing selected ID",
      (data) => data.intent.selectedEvidenceIds.push("missing-record"),
      "references missing ID",
    ],
    [
      "duplicate selected ID",
      (data) => data.intent.selectedEvidenceIds.push(data.intent.selectedEvidenceIds[0]),
      "contains duplicate IDs",
    ],
    [
      "conflicting source records",
      (data) => data.source.evidence.push({ ...data.source.evidence[0], statement: "Conflict" }),
      "duplicate or conflicting ID",
    ],
    [
      "self-authorized brand",
      (data) => {
        data.intent.brand.authorized = true;
      },
      "cannot self-authorize branding",
    ],
    [
      "duplicate brand evidence ID",
      (data) => {
        data.authorization.brandDefaults.evidenceIds.push(
          data.authorization.brandDefaults.evidenceIds[0],
        );
      },
      "brandDefaults.evidenceIds contains duplicate IDs",
    ],
    [
      "invalid family reaches canonical validator",
      (data) => {
        data.intent.slides[2].family = "generic";
      },
      "slides[2].family is invalid",
    ],
    [
      "writing lint failure leaves no output",
      (data) => {
        data.intent.title = "Leverage the workflow";
      },
      "Writing lint failed",
    ],
  ]) {
    await test(name, async () => {
      const data = {
        source: structuredClone(compactSource),
        authorization: structuredClone(authorization),
        intent: structuredClone(intent),
      };
      mutate(data);
      const output = join(directory, `${name.replaceAll(" ", "-")}.json`);
      const { result } = run(directory, data, output);
      expect(result.status !== 0, "compiler unexpectedly succeeded");
      expect(`${result.stdout}${result.stderr}`.includes(text), `${result.stdout}${result.stderr}`);
      try {
        await readFile(output);
        throw new Error("partial output remained");
      } catch (error) {
        if (error.message === "partial output remained" || error.code !== "ENOENT") throw error;
      }
    });
  }

  await test("output boundary rejects outside workspace", async () => {
    const output = join(tmpdir(), `outside-${Date.now()}.json`);
    const { result } = run(directory, {}, output);
    expect(result.status !== 0, "outside output unexpectedly succeeded");
    expect(result.stderr.includes("inside the current workspace"), result.stderr);
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
