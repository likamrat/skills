#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

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
const cliArguments = process.argv.slice(2);
const nativeBaselineOnlyRequested = cliArguments.includes(
  "--native-baseline-only",
);
const nativeRequested =
  cliArguments.includes("--native") || nativeBaselineOnlyRequested;
const nativeUnderMutex = cliArguments.includes("--native-under-test-mutex");
const workerSource = await readFile(worker, "utf8");
const testSource = await readFile(fileURLToPath(import.meta.url), "utf8");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const nativeImplementationStart = testSource.indexOf(
  ["if (nativeRequested", " && !nativeUnderMutex) {"].join(""),
);
const nativeImplementationSource =
  nativeImplementationStart >= 0
    ? testSource.slice(nativeImplementationStart)
    : "";
const nativeMutexWrapperEnd = nativeImplementationSource.indexOf(
  "\nif (!nativeRequested) {",
);
const nativeMutexWrapperSource =
  nativeMutexWrapperEnd > 0
    ? nativeImplementationSource.slice(0, nativeMutexWrapperEnd)
    : "";
const exclusiveBaselineStart = nativeImplementationSource.indexOf(
  "function runExclusiveBaselinePreservationCase(",
);
const exclusiveBaselineEnd = nativeImplementationSource.indexOf(
  "\nlet nativeArtifactDirectory;",
  exclusiveBaselineStart,
);
const exclusiveBaselineSource =
  exclusiveBaselineStart >= 0 && exclusiveBaselineEnd > exclusiveBaselineStart
    ? nativeImplementationSource.slice(
        exclusiveBaselineStart,
        exclusiveBaselineEnd,
      )
    : "";
const runPowerShellStart = nativeImplementationSource.indexOf(
  "function runPowerShell(",
);
const runPowerShellEnd = nativeImplementationSource.indexOf(
  "\nfunction powerPointProcesses(",
  runPowerShellStart,
);
const runPowerShellSource =
  runPowerShellStart >= 0 && runPowerShellEnd > runPowerShellStart
    ? nativeImplementationSource.slice(runPowerShellStart, runPowerShellEnd)
    : "";
if (nativeImplementationStart < 0) {
  failures.push("tests omit the native mutex wrapper implementation");
}
if (!exclusiveBaselineSource) {
  failures.push("tests omit the exclusive baseline implementation");
}
if (!nativeMutexWrapperSource) {
  failures.push("tests omit the native mutex wrapper");
}
if (!runPowerShellSource) {
  failures.push("tests omit the native PowerShell invocation helper");
}
if (
  nativeImplementationSource.includes('"targeted native baseline selector"') ||
  nativeImplementationSource.includes('"redirected worker process capture"')
) {
  failures.push(
    "native implementation source must exclude static assertion declarations",
  );
}
for (const [name, pattern] of [
  ["raw spec hash contract", /ExpectedSpecSha256/],
  ["schema version gate", /fde-drawing-spec\/1\.0/],
  ["960x540 stage gate", /960.*540|540.*960/s],
  ["selected-slide count gate", /selectedSlideIds.*slidesSpec\.Count/s],
  ["shared automation mutex", /Local\\FdeReadoutPowerPointAutomation/],
  [
    "slide background application",
    /Set-SlideBackground[\s\S]*backgroundColorRole/,
  ],
  [
    "reopened slide background verification",
    /Assert-SlideBackground[\s\S]*backgroundColorRole/,
  ],
  ["baseline process capture", /Get-Process\s+-Name\s+POWERPNT/i],
  [
    "exclusive zero-baseline gate",
    /\$baselinePowerPointIdentities\.Count -ne 0[\s\S]*requires an exclusive automation session/,
  ],
  ["PowerPoint HWND ownership", /\$powerPoint\.HWND/],
  ["process StartTime identity", /workerProcessStart|StartTime/],
  ["retained process object", /\$ownedPowerPointProcess/],
  [
    "provisional retained-handle ownership",
    /\[int\]\$verifiedProcessId -ne \$workerProcessId[\s\S]*\$hasProvisionalPowerPointProcess\s*=\s*\$true[\s\S]*Invoke-TestFailpoint -Stage 'process-acquired'/,
  ],
  [
    "provisional cleanup gate",
    /if \(\$hasProvisionalPowerPointProcess -or \$ownsPowerPointProcess\)/,
  ],
  [
    "retained OS handle cleanup validation",
    /\$ownedPowerPointProcess\.Handle -ne \$ownedPowerPointProcessHandle/,
  ],
  ["validated process-object cleanup", /\$ownedPowerPointProcess\.Kill\(\)/],
  ["process path identity", /workerProcessPath/],
  ["pre-eligibility exited-process rejection", /\$ownedPowerPointProcess\.HasExited[\s\S]*ownership validation/],
  ["root lifetime retention", /\[GC\]::KeepAlive\(\$powerPoint\)/],
  ["dedicated worker exit", /\[Environment\]::Exit\(/],
  ["canonical path resolution", /GetFinalPath|Get-CanonicalPath/],
  ["ancestor and alias rejection", /Assert-IndependentPaths/],
  ["new-only bundle", /OutputDirectory must be a new path/],
  ["single sibling staging directory", /worker-stage/],
  [
    "owned staging directory cleanup",
    /\$ownsStagingDirectory\s*=\s*\$true[\s\S]*if \(\$ownsStagingDirectory\)[\s\S]*Remove-StagedPath/,
  ],
  ["staged candidate", /readout\.pptx/],
  ["staged render directory", /Join-Path \$stagingDirectory 'native-render'/],
  ["staged report", /Join-Path \$stagingDirectory 'worker-report\.json'/],
  ["atomic directory rename", /\[IO\.Directory\]::Move/],
  ["same-byte spec hash", /Get-BytesSha256 -Bytes \$specBytes/],
  ["same-byte spec parse", /\$strictUtf8\.GetString\(\$specBytes\)/],
  ["single buffered skeleton read", /ReadAllBytes\(\$skeletonPath\)/],
  ["buffered skeleton write", /WriteAllBytes\(\$candidatePath, \$skeletonBytes\)/],
  ["buffered skeleton hash", /Get-BytesSha256 -Bytes \$skeletonBytes/],
  ["pre-open skeleton rehash", /candidateSourceSha256 = Get-Sha256 -Path \$candidatePath/],
  ["candidate mutation test hook", /FDE_POWERPOINT_TEST_MUTATE_CANDIDATE_BEFORE_OPEN/],
  ["single-release helper", /function Release-ComRef[\s\S]*ReleaseComObject/],
  ["Presentations release", /presentations collection/],
  ["Slides release", /authoring slides|reopened slides/],
  ["Slide release", /authoring slide|export slide/],
  ["Shapes release", /authoring shapes|verification shapes/],
  ["Shape release", /text shape|seed shape/],
  ["legacy TextFrame release", /legacy text frame/],
  ["TextFrame2 release", /text frame 2|overflow text frame/],
  ["TextRange2 release", /text range|overflow text range/],
  ["Font2 release", /text font/],
  ["Fill release", /shape fill|text font fill/],
  ["Line release", /shape line|line format/],
  ["Color release", /font color|line color|fill color/],
  ["ParagraphFormat release", /paragraph format/],
  ["NotesPage release", /notes page/],
  ["notes Shapes release", /notes shapes/],
  ["PlaceholderFormat release", /notes placeholder format/],
  ["native notes hash", /notesSha256/],
  ["exact shape-name verification", /Assert-ExactShapeNames/],
  ["overflow hard gate", /Assert-TextFits/],
  ["rendered-height overflow measurement", /BoundHeight/],
  ["rendered maxLines measurement", /\$range2\.Lines\(\)/],
  ["rendered lines release", /rendered text lines/],
  ["1600x900 export", /1600,\s*900/],
  ["dynamic three-column contact sheet", /Min\(3,\s*\$Images\.Count\)/],
  ["managed image disposal", /\$image\.Dispose\(\)/],
  ["cleanup receipt", /ownedProcessId[\s\S]*graceSeconds/],
  ["failpoint notes", /Invoke-TestFailpoint -Stage 'notes'/],
  ["failpoint delete", /Invoke-TestFailpoint -Stage 'delete'/],
  ["failpoint text", /Invoke-TestFailpoint -Stage 'text'/],
  ["failpoint shape", /Invoke-TestFailpoint -Stage 'shape'/],
  ["failpoint line", /Invoke-TestFailpoint -Stage 'line'/],
  ["failpoint activation", /Invoke-TestFailpoint -Stage 'activation'/],
  ["failpoint HWND", /Invoke-TestFailpoint -Stage 'hwnd'/],
  ["failpoint process acquisition", /Invoke-TestFailpoint -Stage 'process-acquired'/],
  ["failpoint process validation", /Invoke-TestFailpoint -Stage 'process-validated'/],
  ["failpoint overflow", /Invoke-TestFailpoint -Stage 'overflow'/],
  ["failpoint save", /Invoke-TestFailpoint -Stage 'save'/],
  ["failpoint reopen", /Invoke-TestFailpoint -Stage 'reopen'/],
  ["failpoint export", /Invoke-TestFailpoint -Stage 'export'/],
  ["failpoint bundle publish", /Invoke-TestFailpoint -Stage 'publish-bundle'/],
  ["failpoint environment guard", /FDE_POWERPOINT_TEST_FAILPOINTS/],
  ["internal staging evidence", /status = 'WORKER_PASS'[\s\S]*stagingEvidence = \$true/],
  ["unsupported table rejection", /table, nativeChart, and connector/],
]) {
  if (!pattern.test(workerSource)) failures.push(`worker omits ${name}`);
}

for (const [name, pattern] of [
  ["FinalReleaseComObject", /FinalReleaseComObject/i],
  [
    "root Application release",
    /ReleaseComObject\s*\(\s*\$powerPoint\s*\)|Release-ComRef[^\r\n]*\$powerPoint/i,
  ],
  ["pending-finalizer wait", /WaitForPendingFinalizers/i],
  ["name-based process termination", /Stop-Process\s+-Name\b/i],
  ["PID re-resolution cleanup", /Stop-Process\s+-Id\b/i],
  ["backup publication", /\b(?:output|render|report)Backup\b/],
  ["multi-artifact file publication", /\[IO\.File\]::Move/],
  ["legacy Output parameter", /\[string\]\$Output(?:\r?\n|,)/],
  ["legacy Report parameter", /\[string\]\$Report(?:\r?\n|,)/],
  ["legacy RenderDirectory parameter", /\[string\]\$RenderDirectory(?:\r?\n|,)/],
  ["newline-count maxLines heuristic", /logicalLineCount|regex.*maxLines/is],
  ["native chart creation", /\bAddChart\b/i],
  ["OLE creation", /\bAddOLEObject\b|\bOLEFormat\b/i],
  ["media creation", /\bAddMediaObject\b|\bMediaFormat\b/i],
]) {
  if (pattern.test(workerSource)) failures.push(`worker uses forbidden ${name}`);
}

for (const [name, pattern] of [
  [
    "targeted native baseline selector",
    /nativeChildSelector = nativeBaselineOnlyRequested[\s\S]*--native-baseline-only[\s\S]*nativeChildSelector[\s\S]*--native-under-test-mutex/,
  ],
  [
    "redirected worker process capture",
    /Start-Process[\s\S]*-RedirectStandardOutput[\s\S]*-RedirectStandardError[\s\S]*-PassThru[\s\S]*-NoNewWindow[\s\S]*\$workerProcess\.WaitForExit\(\$workerTimeoutMilliseconds\)/,
  ],
  ["nested worker exit capture", /\$workerStatus = \$workerProcess\.ExitCode/],
  ["nested worker process disposal", /\$workerProcess\.Dispose\(\)/],
  [
    "baseline cleanup natural-exit race",
    /try \{[\s\S]*\$baselineProcess\.Handle -ne \$baselineHandle[\s\S]*\$baselineProcess\.Kill\(\)[\s\S]*catch \{[\s\S]*\$cleanupFailure = \$_[\s\S]*\$baselineProcess\.Refresh\(\)[\s\S]*\$confirmedExited = \$baselineProcess\.HasExited[\s\S]*if \(-not \$confirmedExited\) \{ throw \$cleanupFailure \}[\s\S]*\$cleanupMode = 'graceful'/,
  ],
  [
    "direct-spawn zero-baseline gate",
    /\$directBaseline = @\(Get-Process -Name POWERPNT[\s\S]*\$directBaseline\.Count -ne 0[\s\S]*\$baselineProcess = \[Diagnostics\.Process\]::Start\(\$startInfo\)/,
  ],
  [
    "direct child cleanup provenance",
    /\$baselineProcess = \[Diagnostics\.Process\]::Start\(\$startInfo\)[\s\S]*\$ownsBaselineChild = \$true[\s\S]*\$baselineHandle = \$baselineProcess\.Handle/,
  ],
  [
    "direct child identity validation",
    /\$baselineHandle = \$baselineProcess\.Handle[\s\S]*\$baselineStart = \$baselineProcess\.StartTime[\s\S]*\$baselinePath = \$baselineProcess\.Path[\s\S]*\$baselineIdentityValidated = \$true/,
  ],
  [
    "ownership-gated direct child termination",
    /if \(\$ownsBaselineChild -and \$null -ne \$baselineProcess\)[\s\S]*\$baselineProcess\.Kill\(\)/,
  ],
  [
    "baseline-only inert skeleton",
    /if \(nativeBaselineOnlyRequested\) \{[\s\S]*writeFile\(skeletonPath, "baseline-only", "utf8"\)[\s\S]*\} else \{[\s\S]*runPowerShell\(skeletonHelper/,
  ],
  [
    "outer baseline result JSON",
    /\$resultObject \| ConvertTo-Json -Compress/,
  ],
]) {
  if (!pattern.test(nativeImplementationSource)) {
    failures.push(`tests omit ${name}`);
  }
}
if (
  /New-Object -ComObject PowerPoint\.Application|\$baselineApp\.Quit\(\)/.test(
    nativeImplementationSource,
  )
) {
  failures.push("baseline preservation helper must not create or Quit a COM app");
}
if (/return spawnSync\([\s\S]*timeout\s*:/.test(exclusiveBaselineSource)) {
  failures.push(
    "exclusive baseline coordinator must own all timeouts so its finally block always runs",
  );
}
if (/const native = spawnSync\([\s\S]*timeout\s*:/.test(nativeMutexWrapperSource)) {
  failures.push(
    "native mutex wrapper must not time out before child cleanup completes",
  );
}
if (/timeout\s*:/.test(runPowerShellSource)) {
  failures.push(
    "native PowerPoint invocations must not time out before their cleanup completes",
  );
}

const mutexIndex = workerSource.indexOf(
  "$script:workerMutexHeld = $script:workerMutex.WaitOne",
);
const baselineIndex = workerSource.indexOf(
  "$baselinePowerPointIdentities = Get-PowerPointProcesses",
);
const copyIndex = workerSource.indexOf(
  "[IO.File]::WriteAllBytes($candidatePath, $skeletonBytes)",
);
const stageIndex = workerSource.indexOf(
  "[void](New-Item -ItemType Directory -Path $stagingDirectory)",
);
const renderStageIndex = workerSource.indexOf(
  "[void](New-Item -ItemType Directory -Path $temporaryRenderPath)",
);
const zeroBaselineIndex = workerSource.indexOf(
  "$baselinePowerPointIdentities.Count -ne 0",
);
const activationIndex = workerSource.indexOf(
  "$powerPoint = New-Object -ComObject PowerPoint.Application",
);
const stagingOwnershipIndex = workerSource.indexOf(
  "$ownsStagingDirectory = $true",
);
if (
  mutexIndex < 0 ||
  baselineIndex < mutexIndex ||
  zeroBaselineIndex < baselineIndex ||
  stageIndex < baselineIndex ||
  stageIndex < zeroBaselineIndex ||
  stagingOwnershipIndex < stageIndex ||
  copyIndex < zeroBaselineIndex ||
  renderStageIndex < zeroBaselineIndex ||
  activationIndex < zeroBaselineIndex ||
  copyIndex < mutexIndex
) {
  failures.push(
    "worker must acquire its mutex and prove a zero baseline before candidate mutation or COM activation",
  );
}
for (const [name, token] of [
  [
    "candidate staging write",
    "[IO.File]::WriteAllBytes($candidatePath, $skeletonBytes)",
  ],
  [
    "candidate mutation test hook",
    "[IO.File]::AppendAllText($candidatePath, 'test-mutation')",
  ],
  ["slide export", "$slide.Export($renderFile, 'PNG', 1600, 900)"],
  [
    "contact sheet write",
    "New-ContactSheet -Images $renderFiles.ToArray() -OutputPath $contactSheetPath",
  ],
  [
    "staged report write",
    "[IO.File]::WriteAllText($stagedReportPath, $reportJson",
  ],
  ["atomic bundle move", "[IO.Directory]::Move($stagingDirectory, $outputPath)"],
]) {
  const mutationIndex = workerSource.indexOf(token);
  if (mutationIndex < zeroBaselineIndex) {
    failures.push(
      `worker ${name} must occur after the main-flow zero-baseline gate`,
    );
  }
}
if (baselineIndex < 0 || copyIndex < baselineIndex) {
  failures.push("worker must capture the baseline before candidate mutation");
}
const retainedProcessIndex = workerSource.indexOf(
  "$ownedPowerPointProcess = Get-Process -Id $workerProcessId",
);
const retainedHandleIndex = workerSource.indexOf(
  "$ownedPowerPointProcessHandle = $ownedPowerPointProcess.Handle",
);
const processNameValidationIndex = workerSource.indexOf(
  "$ownedPowerPointProcess.ProcessName,",
);
const processPathValidationIndex = workerSource.indexOf(
  "[IO.Path]::GetFileName($workerProcessPath)",
);
const processStartIndex = workerSource.indexOf(
  "$workerProcessStart = $ownedPowerPointProcess.StartTime",
);
const firstExitedCheckIndex = workerSource.indexOf(
  "$ownedPowerPointProcess.HasExited",
  retainedHandleIndex,
);
const secondExitedCheckIndex = workerSource.indexOf(
  "$ownedPowerPointProcess.HasExited",
  firstExitedCheckIndex + 1,
);
const secondHwndIndex = workerSource.indexOf(
  "$verifiedWindowHandle = [IntPtr][int64]$powerPoint.HWND",
);
const secondPidIndex = workerSource.indexOf(
  "[int]$verifiedProcessId -ne $workerProcessId",
);
const provisionalIndex = workerSource.indexOf(
  "$hasProvisionalPowerPointProcess = $true",
);
const processAcquiredFailpointIndex = workerSource.indexOf(
  "Invoke-TestFailpoint -Stage 'process-acquired'",
);
if (
  retainedProcessIndex < 0 ||
  retainedHandleIndex < retainedProcessIndex ||
  firstExitedCheckIndex < retainedHandleIndex ||
  processNameValidationIndex < firstExitedCheckIndex ||
  processPathValidationIndex < processNameValidationIndex ||
  processStartIndex < processPathValidationIndex ||
  secondExitedCheckIndex < processStartIndex ||
  secondHwndIndex < secondExitedCheckIndex ||
  secondPidIndex < secondHwndIndex ||
  provisionalIndex < secondPidIndex ||
  processAcquiredFailpointIndex < provisionalIndex
) {
  failures.push(
    "worker must validate the retained process and repeat HWND PID resolution before provisional kill eligibility",
  );
}
if (
  (
    workerSource.match(
      /\[void\]\[FdePowerPointWorkerNativeMethods\]::GetWindowThreadProcessId\(/g,
    ) ?? []
  ).length !== 2
) {
  failures.push(
    "worker must invoke HWND PID resolution exactly twice during ownership validation",
  );
}
if (
  (workerSource.match(/\[IO\.File\]::ReadAllBytes\(\$specPath\)/g) ?? [])
    .length !== 1
) {
  failures.push("worker must read spec bytes exactly once");
}
if (
  (workerSource.match(/\[IO\.File\]::ReadAllBytes\(\$skeletonPath\)/g) ?? [])
    .length !== 1
) {
  failures.push("worker must read skeleton bytes exactly once");
}
if ((workerSource.match(/\[IO\.Directory\]::Move\(/g) ?? []).length !== 1) {
  failures.push("worker must publish with exactly one atomic directory move");
}

const powershellProbe = spawnSync(
  "powershell",
  ["-NoProfile", "-Command", "exit 0"],
  { encoding: "utf8" },
);
const hasWindowsPowerShell = !powershellProbe.error && powershellProbe.status === 0;
if (hasWindowsPowerShell) {
  const parse = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${worker.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors); if($errors.Count){$errors | ForEach-Object {$_.ToString()}; exit 1}`,
    ],
    { encoding: "utf8" },
  );
  if (parse.status !== 0) {
    failures.push(`worker does not parse: ${parse.stdout}${parse.stderr}`);
  }

  const pathTemp = await mkdtemp(join(tmpdir(), "fde-pptx-worker-paths-"));
  try {
    const realDirectory = join(pathTemp, "real");
    const aliasDirectory = join(pathTemp, "alias");
    await mkdir(realDirectory);
    await symlink(realDirectory, aliasDirectory, "junction");
    const specPath = join(realDirectory, "spec.json");
    const skeletonPath = join(pathTemp, "skeleton.pptx");
    const specBytes = Buffer.from("{}", "utf8");
    await writeFile(specPath, specBytes);
    await writeFile(skeletonPath, "not-opened", "utf8");

    function runPathCase(overrides = {}, extraEnv = {}) {
      const paths = {
        spec: specPath,
        skeleton: skeletonPath,
        outputDirectory: join(pathTemp, "worker-bundle"),
        expectedSpecSha256: sha256(specBytes),
        ...overrides,
      };
      return spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          worker,
          "-Spec",
          paths.spec,
          "-ExpectedSpecSha256",
          paths.expectedSpecSha256,
          "-Skeleton",
          paths.skeleton,
          "-OutputDirectory",
          paths.outputDirectory,
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, ...extraEnv },
        },
      );
    }

    for (const [name, overrides] of [
      ["output directory aliases spec", { outputDirectory: specPath }],
      [
        "junction aliases spec and skeleton",
        { skeleton: join(aliasDirectory, "spec.json") },
      ],
      [
        "output directory contains spec",
        { outputDirectory: realDirectory },
      ],
    ]) {
      const result = runPathCase(overrides);
      if (
        result.status === 0 ||
        result.stdout.trim() !== "" ||
        !/must not alias or contain one another/.test(result.stderr)
      ) {
        failures.push(
          `${name} did not reject before mutation: ${result.stdout}${result.stderr}`,
        );
      }
    }

    const existingBundle = join(pathTemp, "existing-bundle");
    await mkdir(existingBundle);
    await writeFile(join(existingBundle, "sentinel"), "preserve", "utf8");
    const existingResult = runPathCase({ outputDirectory: existingBundle });
    if (
      existingResult.status === 0 ||
      !/OutputDirectory must be a new path/.test(existingResult.stderr) ||
      (await readFile(join(existingBundle, "sentinel"), "utf8")) !== "preserve"
    ) {
      failures.push(
        `pre-existing bundle was not preserved: ${existingResult.stdout}${existingResult.stderr}`,
      );
    }
    const staged = (await readdir(pathTemp)).filter((name) =>
      name.endsWith(".worker-stage"),
    );
    if (staged.length > 0) {
      failures.push(`path rejection left staging directories: ${staged.join(",")}`);
    }

    const collisionSpec = Buffer.from(
      JSON.stringify({
        schemaVersion: "fde-drawing-spec/1.0",
        units: "points",
        stage: { width: 960, height: 540 },
        selectedSlideIds: ["collision"],
        selectedSlideFamilies: ["cover"],
        slides: [{ id: "collision", family: "cover", primitives: [] }],
      }),
      "utf8",
    );
    const collisionSpecPath = join(pathTemp, "collision-spec.json");
    const collisionOutput = join(pathTemp, "collision-bundle");
    const collisionToken = "static-collision";
    const collisionStage = join(
      pathTemp,
      `.collision-bundle.${collisionToken}.worker-stage`,
    );
    await writeFile(collisionSpecPath, collisionSpec);
    await mkdir(collisionStage);
    await writeFile(join(collisionStage, "sentinel"), "preserve", "utf8");
    const collisionResult = runPathCase(
      {
        spec: collisionSpecPath,
        expectedSpecSha256: sha256(collisionSpec),
        outputDirectory: collisionOutput,
      },
      {
        FDE_POWERPOINT_TEST_FAILPOINTS: "1",
        FDE_POWERPOINT_TEST_STAGING_TOKEN: collisionToken,
      },
    );
    if (
      collisionResult.status === 0 ||
      !/staging directory appeared before mutation/.test(
        collisionResult.stderr,
      ) ||
      (await readFile(join(collisionStage, "sentinel"), "utf8")) !==
        "preserve"
    ) {
      failures.push(
        `staging collision was not preserved: ${collisionResult.stdout}${collisionResult.stderr}`,
      );
    }

  } finally {
    await rm(pathTemp, { recursive: true, force: true });
  }
}

if (nativeRequested && !nativeUnderMutex) {
  if (failures.length > 0) {
    console.error("Basic PowerPoint worker static tests failed:");
    failures.forEach((failure, index) =>
      console.error(`${index + 1}. ${failure}`),
    );
    process.exit(1);
  }
  if (!hasWindowsPowerShell) {
    console.error("Basic PowerPoint worker tests failed:");
    console.error("1. native suite requires Windows PowerShell on Windows");
    process.exit(1);
  }
  const nativeChildSelector = nativeBaselineOnlyRequested
    ? "--native-baseline-only"
    : "--native";
  const command = [
    "$mutex = [Threading.Mutex]::new($false, 'Local\\FdeReadoutPowerPointWorkerNativeTest')",
    "$held = $false",
    "$childStatus = 1",
    "try {",
    "  try { $held = $mutex.WaitOne([TimeSpan]::FromSeconds(30)) } catch [Threading.AbandonedMutexException] { $held = $true }",
    "  if (-not $held) { throw 'Timed out waiting for the native worker test mutex.' }",
    `  & '${process.execPath.replaceAll("'", "''")}' '${fileURLToPath(import.meta.url).replaceAll("'", "''")}' ${nativeChildSelector} --native-under-test-mutex`,
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
    console.error("Basic PowerPoint worker static tests failed:");
    failures.forEach((failure, index) =>
      console.error(`${index + 1}. ${failure}`),
    );
    process.exit(1);
  }
  console.log("Basic PowerPoint worker static tests passed.");
  process.exit(0);
}

if (process.platform !== "win32" || !hasWindowsPowerShell) {
  failures.push("native suite requires Windows PowerShell on Windows");
}

const availability = hasWindowsPowerShell
  ? spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "[bool][type]::GetTypeFromProgID('PowerPoint.Application')",
      ],
      { encoding: "utf8" },
    )
  : null;
if (
  availability === null ||
  availability.status !== 0 ||
  availability.stdout.trim() !== "True"
) {
  failures.push("native suite requires Microsoft PowerPoint");
}
const suiteBaseline = nativeRequested ? powerPointProcesses() : [];
if (nativeRequested && suiteBaseline.length > 0) {
  failures.push(
    `native suite requires a zero baseline; observed ${suiteBaseline
      .map(processIdentity)
      .join(",")}`,
  );
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
    throw new Error(`could not inspect PowerPoint baseline: ${result.stderr}`);
  }
  return result.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((value) => {
      const [processId, startTimeUtc] = value.split("|");
      return { processId: Number.parseInt(processId, 10), startTimeUtc };
    });
}

function processIdentity(receipt) {
  return `${receipt.processId}|${receipt.startTimeUtc}`;
}

async function assertReceiptAbsent(name, receipt, suiteBaseline) {
  for (const [label, wait] of [
    ["at return", 0],
    ["after 10s", 10_000],
    ["after 30s", 20_000],
  ]) {
    if (wait > 0) await delay(wait);
    const current = powerPointProcesses();
    const currentKeys = new Set(current.map(processIdentity));
    if (currentKeys.has(processIdentity(receipt))) {
      failures.push(
        `${name} retained exact owned POWERPNT ${processIdentity(receipt)} ${label}`,
      );
    }
    const baselineKeys = new Set(suiteBaseline.map(processIdentity));
    const unrelated = current.filter(
      (process) =>
        !baselineKeys.has(processIdentity(process)) &&
        processIdentity(process) !== processIdentity(receipt),
    );
    if (unrelated.length > 0) {
      failures.push(
        `${name} observed environmental POWERPNT contamination ${label}: ${unrelated
          .map(processIdentity)
          .join(",")}`,
      );
    }
  }
}

async function assertBaselineRestored(name, suiteBaseline) {
  for (const [label, wait] of [
    ["at return", 0],
    ["after 10s", 10_000],
    ["after 30s", 20_000],
  ]) {
    if (wait > 0) await delay(wait);
    const baselineKeys = new Set(suiteBaseline.map(processIdentity));
    const unrelated = powerPointProcesses().filter(
      (process) => !baselineKeys.has(processIdentity(process)),
    );
    if (unrelated.length > 0) {
      failures.push(
        `${name} observed environmental POWERPNT contamination ${label}: ${unrelated
          .map(processIdentity)
          .join(",")}`,
      );
    }
  }
}

function cleanupReceiptFromFailure(output) {
  const match = output.match(
    /PowerPoint cleanup: PID (\d+) start ([^ ]+) exited via (?:graceful|forced)\./,
  );
  return match
    ? { processId: Number.parseInt(match[1], 10), startTimeUtc: match[2] }
    : null;
}

function runExclusiveBaselinePreservationCase({
  specPath,
  expectedSpecSha256,
  skeletonPath,
  outputDirectory,
  temp,
}) {
  const stdoutPath = join(temp, "baseline-worker.stdout");
  const stderrPath = join(temp, "baseline-worker.stderr");
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$baselineProcess = $null",
    "$baselineProcessId = 0",
    "$baselineHandle = [IntPtr]::Zero",
    "$baselineStart = $null",
    "$baselinePath = $null",
    "$ownsBaselineChild = $false",
    "$baselineIdentityValidated = $false",
    "$workerProcess = $null",
    "$workerProcessHandle = [IntPtr]::Zero",
    "$workerProcessId = 0",
    "$workerProcessStart = $null",
    "$workerProcessPath = $null",
    "$workerTimeoutMilliseconds = 60000",
    "$cleanupMode = $null",
    "$resultObject = $null",
    "try {",
    "    $appPathsKey = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\POWERPNT.EXE'",
    "    $powerPointExecutable = [string](Get-ItemPropertyValue -LiteralPath $appPathsKey -Name '(default)' -ErrorAction Stop)",
    "    $powerPointExecutable = [IO.Path]::GetFullPath($powerPointExecutable)",
    "    if (-not (Test-Path -LiteralPath $powerPointExecutable -PathType Leaf)) { throw 'Registered POWERPNT executable does not exist.' }",
    "    $startInfo = [Diagnostics.ProcessStartInfo]::new()",
    "    $startInfo.FileName = $powerPointExecutable",
    "    $startInfo.Arguments = '/AUTOMATION'",
    "    $startInfo.UseShellExecute = $false",
    "    $directBaseline = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue)",
    "    for ($baselineIndex = 0; $baselineIndex -lt $directBaseline.Count; $baselineIndex++) {",
    "        $baselineEntry = $directBaseline[$baselineIndex]",
    "        try {",
    "            [void]$baselineEntry.StartTime",
    "            [void]$baselineEntry.Path",
    "        }",
    "        finally {",
    "            $baselineEntry.Dispose()",
    "        }",
    "    }",
    "    if ($directBaseline.Count -ne 0) { throw 'Baseline preservation test requires zero POWERPNT immediately before direct spawn.' }",
    "    $baselineProcess = [Diagnostics.Process]::Start($startInfo)",
    "    if ($null -eq $baselineProcess) { throw 'Direct POWERPNT spawn returned no process.' }",
    "    $ownsBaselineChild = $true",
    "    $baselineHandle = $baselineProcess.Handle",
    "    if ($baselineProcess.HasExited) { throw 'Direct POWERPNT child exited before identity capture.' }",
    "    $baselineProcessId = $baselineProcess.Id",
    "    $baselineStart = $baselineProcess.StartTime",
    "    $baselinePath = $baselineProcess.Path",
    "    if (-not [string]::Equals($baselineProcess.ProcessName, 'POWERPNT', [StringComparison]::OrdinalIgnoreCase)) { throw 'Direct child is not POWERPNT.' }",
    "    if ([string]::IsNullOrWhiteSpace($baselinePath)) { throw 'Direct POWERPNT child exposed no executable path.' }",
    "    $baselinePath = [IO.Path]::GetFullPath($baselinePath)",
    "    if ($baselineProcess.HasExited) { throw 'Direct POWERPNT child exited or delegated during validation.' }",
    "    $baselineIdentityValidated = $true",
    "    $currentProcess = [Diagnostics.Process]::GetCurrentProcess()",
    "    try { $powerShellExecutable = $currentProcess.MainModule.FileName } finally { $currentProcess.Dispose() }",
    "    $argumentList = @(",
    "        '-NoProfile',",
    "        '-ExecutionPolicy',",
    "        'Bypass',",
    "        '-File',",
    `        ${quote(`"${worker}"`)},`,
    "        '-Spec',",
    `        ${quote(`"${specPath}"`)},`,
    "        '-ExpectedSpecSha256',",
    `        ${quote(expectedSpecSha256)},`,
    "        '-Skeleton',",
    `        ${quote(`"${skeletonPath}"`)},`,
    "        '-OutputDirectory',",
    `        ${quote(`"${outputDirectory}"`)}`,
    "    )",
    `    $workerProcess = Start-Process -FilePath $powerShellExecutable -ArgumentList $argumentList -RedirectStandardOutput ${quote(stdoutPath)} -RedirectStandardError ${quote(stderrPath)} -PassThru -NoNewWindow`,
    "    $workerProcessHandle = $workerProcess.Handle",
    "    $workerProcessId = $workerProcess.Id",
    "    $workerProcessStart = $workerProcess.StartTime",
    "    $workerProcessPath = $workerProcess.Path",
    "    try {",
    "        if (-not $workerProcess.WaitForExit($workerTimeoutMilliseconds)) {",
    "            try {",
    "                if (",
    "                    $workerProcess.Id -ne $workerProcessId -or",
    "                    $workerProcess.Handle -ne $workerProcessHandle -or",
    "                    $workerProcess.StartTime -ne $workerProcessStart -or",
    "                    -not [string]::Equals($workerProcess.Path, $workerProcessPath, [StringComparison]::OrdinalIgnoreCase)",
    "                ) { throw 'Worker PowerShell identity changed before timeout cleanup.' }",
    "                $workerProcess.Kill()",
    "            }",
    "            catch {",
    "                $workerTimeoutFailure = $_",
    "                $workerProcess.Refresh()",
    "                if (-not $workerProcess.HasExited) { throw $workerTimeoutFailure }",
    "            }",
    "            if (-not $workerProcess.HasExited -and -not $workerProcess.WaitForExit(5000)) { throw 'Worker PowerShell survived timeout cleanup.' }",
    "            throw 'Exclusive-baseline worker invocation timed out.'",
    "        }",
    "        $workerProcess.WaitForExit()",
    "        $workerStatus = $workerProcess.ExitCode",
    "    }",
    "    finally {",
    "        $workerProcess.Dispose()",
    "        $workerProcess = $null",
    "    }",
    `    $workerStdout = if (Test-Path -LiteralPath ${quote(stdoutPath)}) { [IO.File]::ReadAllText(${quote(stdoutPath)}) } else { '' }`,
    `    $workerStderr = if (Test-Path -LiteralPath ${quote(stderrPath)}) { [IO.File]::ReadAllText(${quote(stderrPath)}) } else { '' }`,
    "    $baselineProcess.Refresh()",
    "    $baselinePreserved = (",
    "        -not $baselineProcess.HasExited -and",
    "        $baselineProcess.Id -eq $baselineProcessId -and",
    "        $baselineProcess.Handle -eq $baselineHandle -and",
    "        $baselineProcess.StartTime -eq $baselineStart -and",
    "        [string]::Equals($baselineProcess.Path, $baselinePath, [StringComparison]::OrdinalIgnoreCase)",
    "    )",
    "    $resultObject = [ordered]@{",
    "        workerStatus = $workerStatus",
    "        workerStdout = $workerStdout",
    "        workerStderr = $workerStderr",
    `        outputExists = Test-Path -LiteralPath ${quote(outputDirectory)}`,
    "        baselinePreserved = $baselinePreserved",
    "        processId = $baselineProcessId",
    "        startTimeUtc = $baselineStart.ToUniversalTime().ToString('o')",
    "        cleanupMode = $null",
    "    }",
    "}",
    "finally {",
    "    if ($null -ne $workerProcess) {",
    "        $workerProcess.Dispose()",
    "        $workerProcess = $null",
    "    }",
    "    if ($ownsBaselineChild -and $null -ne $baselineProcess) {",
    "        $baselineProcess.Refresh()",
    "        if ($baselineProcess.HasExited) {",
    "            $cleanupMode = 'graceful'",
    "        }",
    "        else {",
    "            try {",
    "                if (",
    "                    $baselineIdentityValidated -and (",
    "                        $baselineProcess.Id -ne $baselineProcessId -or",
    "                        $baselineProcess.Handle -ne $baselineHandle -or",
    "                        $baselineProcess.StartTime -ne $baselineStart -or",
    "                        -not [string]::Equals($baselineProcess.Path, $baselinePath, [StringComparison]::OrdinalIgnoreCase)",
    "                    )",
    "                ) { throw 'Baseline PowerPoint identity changed before test cleanup.' }",
    "                $baselineProcess.Kill()",
    "            }",
    "            catch {",
    "                $cleanupFailure = $_",
    "                $confirmedExited = $false",
    "                try {",
    "                    $baselineProcess.Refresh()",
    "                    $confirmedExited = $baselineProcess.HasExited",
    "                }",
    "                catch {",
    "                    throw $cleanupFailure",
    "                }",
    "                if (-not $confirmedExited) { throw $cleanupFailure }",
    "                $cleanupMode = 'graceful'",
    "            }",
    "            if ($null -eq $cleanupMode) {",
    "                if (-not $baselineProcess.WaitForExit(5000)) { throw 'Baseline PowerPoint survived test cleanup.' }",
    "                $cleanupMode = 'forced'",
    "            }",
    "        }",
    "    }",
    "    if ($null -ne $baselineProcess) {",
    "        $baselineProcess.Dispose()",
    "    }",
    "}",
    "if ($null -eq $resultObject) { throw 'Baseline preservation result was not captured.' }",
    "$resultObject.cleanupMode = $cleanupMode",
    "$resultObject | ConvertTo-Json -Compress",
  ].join("\n");
  return spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8" },
  );
}

let nativeArtifactDirectory;
if (failures.length === 0) {
  const temp = await mkdtemp(join(tmpdir(), "fde-pptx-worker-basic-"));
  nativeArtifactDirectory = temp;
  try {
    const sourcePlan = JSON.parse(await readFile(examplePlan, "utf8"));
    const metrics = structuredClone(
      sourcePlan.slides.find((slide) => slide.family === "metrics"),
    );
    metrics.evidenceIds = [
      ...new Set([...metrics.evidenceIds, "authority-001"]),
    ];
    const metricsTwo = structuredClone(metrics);
    metricsTwo.id = "target-metrics";
    metricsTwo.title = "The target keeps speed and reclassification visible";
    metricsTwo.notes =
      "Fictional target restatement. Sources: [target-001], [authority-001].";
    metricsTwo.content.metrics = metricsTwo.content.metrics.slice(0, 2);
    metricsTwo.content.metrics[0].label = "Target median";
    metricsTwo.content.metrics[0].value = "<=20 min";
    metricsTwo.content.metrics[0].context = "four-week target";
    metricsTwo.content.metrics[0].evidenceIds = ["target-001"];
    metricsTwo.content.metrics[1].label = "Target reclassified";
    metricsTwo.content.metrics[1].value = "<=10%";
    metricsTwo.content.metrics[1].context = "four-week target";
    metricsTwo.content.metrics[1].evidenceIds = ["target-001"];
    const evidence = structuredClone(sourcePlan.slides.at(-1));
    evidence.content.groups[0].evidenceIds = [
      "customer-001",
      "workflow-001",
    ];
    evidence.content.groups[1].evidenceIds = [
      "baseline-001",
      "assignment-001",
    ];
    sourcePlan.slides = [
      sourcePlan.slides[0],
      sourcePlan.slides[1],
      metrics,
      metricsTwo,
      evidence,
    ];

    const planPath = join(temp, "plan.json");
    const specPath = join(temp, "spec.json");
    const skeletonPath = join(temp, "skeleton.pptx");
    const bundlePath = join(temp, "worker-bundle");
    const outputPath = join(bundlePath, "readout.pptx");
    const renderPath = join(bundlePath, "native-render");
    const reportPath = join(bundlePath, "worker-report.json");
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
      { encoding: "utf8", timeout: 30_000 },
    );
    if (compile.status !== 0) {
      failures.push(`five-slide spec compilation failed: ${compile.stderr}`);
    }

    if (failures.length === 0) {
      if (nativeBaselineOnlyRequested) {
        await writeFile(skeletonPath, "baseline-only", "utf8");
      } else {
        const skeleton = runPowerShell(skeletonHelper, [
          "-Plan",
          planPath,
          "-Output",
          skeletonPath,
        ]);
        if (skeleton.status !== 0) {
          failures.push(`five-slide skeleton failed: ${skeleton.stderr}`);
        }
      }
    }

    let expectedSpecSha256;
    if (failures.length === 0) {
      expectedSpecSha256 = sha256(await readFile(specPath));
      const baselineBundlePath = join(temp, "baseline-blocked-bundle");
      const baselineCase = runExclusiveBaselinePreservationCase({
        specPath,
        expectedSpecSha256,
        skeletonPath,
        outputDirectory: baselineBundlePath,
        temp,
      });
      let baselineResult;
      try {
        baselineResult = JSON.parse(baselineCase.stdout);
      } catch {
        failures.push(
          `exclusive baseline preservation test returned invalid JSON: ${baselineCase.stdout}${baselineCase.stderr}`,
        );
      }
      if (
        baselineResult &&
        (baselineCase.status !== 0 ||
          baselineResult.workerStatus === 0 ||
          baselineResult.workerStdout.trim() !== "" ||
          !/requires an exclusive automation session with a zero process baseline/.test(
            baselineResult.workerStderr,
          ) ||
          baselineResult.outputExists ||
          baselineResult.baselinePreserved !== true)
      ) {
        failures.push(
          `worker did not preserve and reject the exclusive baseline: ${JSON.stringify(baselineResult)}`,
        );
      }
      if (baselineResult) {
        await assertReceiptAbsent(
          "exclusive baseline preservation test",
          {
            processId: baselineResult.processId,
            startTimeUtc: baselineResult.startTimeUtc,
          },
          suiteBaseline,
        );
      }
    }

    if (failures.length === 0 && !nativeBaselineOnlyRequested) {
      const result = runPowerShell(worker, [
        "-Spec",
        specPath,
        "-ExpectedSpecSha256",
        expectedSpecSha256,
        "-Skeleton",
        skeletonPath,
        "-OutputDirectory",
        bundlePath,
      ]);
      if (result.status !== 0) {
        failures.push(`native worker failed: ${result.stdout}${result.stderr}`);
      } else {
        let payload;
        try {
          payload = JSON.parse(result.stdout);
        } catch {
          failures.push(`native worker returned invalid JSON: ${result.stdout}`);
        }
        if (payload) {
          if (
            payload.status !== "WORKER_PASS" ||
            payload.stagingEvidence !== true ||
            payload.slides?.length !== 5 ||
            payload.selectedSlideFamilies?.join(",") !==
              "cover,decision,metrics,metrics,evidence" ||
            payload.cleanup?.exited !== true ||
            !["graceful", "forced"].includes(payload.cleanup?.mode) ||
            !payload.cleanup?.ownedProcessStartUtc ||
            !payload.cleanup?.ownedProcessPath
          ) {
            failures.push(`native worker report is invalid: ${result.stdout}`);
          }
          await assertReceiptAbsent(
            "successful worker",
            {
              processId: payload.cleanup.ownedProcessId,
              startTimeUtc: payload.cleanup.ownedProcessStartUtc,
            },
            suiteBaseline,
          );
        }
      }
    }

    if (failures.length === 0 && !nativeBaselineOnlyRequested) {
      for (const path of [outputPath, reportPath, join(renderPath, "contact-sheet.png")]) {
        await access(path).catch(() => failures.push(`missing native artifact ${path}`));
      }
      const renders = (await readdir(renderPath)).filter((name) =>
        /^slide-\d{3}\.png$/.test(name),
      );
      if (renders.length !== 5) {
        failures.push(`expected 5 slide renders, found ${renders.length}`);
      }
      const pptx = await readFile(outputPath);
      if (pptx[0] !== 0x50 || pptx[1] !== 0x4b) {
        failures.push("worker output is not a native PPTX package");
      }
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      if (
        report.slides.some(
          (slide) =>
            slide.overflow !== false ||
            !slide.notesSha256 ||
            !slide.shapeNamesSha256 ||
            !slide.renderSha256,
        )
      ) {
        failures.push("report omits native notes, names, render, or overflow receipts");
      }
    }

    if (failures.length === 0 && !nativeBaselineOnlyRequested) {
      for (const stage of [
        "activation",
        "hwnd",
        "process-acquired",
        "process-validated",
        "notes",
        "delete",
        "text",
        "shape",
        "line",
        "overflow",
        "save",
        "reopen",
        "export",
        "publish-bundle",
      ]) {
        const failBundle = join(temp, `fail-${stage}-bundle`);
        const result = runPowerShell(
          worker,
          [
            "-Spec",
            specPath,
            "-ExpectedSpecSha256",
            expectedSpecSha256,
            "-Skeleton",
            skeletonPath,
            "-OutputDirectory",
            failBundle,
            "-FailAfter",
            stage,
          ],
          { FDE_POWERPOINT_TEST_FAILPOINTS: "1" },
        );
        const output = `${result.stdout}${result.stderr}`;
        if (
          result.status === 0 ||
          result.stdout.trim() !== "" ||
          !new RegExp(`Test failpoint after ${stage}`).test(output)
        ) {
          failures.push(`failpoint ${stage} did not fail cleanly: ${output}`);
          break;
        }
        if (
          await access(failBundle).then(
            () => true,
            () => false,
          )
        ) {
          failures.push(`failpoint ${stage} published bundle ${failBundle}`);
          break;
        }
        const cleanupReceipt = cleanupReceiptFromFailure(output);
        const receiptRequired = !["activation", "hwnd"].includes(stage);
        if (receiptRequired && !cleanupReceipt) {
          failures.push(`failpoint ${stage} omitted exact cleanup receipt: ${output}`);
          break;
        }
        if (cleanupReceipt) {
          await assertReceiptAbsent(
            `failpoint ${stage}`,
            cleanupReceipt,
            suiteBaseline,
          );
        } else {
          await assertBaselineRestored(`failpoint ${stage}`, suiteBaseline);
        }
        if (failures.length > 0) break;
      }
    }

    if (failures.length === 0 && !nativeBaselineOnlyRequested) {
      const originalSpec = JSON.parse(await readFile(specPath, "utf8"));
      const wrappedOverflow = structuredClone(originalSpec);
      const wrappedText = wrappedOverflow.slides
        .flatMap((slide) => slide.primitives)
        .find((primitive) => primitive.kind === "text");
      wrappedText.w = 80;
      wrappedText.h = 120;
      wrappedText.text =
        "newline free wrapped text exceeds one rendered line without exceeding its box";
      wrappedText.maxLines = 1;
      const wrappedSpecPath = join(temp, "wrapped-overflow-spec.json");
      const wrappedBundle = join(temp, "wrapped-overflow-bundle");
      await writeFile(wrappedSpecPath, JSON.stringify(wrappedOverflow), "utf8");
      const wrappedResult = runPowerShell(worker, [
        "-Spec",
        wrappedSpecPath,
        "-ExpectedSpecSha256",
        sha256(await readFile(wrappedSpecPath)),
        "-Skeleton",
        skeletonPath,
        "-OutputDirectory",
        wrappedBundle,
      ]);
      const wrappedOutputText = `${wrappedResult.stdout}${wrappedResult.stderr}`;
      const wrappedReceipt = cleanupReceiptFromFailure(wrappedOutputText);
      if (
        wrappedResult.status === 0 ||
        !/exceeding maxLines/.test(wrappedOutputText) ||
        !wrappedReceipt
      ) {
        failures.push(
          `newline-free wrapped overflow did not hit rendered bounds: ${wrappedOutputText}`,
        );
      } else {
        await assertReceiptAbsent(
          "newline-free wrapped overflow",
          wrappedReceipt,
          suiteBaseline,
        );
      }
      if (
        await access(wrappedBundle).then(
          () => true,
          () => false,
        )
      ) {
        failures.push(`wrapped maxLines regression published ${wrappedBundle}`);
      }
    }

    if (failures.length === 0 && !nativeBaselineOnlyRequested) {
      const mutationBundle = join(temp, "mutation-before-open-bundle");
      const mutationResult = runPowerShell(
        worker,
        [
          "-Spec",
          specPath,
          "-ExpectedSpecSha256",
          expectedSpecSha256,
          "-Skeleton",
          skeletonPath,
          "-OutputDirectory",
          mutationBundle,
        ],
        {
          FDE_POWERPOINT_TEST_FAILPOINTS: "1",
          FDE_POWERPOINT_TEST_MUTATE_CANDIDATE_BEFORE_OPEN: "1",
        },
      );
      const mutationOutput = `${mutationResult.stdout}${mutationResult.stderr}`;
      const mutationReceipt = cleanupReceiptFromFailure(mutationOutput);
      if (
        mutationResult.status === 0 ||
        !/Staged skeleton bytes changed before Presentations\.Open/.test(
          mutationOutput,
        ) ||
        !mutationReceipt ||
        (await access(mutationBundle).then(
          () => true,
          () => false,
        ))
      ) {
        failures.push(`candidate TOCTOU hook failed: ${mutationOutput}`);
      } else {
        await assertReceiptAbsent(
          "candidate mutation before open",
          mutationReceipt,
          suiteBaseline,
        );
      }
    }

    if (failures.length === 0 && !nativeBaselineOnlyRequested) {
      const originalSpec = JSON.parse(await readFile(specPath, "utf8"));
      for (const unsupported of ["table", "nativeChart", "connector"]) {
        const rejected = structuredClone(originalSpec);
        rejected.slides[0].primitives[0].kind = unsupported;
        const rejectedPath = join(temp, `unsupported-${unsupported}.json`);
        const rejectedBundle = join(temp, `unsupported-${unsupported}-bundle`);
        await writeFile(rejectedPath, JSON.stringify(rejected), "utf8");
        const result = runPowerShell(worker, [
          "-Spec",
          rejectedPath,
          "-ExpectedSpecSha256",
          sha256(await readFile(rejectedPath)),
          "-Skeleton",
          skeletonPath,
          "-OutputDirectory",
          rejectedBundle,
        ]);
        if (
          result.status === 0 ||
          !result.stderr.includes(`Unsupported primitive kind '${unsupported}'`) ||
          (await access(rejectedBundle).then(
            () => true,
            () => false,
          ))
        ) {
          failures.push(
            `unsupported ${unsupported} rejection failed: ${result.stdout}${result.stderr}`,
          );
          break;
        }
      }
    }
  } finally {
    if (!nativeBaselineOnlyRequested) {
      await rm(temp, { recursive: true, force: true });
    }
  }
}

if (failures.length > 0) {
  console.error("Basic PowerPoint worker tests failed:");
  failures.forEach((failure, index) =>
    console.error(`${index + 1}. ${failure}`),
  );
  process.exit(1);
}

if (nativeBaselineOnlyRequested) {
  console.log(
    `Basic PowerPoint worker baseline preservation test passed. Artifacts: ${nativeArtifactDirectory}`,
  );
} else {
  console.log("Basic PowerPoint worker native suite passed.");
}
