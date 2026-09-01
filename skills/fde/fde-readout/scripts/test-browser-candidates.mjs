#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  browserCandidates,
  browserLaunchArguments,
} from "./browser-candidates.mjs";

assert.deepEqual(
  browserCandidates("linux", {
    FDE_READOUT_BROWSER: "/custom/browser",
    CHROME_BIN: "/runner/chrome",
  }),
  [
    "/custom/browser",
    "/runner/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/microsoft-edge",
  ],
  "Linux must prefer configured browsers, then Chrome and Chromium before Edge",
);

const windows = browserCandidates("win32", {
  "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
  PROGRAMFILES: "C:\\Program Files",
});
assert.match(windows[0], /Microsoft\\Edge\\Application\\msedge\.exe$/);
assert.match(windows[1], /Google\\Chrome\\Application\\chrome\.exe$/);

assert.deepEqual(
  browserCandidates("linux", {
    FDE_READOUT_BROWSER: "/same/browser",
    CHROME_BIN: "/same/browser",
  }).slice(0, 2),
  ["/same/browser", "/usr/bin/google-chrome"],
  "duplicate configured candidates must be removed",
);

const linuxArguments = browserLaunchArguments("/tmp/profile", "linux");
assert(linuxArguments.includes("--no-sandbox"));
assert(linuxArguments.includes("--disable-dev-shm-usage"));
assert(!linuxArguments.includes("--disable-setuid-sandbox"));

for (const platform of ["win32", "darwin"]) {
  const argumentsForPlatform = browserLaunchArguments("/tmp/profile", platform);
  assert(!argumentsForPlatform.includes("--no-sandbox"));
  assert(!argumentsForPlatform.includes("--disable-dev-shm-usage"));
  assert(argumentsForPlatform.includes("--remote-debugging-port=0"));
  assert(argumentsForPlatform.includes("--user-data-dir=/tmp/profile"));
}

console.log("Browser candidate ordering passed.");
