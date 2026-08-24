#!/usr/bin/env node

import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = "npx";
const version = "1.5.22";
const directory = await mkdtemp(join(root, ".cli-smoke-"));
const failures = [];

function run(args, { cwd = directory, env = process.env } = {}) {
  const result = spawnSync(
    cli,
    ["--yes", `skills@${version}`, ...args],
    {
      cwd,
      env,
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 120_000,
    },
  );
  return {
    ...result,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}${
      result.error ? `\n${result.error.message}` : ""
    }`,
  };
}

function check(condition, message) {
  if (!condition) failures.push(message);
}

async function project(name) {
  const path = join(directory, name);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "package.json"),
    JSON.stringify({ name: name.replaceAll(/[^a-z0-9-]/gi, "-"), private: true }),
  );
  return path;
}

try {
  const list = run(["add", root, "--list"]);
  check(list.status === 0, `local discovery failed:\n${list.output}`);
  check(
    list.output.includes("fde-engagement") &&
      list.output.includes("fde-readout"),
    "local discovery did not list both skills",
  );

  for (const skill of ["fde-engagement", "fde-readout"]) {
    const cwd = await project(`install-${skill}`);
    const install = run(
      [
        "add",
        root,
        "--skill",
        skill,
        "--agent",
        "github-copilot",
        "-y",
      ],
      { cwd },
    );
    check(
      install.status === 0,
      `${skill} project install failed:\n${install.output}`,
    );
    try {
      await access(join(cwd, ".agents", "skills", skill, "SKILL.md"));
    } catch {
      failures.push(`${skill} project install did not create SKILL.md`);
    }
    if (skill === "fde-readout") {
      try {
        await access(
          join(
            cwd,
            ".agents",
            "skills",
            skill,
            "scripts",
            "render-html.mjs",
          ),
        );
        await access(
          join(
            cwd,
            ".agents",
            "skills",
            skill,
            "assets",
            "readout-plan.template.json",
          ),
        );
      } catch {
        failures.push("fde-readout install is missing renderer or plan template");
      }
    }

    try {
      const lock = JSON.parse(
        await readFile(join(cwd, "skills-lock.json"), "utf8"),
      );
      check(lock.version === 1, `${skill} lockfile version is invalid`);
      check(
        lock.skills?.[skill]?.sourceType === "local" &&
          typeof lock.skills?.[skill]?.computedHash === "string",
        `${skill} lockfile source metadata is invalid`,
      );

      const update = run(["update", "--project", "-y"], { cwd });
      check(
        update.status === 0,
        `${skill} project update failed:\n${update.output}`,
      );
    } catch {
      failures.push(
        `${skill} project install did not create skills-lock.json:\n${install.output}`,
      );
    }
  }

  const wildcardCwd = await project("install-all");
  const wildcard = run(
    [
      "add",
      root,
      "--skill",
      "*",
      "--agent",
      "github-copilot",
      "-y",
    ],
    { cwd: wildcardCwd },
  );
  check(wildcard.status === 0, `wildcard install failed:\n${wildcard.output}`);
  for (const skill of ["fde-engagement", "fde-readout"]) {
    try {
      await access(
        join(wildcardCwd, ".agents", "skills", skill, "SKILL.md"),
      );
    } catch {
      failures.push(`wildcard install omitted ${skill}`);
    }
  }

  const use = run(["use", root, "--skill", "fde-engagement"]);
  check(use.status === 0, `one-session use failed:\n${use.output}`);
  check(
    use.output.includes("fde-engagement") && use.output.length > 100,
    "one-session use did not emit a usable prompt",
  );

  const globalHome = join(directory, "global-home");
  const globalWork = await project("global-work");
  await mkdir(globalHome, { recursive: true });
  const globalEnv = {
    ...process.env,
    HOME: globalHome,
    USERPROFILE: globalHome,
  };
  const globalInstall = run(
    [
      "add",
      root,
      "--skill",
      "fde-engagement",
      "--global",
      "--agent",
      "github-copilot",
      "-y",
    ],
    { cwd: globalWork, env: globalEnv },
  );
  check(
    globalInstall.status === 0,
    `isolated global install failed:\n${globalInstall.output}`,
  );
  try {
    await access(
      join(globalHome, ".agents", "skills", "fde-engagement", "SKILL.md"),
    );
  } catch {
    failures.push("isolated global install did not create SKILL.md");
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("Skills CLI smoke tests failed:");
  failures.forEach((failure, index) =>
    console.error(`${index + 1}. ${failure}`),
  );
  process.exit(1);
}

console.log(
  `Skills CLI smoke tests passed with skills@${version}: discovery, project installs, wildcard, use, update, and isolated global install.`,
);
