#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
  win32 as windowsPath,
} from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";

import {
  CoordinatorError,
  parseCoordinatorArgs,
  runChildWatchdogForTest,
  runPowerPointNativeCoordinator,
  runPowerPointNativeCoordinatorForTest,
} from "./powerpoint-native-coordinator.mjs";
import {
  compileReadoutPlan,
  stableSerialize,
} from "./powerpoint-layout.mjs";
import {
  canonicalizeJson,
  selectSmokeSlides,
} from "./powerpoint-smoke-contract.mjs";

const scriptsDirectory = fileURLToPath(new URL(".", import.meta.url));
const skillRoot = resolve(scriptsDirectory, "..");
const examplePlan = join(
  skillRoot,
  "assets",
  "examples",
  "lattice-harbor-readout-plan.json",
);
const coordinatorPath = join(scriptsDirectory, "powerpoint-native-coordinator.mjs");
const ownedProcessWatchdogPath = join(
  scriptsDirectory,
  "powerpoint-owned-process-watchdog.ps1",
);
const smokeContractPath = join(
  scriptsDirectory,
  "powerpoint-smoke-contract.mjs",
);
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "fde-powerpoint-native-coordinator-"),
);
const hashPattern = /^[a-f0-9]{64}$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function nativeNotesText(value) {
  return String(value).replace(/\r\n|\n/g, "\r");
}

function jsonText(value) {
  return `${canonicalizeJson(value)}\n`;
}

function argument(args, name) {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `missing child argument ${name}`);
  return args[index + 1];
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function relativeFiles(root) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(relative(root, path).split(sep).join("/"));
    }
  }
  await walk(root);
  return files.sort();
}

async function relativeEntries(root) {
  const entries = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      entries.push(relative(root, path).split(sep).join("/"));
      if (entry.isDirectory()) await walk(path);
    }

  }
  await walk(root);
  return entries.sort();
}

async function assertPublicationManifest(report, root) {
  const actualFiles = await relativeFiles(root);
  assert.deepEqual(report.publication.expectedFiles, actualFiles);
  const payloadFiles = actualFiles.filter(
    (path) => path !== "coordinator-report.json",
  );
  assert.equal(report.publication.algorithm, "sha256");
  assert.equal(report.publication.payload.fileCount, payloadFiles.length);
  assert.deepEqual(
    report.publication.payload.files.map((file) => file.path),
    payloadFiles,
  );
  const payloadByPath = new Map(
    report.publication.payload.files.map((file) => [file.path, file]),
  );
  for (const file of report.publication.payload.files) {
    const bytes = await readFile(join(root, file.path));
    assert.equal(file.bytes, bytes.length);
    assert.equal(file.sha256, sha256(bytes));
  }
  for (const artifact of [
    report.artifacts.presentation,
    report.artifacts.contactSheet,
    report.artifacts.workerReport,
    report.artifacts.packageQa,
    ...(report.artifacts.smokeReport ? [report.artifacts.smokeReport] : []),
    ...report.artifacts.renders,
  ]) {
    assert.equal(payloadByPath.get(artifact.path)?.sha256, artifact.sha256);
  }
}

function expectedFinalFiles(mode, slideCount) {
  return [
    "coordinator-report.json",
    "package-qa.json",
    "readout.pptx",
    "worker-report.json",
    "native-render/contact-sheet.png",
    ...Array.from(
      { length: slideCount },
      (_, index) => `native-render/slide-${String(index + 1).padStart(3, "0")}.png`,
    ),
    ...(mode === "smoke" ? ["smoke-report.json"] : []),
  ].sort();
}

function connectorRoutes(slide) {
  const groups = new Map();
  for (const primitive of slide.primitives) {
    if (
      primitive.kind !== "line" ||
      !Number.isSafeInteger(primitive.edgeIndex) ||
      !Number.isSafeInteger(primitive.segmentIndex)
    ) {
      continue;
    }
    if (!groups.has(primitive.edgeIndex)) groups.set(primitive.edgeIndex, []);
    groups.get(primitive.edgeIndex).push(primitive);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([edgeIndex, segments]) => {
    segments.sort((left, right) => left.segmentIndex - right.segmentIndex);
    const first = segments[0];
    const points = [
      { x: first.x1, y: first.y1 },
      ...segments.map((segment) => ({ x: segment.x2, y: segment.y2 })),
    ];
    return {
      edgeIndex,
      kind: first.role.match(/^workflow-edge-(system|decision)-/)[1],
      sourceNodeId: first.sourceNodeId,
      targetNodeId: first.targetNodeId,
      segmentCount: segments.length,
      points,
      pointSequenceSha256: sha256(
        JSON.stringify({ edgeIndex, points }),
      ),
      declaredCost: null,
      costStatus: "not-declared-by-fde-drawing-spec/1.0",
    };
    });
}

function connectorProjection(spec) {
  const allPrimitives = [];
  const allMetadata = [];
  const allPointSequences = [];
  const slides = spec.slides.map((slide) => {
    const primitives = slide.primitives
      .filter(
        (primitive) =>
          primitive.kind === "line" &&
          /^workflow-edge-(system|decision)-\d{2}$/.test(primitive.role),
      )
      .map((primitive) => ({
        name: primitive.name,
        role: primitive.role,
        z: primitive.z,
        x1: primitive.x1,
        y1: primitive.y1,
        x2: primitive.x2,
        y2: primitive.y2,
        colorRole: primitive.colorRole,
        transparency: primitive.transparency,
        width: primitive.width,
        dash: primitive.dash,
        arrowStart: primitive.arrowStart,
        arrowEnd: primitive.arrowEnd,
        sourceNodeId: primitive.sourceNodeId,
        targetNodeId: primitive.targetNodeId,
        edgeIndex: primitive.edgeIndex,
        segmentIndex: primitive.segmentIndex,
      }));
    const routes = connectorRoutes(slide);
    const metadata = routes.map((route) => ({
      edgeIndex: route.edgeIndex,
      kind: route.kind,
      sourceNodeId: route.sourceNodeId,
      targetNodeId: route.targetNodeId,
      segmentCount: route.segmentCount,
    }));
    const pointSequences = routes.map((route) => ({
      edgeIndex: route.edgeIndex,
      points: route.points,
    }));
    allPrimitives.push(...primitives);
    allMetadata.push(...metadata);
    allPointSequences.push(...pointSequences);
    return {
      primitiveSha256: sha256(JSON.stringify(primitives)),
      routeMetadataSha256: sha256(JSON.stringify(metadata)),
      pointSequenceSha256: sha256(JSON.stringify(pointSequences)),
      routes,
    };
  });
  return {
    primitiveSha256: sha256(JSON.stringify(allPrimitives)),
    routeMetadataSha256: sha256(JSON.stringify(allMetadata)),
    pointSequenceSha256: sha256(JSON.stringify(allPointSequences)),
    slides,
  };
}

function chartShapeNames(primitive) {
  const names = [
    primitive.name,
    `${primitive.name.slice(0, -13)}-chart-bounds`,
    ...primitive.axis.ticks.map((tick) => tick.gridLine.name),
  ];
  for (const series of primitive.series) {
    names.push(
      ...(primitive.chartType === "bar" ? series.bars : series.segments).map(
        (item) => item.name,
      ),
    );
  }
  names.push(primitive.axis.baseline.name);
  if (primitive.chartType === "line") {
    for (const series of primitive.series) {
      names.push(...series.markers.map((marker) => marker.name));
    }
  }
  names.push(
    ...primitive.legend.map((entry) => entry.swatchName),
    primitive.unitLabel.name,
    ...primitive.axis.ticks.map((tick) => tick.labelBox.name),
    ...primitive.categories.map((category) => category.labelBox.name),
    ...primitive.legend.map((entry) => entry.labelBox.name),
  );
  for (const row of primitive.dataGrid.rows) {
    names.push(row.labelBox.name, ...row.values.map((value) => value.labelBox.name));
  }
  return names;
}

function shapeProjection(slide) {
  const recursiveNames = [];
  const chartNames = [];
  for (const primitive of slide.primitives) {
    if (primitive.kind === "nativeChart") {
      const names = chartShapeNames(primitive);
      recursiveNames.push(...names);
      chartNames.push(...names);
    } else {
      recursiveNames.push(primitive.name);
    }
  }
  const tables = slide.primitives.filter((primitive) => primitive.kind === "table");
  return {
    recursiveNames,
    chartNames,
    nativeTableCount: tables.length,
    nativeTableCellCount: tables.reduce(
      (total, table) => total + table.headers.length * (table.rows.length + 1),
      0,
    ),
  };
}

function fakePackageQa(presentationBytes, slideCount) {
  const slides = Array.from({ length: slideCount }, (_, index) => ({
    index: index + 1,
    notesPart: `ppt/notesSlides/notesSlide${index + 1}.xml`,
    notesSha256: sha256(`notes-${index + 1}`),
    part: `ppt/slides/slide${index + 1}.xml`,
    sha256: sha256(`slide-${index + 1}`),
  }));
  const parts = [
    {
      compressedSize: presentationBytes.length,
      compressionMethod: "stored",
      name: "[Content_Types].xml",
      sha256: sha256("content-types"),
      uncompressedSize: presentationBytes.length,
    },
    ...slides.flatMap((slide) => [
      {
        compressedSize: 10,
        compressionMethod: "deflate",
        name: slide.part,
        sha256: slide.sha256,
        uncompressedSize: 20,
      },
      {
        compressedSize: 10,
        compressionMethod: "deflate",
        name: slide.notesPart,
        sha256: slide.notesSha256,
        uncompressedSize: 20,
      },
    ]),
  ].sort((left, right) => left.name.localeCompare(right.name, "en"));
  return {
    schemaVersion: 1,
    valid: true,
    package: {
      byteLength: presentationBytes.length,
      sha256: sha256(presentationBytes),
    },
    counts: {
      archiveEntries: parts.length,
      notes: slideCount,
      parts: parts.length,
      relationships: slideCount * 2 + 3,
      slides: slideCount,
    },
    slides,
    parts,
    findings: [],
  };
}

function createStubRunner(options = {}) {
  const calls = [];
  const state = {
    calls,
    currentSpec: undefined,
    skeletonModes: [],
  };
  const runner = async (request) => {
    calls.push(structuredClone(request));
    assert.equal(Object.hasOwn(request, "timeout"), false);
    assert.equal(Object.hasOwn(request, "signal"), false);
    assert.equal(Object.hasOwn(request, "killSignal"), false);
    assert.equal(typeof request.env, "object");
    assert.equal(
      Object.keys(request.env).some((key) => /^FDE_/i.test(key)),
      false,
    );
    assert.equal(Object.hasOwn(request.env, "NODE_OPTIONS"), false);
    assert.equal(request.env.PATH.includes("malicious-powershell"), false);
    assert.equal(request.env.PATH.includes(dirname(process.execPath)), true);
    if (["native-skeleton", "native-worker"].includes(request.name)) {
      assert.equal(windowsPath.isAbsolute(request.command), true);
      assert.match(
        request.command,
        /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i,
      );
    } else {
      assert.equal(resolve(request.command), request.command);
    }

    if (request.name === "spec-compiler") {
      const planPath = argument(request.args, "--plan");
      const mode = argument(request.args, "--mode");
      const outputPath = argument(request.args, "--output");
      const planBytes = await readFile(planPath);
      const plan = JSON.parse(planBytes);
      const planHash = sha256(planBytes);
      const spec = compileReadoutPlan(plan, {
        mode,
        sourcePlanSha256: planHash,
      });
      const specBytes = Buffer.from(stableSerialize(spec), "utf8");
      await writeFile(outputPath, specBytes, { flag: "wx" });
      state.currentSpec = spec;
      if (options.mutatePlanDuringCompile) {
        await writeFile(planPath, `${planBytes.toString("utf8")} `);
      }
      if (options.mutateSmokeBundleDuringFull && mode === "full") {
        await writeFile(
          join(options.mutateSmokeBundleDuringFull, "native-render", "contact-sheet.png"),
          "mutated-after-review",
        );
      }
      return {
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: jsonText({
          status: "PASS",
          mode,
          sourcePlanSha256: planHash,
          selectedSlideIds: spec.selectedSlideIds,
          selectedSlideFamilies: spec.selectedSlideFamilies,
          outputPath,
          outputSha256: sha256(specBytes),
          primitiveCount: spec.slides.reduce(
            (total, slide) => total + slide.primitives.length,
            0,
          ),
        }),
      };
    }

    if (request.name === "native-skeleton") {
      assert.equal(request.cleanupSensitive, true);
      assert.equal(request.timeoutMilliseconds, 300_000);
      assert.equal(
        argument(request.args, "-OwnershipReceipt"),
        request.ownershipReceiptPath,
      );
      assert.equal(
        request.expectedOwnershipOwner,
        "fde-powerpoint-skeleton/1.0",
      );
      const planPath = argument(request.args, "-Plan");
      const outputPath = argument(request.args, "-Output");
      const planBytes = await readFile(planPath);
      const plan = JSON.parse(planBytes);
      const smokeSlideIds = request.args.includes("-SmokeSlideIds")
        ? argument(request.args, "-SmokeSlideIds").split(",")
        : undefined;
      const mode = smokeSlideIds ? "smoke" : "full";
      state.skeletonModes.push(mode);
      const selection = smokeSlideIds
        ? selectSmokeSlides(plan)
        : plan.slides;
      const skeletonBytes = Buffer.from(
        `PK-stub-skeleton-${mode}-${state.skeletonModes.length}-${sha256(planBytes)}`,
        "utf8",
      );
      await writeFile(outputPath, skeletonBytes, { flag: "wx" });
      return {
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: jsonText({
          output: outputPath,
          slides: selection.length,
          verifiedNotes: selection.length,
          widthPoints: 960,
          heightPoints: 540,
          selectionMode: mode,
          sourcePlanSha256: sha256(planBytes),
          selectedSlideIds: selection.map((slide) => slide.id),
          selectedSlideFamilies: selection.map((slide) => slide.family),
          packageSlides: selection.length,
          packageNotesParts: selection.length,
          uniqueNotesRelationships: selection.length,
          macroFree: true,
          sha256: sha256(skeletonBytes),
          powerPointCleanup: {
            ownedProcessId: 4100 + state.skeletonModes.length,
            exited: true,
            mode: "graceful",
            graceSeconds: 8,
          },
        }),
      };
    }

    if (request.name === "native-worker") {
      assert.equal(request.cleanupSensitive, true);
      assert.equal(request.timeoutMilliseconds, 1_800_000);
      assert.equal(
        argument(request.args, "-OwnershipReceipt"),
        request.ownershipReceiptPath,
      );
      assert.equal(
        request.expectedOwnershipOwner,
        "fde-powerpoint-native-shapes/2.0",
      );
      assert.equal(argument(request.args, "-NodeExecutable"), process.execPath);
      if (options.workerFailure) {
        return {
          abnormalCleanup: {
            cleanupSensitive: true,
            childExited: true,
            ownershipReceiptPath: request.ownershipReceiptPath,
            ownershipStatus: "validated",
            ownershipReceiptTiming: "after-exit",
            contaminationRisk: false,
            ownershipCleanup: {
              status: "already-exited",
              exactIdentity: true,
              exited: true,
            },
          },
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "stub worker failed after cleanup",
        };
      }
      const specPath = argument(request.args, "-Spec");
      const skeletonPath = argument(request.args, "-Skeleton");
      const outputDirectory = argument(request.args, "-OutputDirectory");
      const specBytes = await readFile(specPath);
      const skeletonBytes = await readFile(skeletonPath);
      const spec = JSON.parse(specBytes);
      const expectedConnectors = connectorProjection(spec);
      await mkdir(join(outputDirectory, "native-render"), { recursive: true });
      const presentationBytes = Buffer.from(
        `PK-stub-presentation-${spec.source.planSha256}-${spec.selectedSlideIds.join(",")}`,
        "utf8",
      );
      await writeFile(join(outputDirectory, "readout.pptx"), presentationBytes);
      const slideReports = [];
      const connectorSlides = [];
      for (let index = 0; index < spec.slides.length; index += 1) {
        const specSlide = spec.slides[index];
        const render = `slide-${String(index + 1).padStart(3, "0")}.png`;
        const renderBytes = Buffer.from(`PNG-stub-${specSlide.id}`, "utf8");
        await writeFile(join(outputDirectory, "native-render", render), renderBytes);
        const expectedShapes = shapeProjection(specSlide);
        const expectedConnectorSlide = expectedConnectors.slides[index];
        const nativeTableCount = expectedShapes.nativeTableCount;
        const nativeChartShapeCount = expectedShapes.chartNames.length;
        const shapeCount = specSlide.primitives.length;
        const recursiveShapeCount = expectedShapes.recursiveNames.length;
        const routes = connectorRoutes(specSlide);
        const segmentCount = routes.reduce(
          (total, route) => total + route.segmentCount,
          0,
        );
        const connectorPrimitiveSha256 = expectedConnectorSlide.primitiveSha256;
        const routeMetadataSha256 = expectedConnectorSlide.routeMetadataSha256;
        const pointSequenceSha256 = expectedConnectorSlide.pointSequenceSha256;
        connectorSlides.push({
          index: index + 1,
          id: specSlide.id,
          family: specSlide.family,
          routeCount: routes.length,
          segmentCount,
          connectorPrimitiveSha256,
          routeMetadataSha256,
          pointSequenceSha256,
          costStatus: "not-declared-by-fde-drawing-spec/1.0",
          routes,
        });
        slideReports.push({
          index: index + 1,
          id: specSlide.id,
          family: specSlide.family,
          backgroundColorRole: specSlide.backgroundColorRole,
          primitiveCount: specSlide.primitives.length,
          primitiveSha256: sha256(canonicalizeJson(specSlide.primitives)),
          shapeCount,
          shapeNamesSha256: sha256(
            specSlide.primitives.map((primitive) => primitive.name).join("\n"),
          ),
          recursiveShapeCount,
          recursiveShapeNamesSha256: sha256(expectedShapes.recursiveNames.join("\n")),
          recursiveShapeGeometrySha256: sha256(`geometry-${specSlide.id}`),
          recursiveShapeContentSha256: sha256(`content-${specSlide.id}`),
          recursiveShapeStyleSha256: sha256(`style-${specSlide.id}`),
          nativeChartShapeCount,
          nativeChartShapeNamesSha256: sha256(expectedShapes.chartNames.join("\n")),
          nativeTableCount,
          nativeTableCellCount: expectedShapes.nativeTableCellCount,
          connectorRouteCount: routes.length,
          connectorSegmentCount: segmentCount,
          connectorPrimitiveSha256,
          connectorRouteMetadataSha256: routeMetadataSha256,
          connectorPointSequenceSha256: pointSequenceSha256,
          connectorCostStatus: "not-declared-by-fde-drawing-spec/1.0",
          render,
          renderSha256: sha256(renderBytes),
          notesSha256: sha256(
            Buffer.from(nativeNotesText(specSlide.notesText), "utf8"),
          ),
          overflow: false,
        });
      }
      const contactSheetBytes = Buffer.from(
        `PNG-contact-${spec.selectedSlideIds.join(",")}`,
        "utf8",
      );
      await writeFile(
        join(outputDirectory, "native-render", "contact-sheet.png"),
        contactSheetBytes,
      );
      const reportPath = join(outputDirectory, "worker-report.json");
      const report = {
        status: "WORKER_PASS",
        stagingEvidence: true,
        worker: "fde-powerpoint-native-shapes/2.0",
        spec: specPath,
        specSha256: sha256(specBytes),
        skeleton: skeletonPath,
        skeletonSha256: sha256(skeletonBytes),
        presentation: join(outputDirectory, "readout.pptx"),
        presentationSha256: options.workerHashMismatch
          ? sha256("wrong-presentation")
          : sha256(presentationBytes),
        renderDirectory: join(outputDirectory, "native-render"),
        report: reportPath,
        contactSheet: join(outputDirectory, "native-render", "contact-sheet.png"),
        contactSheetSha256: sha256(contactSheetBytes),
        selectedSlideIds: spec.selectedSlideIds,
        selectedSlideFamilies: spec.selectedSlideFamilies,
        connectors: {
          drawingNameCount: spec.slides.reduce(
            (total, slide) => total + slide.primitives.length,
            0,
          ),
          slideCount: spec.slides.length,
          routeCount: connectorSlides.reduce(
            (total, slide) => total + slide.routeCount,
            0,
          ),
          segmentCount: connectorSlides.reduce(
            (total, slide) => total + slide.segmentCount,
            0,
          ),
          primitiveSha256: expectedConnectors.primitiveSha256,
          routeMetadataSha256: expectedConnectors.routeMetadataSha256,
          pointSequenceSha256: expectedConnectors.pointSequenceSha256,
          costStatus: "not-declared-by-fde-drawing-spec/1.0",
          reopenedExactVerification: true,
          slides: connectorSlides,
        },
        slides: slideReports,
        nativeShapes: {
          recursiveShapeCount: slideReports.reduce(
            (total, slide) => total + slide.recursiveShapeCount,
            0,
          ),
          nativeChartShapeCount: slideReports.reduce(
            (total, slide) => total + slide.nativeChartShapeCount,
            0,
          ),
          recursiveShapeTreeSha256: sha256(
            slideReports
              .map(
                (slide) =>
                  `${slide.id}|${slide.recursiveShapeNamesSha256}|${slide.recursiveShapeGeometrySha256}|${slide.recursiveShapeContentSha256}|${slide.recursiveShapeStyleSha256}`,
              )
              .join("\n"),
          ),
        },
        cleanup: {
          ownedProcessId: 5100,
          ownedProcessStartUtc: "2026-01-15T09:30:00.0000000Z",
          ownedProcessPath: "C:\\Program Files\\Microsoft Office\\POWERPNT.EXE",
          exited: true,
          mode: "graceful",
          graceSeconds: 8,
          contaminationDetected: false,
          releaseErrors: [],
        },
        elapsedMilliseconds: 125,
      };
      if (options.malformedWorkerReceipt) {
        report.slides[0].recursiveShapeStyleSha256 = "not-a-hash";
      }
      if (options.wrongPrimitiveReceipt) {
        report.slides[0].primitiveSha256 = sha256("valid-but-wrong-primitives");
      }
      if (options.wrongTableReceipt) {
        report.slides[0].nativeTableCount += 1;
      }
      if (options.wrongConnectorReceipt) {
        const wrongHash = sha256("valid-but-wrong-connectors");
        report.slides[0].connectorPrimitiveSha256 = wrongHash;
        report.connectors.slides[0].connectorPrimitiveSha256 = wrongHash;
      }
      if (options.missingConnectorSlides) {
        report.connectors.slides = [];
      }
      await writeFile(reportPath, jsonText(report));
      return {
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: jsonText(report),
      };
    }

    if (request.name === "package-qa") {
      if (options.packageQaFailure) {
        return {
          exitCode: 1,
          signal: null,
          stderr: "",
          stdout: jsonText({
            schemaVersion: 1,
            valid: false,
            package: { byteLength: 1, sha256: sha256("bad") },
            counts: {
              archiveEntries: 0,
              notes: 0,
              parts: 0,
              relationships: 0,
              slides: 0,
            },
            slides: [],
            parts: [],
            findings: [
              {
                code: "MEDIA_PART_FORBIDDEN",
                message: "stub package QA failure",
                severity: "error",
              },
            ],
          }),
        };
      }
      const presentationPath = request.args.at(-1);
      const presentationBytes = await readFile(presentationPath);
      if (options.createOutputDuringPackageQa) {
        await mkdir(options.createOutputDuringPackageQa);
      }
      let slideCount = state.currentSpec?.slides.length;
      if (slideCount === undefined) {
        const persistedQa = JSON.parse(
          await readFile(join(dirname(presentationPath), "package-qa.json"), "utf8"),
        );
        slideCount = persistedQa.counts.slides;
      }
      const report = fakePackageQa(presentationBytes, slideCount);
      if (options.malformedPackageReceipt) {
        report.parts[0].sha256 = "not-a-hash";
      }
      if (options.inconsistentPackagePartHash) {
        report.slides[0].sha256 = sha256("valid-but-wrong-slide-part");
      }
      return {
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: jsonText(report),
      };
    }

    throw new Error(`unexpected child ${request.name}`);
  };
  return { runner, state };
}

async function newCase(name) {
  const root = join(temporaryDirectory, name);
  await mkdir(root);
  const planPath = join(root, "plan.json");
  const plan = JSON.parse(await readFile(examplePlan, "utf8"));
  const collectEvidenceIds = (value, ids) => {
    if (Array.isArray(value)) {
      value.forEach((item) => collectEvidenceIds(item, ids));
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value.evidenceIds)) {
      value.evidenceIds.forEach((id) => ids.add(id));
    }
    Object.values(value).forEach((item) => collectEvidenceIds(item, ids));
  };
  for (const slide of plan.slides) {
    const evidenceIds = new Set(slide.evidenceIds);
    collectEvidenceIds(slide.content, evidenceIds);
    slide.evidenceIds = [...evidenceIds];
  }
  await writeFile(planPath, jsonText(plan));
  return {
    root,
    planPath,
    smokeOutput: join(root, "smoke-bundle"),
    fullOutput: join(root, "full-bundle"),
  };
}

async function expectCoordinatorError(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof CoordinatorError);
    assert.equal(error.code, code);
    return true;
  });
}

function createFakeSpawn({ closeOnKill = true, beforeFirstClose } = {}) {
  const state = { child: null, killCount: 0 };
  const spawnChild = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      state.killCount += 1;
      if (closeOnKill && !child.closed) {
        const close = () => {
          child.closed = true;
          child.emit("close", null, "SIGTERM");
        };
        if (state.killCount === 1 && beforeFirstClose) {
          Promise.resolve(beforeFirstClose()).then(close);
        } else {
          close();
        }
      }
      return true;
    };
    child.closed = false;
    state.child = child;
    return child;
  };
  return { spawnChild, state };
}

function createAbnormalExitSpawn(exitCode = 1, signal = null) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const spawnChild = () => {
    setImmediate(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", exitCode, signal);
    });
    return child;
  };
  return { child, spawnChild };
}

function ownershipReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    owner: "fde-powerpoint-skeleton/1.0",
    status: "owned",
    processId: 4242,
    processStartTimeUtc: "2026-01-15T09:30:00.0000000Z",
    processPath: String.raw`C:\Program Files\Microsoft Office\POWERPNT.EXE`,
    ...overrides,
  };
}

function watchdogRequest(receiptPath) {
  return {
    name: "watchdog-test",
    command: "stub",
    args: [],
    cwd: dirname(receiptPath),
    cleanupSensitive: true,
    expectedOwnershipOwner: "fde-powerpoint-skeleton/1.0",
    ownershipReceiptPath: receiptPath,
    timeoutMilliseconds: 5,
  };
}

async function expectWatchdogTimeout(action, verify) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof CoordinatorError);
    assert.equal(error.code, "CHILD_TIMEOUT");
    verify(error.details);
    return true;
  });
}

async function runSmoke(
  casePaths,
  stub = createStubRunner(),
  harnessOverrides = {},
  optionOverrides = {},
) {
  const report = await runPowerPointNativeCoordinatorForTest(
    {
      mode: "smoke",
      plan: casePaths.planPath,
      output: casePaths.smokeOutput,
      ...optionOverrides,
    },
    {
      childRunner: stub.runner,
      removeDirectory: undefined,
      publicationHook: undefined,
      ...harnessOverrides,
    },
  );
  return { report, stub };
}

async function runFull(
  casePaths,
  stub = createStubRunner(),
  harnessOverrides = {},
  optionOverrides = {},
) {
  const report = await runPowerPointNativeCoordinatorForTest(
    {
      mode: "full",
      plan: casePaths.planPath,
      output: casePaths.fullOutput,
      approveSmoke: true,
      smokeBundle: casePaths.smokeOutput,
      ...optionOverrides,
    },
    {
      childRunner: stub.runner,
      removeDirectory: undefined,
      publicationHook: undefined,
      ...harnessOverrides,
    },
  );
  return { report, stub };
}

try {
  {
    await expectCoordinatorError(
      () =>
        runPowerPointNativeCoordinator(
          { mode: "smoke", plan: "ignored", output: "ignored" },
          { childRunner: createStubRunner().runner },
        ),
      "ARGUMENT_INVALID",
    );
    const smokeArgs = [
      "--mode",
      "smoke",
      "--plan",
      "plan.json",
      "--output",
      "bundle",
    ];
    const parsed = parseCoordinatorArgs(smokeArgs);
    assert.equal(parsed.options.mode, "smoke");
    assert.equal(Object.hasOwn(parsed.options, "approveSmoke"), false);
    const fullArgs = [
      "--mode",
      "full",
      "--plan",
      "plan.json",
      "--smoke-bundle",
      "smoke-bundle",
      "--approve-smoke",
      "--output",
      "bundle",
    ];
    const parsedFull = parseCoordinatorArgs(fullArgs);
    assert.equal(parsedFull.options.mode, "full");
    assert.equal(parsedFull.options.approveSmoke, true);
    assert.equal(parsedFull.options.smokeBundle, "smoke-bundle");
    assert.throws(
      () => parseCoordinatorArgs(fullArgs.filter((value) => value !== "--approve-smoke")),
      (error) =>
        error instanceof CoordinatorError &&
        error.code === "ARGUMENT_INVALID" &&
        error.details.errors.some((message) => /full mode requires --approve-smoke/.test(message)),
    );
    assert.throws(
      () => parseCoordinatorArgs([...smokeArgs, "--approve-smoke"]),
      (error) =>
        error instanceof CoordinatorError &&
        error.code === "ARGUMENT_INVALID" &&
        error.details.errors.some((message) => /smoke mode does not accept --approve-smoke/.test(message)),
    );
    for (const [flag, value] of [
      ["--approval", "approval.json"],
      ["--trusted-keyring", "caller-keyring.json"],
      ["--private-key", "signer.pem"],
      ["--signer", "self"],
    ]) {
      assert.throws(
        () => parseCoordinatorArgs([...fullArgs, flag, value]),
        (error) =>
          error instanceof CoordinatorError &&
          error.code === "ARGUMENT_INVALID" &&
          error.details.errors.some((message) =>
            new RegExp(`unknown argument: ${flag}`).test(message),
          ),
      );
    }
    assert.throws(
      () => parseCoordinatorArgs([...fullArgs, "--approve-smoke"]),
      (error) =>
        error instanceof CoordinatorError &&
        error.details.errors.some((message) => /duplicate argument: --approve-smoke/.test(message)),
    );
    const cliFailure = spawnSync(
      process.execPath,
      [
        coordinatorPath,
        "--mode",
        "full",
        "--plan",
        "plan.json",
        "--output",
        "bundle",
        "--private-key",
        "signer.pem",
      ],
      { encoding: "utf8" },
    );
    assert.equal(cliFailure.status, 2);
    assert.equal(cliFailure.stdout, "");
    const errorReceipt = JSON.parse(cliFailure.stderr);
    assert.deepEqual(Object.keys(errorReceipt).sort(), [
      "code",
      "details",
      "message",
      "schemaVersion",
      "stage",
      "status",
    ]);
    assert.equal(errorReceipt.status, "COORDINATOR_ERROR");
    assert.equal(errorReceipt.code, "ARGUMENT_INVALID");
    assert.equal(errorReceipt.stage, "arguments");
    const help = spawnSync(
      process.execPath,
      [coordinatorPath, "--help"],
      { encoding: "utf8" },
    );
    assert.equal(help.status, 0);
    assert.equal(help.stderr, "");
    assert.match(
      help.stdout,
      /--mode full --plan <plan> --smoke-bundle <dir> --approve-smoke --output <new-dir>/,
    );
  }

  {
    const casePaths = await newCase("sanitized-production-shaped-requests");
    const saved = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      FDE_POWERPOINT_TEST_FAILPOINTS:
        process.env.FDE_POWERPOINT_TEST_FAILPOINTS,
      FDE_POWERPOINT_TEST_MUTATE_CANDIDATE_BEFORE_OPEN:
        process.env.FDE_POWERPOINT_TEST_MUTATE_CANDIDATE_BEFORE_OPEN,
    };
    try {
      process.env.PATH = String.raw`C:\malicious-powershell`;
      process.env.SystemRoot = String.raw`C:\attacker-controlled-windows`;
      process.env.NODE_OPTIONS = "--require attacker-process-injection.js";
      process.env.FDE_POWERPOINT_TEST_FAILPOINTS = "1";
      process.env.FDE_POWERPOINT_TEST_MUTATE_CANDIDATE_BEFORE_OPEN = "1";
      const { stub } = await runSmoke(casePaths);
      for (const request of stub.state.calls) {
        assert.equal(request.env.PATH.includes("malicious-powershell"), false);
        assert.equal(
          request.env.SystemRoot,
          String.raw`C:\Windows`,
        );
        if (request.cleanupSensitive) {
          assert.equal(
            request.command,
            String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
          );
        }
        assert.equal(Object.hasOwn(request.env, "NODE_OPTIONS"), false);
        assert.equal(
          Object.keys(request.env).some((key) => /^FDE_/i.test(key)),
          false,
        );
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  {
    const casePaths = await newCase("success");
    const smokeStub = createStubRunner();
    const { report: smokeReport } = await runSmoke(casePaths, smokeStub);
    const plan = JSON.parse(await readFile(casePaths.planPath, "utf8"));
    const smokeSelection = selectSmokeSlides(plan);
    assert.equal(smokeReport.status, "COORDINATOR_PASS");
    assert.equal(smokeReport.mode, "smoke");
    assert.deepEqual(
      smokeReport.selection.selectedSlideIds,
      smokeSelection.map((slide) => slide.id),
    );
    assert.deepEqual(
      await relativeFiles(casePaths.smokeOutput),
      expectedFinalFiles("smoke", 3),
    );
    const persistedSmokeCoordinator = JSON.parse(
      await readFile(join(casePaths.smokeOutput, "coordinator-report.json"), "utf8"),
    );
    assert.deepEqual(persistedSmokeCoordinator, smokeReport);
    assert.equal(smokeReport.coordinator, "fde-powerpoint-native-coordinator/test-only");
    assert.equal(smokeReport.executionProfile, "test-only");
    const persistedSmokeReport = JSON.parse(
      await readFile(join(casePaths.smokeOutput, "smoke-report.json"), "utf8"),
    );
    assert.equal(
      persistedSmokeReport.coordinator,
      "fde-powerpoint-native-coordinator/test-only",
    );
    assert.equal(persistedSmokeReport.executionProfile, "test-only");
    assert.deepEqual(smokeReport.approval, {
      requiredForFull: true,
      approved: false,
      method: "explicit-full-mode-flag",
    });
    await assertPublicationManifest(smokeReport, casePaths.smokeOutput);
    const persistedSmokeWorkerBytes = await readFile(
      join(casePaths.smokeOutput, "worker-report.json"),
    );
    const persistedSmokeWorker = JSON.parse(persistedSmokeWorkerBytes);
    assert.equal(persistedSmokeWorker.spec, null);
    assert.equal(persistedSmokeWorker.skeleton, null);
    assert.equal(persistedSmokeWorker.presentation, "readout.pptx");
    assert.equal(persistedSmokeWorker.renderDirectory, "native-render");
    assert.equal(persistedSmokeWorker.report, "worker-report.json");
    assert.equal(
      persistedSmokeWorker.contactSheet,
      "native-render/contact-sheet.png",
    );
    assert.equal(
      smokeReport.artifacts.workerReport.sha256,
      sha256(persistedSmokeWorkerBytes),
    );
    assert.equal(
      smokeReport.artifacts.workerReport.normalizedForBundle,
      true,
    );
    const fullStub = createStubRunner();
    const { report: fullReport } = await runFull(casePaths, fullStub);
    assert.equal(fullReport.status, "COORDINATOR_PASS");
    assert.equal(fullReport.mode, "full");
    assert.deepEqual(fullReport.approval, {
      requiredForFull: true,
      approved: true,
      method: "explicit-full-mode-flag",
    });
    assert.equal(fullReport.checks.smokeBundleVerifiedBeforeSkeleton, true);
    assert.equal(fullReport.selection.slideCount, plan.slides.length);
    assert.deepEqual(
      fullReport.selection.selectedSlideIds,
      plan.slides.map((slide) => slide.id),
    );
    assert.deepEqual(
      await relativeFiles(casePaths.fullOutput),
      expectedFinalFiles("full", plan.slides.length),
    );
    assert.equal(fullReport.coordinator, "fde-powerpoint-native-coordinator/test-only");
    assert.equal(fullReport.executionProfile, "test-only");
    await assertPublicationManifest(fullReport, casePaths.fullOutput);
    assert.deepEqual(smokeStub.state.skeletonModes, ["smoke"]);
    assert.deepEqual(fullStub.state.skeletonModes, ["full"]);
    assert.equal(
      fullStub.state.calls.find((call) => call.name === "native-skeleton")
        .cleanupSensitive,
      true,
    );
    assert.equal(
      fullStub.state.calls.find((call) => call.name === "native-worker")
        .cleanupSensitive,
      true,
    );
  }

  {
    const casePaths = await newCase("coordinator-report-relabel");
    await runSmoke(casePaths);
    const coordinatorReportPath = join(
      casePaths.smokeOutput,
      "coordinator-report.json",
    );
    const coordinatorReport = JSON.parse(
      await readFile(coordinatorReportPath, "utf8"),
    );
    coordinatorReport.coordinator = "fde-powerpoint-native-coordinator/1.0";
    coordinatorReport.executionProfile = "production";
    await writeFile(coordinatorReportPath, jsonText(coordinatorReport));
    await expectCoordinatorError(
      () => runFull(casePaths),
      "SMOKE_BUNDLE_INVALID",
    );
    assert.equal(await exists(casePaths.fullOutput), false);
  }

  {
    const root = join(temporaryDirectory, "watchdog-pre-ownership");
    await mkdir(root);
    const fake = createFakeSpawn();
    let cleanupCalled = false;
    await expectWatchdogTimeout(
      () =>
        runChildWatchdogForTest(watchdogRequest(join(root, "missing.json")), {
          spawnChild: fake.spawnChild,
          cleanupOwnedProcess: async () => {
            cleanupCalled = true;
          },
        }),
      (details) => {
        assert.equal(details.ownershipStatus, "absent");
        assert.equal(details.contaminationRisk, true);
        assert.equal(details.childExited, true);
      },
    );
    assert.equal(cleanupCalled, false);
    assert.equal(fake.state.killCount, 1);
  }

  {
    const root = join(temporaryDirectory, "watchdog-late-ownership-receipt");
    await mkdir(root);
    const receiptPath = join(root, "ownership.json");
    const fake = createFakeSpawn({
      beforeFirstClose: () =>
        writeFile(receiptPath, jsonText(ownershipReceipt())),
    });
    let cleanupObservedTerminatedChild = false;
    await expectWatchdogTimeout(
      () =>
        runChildWatchdogForTest(watchdogRequest(receiptPath), {
          spawnChild: fake.spawnChild,
          cleanupOwnedProcess: async (receipt) => {
            cleanupObservedTerminatedChild = fake.state.child.closed;
            return {
              status: "already-exited",
              processId: receipt.processId,
              exactIdentity: true,
              exited: true,
              mode: "none",
            };
          },
        }),
      (details) => {
        assert.equal(details.ownershipStatus, "validated-late");
        assert.equal(details.ownershipReceiptTiming, "late");
        assert.equal(details.ownershipCleanup.status, "already-exited");
        assert.equal(details.contaminationRisk, false);
        assert.equal(details.childExited, true);
      },
    );
    assert.equal(cleanupObservedTerminatedChild, true);
    assert.equal(fake.state.killCount, 1);
  }

  {
    const root = join(temporaryDirectory, "watchdog-post-ownership");
    await mkdir(root);
    const receiptPath = join(root, "ownership.json");
    await writeFile(receiptPath, jsonText(ownershipReceipt()));
    const fake = createFakeSpawn();
    let cleanedProcessId;
    await expectWatchdogTimeout(
      () =>
        runChildWatchdogForTest(watchdogRequest(receiptPath), {
          spawnChild: fake.spawnChild,
          cleanupOwnedProcess: async (receipt) => {
            cleanedProcessId = receipt.processId;
            return {
              status: "cleaned",
              processId: receipt.processId,
              exactIdentity: true,
              exited: true,
              mode: "graceful",
            };
          },
        }),
      (details) => {
        assert.equal(details.ownershipStatus, "validated");
        assert.equal(details.ownershipCleanup.status, "cleaned");
        assert.equal(details.contaminationRisk, false);
      },
    );
    assert.equal(cleanedProcessId, 4242);
    assert.equal(fake.state.killCount, 1);
  }

  {
    const root = join(temporaryDirectory, "watchdog-identity-mismatch");
    await mkdir(root);
    const receiptPath = join(root, "ownership.json");
    await writeFile(
      receiptPath,
      jsonText(ownershipReceipt({ owner: "untrusted-owner/1.0" })),
    );
    const fake = createFakeSpawn();
    let cleanupCalled = false;
    await expectWatchdogTimeout(
      () =>
        runChildWatchdogForTest(watchdogRequest(receiptPath), {
          spawnChild: fake.spawnChild,
          cleanupOwnedProcess: async () => {
            cleanupCalled = true;
          },
        }),
      (details) => {
        assert.equal(details.ownershipStatus, "ambiguous");
        assert.equal(details.contaminationRisk, true);
      },
    );
    assert.equal(cleanupCalled, false);
  }

  {
    const root = join(temporaryDirectory, "watchdog-natural-exit-race");
    await mkdir(root);
    const receiptPath = join(root, "ownership.json");
    await writeFile(receiptPath, jsonText(ownershipReceipt()));
    const fake = createFakeSpawn();
    await expectWatchdogTimeout(
      () =>
        runChildWatchdogForTest(watchdogRequest(receiptPath), {
          spawnChild: fake.spawnChild,
          cleanupOwnedProcess: async (receipt) => {
            fake.state.child.closed = true;
            fake.state.child.emit("close", 0, null);
            return {
              status: "already-exited",
              processId: receipt.processId,
              exactIdentity: true,
              exited: true,
              mode: "none",
            };
          },
        }),
      (details) => {
        assert.equal(details.ownershipCleanup.status, "already-exited");
        assert.equal(details.childExited, true);
        assert.equal(details.contaminationRisk, false);
      },
    );
    assert.equal(fake.state.killCount, 0);
  }

  {
    const root = join(temporaryDirectory, "watchdog-cleanup-failure");
    await mkdir(root);
    const receiptPath = join(root, "ownership.json");
    await writeFile(receiptPath, jsonText(ownershipReceipt()));
    const fake = createFakeSpawn();
    await expectWatchdogTimeout(
      () =>
        runChildWatchdogForTest(watchdogRequest(receiptPath), {
          spawnChild: fake.spawnChild,
          cleanupOwnedProcess: async () => {
            throw new Error("exact cleanup refused identity");
          },
        }),
      (details) => {
        assert.equal(details.ownershipStatus, "cleanup-failed");
        assert.match(details.ownershipCleanupError, /refused identity/);
        assert.equal(details.contaminationRisk, true);
        assert.equal(details.childExited, true);
      },
    );
  }

  {
    const root = join(temporaryDirectory, "watchdog-abnormal-exit-owned");
    await mkdir(root);
    const receiptPath = join(root, "ownership.json");
    await writeFile(receiptPath, jsonText(ownershipReceipt()));
    const fake = createAbnormalExitSpawn();
    let cleanedProcessId;
    const result = await runChildWatchdogForTest(watchdogRequest(receiptPath), {
      spawnChild: fake.spawnChild,
      cleanupOwnedProcess: async (receipt) => {
        cleanedProcessId = receipt.processId;
        return {
          status: "already-exited",
          processId: receipt.processId,
          exactIdentity: true,
          exited: true,
          mode: "none",
        };
      },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(cleanedProcessId, 4242);
    assert.equal(result.abnormalCleanup.ownershipStatus, "validated");
    assert.equal(result.abnormalCleanup.contaminationRisk, false);
  }

  {
    const root = join(temporaryDirectory, "watchdog-abnormal-exit-unowned");
    await mkdir(root);
    const receiptPath = join(root, "missing.json");
    const fake = createAbnormalExitSpawn();
    const result = await runChildWatchdogForTest(watchdogRequest(receiptPath), {
      spawnChild: fake.spawnChild,
      cleanupOwnedProcess: async () => {
        throw new Error("cleanup must not run without an exact receipt");
      },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.abnormalCleanup.ownershipStatus, "absent");
    assert.equal(result.abnormalCleanup.contaminationRisk, true);
  }

  {
    const casePaths = await newCase("explicit-approval-required");
    await runSmoke(casePaths);
    const fullStub = createStubRunner();
    await expectCoordinatorError(
      () => runFull(casePaths, fullStub, {}, { approveSmoke: undefined }),
      "ARGUMENT_INVALID",
    );
    assert.equal(fullStub.state.calls.length, 0);
    assert.equal(await exists(casePaths.fullOutput), false);
  }

  {
    const casePaths = await newCase("smoke-rejects-explicit-approval");
    const smokeStub = createStubRunner();
    await expectCoordinatorError(
      () => runSmoke(casePaths, smokeStub, {}, { approveSmoke: true }),
      "ARGUMENT_INVALID",
    );
    assert.equal(smokeStub.state.calls.length, 0);
    assert.equal(await exists(casePaths.smokeOutput), false);
  }

  {
    const casePaths = await newCase("hash-mismatch");
    const stub = createStubRunner({ workerHashMismatch: true });
    await expectCoordinatorError(
      () => runSmoke(casePaths, stub),
      "HASH_MISMATCH",
    );
    assert.equal(await exists(casePaths.smokeOutput), false);
  }

  {
    const casePaths = await newCase("worker-failure");
    const stub = createStubRunner({ workerFailure: true });
    await expectCoordinatorError(
      () => runSmoke(casePaths, stub),
      "CHILD_FAILED",
    );
    assert.equal(await exists(casePaths.smokeOutput), false);
  }

  {
    const casePaths = await newCase("timeout-diagnostic-preservation");
    const diagnosticPath = join(casePaths.root, "timeout-diagnostic");
    const baseStub = createStubRunner();
    const timeoutStub = {
      state: baseStub.state,
      runner: async (request) => {
        if (request.name === "native-skeleton") {
          throw new CoordinatorError(
            "CHILD_TIMEOUT",
            "native-skeleton exceeded its bounded execution deadline",
            {
              stage: "native-skeleton",
              details: {
                ownershipStatus: "absent",
                contaminationRisk: true,
                ownershipReceiptPath: request.ownershipReceiptPath,
              },
            },
          );
        }
        return baseStub.runner(request);
      },
    };
    await expectCoordinatorError(
      () =>
        runSmoke(
          casePaths,
          timeoutStub,
          {},
          { diagnosticOutput: diagnosticPath },
        ),
      "CHILD_TIMEOUT",
    );
    assert.equal(await exists(casePaths.smokeOutput), false);
    assert.equal(await exists(diagnosticPath), true);
    assert.ok(
      (await relativeEntries(diagnosticPath)).some((path) =>
        path.includes(".w"),
      ),
    );
  }

  {
    const casePaths = await newCase("timeout-ambiguous-staging-retained");
    const baseStub = createStubRunner();
    const timeoutStub = {
      state: baseStub.state,
      runner: async (request) => {
        if (request.name === "native-skeleton") {
          throw new CoordinatorError(
            "CHILD_TIMEOUT",
            "native-skeleton exceeded its bounded execution deadline",
            {
              stage: "native-skeleton",
              details: {
                ownershipStatus: "ambiguous",
                contaminationRisk: true,
                childExited: true,
                ownershipReceiptPath: request.ownershipReceiptPath,
              },
            },
          );
        }
        return baseStub.runner(request);
      },
    };
    let retainedStagingPath;
    await assert.rejects(
      () => runSmoke(casePaths, timeoutStub),
      (error) => {
        assert.ok(error instanceof CoordinatorError);
        assert.equal(error.code, "CHILD_TIMEOUT");
        assert.match(error.details.retainedStagingPath, /[\\/]\.fde-[a-f0-9]{32}$/);
        retainedStagingPath = error.details.retainedStagingPath;
        return true;
      },
    );
    assert.equal(await exists(retainedStagingPath), true);
    await rm(retainedStagingPath, { recursive: true, force: true });
  }

  {
    const casePaths = await newCase("package-qa-failure");
    const stub = createStubRunner({ packageQaFailure: true });
    await expectCoordinatorError(
      () => runSmoke(casePaths, stub),
      "CHILD_FAILED",
    );
    assert.equal(await exists(casePaths.smokeOutput), false);
  }

  {
    const casePaths = await newCase("publication-receipt-gap-mutation");
    await expectCoordinatorError(
      () =>
        runSmoke(casePaths, createStubRunner(), {
          publicationHook: async ({ phase, path }) => {
            if (phase === "before-payload-seal") {
              await writeFile(join(path, "readout.pptx"), "unvalidated-pptx");
            }
          },
        }),
      "PUBLICATION_RECEIPT_MISMATCH",
    );
    assert.equal(await exists(casePaths.smokeOutput), false);
  }

  {
    const casePaths = await newCase("publication-pre-rename-mutation");
    await expectCoordinatorError(
      () =>
        runSmoke(casePaths, createStubRunner(), {
          publicationHook: async ({ phase, path }) => {
            if (phase === "before-rename") {
              await writeFile(
                join(path, "package-qa.json"),
                "mutated-before-rename",
              );
            }
          },
        }),
      "PUBLICATION_MUTATED",
    );
    assert.equal(await exists(casePaths.smokeOutput), false);
  }

  {
    const casePaths = await newCase("publication-post-rename-mutation");
    const diagnosticPath = join(casePaths.root, "publication-quarantine");
    await expectCoordinatorError(
      () =>
        runSmoke(
          casePaths,
          createStubRunner(),
          {
            publicationHook: async ({ phase, path }) => {
              if (phase === "after-rename") {
                await writeFile(
                  join(path, "native-render", "contact-sheet.png"),
                  "mutated-after-rename",
                );
              }
            },
          },
          { diagnosticOutput: diagnosticPath },
        ),
      "PUBLICATION_MUTATED",
    );
    assert.equal(await exists(casePaths.smokeOutput), false);
    assert.equal(await exists(diagnosticPath), true);
  }

  {
    const casePaths = await newCase("publication-quarantine-rename-failure");
    const diagnosticPath = join(casePaths.root, "occupied-quarantine");
    await expectCoordinatorError(
      () =>
        runSmoke(
          casePaths,
          createStubRunner(),
          {
            publicationHook: async ({ phase, path }) => {
              if (phase === "after-rename") {
                await mkdir(diagnosticPath);
                await writeFile(
                  join(path, "native-render", "contact-sheet.png"),
                  "mutated-after-rename",
                );
              }
            },
          },
          { diagnosticOutput: diagnosticPath },
        ),
      "PUBLICATION_MUTATED",
    );
    assert.equal(await exists(casePaths.smokeOutput), false);
    assert.equal(await exists(diagnosticPath), true);
  }

  {
    const casePaths = await newCase("publication-quarantine-removal-failure");
    const diagnosticPath = join(casePaths.root, "occupied-quarantine");
    let retainedPublishedPath;
    await assert.rejects(
      () =>
        runSmoke(
          casePaths,
          createStubRunner(),
          {
            publicationHook: async ({ phase, path }) => {
              if (phase === "after-rename") {
                await mkdir(diagnosticPath);
                await writeFile(
                  join(path, "native-render", "contact-sheet.png"),
                  "mutated-after-rename",
                );
              }
            },
            removeDirectory: async () => {
              throw new Error("stub published cleanup lock");
            },
          },
          { diagnosticOutput: diagnosticPath },
        ),
      (error) => {
        assert.ok(error instanceof CoordinatorError);
        assert.equal(error.code, "PUBLICATION_MUTATED");
        assert.equal(error.details.cleanupError, "stub published cleanup lock");
        assert.equal(error.details.retainedPublishedPath, casePaths.smokeOutput);
        retainedPublishedPath = error.details.retainedPublishedPath;
        return true;
      },
    );
    assert.equal(await exists(retainedPublishedPath), true);
    await rm(retainedPublishedPath, { recursive: true, force: true });
  }

  {
    const casePaths = await newCase("malformed-worker-receipt");
    const stub = createStubRunner({ malformedWorkerReceipt: true });
    await expectCoordinatorError(
      () => runSmoke(casePaths, stub),
      "HASH_INVALID",
    );
    assert.equal(await exists(casePaths.smokeOutput), false);
  }

  for (const [name, option, code] of [
    ["valid-wrong-primitive-receipt", "wrongPrimitiveReceipt", "HASH_MISMATCH"],
    ["valid-wrong-table-receipt", "wrongTableReceipt", "WORKER_REPORT_INVALID"],
    ["valid-wrong-connector-receipt", "wrongConnectorReceipt", "HASH_MISMATCH"],
  ]) {
    const casePaths = await newCase(name);
    const stub = createStubRunner({ [option]: true });
    await expectCoordinatorError(() => runSmoke(casePaths, stub), code);
    assert.equal(await exists(casePaths.smokeOutput), false);
  }

  {
    const casePaths = await newCase("missing-connector-receipts");
    const stub = createStubRunner({ missingConnectorSlides: true });
    await expectCoordinatorError(
      () => runSmoke(casePaths, stub),
      "WORKER_REPORT_INVALID",
    );
    assert.equal(await exists(casePaths.smokeOutput), false);
  }

  {
    const casePaths = await newCase("malformed-package-receipt");
    const stub = createStubRunner({ malformedPackageReceipt: true });
    await expectCoordinatorError(
      () => runSmoke(casePaths, stub),
      "HASH_INVALID",
    );
    assert.equal(await exists(casePaths.smokeOutput), false);
  }

  {
    const casePaths = await newCase("inconsistent-package-part-hash");
    const stub = createStubRunner({ inconsistentPackagePartHash: true });
    await expectCoordinatorError(
      () => runSmoke(casePaths, stub),
      "HASH_MISMATCH",
    );
    assert.equal(await exists(casePaths.smokeOutput), false);
  }

  {
    const casePaths = await newCase("stale-plan");
    const stub = createStubRunner({ mutatePlanDuringCompile: true });
    await expectCoordinatorError(
      () => runSmoke(casePaths, stub),
      "INPUT_MUTATED",
    );
    assert.equal(await exists(casePaths.smokeOutput), false);
  }

  {
    const casePaths = await newCase("mutated-smoke");
    await runSmoke(casePaths);
    const stub = createStubRunner({
      mutateSmokeBundleDuringFull: casePaths.smokeOutput,
    });
    await expectCoordinatorError(
      () => runFull(casePaths, stub),
      "INPUT_MUTATED",
    );
    assert.equal(await exists(casePaths.fullOutput), false);
  }

  {
    const casePaths = await newCase("malformed-smoke-package");
    await runSmoke(casePaths);
    const packageQaPath = join(casePaths.smokeOutput, "package-qa.json");
    const packageQa = JSON.parse(await readFile(packageQaPath, "utf8"));
    packageQa.schemaVersion = 2;
    await writeFile(packageQaPath, jsonText(packageQa));
    await expectCoordinatorError(
      () => runFull(casePaths),
      "PACKAGE_QA_INVALID",
    );
    assert.equal(await exists(casePaths.fullOutput), false);
  }

  {
    const casePaths = await newCase("forged-smoke-package");
    await runSmoke(casePaths);
    const packageQaPath = join(casePaths.smokeOutput, "package-qa.json");
    const packageQa = JSON.parse(await readFile(packageQaPath, "utf8"));
    packageQa.parts[0].sha256 = sha256("forged-valid-looking-part-hash");
    const forgedPackageQaBytes = Buffer.from(jsonText(packageQa), "utf8");
    await writeFile(packageQaPath, forgedPackageQaBytes);
    const coordinatorReportPath = join(
      casePaths.smokeOutput,
      "coordinator-report.json",
    );
    const coordinatorReport = JSON.parse(
      await readFile(coordinatorReportPath, "utf8"),
    );
    coordinatorReport.artifacts.packageQa.sha256 = sha256(
      forgedPackageQaBytes,
    );
    await writeFile(coordinatorReportPath, jsonText(coordinatorReport));
    await expectCoordinatorError(
      () => runFull(casePaths),
      "SMOKE_BUNDLE_INVALID",
    );
    assert.equal(await exists(casePaths.fullOutput), false);
  }

  {
    const casePaths = await newCase("output-collision");
    await mkdir(casePaths.smokeOutput);
    await expectCoordinatorError(
      () => runSmoke(casePaths),
      "OUTPUT_EXISTS",
    );
  }

  {
    const casePaths = await newCase("publication-collision");
    const stub = createStubRunner({
      createOutputDuringPackageQa: casePaths.smokeOutput,
    });
    await expectCoordinatorError(
      () => runSmoke(casePaths, stub),
      "OUTPUT_EXISTS",
    );
    assert.equal(await exists(casePaths.smokeOutput), true);
    assert.deepEqual(await relativeFiles(casePaths.smokeOutput), []);
  }

  {
    const casePaths = await newCase("path-alias");
    await runSmoke(casePaths);
    await expectCoordinatorError(
      () =>
        runPowerPointNativeCoordinatorForTest(
          {
            mode: "full",
            plan: casePaths.planPath,
            output: join(casePaths.smokeOutput, "nested-output"),
            approveSmoke: true,
            smokeBundle: casePaths.smokeOutput,
          },
          {
            childRunner: createStubRunner().runner,
            removeDirectory: undefined,
            publicationHook: undefined,
          },
        ),
      "PATH_ALIAS_INVALID",
    );
    await expectCoordinatorError(
      () =>
        runPowerPointNativeCoordinatorForTest(
          {
            mode: "full",
            plan: casePaths.planPath,
            output: casePaths.fullOutput,
            approveSmoke: true,
            smokeBundle: casePaths.smokeOutput,
            diagnosticOutput: join(casePaths.smokeOutput, "diagnostics"),
          },
          {
            childRunner: createStubRunner().runner,
            removeDirectory: undefined,
            publicationHook: undefined,
          },
        ),
      "PATH_ALIAS_INVALID",
    );
  }

  {
    const casePaths = await newCase("diagnostic-preservation");
    const diagnosticOutput = join(casePaths.root, "diagnostics");
    const stub = createStubRunner({ workerFailure: true });
    await assert.rejects(
      () =>
        runPowerPointNativeCoordinatorForTest(
          {
            mode: "smoke",
            plan: casePaths.planPath,
            output: casePaths.smokeOutput,
            diagnosticOutput,
          },
          {
            childRunner: stub.runner,
            removeDirectory: undefined,
            publicationHook: undefined,
          },
        ),
      (error) => {
        assert.ok(error instanceof CoordinatorError);
        assert.equal(error.code, "CHILD_FAILED");
        assert.equal(error.details.diagnosticPath, diagnosticOutput);
        return true;
      },
    );
    assert.equal(await exists(casePaths.smokeOutput), false);
    assert.equal(await exists(diagnosticOutput), true);
  }

  {
    const casePaths = await newCase("cleanup-failure-reporting");
    const stub = createStubRunner({ workerFailure: true });
    let retainedStagingPath;
    await assert.rejects(
      () =>
        runPowerPointNativeCoordinatorForTest(
          {
            mode: "smoke",
            plan: casePaths.planPath,
            output: casePaths.smokeOutput,
          },
          {
            childRunner: stub.runner,
            removeDirectory: async () => {
              throw new Error("stub cleanup lock");
            },
            publicationHook: undefined,
          },
        ),
      (error) => {
        assert.ok(error instanceof CoordinatorError);
        assert.equal(error.code, "CHILD_FAILED");
        assert.equal(error.details.cleanupError, "stub cleanup lock");
        assert.match(error.details.retainedStagingPath, /[\\/]\.fde-[a-f0-9]{32}$/);
        retainedStagingPath = error.details.retainedStagingPath;
        return true;
      },
    );
    assert.equal(await exists(retainedStagingPath), true);
    await rm(retainedStagingPath, { recursive: true, force: true });
  }

  const allEntries = await relativeEntries(temporaryDirectory);
  assert.equal(
    allEntries.some(
      (path) =>
        /(^|[\\/])\.fde-[a-f0-9]{32}([\\/]|$)/.test(path) ||
        path.includes(".worker-stage"),
    ),
    false,
  );
  const coordinatorSource = await readFile(coordinatorPath, "utf8");
  const ownedProcessWatchdogSource = await readFile(
    ownedProcessWatchdogPath,
    "utf8",
  );
  const smokeContractSource = await readFile(smokeContractPath, "utf8");
  assert.doesNotMatch(coordinatorSource, /\bAbortController\b|\bAbortSignal\b/);
  assert.doesNotMatch(
    coordinatorSource,
    /Ed25519|trusted-keyring|Get-Acl|attestation|authenticated|private[-_]?key|signer/i,
  );
  assert.match(
    coordinatorSource,
    /export async function runPowerPointNativeCoordinator\(options\)[\s\S]*arguments\.length !== 1/,
  );
  assert.match(
    smokeContractSource,
    /export const PRODUCTION_COORDINATOR_ID = "fde-powerpoint-native-coordinator\/1\.0"/,
  );
  assert.match(
    coordinatorSource,
    /const TEST_COORDINATOR_ID = "fde-powerpoint-native-coordinator\/test-only"/,
  );
  assert.match(
    coordinatorSource,
    /coordinatorReport\.coordinator === dependencies\.coordinatorId[\s\S]*coordinatorReport\.executionProfile === dependencies\.executionProfile/,
  );
  assert.match(coordinatorSource, /validateSmokeReport\(\{/);
  assert.match(coordinatorSource, /"explicit-full-mode-flag"/);
  assert.doesNotMatch(
    smokeContractSource,
    /validateSmokeApproval|smokeApprovalSignaturePayload|Ed25519|createPublicKey|verify\(/,
  );
  const mainSource = coordinatorSource.slice(
    coordinatorSource.indexOf("export async function main("),
  );
  assert.match(mainSource, /runPowerPointNativeCoordinator\(parsed\.options\)/);
  assert.doesNotMatch(mainSource, /runPowerPointNativeCoordinatorForTest/);
  assert.match(
    coordinatorSource,
    /timeoutMilliseconds: name === "native-worker" \? 1_800_000 : 300_000/,
  );
  assert.match(coordinatorSource, /powerpoint-owned-process-watchdog\.ps1/);
  assert.match(
    coordinatorSource,
    /const powerShellCommand = await resolveTrustedWindowsPowerShell\(\);/,
  );
  assert.match(coordinatorSource, /command: process\.execPath/);
  assert.match(coordinatorSource, /env: request\.env/);
  assert.match(coordinatorSource, /"before-rename"[\s\S]*"after-rename"/);
  assert.match(
    ownedProcessWatchdogSource,
    /\$actualStart\.Ticks -ne \$expectedStart\.ToUniversalTime\(\)\.Ticks/,
  );
  assert.match(
    ownedProcessWatchdogSource,
    /\[IO\.Path\]::GetFullPath\(\$actualPath\)[\s\S]*\[IO\.Path\]::GetFullPath\(\$ProcessPath\)/,
  );
  assert.doesNotMatch(ownedProcessWatchdogSource, /Get-Content|ConvertFrom-Json/);
  assert.doesNotMatch(
    ownedProcessWatchdogSource,
    /Stop-Process\s+-Name|Get-Process\s+-Name/i,
  );
  assert.match(
    coordinatorSource,
    /cleanupSensitive:\s*true/,
    "PowerShell children must be marked cleanup-sensitive",
  );
  assert.ok(hashPattern.test(sha256(coordinatorSource)));

  console.log(
    "PowerPoint native coordinator tests passed: explicit smoke approval, bounded ownership-aware timeouts, smoke/full isolation, exact receipts, publication resealing, mutations, collisions, diagnostics, and cleanup reporting.",
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
