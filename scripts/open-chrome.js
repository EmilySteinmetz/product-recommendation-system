import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT ?? 3000);
const url = `http://127.0.0.1:${port}`;
const healthUrl = `${url}/api/health`;

async function isGoodfindRunning() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return false;
    const body = await response.json();
    return body.service === "Goodfind comparison server";
  } catch {
    return false;
  }
}

async function waitForServer(child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await isGoodfindRunning()) return;
    if (child.exitCode !== null) {
      throw new Error(`Goodfind server exited with code ${child.exitCode}.`);
    }
    await delay(250);
  }
  throw new Error(`Goodfind did not start. Check whether port ${port} is available.`);
}

async function openChrome() {
  const browser = spawn("open", ["-a", "Google Chrome", url], { stdio: "ignore" });
  const exitCode = await new Promise((resolveExit, reject) => {
    browser.once("error", reject);
    browser.once("close", resolveExit);
  });
  if (exitCode !== 0) throw new Error("Google Chrome could not open the Goodfind page.");
}

try {
  if (!(await isGoodfindRunning())) {
    const server = spawn(process.execPath, ["server.js"], {
      cwd: root,
      detached: true,
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
      stdio: "ignore"
    });
    server.unref();
    await waitForServer(server);
  }
  await openChrome();
  console.log(`Opened Goodfind in Google Chrome: ${url}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
