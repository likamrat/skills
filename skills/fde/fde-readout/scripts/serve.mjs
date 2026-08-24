#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
]);

function inside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function createReadoutServer({
  directory,
  host = "127.0.0.1",
  port = 4173,
} = {}) {
  const root = resolve(directory);
  await access(join(root, "index.html"));
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${host}:${port}`);
      const requested = url.pathname.endsWith("/")
        ? join(root, decodeURIComponent(url.pathname), "index.html")
        : join(root, decodeURIComponent(url.pathname));
      const path = resolve(requested);
      if (!inside(root, path)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const info = await stat(path);
      if (!info.isFile()) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.setHeader(
        "Content-Type",
        mimeTypes.get(extname(path).toLowerCase()) ??
          "application/octet-stream",
      );
      response.setHeader("Cache-Control", "no-store");
      createReadStream(path).pipe(response);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise((listen, reject) => {
    server.once("error", reject);
    server.listen(port, host, listen);
  });
  const address = server.address();
  const activePort = typeof address === "object" ? address.port : port;
  return { server, url: `http://${host}:${activePort}/` };
}

function parseArgs(args) {
  const directory = args.find((arg) => !arg.startsWith("--"));
  const portIndex = args.indexOf("--port");
  const port =
    portIndex >= 0 ? Number.parseInt(args[portIndex + 1], 10) : 4173;
  return { directory, port };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const { directory, port } = parseArgs(process.argv.slice(2));
  if (!directory || !Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(
      "Usage: node scripts/serve.mjs <output-directory> [--port 4173]",
    );
    process.exit(2);
  }
  const running = await createReadoutServer({ directory, port });
  console.log(`FDE readout: ${running.url}`);
}
