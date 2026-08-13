import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "playwright-core";

const root = path.resolve(import.meta.dirname, "..");
const artifacts = path.join(root, "tests/artifacts");
mkdirSync(artifacts, { recursive: true });

run("cargo", ["build", "-p", "dashboardd", "-p", "cpu"]);
run("npm", ["run", "build"]);
run("cargo", ["xtask", "widget", "prepare", "--all"]);

const dashboardPort = await reservePort();
const browserPort = await reservePort();
const dashboardUrl = `http://127.0.0.1:${dashboardPort}`;
const baseUrl = `http://127.0.0.1:${browserPort}`;
const logPath = path.join(artifacts, "dashboardd.log");
const log = openSync(logPath, "w");
const dashboardd = spawn(path.join(root, "target/debug/dashboardd"), [], {
  cwd: root,
  env: {
    ...process.env,
    DASHBOARDD_PORT: String(dashboardPort),
    DASHBOARDD_WIDGETS_DIR: path.join(root, ".build/widgets"),
  },
  stdio: ["ignore", log, log],
});
let browser;
let pages = [];
const proxy = networkProxy(browserPort, dashboardPort);

try {
  await waitForHealth(dashboardUrl);
  await proxy.start();
  browser = await chromium.launch({
    executablePath: chromiumPath(),
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  pages.push(page);

  const pageStartedAt = Date.now();
  await page.goto(baseUrl);
  await page.locator('.dashboard-widget[data-widget-id="cpu"]').waitFor();
  assert.ok(
    Date.now() - pageStartedAt < 5_000,
    "initial SSE data starts reconciliation without waiting for keep-alive",
  );
  await page.locator(".usage").waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".dashboard-widget-mount")
        ?.shadowRoot?.querySelector(".usage")?.textContent !== "--.-%",
  );
  assert.equal(
    await page.locator("#dashboard-error").isHidden(),
    true,
    "creation race does not report a missing widget descriptor",
  );
  assert.equal(
    await instanceCount(page, baseUrl),
    1,
    "creates one CPU instance",
  );
  const frontendResponse = await page.request.get(
    `${baseUrl}/widgets/cpu/frontend.js`,
  );
  assert.equal(frontendResponse.headers()["cache-control"], "no-cache");

  const instanceId = await page
    .locator(".dashboard-widget")
    .getAttribute("data-instance-id");
  assert.ok(instanceId);
  await page.reload();
  await page.locator(`[data-instance-id="${instanceId}"] .usage`).waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".dashboard-widget-mount")
        ?.shadowRoot?.querySelector(".usage")?.textContent !== "--.-%",
  );
  assert.equal(
    await instanceCount(page, baseUrl),
    1,
    "refresh keeps the server-owned instance",
  );

  const secondPage = await context.newPage();
  pages.push(secondPage);
  await secondPage.goto(baseUrl);
  await secondPage.locator(`[data-instance-id="${instanceId}"]`).waitFor();
  assert.equal(
    await instanceCount(secondPage, baseUrl),
    1,
    "two pages share one backend",
  );

  assert.equal(
    await page
      .locator(".dashboard-grid")
      .evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.split(" ").length,
      ),
    3,
    "wide dashboard has three columns",
  );
  const rows = await page.locator(".dashboard-grid").evaluate((grid) => {
    const samples = Array.from({ length: 5 }, () => {
      const item = document.createElement("section");
      item.className = "dashboard-widget";
      grid.append(item);
      return item;
    });
    const positions = Array.from(grid.children, (element) => ({
      left: element.getBoundingClientRect().left,
      top: element.getBoundingClientRect().top,
    }));
    for (const sample of samples) sample.remove();
    return {
      columns: new Set(positions.map((position) => position.left)).size,
      rows: new Set(positions.map((position) => position.top)).size,
    };
  });
  assert.deepEqual(
    rows,
    { columns: 3, rows: 2 },
    "six widgets form a 3x2 grid",
  );

  await page.setViewportSize({ width: 420, height: 900 });
  assert.equal(
    await page
      .locator(".dashboard-grid")
      .evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.split(" ").length,
      ),
    1,
    "narrow dashboard has one column",
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "narrow widget does not overflow",
  );

  await proxy.stop();
  await page
    .locator('#connection-status[data-status="disconnected"]')
    .waitFor();
  await proxy.start();
  await page.locator('#connection-status[data-status="connected"]').waitFor();
  await page.locator(`[data-instance-id="${instanceId}"]`).waitFor();
  assert.equal(
    await instanceCount(page, baseUrl),
    1,
    "reconnect reconciles authoritative state",
  );

  const response = await page.request.delete(
    `${baseUrl}/api/v1/instances/${instanceId}`,
  );
  assert.equal(response.status(), 204);
  await page.locator(`[data-instance-id="${instanceId}"]`).waitFor({
    state: "detached",
  });
  await secondPage.locator(`[data-instance-id="${instanceId}"]`).waitFor({
    state: "detached",
  });
  assert.equal(
    await instanceCount(page, baseUrl),
    0,
    "deletion stops the instance",
  );

  const replacement = await page.request.post(`${baseUrl}/api/v1/instances`, {
    data: { widget_id: "cpu" },
  });
  assert.equal(replacement.status(), 201);
  const replacementId = (await replacement.json()).id;
  await page.locator(`[data-instance-id="${replacementId}"]`).waitFor();

  await requestGracefulStop(dashboardd);
  console.log("browser integration scenarios passed");
} catch (error) {
  for (const [index, page] of pages.entries()) {
    await page
      .screenshot({
        path: path.join(artifacts, `failure-${index + 1}.png`),
        fullPage: true,
      })
      .catch(() => {});
  }
  console.error(`dashboardd log: ${logPath}`);
  throw error;
} finally {
  await browser?.close().catch(() => {});
  await proxy.stop();
  await stopRecordedProcess(dashboardd);
  closeSync(log);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}`,
    );
  }
}

function chromiumPath() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/run/current-system/sw/bin/chromium",
    "/home/alex/.nix-profile/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const executable = candidates.find(existsSync);
  if (!executable) {
    throw new Error("system Chromium not found; set CHROMIUM_PATH");
  }
  return executable;
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.notEqual(typeof address, "string");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function networkProxy(listenPort, targetPort) {
  const connections = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    connections.add(client);
    connections.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    const forget = () => {
      connections.delete(client);
      connections.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    client.once("close", forget);
    upstream.once("close", forget);
    client.once("error", forget);
    upstream.once("error", forget);
  });
  let listening = false;

  return {
    async start() {
      if (listening) return;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(listenPort, "127.0.0.1", resolve);
      });
      listening = true;
    },
    async stop() {
      if (!listening) return;
      for (const connection of connections) connection.destroy();
      connections.clear();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      listening = false;
    },
  };
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The reserved port stays closed until dashboardd starts listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("dashboardd did not become healthy");
}

async function instanceCount(page, baseUrl) {
  const response = await page.request.get(`${baseUrl}/api/v1/instances`);
  assert.equal(response.ok(), true);
  return (await response.json()).instances.length;
}

async function requestGracefulStop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGINT");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const timeout = new Promise((resolve) =>
    setTimeout(resolve, 5_000, "timeout"),
  );
  const exitCode = await Promise.race([exited, timeout]);
  assert.notEqual(
    exitCode,
    "timeout",
    "dashboardd exits after SIGINT while SSE clients are connected",
  );
  assert.equal(exitCode, 0, "dashboardd completes graceful shutdown");
}

async function stopRecordedProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGINT");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const timeout = new Promise((resolve) =>
    setTimeout(resolve, 5_000, "timeout"),
  );
  if ((await Promise.race([exited, timeout])) === "timeout") {
    child.kill("SIGKILL");
    await exited;
  }
}
