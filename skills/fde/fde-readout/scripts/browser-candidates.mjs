import { win32 } from "node:path";

export function browserCandidates(
  platform = process.platform,
  environment = process.env,
) {
  const configured = [
    environment.FDE_READOUT_BROWSER,
    environment.CHROME_BIN,
  ];
  let defaults;

  if (platform === "win32") {
    defaults = [
      environment["PROGRAMFILES(X86)"]
        ? win32.join(
            environment["PROGRAMFILES(X86)"],
            "Microsoft",
            "Edge",
            "Application",
            "msedge.exe",
          )
        : undefined,
      environment.PROGRAMFILES
        ? win32.join(
            environment.PROGRAMFILES,
            "Google",
            "Chrome",
            "Application",
            "chrome.exe",
          )
        : undefined,
    ];
  } else if (platform === "darwin") {
    defaults = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  } else {
    defaults = [
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/microsoft-edge",
    ];
  }

  return [...new Set([...configured, ...defaults].filter(Boolean))];
}

export function browserLaunchArguments(profile, platform = process.platform) {
  return [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    ...(platform === "linux"
      ? ["--no-sandbox", "--disable-dev-shm-usage"]
      : []),
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ];
}
