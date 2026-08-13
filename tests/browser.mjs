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
const pages = [];
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

  await page.goto(baseUrl);
  await page.locator('#connection-status:text-is("Connected")').waitFor();
  const layoutResponse = await page.request.get(`${baseUrl}/api/v1/layout`);
  assert.equal(layoutResponse.status(), 200);
  assert.deepEqual(await layoutResponse.json(), { columns: 3 });
  assert.equal(await instanceCount(page, baseUrl), 0, "startup is empty");
  assert.equal(
    await page.locator("#finish-editing").isVisible(),
    true,
    "empty dashboard enters edit mode",
  );
  assert.equal(
    await page.locator(".dashboard-slot").count(),
    6,
    "empty edit canvas is 3x2",
  );
  assert.equal(
    await page.locator(".dashboard-footer").isVisible(),
    true,
    "connection status is in footer",
  );

  const cpuOne = await addWidget(page, "0", "0", "CPU");
  await waitForTelemetry(page.locator(`[data-instance-id="${cpuOne}"]`));
  assert.equal(
    await page.locator(".dashboard-slot").count(),
    5,
    "occupied first row retains one empty row",
  );

  const cpuTwo = await addWidget(page, "1", "0", "CPU");
  await waitForTelemetry(page.locator(`[data-instance-id="${cpuTwo}"]`));
  assert.notEqual(
    cpuTwo,
    cpuOne,
    "duplicate widget definitions create independent instances",
  );

  const memory = await addWidget(page, "2", "0", "Memory");
  const memoryWidget = page.locator(`[data-instance-id="${memory}"]`);
  await waitForTelemetry(memoryWidget);
  await memoryWidget.locator(".ram .bar-fill").waitFor();
  await memoryWidget.locator(".swap .bar-fill").waitFor();
  assert.equal(await instanceCount(page, baseUrl), 3);

  await page.locator("#finish-editing").click();
  assert.equal(
    await page.locator(".dashboard-slot").count(),
    0,
    "normal mode hides empty slots",
  );
  assert.equal(await page.locator("#edit-layout").isVisible(), true);
  const boxes = await Promise.all(
    [cpuOne, cpuTwo, memory].map((id) =>
      page.locator(`[data-instance-id="${id}"]`).boundingBox(),
    ),
  );
  assert.ok(boxes.every(Boolean));
  assert.ok(boxes.every((box) => box.height === 350));

  await page.reload();
  await page.locator(`[data-instance-id="${cpuOne}"]`).waitFor();
  assert.equal(
    await page.locator("#edit-layout").isVisible(),
    true,
    "refresh retains composed dashboard",
  );

  const secondPage = await context.newPage();
  pages.push(secondPage);
  await secondPage.goto(baseUrl);
  await secondPage.locator(`[data-instance-id="${memory}"]`).waitFor();
  await page.locator("#edit-layout").click();
  await page.locator(`[data-instance-id="${cpuTwo}"] .remove-widget`).click();
  assert.match(await page.locator("#remove-title").textContent(), /Remove CPU/);
  await page.locator("#remove-widget .button[value=cancel]").click();
  await page.locator(`[data-instance-id="${cpuTwo}"]`).waitFor();
  await page.locator(`[data-instance-id="${cpuTwo}"] .remove-widget`).click();
  await page.locator("#confirm-remove").click();
  await page
    .locator(`[data-instance-id="${cpuTwo}"]`)
    .waitFor({ state: "detached" });
  await secondPage
    .locator(`[data-instance-id="${cpuTwo}"]`)
    .waitFor({ state: "detached" });
  assert.equal(
    await instanceCount(page, baseUrl),
    2,
    "confirmed removal synchronizes across pages",
  );

  const memoryTwo = await addWidget(page, "1", "0", "Memory");
  await secondPage.locator(`[data-instance-id="${memoryTwo}"]`).waitFor();
  assert.equal(
    await instanceCount(page, baseUrl),
    3,
    "addition synchronizes across pages",
  );

  await dragToSlot(page, memoryTwo, "1", "1");
  await page
    .locator(`[data-instance-id="${memoryTwo}"][data-row="1"]`)
    .waitFor();
  await secondPage
    .locator(`[data-instance-id="${memoryTwo}"][data-row="1"]`)
    .waitFor();

  const cpuFrame = page.locator(`[data-instance-id="${cpuOne}"]`);
  await cpuFrame.focus();
  await cpuFrame.press("ArrowDown");
  await page
    .locator('#dashboard-announcement:text-is("CPU moved to column 1, row 2")')
    .waitFor();
  await secondPage
    .locator(`[data-instance-id="${cpuOne}"][data-row="1"]`)
    .waitFor();
  await cpuFrame.press("ArrowRight");
  await page
    .locator('#dashboard-announcement:text-is("That position is unavailable")')
    .waitFor();

  const collision = await page.request.post(`${baseUrl}/api/v1/instances`, {
    data: {
      widget_id: "cpu",
      layout: { column: 0, row: 1, width: 1, height: 1 },
    },
  });
  assert.equal(
    collision.status(),
    409,
    "server rejects occupied atomic creation",
  );

  await page.screenshot({
    path: path.join(artifacts, "dashboard-edit-wide.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 420, height: 900 });
  assert.equal(
    await page
      .locator(".dashboard-grid")
      .evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.split(" ").length,
      ),
    1,
    "mobile edit canvas projects to one column",
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: path.join(artifacts, "dashboard-edit-narrow.png"),
    fullPage: true,
  });

  await proxy.stop();
  await page
    .locator('#connection-indicator[data-status="disconnected"]')
    .waitFor();
  await proxy.start();
  await page
    .locator('#connection-indicator[data-status="connected"]')
    .waitFor();
  assert.equal(
    await instanceCount(page, baseUrl),
    3,
    "reconnect retains composition",
  );

  for (const widgetId of ["cpu", "memory"]) {
    const response = await page.request.get(
      `${baseUrl}/widgets/${widgetId}/frontend.js`,
    );
    assert.equal(response.headers()["cache-control"], "no-cache");
  }

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

async function dragToSlot(page, instanceId, column, row) {
  const source = page.locator(`[data-instance-id="${instanceId}"]`);
  const target = page.locator(
    `.dashboard-slot[data-column="${column}"][data-row="${row}"]`,
  );
  const handle = source.locator(".drag-handle");
  const handleBox = await handle.boundingBox();
  const targetBox = await target.boundingBox();
  assert.ok(handleBox);
  assert.ok(targetBox);
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 20, {
    steps: 5,
  });
  assert.equal(
    await source.evaluate((element) => element.classList.contains("dragging")),
    true,
  );
  assert.equal(
    await target.evaluate((element) =>
      element.classList.contains("drop-target"),
    ),
    true,
  );
  await page.mouse.up();
}

async function addWidget(page, column, row, name) {
  await page
    .locator(`.dashboard-slot[data-column="${column}"][data-row="${row}"]`)
    .click();
  await page.locator("#add-widget").waitFor();
  assert.match(
    await page.locator("#add-position").textContent(),
    /Position: Column \d, Row \d/,
  );
  await page.locator(".widget-choice", { hasText: name }).click();
  assert.equal(await page.locator("#widget-selection").isVisible(), true);
  assert.match(
    await page.locator("#widget-selection").textContent(),
    /No options/,
  );
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/instances") &&
      response.request().method() === "POST",
  );
  await page.locator("#confirm-add").click();
  const response = await responsePromise;
  assert.equal(response.status(), 201);
  const instance = await response.json();
  await page.locator(`[data-instance-id="${instance.id}"]`).waitFor();
  return instance.id;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}`,
    );
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
  if (!executable)
    throw new Error("system Chromium not found; set CHROMIUM_PATH");
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
    } catch {}
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
        if (element.textContent !== "--.-%") return resolve();
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
  const exitCode = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 5_000, "timeout")),
  ]);
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
  if (
    (await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 5_000, "timeout")),
    ])) === "timeout"
  ) {
    child.kill("SIGKILL");
    await exited;
  }
}
