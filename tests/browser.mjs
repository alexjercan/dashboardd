import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "playwright-core";

const root = path.resolve(import.meta.dirname, "..");
const artifacts = path.join(root, "tests/artifacts");
mkdirSync(artifacts, { recursive: true });

run("cargo", ["build", "--workspace"]);
run("npm", ["run", "build"]);
run("cargo", ["xtask", "widget", "prepare", "--all"]);

const dashboardPort = await reservePort();
const browserPort = await reservePort();
const stateFile = path.join(artifacts, `dashboard-${process.pid}.json`);
const dashboardUrl = `http://127.0.0.1:${dashboardPort}`;
const baseUrl = `http://127.0.0.1:${browserPort}`;
const logPath = path.join(artifacts, "dashboardd.log");
const log = openSync(logPath, "w");
let dashboardd = startDashboardd();
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
  assert.deepEqual(await layoutResponse.json(), { columns: 9 });
  assert.equal(await instanceCount(page, baseUrl), 0, "startup is empty");
  assert.equal(
    await page.locator("#finish-editing").isVisible(),
    true,
    "empty dashboard enters edit mode",
  );
  assert.equal(
    await page.locator(".dashboard-slot").count(),
    54,
    "empty edit canvas is 9x6",
  );
  assert.equal(
    await page.locator(".dashboard-footer").isVisible(),
    true,
    "connection status is in footer",
  );

  const catalogResponse = await page.request.get(`${baseUrl}/api/v1/widgets`);
  const catalog = (await catalogResponse.json()).widgets;
  assert.deepEqual(
    Object.fromEntries(
      catalog.map((widget) => [
        widget.id,
        widget.variants.map((variant) => [
          variant.id,
          variant.width,
          variant.height,
        ]),
      ]),
    ),
    {
      "claude-usage": [
        ["full", 3, 2],
        ["compact", 3, 1],
        ["minimal", 1, 1],
      ],
      "codex-usage": [
        ["compact", 3, 1],
        ["minimal", 1, 1],
      ],
      cpu: [
        ["full", 3, 3],
        ["compact", 1, 1],
      ],
      memory: [
        ["full", 3, 3],
        ["compact", 1, 1],
      ],
    },
  );

  const cpuOne = await addWidget(page, "0", "0", "CPU", "Compact");
  await waitForTelemetry(page.locator(`[data-instance-id="${cpuOne}"]`));
  assert.equal(
    await page.locator(".dashboard-slot").count(),
    53,
    "occupied first unit retains the minimum canvas",
  );

  const cpuTwo = await addWidget(page, "1", "0", "CPU", "Compact");
  await waitForTelemetry(page.locator(`[data-instance-id="${cpuTwo}"]`));
  assert.notEqual(
    cpuTwo,
    cpuOne,
    "duplicate widget definitions create independent instances",
  );

  const memory = await addWidget(page, "2", "0", "Memory", "Compact");
  const memoryWidget = page.locator(`[data-instance-id="${memory}"]`);
  await waitForTelemetry(memoryWidget);
  await memoryWidget.locator(".bar .fill").waitFor();
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
  assert.ok(boxes.every((box) => box.height === 110));

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

  const memoryTwo = await addWidget(page, "1", "0", "Memory", "Compact");
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
    .locator('#dashboard-announcement:text-is("CPU swapped with Memory")')
    .waitFor();
  await secondPage
    .locator(`[data-instance-id="${cpuOne}"][data-column="1"]`)
    .waitFor();
  await secondPage
    .locator(`[data-instance-id="${memoryTwo}"][data-column="0"]`)
    .waitFor();

  await dragToWidget(page, memoryTwo, memory);
  await page
    .locator('#dashboard-announcement:text-is("Memory swapped with Memory")')
    .waitFor();
  await secondPage
    .locator(`[data-instance-id="${memoryTwo}"][data-column="2"][data-row="0"]`)
    .waitFor();
  await secondPage
    .locator(`[data-instance-id="${memory}"][data-column="0"][data-row="1"]`)
    .waitFor();
  assert.equal(
    await page
      .locator(`[data-instance-id="${memoryTwo}"]`)
      .evaluate((element) => element === document.activeElement),
    true,
  );

  const collision = await page.request.post(`${baseUrl}/api/v1/instances`, {
    data: {
      widget_id: "cpu",
      variant_id: "compact",
      position: { column: 2, row: 0 },
    },
  });
  assert.equal(
    collision.status(),
    409,
    "server rejects occupied atomic creation",
  );

  const fullResponse = await page.request.post(`${baseUrl}/api/v1/instances`, {
    data: {
      widget_id: "cpu",
      variant_id: "full",
      position: { column: 3, row: 0 },
    },
  });
  assert.equal(fullResponse.status(), 201);
  const fullInstance = await fullResponse.json();
  const fullFrame = page.locator(`[data-instance-id="${fullInstance.id}"]`);
  await fullFrame.waitFor();
  await waitForTelemetry(fullFrame);
  const fullBox = await fullFrame.boundingBox();
  assert.ok(fullBox);
  assert.equal(fullBox.height, 350);
  assert.deepEqual(fullInstance.layout, {
    column: 3,
    row: 0,
    width: 3,
    height: 3,
  });
  await page.request.delete(`${baseUrl}/api/v1/instances/${fullInstance.id}`);
  await fullFrame.waitFor({ state: "detached" });

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
    3,
    "mobile edit canvas projects to three unit columns",
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

  for (const [widgetId, variants] of [
    ["cpu", ["full", "compact"]],
    ["memory", ["full", "compact"]],
    ["claude-usage", ["full", "compact", "minimal"]],
    ["codex-usage", ["compact", "minimal"]],
  ]) {
    for (const variantId of variants) {
      const response = await page.request.get(
        `${baseUrl}/widgets/${widgetId}/variants/${variantId}/frontend.js`,
      );
      assert.equal(response.status(), 200);
      assert.equal(response.headers()["cache-control"], "no-cache");
    }
  }

  for (const widgetId of ["claude-usage", "codex-usage"]) {
    const commandResult = await exerciseUsageCommands(page, widgetId);
    assert.deepEqual(commandResult.commands, [
      { command: "refresh", force: false },
      { command: "refresh", force: true },
    ]);
    assert.equal(commandResult.minimalHasRefresh, false);
  }

  await requestGracefulStop(dashboardd);
  assert.equal(existsSync(stateFile), true, "composition is persisted");
  dashboardd = startDashboardd();
  await waitForHealth(dashboardUrl);
  await page.locator(`[data-instance-id="${cpuOne}"]`).waitFor();
  assert.equal(
    await instanceCount(page, baseUrl),
    3,
    "restart restores persisted composition with stable IDs",
  );
  await waitForTelemetry(page.locator(`[data-instance-id="${cpuOne}"]`));
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
  if (existsSync(stateFile)) unlinkSync(stateFile);
}

async function exerciseUsageCommands(page, widgetId) {
  return page.evaluate(async (id) => {
    const module = await import(
      `/widgets/${id}/variants/compact/frontend.js?command-test`
    );
    const container = document.createElement("div");
    document.body.append(container);
    const commands = [];
    const frontend = module.mount(container, {
      widgetId: id,
      variantId: "compact",
      instanceId: `${id}-command-test`,
      async send(payload) {
        commands.push(payload);
      },
    });
    await new Promise((resolve) => setTimeout(resolve));
    frontend.update({
      status: "ok",
      subscription_type: "test",
      updated_at: Math.floor(Date.now() / 1000),
      stale: false,
      important: {
        label: "Weekly",
        remaining_percent: 50,
        resets_at: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    container.shadowRoot.querySelector(".refresh").click();
    await new Promise((resolve) => setTimeout(resolve));
    if (!container.shadowRoot.querySelector(".refresh").disabled)
      throw new Error("Refresh button was not disabled");
    frontend.destroy();
    container.remove();

    const minimalModule = await import(
      `/widgets/${id}/variants/minimal/frontend.js?command-test`
    );
    const minimal = document.createElement("div");
    document.body.append(minimal);
    const minimalFrontend = minimalModule.mount(minimal, {
      widgetId: id,
      variantId: "minimal",
      instanceId: `${id}-minimal-command-test`,
      async send() {},
    });
    minimalFrontend.update({
      status: "ok",
      subscription_type: "test",
      updated_at: Math.floor(Date.now() / 1000),
      stale: false,
      important: {
        label: "Weekly",
        remaining_percent: 50,
        resets_at: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    const minimalHasRefresh =
      minimal.shadowRoot.querySelector(".refresh") !== null;
    minimalFrontend.destroy();
    minimal.remove();
    return { commands, minimalHasRefresh };
  }, widgetId);
}

function startDashboardd() {
  return spawn(path.join(root, "target/debug/dashboardd"), [], {
    cwd: root,
    env: {
      ...process.env,
      DASHBOARDD_PORT: String(dashboardPort),
      DASHBOARDD_WIDGETS_DIR: path.join(root, ".build/widgets"),
      DASHBOARDD_STATE_FILE: stateFile,
    },
    stdio: ["ignore", log, log],
  });
}

async function dragToWidget(page, sourceId, targetId) {
  const source = page.locator(`[data-instance-id="${sourceId}"]`);
  const target = page.locator(`[data-instance-id="${targetId}"]`);
  const handleBox = await source.locator(".drag-handle").boundingBox();
  const targetBox = await target.boundingBox();
  assert.ok(handleBox);
  assert.ok(targetBox);
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 5 },
  );
  assert.equal(
    await target.evaluate((element) =>
      element.classList.contains("drop-target"),
    ),
    true,
  );
  await page.mouse.up();
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
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 5 },
  );
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

async function addWidget(page, column, row, name, variant) {
  await page
    .locator(`.dashboard-slot[data-column="${column}"][data-row="${row}"]`)
    .click();
  await page.locator("#add-widget").waitFor();
  assert.match(
    await page.locator("#add-position").textContent(),
    /Position: Column \d, Row \d/,
  );
  await page
    .locator(
      `.widget-choice[data-widget-id="${name.toLowerCase()}"][data-variant-id="${variant.toLowerCase()}"]`,
    )
    .click();
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
