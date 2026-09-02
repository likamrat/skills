#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileReadoutPlan } from "./powerpoint-layout.mjs";

const skillRoot = fileURLToPath(new URL("..", import.meta.url));
const scripts = join(skillRoot, "scripts");
const worker = join(scripts, "render-powerpoint-worker.ps1");
const skeletonHelper = join(scripts, "create-powerpoint-skeleton.ps1");
const specCompiler = join(scripts, "render-powerpoint-spec.mjs");
const examplePlan = join(
  skillRoot,
  "assets",
  "examples",
  "lattice-harbor-readout-plan.json",
);
const failures = [];
const nativeRequested = process.argv.includes("--native");
const nativeUnderMutex = process.argv.includes("--native-under-test-mutex");
const workerSource = await readFile(worker, "utf8");

function check(condition, message) {
  if (!condition) failures.push(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function tablePlanSlide() {
  return {
    id: "native-worker-table",
    family: "table",
    title: "Native worker table",
    customerSafe: true,
    notes: "Fictional table source. Sources: [baseline-001], [eval-001].",
    evidenceIds: ["baseline-001", "eval-001"],
    judgmentIds: ["judgment-rationale-001"],
    content: {
      columns: ["Cohort", "Owner", "Result"],
      rows: [
        {
          cells: ["Priority", "Operations", "pass"],
          evidenceIds: ["baseline-001"],
        },
        {
          cells: ["Escalation", "Review", "escalate"],
          evidenceIds: ["eval-001"],
        },
        {
          cells: ["Blocked", "Engineering", "fail"],
          evidenceIds: ["baseline-001", "eval-001"],
        },
      ],
      insight: {
        statement: "The editable table keeps ownership and outcomes explicit.",
        evidenceIds: ["baseline-001"],
      },
    },
  };
}

function evidencePlanSlide() {
  return {
    id: "native-worker-evidence",
    family: "evidence",
    title: "Fixture evidence remains explicit",
    customerSafe: true,
    notes: "Fictional fixture evidence register.",
    evidenceIds: ["baseline-001", "eval-001", "workflow-001"],
    judgmentIds: ["judgment-rationale-001"],
    content: {
      groups: [
        {
          label: "Table fixture",
          items: ["Editable table source", "Workflow observation source"],
          evidenceIds: ["baseline-001", "workflow-001"],
        },
        {
          label: "Evaluation fixture",
          items: ["Editable evaluation source"],
          evidenceIds: ["eval-001"],
        },
      ],
      controls: ["Fictional fixture data"],
    },
  };
}

function tableFixturePlan(sourcePlan) {
  sourcePlan.slides = [
    sourcePlan.slides.find((slide) => slide.family === "cover"),
    sourcePlan.slides.find((slide) => slide.family === "decision"),
    tablePlanSlide(),
    sourcePlan.slides.find((slide) => slide.family === "evaluation"),
    evidencePlanSlide(),
  ];
  const unusedEvidence = new Set([
    "assignment-002",
    "assignment-003",
  ]);
  sourcePlan.evidence = sourcePlan.evidence.filter(
    (entry) => !unusedEvidence.has(entry.id),
  );
  sourcePlan.humanContext = sourcePlan.humanContext.filter(
    (entry) => entry.id !== "judgment-failed-attempt-001",
  );
  return sourcePlan;
}

function functionSource(name, nextName) {
  const start = workerSource.indexOf(`function ${name} {`);
  const end = workerSource.indexOf(`\nfunction ${nextName} {`, start);
  return start >= 0 && end > start ? workerSource.slice(start, end) : "";
}

const authorSource = functionSource(
  "Add-TablePrimitive",
  "Assert-WithinTableTolerance",
);
const geometrySource = functionSource(
  "Set-NativeTableGeometry",
  "Assert-TableCellTextFits",
);
const measurementSource = functionSource(
  "Assert-TableCellTextFits",
  "Add-TablePrimitive",
);
const verificationSource = functionSource(
  "Assert-TablePrimitive",
  "Assert-NativeTables",
);
const mutationSource = functionSource(
  "Invoke-TestTableMutation",
  "Get-NativeNotesText",
);

for (const [name, pattern] of [
  ["table authoring function", /function Add-TablePrimitive/],
  ["native AddTable creation", /\.AddTable\(/],
  ["exact table shape name", /\$shape\.Name = \[string\]\$Primitive\.name/],
  ["table object capture", /\$table = \$shape\.Table/],
  ["table rows capture", /\$tableRows = \$table\.Rows/],
  ["table columns capture", /\$tableColumns = \$table\.Columns/],
  ["table cell capture", /\$cell = \$table\.Cell\(/],
  ["table cell shape capture", /\$cellShape = \$cell\.Shape/],
  ["legacy table text frame", /\$textFrame = \$cellShape\.TextFrame/],
  ["table text range capture", /\$textRange = \$textFrame\.TextRange/],
  ["table font capture", /\$font = \$textRange\.Font/],
  ["table fill capture", /\$cellFill = \$cellShape\.Fill/],
  ["cell border collection", /\$borders = \$cell\.Borders/],
  ["cell border item access", /\$borderLine = \$borders\.Item\(\$borderType\)/],
  ["table authoring failpoint", /Invoke-TestFailpoint -Stage 'table'/],
  ["table preflight", /Assert-TablePrimitiveSpec/],
  ["reopened table verification", /Assert-NativeTables/],
  ["two-point geometry tolerance", /Abs\(\$Actual - \$Expected\) -gt 2/],
  ["table-cell bound height", /measureRange\.BoundHeight/],
  ["table-cell bound width", /measureRange\.BoundWidth/],
  ["table-cell overflow failure", /Table-cell overflow/],
  ["table report count", /nativeTableCount/],
  ["table cell report count", /nativeTableCellCount/],
  ["table verification mutation hook", /FDE_POWERPOINT_TEST_MUTATE_TABLE_BEFORE_VERIFY/],
  ["integrated table worker receipt version", /fde-powerpoint-tables-connectors\/1\.0/],
]) {
  check(pattern.test(workerSource), `worker omits ${name}`);
}

check(
  !/\$textFrame\.(?:AutoSize|WordWrap)\s*=/.test(authorSource),
  "table authoring must not set unsupported table-cell AutoSize or WordWrap",
);
check(
  authorSource.indexOf("Assert-TableCellTextFits `") <
    authorSource.indexOf("$textRange.Text = $cellText"),
  "table authoring must measure text before assigning it to a table cell",
);
check(
  (
    authorSource.match(
      /Set-NativeTableGeometry -Shape \$shape -Table \$table -Primitive \$Primitive/g,
    ) ?? []
  ).length === 2,
  "table authoring must apply exact geometry before and after cell population",
);
for (const [name, pattern] of [
  ["shape left", /\$Shape\.Left = \[single\]\$Primitive\.x/g],
  ["shape top", /\$Shape\.Top = \[single\]\$Primitive\.y/g],
  ["shape width", /\$Shape\.Width = \[single\]\$Primitive\.w/],
  ["shape height", /\$Shape\.Height = \[single\]\$Primitive\.h/],
  ["column width", /\$tableColumn\.Width = \[single\]\$Primitive\.columnWidths/],
  ["row height", /\$tableRow\.Height = \[single\]\$Primitive\.rowHeights/],
]) {
  check(pattern.test(geometrySource), `table geometry reset omits ${name}`);
}
check(
  (geometrySource.match(/\$Shape\.Left =/g) ?? []).length === 2 &&
    (geometrySource.match(/\$Shape\.Top =/g) ?? []).length === 2,
  "table geometry reset must restore exact position after row and column sizing",
);
for (const label of [
  "table geometry rows collection",
  "table geometry row",
  "table geometry columns collection",
  "table geometry column",
]) {
  check(
    geometrySource.includes(`-Label '${label}'`),
    `table geometry reset omits explicit ${label} release`,
  );
}

for (const [name, pattern] of [
  ["ordinary text box creation", /\$Shapes\.AddTextbox\(/],
  ["exact intended cell width", /\$Primitive\.columnWidths\[\$ColumnIndex - 1\]/],
  ["exact intended cell height", /\$Primitive\.rowHeights\[\$RowIndex - 1\]/],
  ["legacy measurement autosize", /\$measureLegacyFrame\.AutoSize = 0/],
  ["legacy measurement wrap", /\$measureLegacyFrame\.WordWrap = -1/],
  ["measurement left margin", /\$measureFrame2\.MarginLeft = \[single\]\$Primitive\.cellMargin/],
  ["measurement right margin", /\$measureFrame2\.MarginRight = \[single\]\$Primitive\.cellMargin/],
  ["measurement top margin", /\$measureFrame2\.MarginTop = \[single\]\$Primitive\.cellMargin/],
  ["measurement bottom margin", /\$measureFrame2\.MarginBottom = \[single\]\$Primitive\.cellMargin/],
  ["measurement wrap", /\$measureFrame2\.WordWrap = -1/],
  ["measurement autosize", /\$measureFrame2\.AutoSize = 0/],
  ["measurement font family", /\$measureFont2\.Name = \[string\]\$Theme\.fontFamily/],
  ["measurement font size", /\$measureFont2\.Size = \$fontSize/],
  ["measurement bold", /\$measureFont2\.Bold = if \(\$IsHeader\)/],
  ["measurement alignment", /\$measureParagraph\.Alignment = 1/],
  ["measurement bound height", /\$measureRange2\.BoundHeight/],
  ["measurement bound width", /\$measureRange2\.BoundWidth/],
  ["measurement two-point tolerance", /\(\[double\]\$Primitive\.cellMargin \* 2\) \+\s+2/],
  ["measurement overflow error", /Table-cell overflow/],
  ["temporary shape delete", /\$measureShape\.Delete\(\)/],
]) {
  check(pattern.test(measurementSource), `table measurement omits ${name}`);
}
for (const label of [
  "table measurement paragraph format",
  "table measurement font",
  "table measurement text range",
  "table measurement text frame 2",
  "table measurement legacy text frame",
  "table measurement shape fill",
  "table measurement shape line",
  "table measurement shape",
]) {
  check(
    measurementSource.includes(`-Label '${label}'`),
    `table measurement omits explicit ${label} release`,
  );
}
check(
  measurementSource.indexOf("$measureShape.Delete()") <
    measurementSource.indexOf(
      "Release-ComRef -Reference ([ref]$measureShape) -Label 'table measurement shape'",
    ),
  "temporary measurement shape must be deleted before its RCW is released",
);

for (const [name, pattern] of [
  ["Cell.Shape.Line borders", /Cell\.Shape\.Line/i],
  ["cellShape.Line borders", /\$cellShape\.Line/i],
  ["table TextFrame2 WordWrap", /TextFrame2[\s\S]{0,200}WordWrap/i],
  ["table TextFrame2 AutoSize", /TextFrame2[\s\S]{0,200}AutoSize/i],
  ["root Application release", /Release-ComRef[^\r\n]*\$powerPoint/i],
  ["FinalReleaseComObject", /FinalReleaseComObject/i],
]) {
  check(!pattern.test(authorSource), `table authoring uses forbidden ${name}`);
  check(!pattern.test(verificationSource), `table verification uses forbidden ${name}`);
}

for (const label of [
  "native table shape",
  "native table",
  "table cell",
  "table cell shape",
  "table cell text frame",
  "table cell text range",
  "table cell font",
  "table cell fill",
  "table cell border line",
  "table cell border color",
  "table cell borders collection",
]) {
  check(
    authorSource.includes(`-Label '${label}'`),
    `table authoring omits explicit ${label} release`,
  );
}

check(
  !/\$measureFrame\.(?:WordWrap|AutoSize)/.test(verificationSource),
  "table verification must not read rejected TextFrame2 WordWrap/AutoSize properties",
);
check(
  /FDE_POWERPOINT_TEST_FAILPOINTS[\s\S]*FDE_POWERPOINT_TEST_MUTATE_TABLE_BEFORE_VERIFY/.test(
    mutationSource,
  ),
  "table mutation hook must be failpoint-gated",
);

const preflightIndex = workerSource.indexOf("Assert-TablePrimitiveSpec `");
const mutexIndex = workerSource.indexOf(
  "$script:workerMutexHeld = $script:workerMutex.WaitOne",
);
const codeOnlyIndex = workerSource.indexOf(
  "$env:FDE_POWERPOINT_CODE_ONLY -eq '1'",
);
const activationIndex = workerSource.indexOf(
  "$powerPoint = New-Object -ComObject PowerPoint.Application",
);
check(
  preflightIndex >= 0 &&
    codeOnlyIndex > preflightIndex &&
    codeOnlyIndex < mutexIndex &&
    preflightIndex < mutexIndex &&
    preflightIndex < activationIndex,
  "malformed table specs and the code-only guard must run before mutex acquisition and COM activation",
);

const powershellProbe = spawnSync(
  "powershell",
  ["-NoProfile", "-Command", "exit 0"],
  {
    encoding: "utf8",
    env: { ...process.env, FDE_POWERPOINT_CODE_ONLY: "1" },
  },
);
const hasWindowsPowerShell =
  !powershellProbe.error && powershellProbe.status === 0;
const parser = hasWindowsPowerShell
  ? spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${worker.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors); if($errors.Count){$errors | ForEach-Object {$_.ToString()}; exit 1}`,
      ],
      { encoding: "utf8" },
    )
  : null;
if (parser) {
  check(
    parser.status === 0,
    `PowerPoint table worker does not parse: ${parser.stdout}${parser.stderr}`,
  );
}

if (hasWindowsPowerShell) {
  const malformedTemp = await mkdtemp(
    join(tmpdir(), "fde-pptx-worker-table-preflight-"),
  );
  try {
    const rawPlan = await readFile(examplePlan, "utf8");
    const sourcePlan = tableFixturePlan(JSON.parse(rawPlan));
    const fixturePlanPath = join(malformedTemp, "fixture-plan.json");
    const fixtureSpecPath = join(malformedTemp, "fixture-spec.json");
    await writeFile(fixturePlanPath, JSON.stringify(sourcePlan), "utf8");
    const fixtureCompile = spawnSync(
      process.execPath,
      [
        specCompiler,
        "--plan",
        fixturePlanPath,
        "--mode",
        "full",
        "--output",
        fixtureSpecPath,
      ],
      { encoding: "utf8" },
    );
    check(
      fixtureCompile.status === 0,
      `table fixture plan did not pass public validation: ${fixtureCompile.stderr}`,
    );
    const validSpec = compileReadoutPlan(sourcePlan, {
      sourcePlanSha256: sha256(rawPlan),
      mode: "full",
    });
    const malformedCases = [
      {
        name: "row-width",
        message: /row 1 width does not match the headers/,
        mutate(spec) {
          spec.slides
            .flatMap((slide) => slide.primitives)
            .find((primitive) => primitive.kind === "table")
            .rows[0].pop();
        },
      },
      {
        name: "boolean-margin",
        message: /table cell margin must be a number/,
        mutate(spec) {
          spec.slides
            .flatMap((slide) => slide.primitives)
            .find((primitive) => primitive.kind === "table").cellMargin = true;
        },
      },
      {
        name: "fractional-font",
        message: /Table line, margin, or font contract is invalid/,
        mutate(spec) {
          spec.slides
            .flatMap((slide) => slide.primitives)
            .find((primitive) => primitive.kind === "table").headerFontSize =
            8.4;
        },
      },
      {
        name: "numeric-header",
        message: /Table header 1 must be a string/,
        mutate(spec) {
          spec.slides
            .flatMap((slide) => slide.primitives)
            .find((primitive) => primitive.kind === "table").headers[0] = 42;
        },
      },
      {
        name: "scalar-row-evidence",
        message: /Table row 1 evidence IDs must be an array/,
        mutate(spec) {
          const table = spec.slides
            .flatMap((slide) => slide.primitives)
            .find((primitive) => primitive.kind === "table");
          table.rowEvidenceIds[0] = table.rowEvidenceIds[0][0];
        },
      },
      {
        name: "fractional-z",
        message: /Table primitive z must be a positive integer/,
        mutate(spec) {
          spec.slides
            .flatMap((slide) => slide.primitives)
            .find((primitive) => primitive.kind === "table").z = 1.5;
        },
      },
    ];
    const skeletonPath = join(malformedTemp, "not-opened.pptx");
    await writeFile(skeletonPath, "preflight-only", "utf8");
    for (const malformedCase of malformedCases) {
      const malformed = structuredClone(validSpec);
      malformedCase.mutate(malformed);
      const specPath = join(malformedTemp, `${malformedCase.name}.json`);
      const outputPath = join(malformedTemp, `${malformedCase.name}-bundle`);
      await writeFile(specPath, JSON.stringify(malformed), "utf8");
      const specBytes = await readFile(specPath);
      const result = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          worker,
          "-Spec",
          specPath,
          "-ExpectedSpecSha256",
          sha256(specBytes),
          "-Skeleton",
          skeletonPath,
          "-OutputDirectory",
          outputPath,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, FDE_POWERPOINT_CODE_ONLY: "1" },
        },
      );
      check(
        result.status !== 0 &&
          malformedCase.message.test(result.stderr) &&
          !(await pathExists(outputPath)),
        `${malformedCase.name} table preflight did not fail before COM: ${result.stdout}${result.stderr}`,
      );
    }
  } finally {
    await rm(malformedTemp, { recursive: true, force: true });
  }
}

if (nativeRequested && !nativeUnderMutex) {
  if (failures.length > 0) {
    console.error("PowerPoint table worker static tests failed:");
    failures.forEach((failure, index) =>
      console.error(`${index + 1}. ${failure}`),
    );
    process.exit(1);
  }
  const command = [
    "$mutex = [Threading.Mutex]::new($false, 'Local\\FdeReadoutPowerPointWorkerNativeTest')",
    "$held = $false",
    "$childStatus = 1",
    "try {",
    "  try { $held = $mutex.WaitOne([TimeSpan]::FromSeconds(30)) } catch [Threading.AbandonedMutexException] { $held = $true }",
    "  if (-not $held) { throw 'Timed out waiting for the native worker test mutex.' }",
    `  & '${process.execPath.replaceAll("'", "''")}' '${fileURLToPath(import.meta.url).replaceAll("'", "''")}' --native --native-under-test-mutex`,
    "  $childStatus = $LASTEXITCODE",
    "}",
    "finally {",
    "  if ($held) { $mutex.ReleaseMutex() }",
    "  $mutex.Dispose()",
    "}",
    "exit $childStatus",
  ].join("\n");
  const native = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8" },
  );
  process.stdout.write(native.stdout);
  process.stderr.write(native.stderr);
  process.exit(native.status ?? 1);
}

if (!nativeRequested) {
  if (failures.length > 0) {
    console.error("PowerPoint table worker static tests failed:");
    failures.forEach((failure, index) =>
      console.error(`${index + 1}. ${failure}`),
    );
    process.exit(1);
  }
  console.log("PowerPoint table worker static tests passed.");
  process.exit(0);
}

if (!hasWindowsPowerShell) {
  failures.push("native table suite requires Windows PowerShell on Windows");
}

function runPowerShell(file, args, extraEnv = {}) {
  return spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      file,
      ...args,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ...extraEnv },
    },
  );
}

function powerPointProcesses() {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "@(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id)|$($_.StartTime.ToUniversalTime().ToString('o'))\" }) -join \"`n\"",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`could not inspect PowerPoint processes: ${result.stderr}`);
  }
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}

function cleanupReceipt(output) {
  return /PowerPoint cleanup: PID \d+ start [^ ]+ exited via (?:graceful|forced)\./.test(
    output,
  );
}

async function pathExists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

const availability = spawnSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    "[bool][type]::GetTypeFromProgID('PowerPoint.Application')",
  ],
  { encoding: "utf8" },
);
if (availability.status !== 0 || availability.stdout.trim() !== "True") {
  failures.push("native table suite requires Microsoft PowerPoint");
}
if (powerPointProcesses().length > 0) {
  failures.push("native table suite requires a zero PowerPoint process baseline");
}

if (failures.length === 0) {
  const temp = await mkdtemp(join(tmpdir(), "fde-pptx-worker-tables-"));
  try {
    const sourcePlan = tableFixturePlan(
      JSON.parse(await readFile(examplePlan, "utf8")),
    );
    const planPath = join(temp, "plan.json");
    const specPath = join(temp, "spec.json");
    const skeletonPath = join(temp, "skeleton.pptx");
    const bundlePath = join(temp, "worker-bundle");
    await writeFile(planPath, JSON.stringify(sourcePlan), "utf8");

    const compile = spawnSync(
      process.execPath,
      [
        specCompiler,
        "--plan",
        planPath,
        "--mode",
        "full",
        "--output",
        specPath,
      ],
      { encoding: "utf8" },
    );
    if (compile.status !== 0) {
      failures.push(`table spec compilation failed: ${compile.stderr}`);
    }
    if (failures.length === 0) {
      const skeleton = runPowerShell(skeletonHelper, [
        "-Plan",
        planPath,
        "-Output",
        skeletonPath,
      ]);
      if (skeleton.status !== 0) {
        failures.push(`table skeleton creation failed: ${skeleton.stderr}`);
      }
    }

    if (failures.length === 0) {
      const specBytes = await readFile(specPath);
      const expectedSha256 = sha256(specBytes);
      const result = runPowerShell(worker, [
        "-Spec",
        specPath,
        "-ExpectedSpecSha256",
        expectedSha256,
        "-Skeleton",
        skeletonPath,
        "-OutputDirectory",
        bundlePath,
      ]);
      if (result.status !== 0) {
        failures.push(`native table worker failed: ${result.stdout}${result.stderr}`);
      } else {
        const report = JSON.parse(result.stdout);
        const tableSlides = report.slides.filter(
          (slide) => slide.nativeTableCount === 1,
        );
        check(
          report.status === "WORKER_PASS" &&
            report.worker === "fde-powerpoint-tables-connectors/1.0" &&
            report.cleanup?.exited === true &&
            tableSlides.length === 2 &&
            tableSlides.every(
              (slide) =>
                slide.nativeTableCellCount > 0 && slide.overflow === false,
            ),
          `native table report is invalid: ${result.stdout}`,
        );
        const persistedReport = JSON.parse(
          await readFile(join(bundlePath, "worker-report.json"), "utf8"),
        );
        check(
          JSON.stringify(report) === JSON.stringify(persistedReport),
          "stdout and persisted cleanup-bound reports differ",
        );
      }
      check(
        powerPointProcesses().length === 0,
        "successful native table worker left a PowerPoint process",
      );

      const spec = JSON.parse(specBytes);
      const tablePrimitive = spec.slides
        .flatMap((slide) => slide.primitives)
        .find((primitive) => primitive.kind === "table");

      const malformed = structuredClone(spec);
      malformed.slides
        .flatMap((slide) => slide.primitives)
        .find((primitive) => primitive.kind === "table")
        .rows[0].pop();
      const malformedPath = join(temp, "malformed-table.json");
      const malformedBundle = join(temp, "malformed-table-bundle");
      await writeFile(malformedPath, JSON.stringify(malformed), "utf8");
      const malformedResult = runPowerShell(worker, [
        "-Spec",
        malformedPath,
        "-ExpectedSpecSha256",
        sha256(await readFile(malformedPath)),
        "-Skeleton",
        skeletonPath,
        "-OutputDirectory",
        malformedBundle,
      ]);
      check(
        malformedResult.status !== 0 &&
          /row 1 width does not match the headers/.test(malformedResult.stderr) &&
          !(await pathExists(malformedBundle)) &&
          powerPointProcesses().length === 0,
        `malformed table did not fail before COM activation: ${malformedResult.stdout}${malformedResult.stderr}`,
      );

      const failpointBundle = join(temp, "fail-table-bundle");
      const failpointResult = runPowerShell(
        worker,
        [
          "-Spec",
          specPath,
          "-ExpectedSpecSha256",
          expectedSha256,
          "-Skeleton",
          skeletonPath,
          "-OutputDirectory",
          failpointBundle,
          "-FailAfter",
          "table",
        ],
        { FDE_POWERPOINT_TEST_FAILPOINTS: "1" },
      );
      const failpointOutput = `${failpointResult.stdout}${failpointResult.stderr}`;
      check(
        failpointResult.status !== 0 &&
          /Test failpoint after table/.test(failpointOutput) &&
          cleanupReceipt(failpointOutput) &&
          !(await pathExists(failpointBundle)) &&
          powerPointProcesses().length === 0,
        `table failpoint did not clean up: ${failpointOutput}`,
      );

      const mutationBundle = join(temp, "mutated-table-bundle");
      const mutationResult = runPowerShell(
        worker,
        [
          "-Spec",
          specPath,
          "-ExpectedSpecSha256",
          expectedSha256,
          "-Skeleton",
          skeletonPath,
          "-OutputDirectory",
          mutationBundle,
        ],
        {
          FDE_POWERPOINT_TEST_FAILPOINTS: "1",
          FDE_POWERPOINT_TEST_MUTATE_TABLE_BEFORE_VERIFY: "1",
        },
      );
      const mutationOutput = `${mutationResult.stdout}${mutationResult.stderr}`;
      check(
        mutationResult.status !== 0 &&
          /content changed/.test(mutationOutput) &&
          cleanupReceipt(mutationOutput) &&
          !(await pathExists(mutationBundle)) &&
          powerPointProcesses().length === 0,
        `reopened table mutation was not detected: ${mutationOutput}`,
      );

      const overflow = structuredClone(spec);
      overflow.slides
        .flatMap((slide) => slide.primitives)
        .find((primitive) => primitive.name === tablePrimitive.name)
        .rows[0][0] = "overflow ".repeat(500).trim();
      const overflowPath = join(temp, "overflow-table.json");
      const overflowBundle = join(temp, "overflow-table-bundle");
      await writeFile(overflowPath, JSON.stringify(overflow), "utf8");
      const overflowResult = runPowerShell(worker, [
        "-Spec",
        overflowPath,
        "-ExpectedSpecSha256",
        sha256(await readFile(overflowPath)),
        "-Skeleton",
        skeletonPath,
        "-OutputDirectory",
        overflowBundle,
      ]);
      const overflowOutput = `${overflowResult.stdout}${overflowResult.stderr}`;
      check(
        overflowResult.status !== 0 &&
          /Table-cell overflow/.test(overflowOutput) &&
          cleanupReceipt(overflowOutput) &&
          !(await pathExists(overflowBundle)) &&
          powerPointProcesses().length === 0,
        `table-cell overflow was not cleanup-bound: ${overflowOutput}`,
      );
    }

    const stages = (await readdir(temp)).filter((name) =>
      name.endsWith(".worker-stage"),
    );
    check(stages.length === 0, `native table suite left staging paths: ${stages}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error("PowerPoint table worker tests failed:");
  failures.forEach((failure, index) =>
    console.error(`${index + 1}. ${failure}`),
  );
  process.exit(1);
}

console.log("PowerPoint table worker native tests passed.");
