import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "playwright-core";

const root = path.resolve(import.meta.dirname, "..");
const artifacts = path.join(root, "tests/artifacts");
mkdirSync(artifacts, { recursive: true });

run("cargo", ["build", "-p", "dashboardd", "-p", "cpu", "-p", "memory"]);
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
  const cpuWidget = page.locator('.dashboard-widget[data-widget-id="cpu"]');
  const memoryWidget = page.locator(
    '.dashboard-widget[data-widget-id="memory"]',
  );
  await cpuWidget.waitFor();
  await memoryWidget.waitFor();
  assert.ok(
    Date.now() - pageStartedAt < 5_000,
    "initial SSE data starts reconciliation without waiting for keep-alive",
  );
  await waitForTelemetry(cpuWidget);
  await waitForTelemetry(memoryWidget);
  await memoryWidget.locator(".ram .bar-fill").waitFor();
  await memoryWidget.locator(".swap .bar-fill").waitFor();
  assert.match(
    await memoryWidget.locator('[data-memory="used"]').textContent(),
    /\/.*(?:MiB|GiB|TiB)/,
  );
  assert.equal(
    await page.locator("#dashboard-error").isHidden(),
    true,
    "creation race does not report a missing widget descriptor",
  );
  assert.equal(
    await instanceCount(page, baseUrl),
    2,
    "creates CPU and Memory instances",
  );
  for (const widgetId of ["cpu", "memory"]) {
    const frontendResponse = await page.request.get(
      `${baseUrl}/widgets/${widgetId}/frontend.js`,
    );
    assert.equal(frontendResponse.headers()["cache-control"], "no-cache");
  }

  const cpuInstanceId = await cpuWidget.getAttribute("data-instance-id");
  const memoryInstanceId = await memoryWidget.getAttribute("data-instance-id");
  assert.ok(cpuInstanceId);
  assert.ok(memoryInstanceId);
  await page.reload();
  await waitForTelemetry(page.locator(`[data-instance-id="${cpuInstanceId}"]`));
  await waitForTelemetry(
    page.locator(`[data-instance-id="${memoryInstanceId}"]`),
  );
  assert.equal(
    await instanceCount(page, baseUrl),
    2,
    "refresh keeps both server-owned instances",
  );

  const secondPage = await context.newPage();
  pages.push(secondPage);
  await secondPage.goto(baseUrl);
  await secondPage.locator(`[data-instance-id="${cpuInstanceId}"]`).waitFor();
  await secondPage
    .locator(`[data-instance-id="${memoryInstanceId}"]`)
    .waitFor();
  assert.equal(
    await instanceCount(secondPage, baseUrl),
    2,
    "two pages share both backends",
  );

  const cpuBox = await page
    .locator(`[data-instance-id="${cpuInstanceId}"]`)
    .boundingBox();
  const memoryBox = await page
    .locator(`[data-instance-id="${memoryInstanceId}"]`)
    .boundingBox();
  assert.ok(cpuBox);
  assert.ok(memoryBox);
  assert.ok(
    Math.abs(memoryBox.width - cpuBox.width) < 0.1,
    "1x1 widgets have equal width",
  );
  assert.equal(
    memoryBox.height,
    cpuBox.height,
    "1x1 widgets have equal height",
  );
  assert.equal(cpuBox.height, 350, "one grid height unit is 350 px");

  const expanded = await page.request.patch(
    `${baseUrl}/api/v1/instances/${memoryInstanceId}`,
    { data: { layout: { column: 0, row: 0, width: 2, height: 2 } } },
  );
  assert.equal(expanded.status(), 200);
  await page
    .locator(`[data-instance-id="${memoryInstanceId}"][data-layout="2x2"]`)
    .waitFor();
  const expandedBox = await page
    .locator(`[data-instance-id="${memoryInstanceId}"]`)
    .boundingBox();
  assert.ok(expandedBox);
  assert.ok(Math.abs(expandedBox.width - (cpuBox.width * 2 + 20)) < 0.1);
  assert.equal(expandedBox.height, cpuBox.height * 2 + 20);

  const restored = await page.request.patch(
    `${baseUrl}/api/v1/instances/${memoryInstanceId}`,
    { data: { layout: { column: 0, row: 0, width: 1, height: 1 } } },
  );
  assert.equal(restored.status(), 200);
  await page
    .locator(`[data-instance-id="${memoryInstanceId}"][data-layout="1x1"]`)
    .waitFor();

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
    const samples = Array.from({ length: 4 }, () => {
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

  await page.screenshot({
    path: path.join(artifacts, "dashboard-wide.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 420, height: 900 });
  const narrowCpuBox = await page
    .locator(`[data-instance-id="${cpuInstanceId}"]`)
    .boundingBox();
  const narrowMemoryBox = await page
    .locator(`[data-instance-id="${memoryInstanceId}"]`)
    .boundingBox();
  assert.ok(narrowCpuBox);
  assert.ok(narrowMemoryBox);
  assert.ok(Math.abs(narrowMemoryBox.width - narrowCpuBox.width) < 0.1);
  assert.equal(narrowMemoryBox.height, narrowCpuBox.height);
  assert.equal(narrowCpuBox.height, 350);
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
  await page.screenshot({
    path: path.join(artifacts, "dashboard-narrow.png"),
    fullPage: true,
  });

  await proxy.stop();
  await page
    .locator('#connection-status[data-status="disconnected"]')
    .waitFor();
  await proxy.start();
  await page.locator('#connection-status[data-status="connected"]').waitFor();
  await page.locator(`[data-instance-id="${cpuInstanceId}"]`).waitFor();
  await page.locator(`[data-instance-id="${memoryInstanceId}"]`).waitFor();
  assert.equal(
    await instanceCount(page, baseUrl),
    2,
    "reconnect reconciles both authoritative instances",
  );

  const response = await page.request.delete(
    `${baseUrl}/api/v1/instances/${memoryInstanceId}`,
  );
  assert.equal(response.status(), 204);
  await page.locator(`[data-instance-id="${memoryInstanceId}"]`).waitFor({
    state: "detached",
  });
  await secondPage
    .locator(`[data-instance-id="${memoryInstanceId}"]`)
    .waitFor({ state: "detached" });
  await page.locator(`[data-instance-id="${cpuInstanceId}"]`).waitFor();
  assert.equal(
    await instanceCount(page, baseUrl),
    1,
    "memory deletion leaves CPU running",
  );

  const replacement = await page.request.post(`${baseUrl}/api/v1/instances`, {
    data: { widget_id: "memory" },
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

async function waitForTelemetry(widget) {
  const usage = widget.locator(".usage");
  await usage.waitFor();
  await usage.evaluate(
    (element) =>
      new Promise((resolve, reject) => {
        if (element.textContent !== "--.-%") {
          resolve();
          return;
        }
        const observer = new MutationObserver(() => {
          if (element.textContent !== "--.-%") {
            observer.disconnect();
            resolve();
          }
        });
        observer.observe(element, { childList: true, characterData: true });
        setTimeout(() => {
          observer.disconnect();
          reject(new Error("widget telemetry did not arrive"));
        }, 5_000);
      }),
  );
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
