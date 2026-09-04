#!/usr/bin/env node

import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const compiler = join(skillRoot, "scripts", "compile-readout-intent.mjs");
const compilerSource = await readFile(compiler, "utf8");
const receiptKind = "fde-readout-input-receipt/v1";
const authorizationDecision = "approve";
const authorizationScope = "compile-readout-plan-only";
const maxInputBytes = 2 * 1024 * 1024;
const provenance = await import("./readout-input-provenance.mjs");
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function serialize(value) {
  return JSON.stringify(value);
}

function statusForFindings(findings) {
  return findings.some((finding) => finding.severity === "block")
    ? "block"
    : findings.length > 0
      ? "review"
      : "clear";
}

function sealManifest(body) {
  return {
    ...body,
    manifestSha256: sha256(JSON.stringify(body)),
  };
}

function createManifest(
  inputText,
  sourceId,
  findings = [],
) {
  const status = statusForFindings(findings);
  return sealManifest({
    version: 1,
    generatedAt: "2026-09-03T18:00:00.000Z",
    status,
    limits: {
      maxFileBytes: 2 * 1024 * 1024,
      maxTotalBytes: 10 * 1024 * 1024,
      maxTraversalDepth: 32,
      maxDiscoveredEntries: 1000,
    },
    note:
      "A clear result means no known pattern matched. It does not make source content trusted or authorize actions.",
    sources: [
      {
        sourceId,
        bytes: Buffer.byteLength(inputText),
        sha256: sha256(inputText),
        trust: "untrusted-data",
        status,
        findings,
      },
    ],
  });
}

function resealManifest(manifest) {
  const body = structuredClone(manifest);
  delete body.manifestSha256;
  return sealManifest(body);
}

function createReceipt({
  sourceText,
  authorizationText,
  sourceManifest,
  authorizationManifest,
  sourceInputSha256 = sha256(sourceText),
  authorizationInputSha256 = sha256(authorizationText),
}) {
  const approvedReviewEntries = [];
  if (sourceManifest.sources[0].status === "review") {
    approvedReviewEntries.push({
      input: "source",
      sourceId: sourceManifest.sources[0].sourceId,
    });
  }
  if (authorizationManifest.sources[0].status === "review") {
    approvedReviewEntries.push({
      input: "authorization",
      sourceId: authorizationManifest.sources[0].sourceId,
    });
  }
  return {
    kind: receiptKind,
    sourceInput: {
      sha256: sourceInputSha256,
      manifestSha256: sourceManifest.manifestSha256,
    },
    authorizationInput: {
      sha256: authorizationInputSha256,
      manifestSha256: authorizationManifest.manifestSha256,
    },
    approvedReviewEntries,
    authorizationDecision,
    authorizationScope,
    authoritySourceDescription:
      "Caller-supplied approval record; caller identity is established outside this compiler.",
  };
}

let runNumber = 0;

async function run(directory, overrides = {}, output) {
  const source = structuredClone(overrides.source ?? compactSource);
  const authorizationInput = structuredClone(
    overrides.authorization ?? authorization,
  );
  const intentInput = structuredClone(overrides.intent ?? intent);
  const sourceText = overrides.sourceText ?? serialize(source);
  const authorizationText =
    overrides.authorizationText ?? serialize(authorizationInput);
  const intentText = overrides.intentText ?? serialize(intentInput);
  let sourceManifest =
    overrides.sourceManifest ??
    createManifest(
      overrides.preflightSourceText ?? sourceText,
      "source-input-001",
      overrides.sourceFindings,
    );
  let authorizationManifest =
    overrides.authorizationManifest ??
    createManifest(
      overrides.preflightAuthorizationText ?? authorizationText,
      "authorization-input-001",
      overrides.authorizationFindings,
    );
  if (overrides.mutateSourceManifest) {
    overrides.mutateSourceManifest(sourceManifest);
    if (overrides.resealSourceManifest) {
      sourceManifest = resealManifest(sourceManifest);
    }
  }
  if (overrides.mutateAuthorizationManifest) {
    overrides.mutateAuthorizationManifest(authorizationManifest);
    if (overrides.resealAuthorizationManifest) {
      authorizationManifest = resealManifest(authorizationManifest);
    }
  }
  const receipt =
    overrides.receipt ??
    createReceipt({
      sourceText,
      authorizationText,
      sourceManifest,
      authorizationManifest,
      sourceInputSha256: overrides.receiptSourceSha256,
      authorizationInputSha256: overrides.receiptAuthorizationSha256,
    });
  if (overrides.mutateReceipt) overrides.mutateReceipt(receipt);

  const paths = {
    source: join(directory, "source.json"),
    authorization: join(directory, "authorization.json"),
    intent: join(directory, "intent.json"),
    sourceManifest: join(directory, "source-manifest.json"),
    authorizationManifest: join(directory, "authorization-manifest.json"),
    receipt: join(directory, "receipt.json"),
  };
  const texts = {
    source: sourceText,
    authorization: authorizationText,
    intent: intentText,
    sourceManifest: serialize(sourceManifest),
    authorizationManifest: serialize(authorizationManifest),
    receipt: serialize(receipt),
  };
  await Promise.all(
    Object.entries(paths).map(([name, path]) => writeFile(path, texts[name])),
  );
  const outputPath =
    output ?? join(directory, `readout-plan-${(runNumber += 1)}.json`);
  if (overrides.hardLinkOutputFrom) {
    await rm(outputPath, { force: true });
    await link(paths[overrides.hardLinkOutputFrom], outputPath);
  }
  const result = spawnSync(
    process.execPath,
    [
      compiler,
      "--source",
      paths.source,
      "--source-manifest",
      paths.sourceManifest,
      "--authorization",
      paths.authorization,
      "--authorization-manifest",
      paths.authorizationManifest,
      "--receipt",
      paths.receipt,
      "--intent",
      paths.intent,
      "--output",
      outputPath,
    ],
    { encoding: "utf8" },
  );
  return {
    result,
    output: outputPath,
    fixture: {
      paths,
      texts,
      sourceManifest,
      authorizationManifest,
      receipt,
    },
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

function loadReadBoundedInput(scriptText) {
  const normalized = scriptText.replaceAll("\r\n", "\n");
  const start = normalized.indexOf("function inputSnapshot(");
  const end = normalized.indexOf("\n\nasync function readInput", start);
  if (start < 0 || end <= start) return null;
  const source = normalized.slice(start, end);
  return new Function(
    "Buffer",
    `"use strict"; ${source}; return readBoundedInput;`,
  )(Buffer);
}

function createInputHandle(content, snapshots) {
  let statIndex = 0;
  let closed = false;
  let largestRead = 0;
  return {
    handle: {
      async stat() {
        const snapshot = snapshots[Math.min(statIndex, snapshots.length - 1)];
        statIndex += 1;
        return snapshot;
      },
      async read(buffer, offset, length, position) {
        largestRead = Math.max(largestRead, length);
        const bytesRead = Math.min(length, Math.max(0, content.length - position));
        content.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead };
      },
      async close() {
        closed = true;
      },
    },
    state() {
      return { closed, largestRead };
    },
  };
}

async function expectAbsent(path) {
  try {
    await readFile(path);
    throw new Error(`provenance failure left output: ${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function expectFailure(execution, message) {
  expect(execution.result.status !== 0, "compiler unexpectedly succeeded");
  expect(
    `${execution.result.stdout}${execution.result.stderr}`.includes(message),
    `${execution.result.stdout}${execution.result.stderr}`,
  );
  await expectAbsent(execution.output);
}

try {
  await test("Windows output containment rejects cross-root paths", async () => {
    expect(
      typeof provenance.insideRoot === "function",
      "provenance helper must export insideRoot",
    );
    expect(
      !provenance.insideRoot(
        String.raw`C:\workspace`,
        String.raw`D:\outside\readout.json`,
        win32,
      ),
      "Windows cross-drive output was accepted",
    );
    expect(
      !provenance.insideRoot(
        String.raw`\\server-a\share\workspace`,
        String.raw`\\server-b\share\outside\readout.json`,
        win32,
      ),
      "Windows cross-server UNC output was accepted",
    );
    expect(
      !provenance.insideRoot(
        String.raw`\\server\share-a\workspace`,
        String.raw`\\server\share-b\outside\readout.json`,
        win32,
      ),
      "Windows cross-share UNC output was accepted",
    );
    expect(
      provenance.insideRoot(
        String.raw`C:\workspace`,
        String.raw`C:\workspace\..safe\readout.json`,
        win32,
      ),
      "valid Windows output child beginning with two dots was rejected",
    );
    expect(
      !provenance.insideRoot(
        String.raw`C:\Workspace`,
        String.raw`c:\Workspace\readout.json`,
        win32,
      ),
      "Windows case-only drive-root output was accepted",
    );
    expect(
      !provenance.insideRoot(
        String.raw`\\Server\Share\Workspace`,
        String.raw`\\server\share\Workspace\readout.json`,
        win32,
      ),
      "Windows case-only UNC-root output was accepted",
    );
    expect(
      provenance.insideRoot(
        String.raw`C:\Workspace`,
        String.raw`C:\Workspace\readout.json`,
        win32,
      ),
      "valid exact-case Windows output was rejected",
    );
  });

  await test(
    "lexically outside output fails before parent filesystem access",
    async () => {
      const lexicalCheck = compilerSource.indexOf(
        "!insideRoot(lexicalWorkspace, output)",
      );
      const parentAccess = compilerSource.indexOf(
        "await realpath(dirname(output))",
      );
      expect(
        lexicalCheck >= 0 && parentAccess >= 0 && lexicalCheck < parentAccess,
        "compiler accesses the output parent before lexical containment",
      );
    },
  );

  await test("output cannot alias any compiler input", async () => {
    for (const inputName of [
      "source",
      "sourceManifest",
      "authorization",
      "authorizationManifest",
      "receipt",
      "intent",
    ]) {
      const output = join(
        directory,
        {
          source: "source.json",
          sourceManifest: "source-manifest.json",
          authorization: "authorization.json",
          authorizationManifest: "authorization-manifest.json",
          receipt: "receipt.json",
          intent: "intent.json",
        }[inputName],
      );
      const execution = await run(directory, {}, output);
      expect(
        execution.result.status !== 0 &&
          execution.result.stderr.includes("must not alias an input"),
        `${inputName}: ${execution.result.stdout}${execution.result.stderr}`,
      );
      expect(
        (await readFile(output, "utf8")) === execution.fixture.texts[inputName],
        `${inputName} was overwritten`,
      );
    }
  });

  await test("output cannot hard-link to a compiler input", async () => {
    const output = join(directory, "hard-linked-output.json");
    const execution = await run(
      directory,
      { hardLinkOutputFrom: "receipt" },
      output,
    );
    expect(
      execution.result.status !== 0 &&
        execution.result.stderr.includes("must not alias an input"),
      `${execution.result.stdout}${execution.result.stderr}`,
    );
    expect(
      (await readFile(output, "utf8")) === execution.fixture.texts.receipt,
      "hard-linked receipt input was overwritten",
    );
  });

  await test("oversized compiler input fails before JSON parsing", async () => {
    const sourceJson = serialize(compactSource);
    const sourceText = `${sourceJson}${" ".repeat(
      maxInputBytes + 1 - Buffer.byteLength(sourceJson),
    )}`;
    await expectFailure(
      await run(directory, { sourceText }),
      `exceeds ${maxInputBytes}-byte input limit`,
    );
  });

  await test("compiler input growth is bounded by one sentinel byte", async () => {
    const readBoundedInput = loadReadBoundedInput(compilerSource);
    expect(readBoundedInput, "compiler must define a bounded input reader");
    const initial = {
      dev: 1n,
      ino: 2n,
      mode: 33188n,
      size: 4n,
      mtimeNs: 10n,
      ctimeNs: 11n,
    };
    const grown = { ...initial, size: 6n, mtimeNs: 12n, ctimeNs: 13n };
    const file = createInputHandle(
      Buffer.from("123456"),
      [initial, grown],
    );
    const rejected = await readBoundedInput(
      "grown.json",
      4,
      async () => file.handle,
      async () => initial,
    ).then(
      () => false,
      (error) => error.message.includes("exceeds 4-byte input limit"),
    );
    expect(
      rejected,
      "grown compiler input did not fail its byte limit",
    );
    expect(file.state().closed, "grown compiler input handle did not close");
    expect(
      file.state().largestRead <= 5,
      "grown compiler input read beyond one sentinel byte",
    );
  });

  await test("compiler reads bounded inputs sequentially", async () => {
    expect(
      !compilerSource.includes("await Promise.all(["),
      "compiler still reads all inputs concurrently",
    );
  });

  await test("compiler rejects non-regular inputs before open", async () => {
    const readBoundedInput = loadReadBoundedInput(compilerSource);
    expect(readBoundedInput, "compiler must define a bounded input reader");
    let opened = false;
    const socketMode = 0o140000;
    const rejected = await readBoundedInput(
      "socket.json",
      16,
      async () => {
        opened = true;
        throw new Error("must not open");
      },
      async () => ({
        dev: 1n,
        ino: 2n,
        mode: BigInt(socketMode),
        size: 0n,
        mtimeNs: 1n,
        ctimeNs: 1n,
      }),
    ).then(
      () => false,
      (error) => error.message.includes("must be a regular file"),
    );
    expect(rejected, "non-regular compiler input was not rejected");
    expect(!opened, "non-regular compiler input was opened");
    expect(
      compilerSource.indexOf("await inspectFile(path") <
        compilerSource.indexOf("await openFile(path"),
      "compiler must inspect input type before open",
    );
  });

  if (process.platform !== "win32") {
    await test("compiler rejects a Unix socket without hanging", async () => {
      const fixture = await run(directory);
      await rm(fixture.fixture.paths.source, { force: true });
      const server = createServer();
      await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(fixture.fixture.paths.source, resolveListen);
      });
      try {
        const output = join(directory, "socket-input-output.json");
        const result = spawnSync(
          process.execPath,
          [
            compiler,
            "--source",
            fixture.fixture.paths.source,
            "--source-manifest",
            fixture.fixture.paths.sourceManifest,
            "--authorization",
            fixture.fixture.paths.authorization,
            "--authorization-manifest",
            fixture.fixture.paths.authorizationManifest,
            "--receipt",
            fixture.fixture.paths.receipt,
            "--intent",
            fixture.fixture.paths.intent,
            "--output",
            output,
          ],
          { encoding: "utf8", timeout: 2_000 },
        );
        expect(result.error?.code !== "ETIMEDOUT", "Unix socket input hung");
        expect(
          result.status === 2 &&
            result.stderr.includes("must be a regular file"),
          `${result.stdout}${result.stderr}`,
        );
        await expectAbsent(output);
      } finally {
        await new Promise((resolveClose) => server.close(resolveClose));
      }
    });
  }

  await test("deep intent provenance fails without RangeError", async () => {
    const base = serialize(intent);
    const depth = 20_000;
    const deepValue =
      '{"next":'.repeat(depth) +
      '{"receipt":{}}' +
      "}".repeat(depth);
    const intentText = `${base.slice(0, -1)},"deep":${deepValue}}`;
    const execution = await run(directory, { intentText });
    expect(
      execution.result.status !== 0,
      "deep intent unexpectedly succeeded",
    );
    const diagnostics = `${execution.result.stdout}${execution.result.stderr}`;
    expect(
      diagnostics.includes(
        "Intent cannot contain provenance or receipt fields",
      ),
      diagnostics,
    );
    expect(!diagnostics.includes("RangeError"), diagnostics);
    await expectAbsent(execution.output);
  });

  await test("compilation requires manifests and receipt", async () => {
    const execution = await run(directory);
    const output = join(directory, "missing-provenance-inputs.json");
    const result = spawnSync(
      process.execPath,
      [
        compiler,
        "--source",
        execution.fixture.paths.source,
        "--authorization",
        execution.fixture.paths.authorization,
        "--intent",
        execution.fixture.paths.intent,
        "--output",
        output,
      ],
      { encoding: "utf8" },
    );
    expect(result.status !== 0, "compiler accepted missing provenance inputs");
    expect(
      result.stderr.includes("--source-manifest") &&
        result.stderr.includes("--authorization-manifest") &&
        result.stderr.includes("--receipt"),
      result.stderr,
    );
    await expectAbsent(output);
  });

  await test("valid compile preserves source order and exact records", async () => {
    const source = structuredClone(compactSource);
    delete source.evidence[0].sourceId;
    const selected = source.evidence.map((record) => record.id).reverse();
    const testIntent = {
      ...structuredClone(intent),
      selectedEvidenceIds: selected,
    };
    const execution = await run(directory, { source, intent: testIntent });
    const { result, output, fixture } = execution;
    expect(result.status === 0, `${result.stdout}${result.stderr}`);
    const planText = await readFile(output, "utf8");
    const plan = JSON.parse(planText);
    expect(plan.evidence[0].id === source.evidence[0].id, "source order changed");
    expect(
      plan.evidence[0].sourceId === source.evidence[0].id,
      "sourceId not derived",
    );
    expect(plan.evidence[0].class === source.evidence[0].class, "class changed");
    const preserved = plan.evidence.find(
      (record) => record.id === source.evidence[1].id,
    );
    expect(
      JSON.stringify(preserved) === JSON.stringify(source.evidence[1]),
      "supplied evidence fields or sourceId changed",
    );
    expect(
      JSON.stringify(plan.humanContext[0]) ===
        JSON.stringify(source.humanContext[0]),
      "human context fields or sourceId changed",
    );
    expect(!("selectedEvidenceIds" in plan), "selection field leaked");

    const summary = JSON.parse(result.stdout);
    expect(
      summary.inputs.source.sha256 === sha256(fixture.texts.source),
      "summary source hash differs",
    );
    expect(
      summary.inputs.authorization.sha256 ===
        sha256(fixture.texts.authorization),
      "summary authorization hash differs",
    );
    expect(
      summary.inputs.source.manifestSha256 ===
        fixture.sourceManifest.manifestSha256 &&
        summary.inputs.authorization.manifestSha256 ===
          fixture.authorizationManifest.manifestSha256,
      "summary manifest hashes differ",
    );
    expect(
      summary.inputs.source.manifestFileSha256 ===
        sha256(fixture.texts.sourceManifest) &&
        summary.inputs.authorization.manifestFileSha256 ===
          sha256(fixture.texts.authorizationManifest),
      "summary manifest file hashes differ",
    );
    expect(
      summary.inputs.receipt.sha256 === sha256(fixture.texts.receipt),
      "summary receipt hash differs",
    );
    expect(summary.output.sha256 === sha256(planText), "summary output hash differs");
    expect(
      !/\b(?:authenticated|identity|signature|signer)\b/i.test(result.stdout),
      "summary claimed authenticated identity",
    );
  });

  await test("reviewed local input compiles with exact receipt approval", async () => {
    const execution = await run(directory, {
      sourceFindings: [
        { rule: "external-url", severity: "review", line: 1 },
      ],
    });
    expect(
      execution.result.status === 0,
      `${execution.result.stdout}${execution.result.stderr}`,
    );
    expect(
      execution.fixture.receipt.approvedReviewEntries.some(
        (entry) =>
          entry.input === "source" && entry.sourceId === "source-input-001",
      ),
      "receipt omitted exact reviewed source ID",
    );
  });

  await test(
    "reviewed source and authorization require separate exact approvals",
    async () => {
      const execution = await run(directory, {
        sourceFindings: [
          { rule: "external-url", severity: "review", line: 1 },
        ],
        authorizationFindings: [
          { rule: "external-url", severity: "review", line: 1 },
        ],
      });
      expect(
        execution.result.status === 0,
        `${execution.result.stdout}${execution.result.stderr}`,
      );
      expect(
        execution.fixture.receipt.approvedReviewEntries.length === 2,
        "receipt did not keep source and authorization review approvals separate",
      );
    },
  );

  await test("materializes evidence required by selected human context", async () => {
    const dependency = compactSource.humanContext[0].evidenceIds[0];
    const testIntent = structuredClone(intent);
    testIntent.selectedEvidenceIds = testIntent.selectedEvidenceIds.filter(
      (id) => id !== dependency,
    );
    const output = join(directory, "human-context-evidence-closure.json");
    const { result } = await run(directory, { intent: testIntent }, output);
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

  await test("changed source bytes after preflight fail without output", async () => {
    const preflightSourceText = serialize(compactSource);
    const changedSource = structuredClone(compactSource);
    changedSource.evidence[0].statement += " Changed after preflight.";
    await expectFailure(
      await run(directory, {
        source: changedSource,
        preflightSourceText,
        receiptSourceSha256: sha256(preflightSourceText),
      }),
      "source does not match exactly one preflight manifest entry",
    );
  });

  await test(
    "changed authorization bytes after preflight fail without output",
    async () => {
      const preflightAuthorizationText = serialize(authorization);
      const changedAuthorization = structuredClone(authorization);
      changedAuthorization.brandDefaults.wordmark = "Changed";
      await expectFailure(
        await run(directory, {
          authorization: changedAuthorization,
          preflightAuthorizationText,
          receiptAuthorizationSha256: sha256(preflightAuthorizationText),
        }),
        "authorization does not match exactly one preflight manifest entry",
      );
    },
  );

  await test("tampered manifest body fails without output", async () => {
    await expectFailure(
      await run(directory, {
        mutateSourceManifest(manifest) {
          manifest.generatedAt = "2026-09-03T18:00:01.000Z";
        },
      }),
      "source manifestSha256 does not match its body",
    );
  });

  await test("tampered manifestSha256 fails without output", async () => {
    await expectFailure(
      await run(directory, {
        mutateSourceManifest(manifest) {
          manifest.manifestSha256 = "0".repeat(64);
        },
      }),
      "source manifestSha256 does not match its body",
    );
  });

  await test("manifest with no matching source fails without output", async () => {
    await expectFailure(
      await run(directory, {
        mutateSourceManifest(manifest) {
          manifest.sources[0].sha256 = "0".repeat(64);
        },
        resealSourceManifest: true,
      }),
      "source does not match exactly one preflight manifest entry",
    );
  });

  await test(
    "manifest with duplicate matching entries fails without output",
    async () => {
      await expectFailure(
        await run(directory, {
          mutateSourceManifest(manifest) {
            manifest.sources.push({
              ...structuredClone(manifest.sources[0]),
              sourceId: "source-input-duplicate",
            });
          },
          resealSourceManifest: true,
        }),
        "source matches multiple preflight manifest entries",
      );
    },
  );

  await test("blocked input cannot be overridden by receipt", async () => {
    await expectFailure(
      await run(directory, {
        sourceFindings: [
          { rule: "instruction-override", severity: "block", line: 1 },
        ],
        mutateReceipt(receipt) {
          receipt.approvedReviewEntries.push({
            input: "source",
            sourceId: "source-input-001",
          });
        },
      }),
      "source preflight status is block",
    );
  });

  await test("reviewed input requires exact receipt approval", async () => {
    await expectFailure(
      await run(directory, {
        sourceFindings: [
          { rule: "external-url", severity: "review", line: 1 },
        ],
        mutateReceipt(receipt) {
          receipt.approvedReviewEntries = [];
        },
      }),
      "receipt approvedReviewEntries do not match reviewed inputs",
    );
  });

  for (const [name, mutateReceipt, message] of [
    [
      "receipt bound to another source",
      (receipt) => {
        receipt.sourceInput.sha256 = "0".repeat(64);
      },
      "receipt source input SHA-256 differs",
    ],
    [
      "receipt bound to another authorization",
      (receipt) => {
        receipt.authorizationInput.sha256 = "0".repeat(64);
      },
      "receipt authorization input SHA-256 differs",
    ],
    [
      "receipt bound to another source manifest",
      (receipt) => {
        receipt.sourceInput.manifestSha256 = "0".repeat(64);
      },
      "receipt source manifest SHA-256 differs",
    ],
    [
      "receipt bound to another authorization manifest",
      (receipt) => {
        receipt.authorizationInput.manifestSha256 = "0".repeat(64);
      },
      "receipt authorization manifest SHA-256 differs",
    ],
    [
      "receipt bound to another review decision",
      (receipt) => {
        receipt.approvedReviewEntries = [
          { input: "source", sourceId: "another-source" },
        ];
      },
      "receipt approvedReviewEntries do not match reviewed inputs",
    ],
    [
      "receipt bound to another authorization decision",
      (receipt) => {
        receipt.authorizationDecision = "deny";
      },
      "receipt authorizationDecision must be approve",
    ],
    [
      "receipt bound to another authorization scope",
      (receipt) => {
        receipt.authorizationScope = "external-publication";
      },
      "receipt authorizationScope must be compile-readout-plan-only",
    ],
    [
      "receipt kind differs",
      (receipt) => {
        receipt.kind = "fde-readout-input-receipt/v2";
      },
      "receipt kind must be fde-readout-input-receipt/v1",
    ],
    [
      "receipt omits its authority source",
      (receipt) => {
        receipt.authoritySourceDescription = "";
      },
      "receipt authoritySourceDescription must be a non-empty string",
    ],
  ]) {
    await test(name, async () => {
      await expectFailure(
        await run(directory, { mutateReceipt }),
        message,
      );
    });
  }

  for (const [name, mutateIntent, message] of [
    [
      "intent manufactures receipt",
      (value) => {
        value.receipt = { authorizationDecision: "approve" };
      },
      "Intent cannot contain provenance or receipt fields: receipt",
    ],
    [
      "intent manufactures authorization decision",
      (value) => {
        value.authorizationDecision = "approve";
      },
      "Intent cannot contain provenance or receipt fields: authorizationDecision",
    ],
    [
      "intent manufactures manifest hash",
      (value) => {
        value.manifestSha256 = "0".repeat(64);
      },
      "Intent cannot contain provenance or receipt fields: manifestSha256",
    ],
  ]) {
    await test(name, async () => {
      const testIntent = structuredClone(intent);
      mutateIntent(testIntent);
      await expectFailure(
        await run(directory, { intent: testIntent }),
        message,
      );
    });
  }

  for (const [name, mutate, text] of [
    [
      "missing selected ID",
      (data) => data.intent.selectedEvidenceIds.push("missing-record"),
      "references missing ID",
    ],
    [
      "duplicate selected ID",
      (data) =>
        data.intent.selectedEvidenceIds.push(data.intent.selectedEvidenceIds[0]),
      "contains duplicate IDs",
    ],
    [
      "conflicting source records",
      (data) =>
        data.source.evidence.push({
          ...data.source.evidence[0],
          statement: "Conflict",
        }),
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
      await expectFailure(
        await run(directory, data),
        text,
      );
    });
  }

  await test("output boundary rejects outside workspace", async () => {
    const output = join(tmpdir(), `outside-${Date.now()}.json`);
    const execution = await run(directory, {}, output);
    expect(execution.result.status !== 0, "outside output unexpectedly succeeded");
    expect(
      execution.result.stderr.includes("inside the current workspace"),
      execution.result.stderr,
    );
    await expectAbsent(output);
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
