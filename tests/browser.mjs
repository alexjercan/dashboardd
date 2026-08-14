import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
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
await verifyBackendHealthProbes();

const dashboardPort = await reservePort();
const browserPort = await reservePort();
const stateFile = path.join(artifacts, `dashboard-${process.pid}.json`);
const configFile = path.join(artifacts, `config-${process.pid}.toml`);
const tatrRoot = path.join(artifacts, `tatr-${process.pid}`);
writeTatrTask(
  "scufris",
  "20260814-120000",
  "Add Tatr widget",
  "IN_PROGRESS",
  100,
  ["widget", "rust"],
);
writeTatrTask("tatr", "20260814-110000", "Document filters", "OPEN", 40, [
  "docs",
]);
writeTatrTask("tatr", "20260814-100000", "Old task", "CLOSED", 200, [
  "archive",
]);
writeConfiguration("#123456");
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
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
  });

  await page.goto(baseUrl);
  await page.locator('#connection-status:text-is("Connected")').waitFor();
  const layoutResponse = await page.request.get(`${baseUrl}/api/v1/layout`);
  assert.equal(layoutResponse.status(), 200);
  assert.deepEqual(await layoutResponse.json(), { columns: 9 });
  assert.equal(await instanceCount(page, baseUrl), 0, "startup is empty");
  assert.equal(
    await page.locator("#editor-header").isHidden(),
    true,
    "Zen mode hides the editor header",
  );
  assert.equal(await page.locator("#empty-dashboard").isVisible(), true);
  assert.equal(await page.locator(".dashboard-slot").count(), 0);
  assert.equal(await page.locator("#edit-layout").isVisible(), true);
  assert.equal(
    await page
      .locator(".dashboard-footer")
      .evaluate((element) => getComputedStyle(element).position),
    "fixed",
    "Zen controls remain in the viewport",
  );
  await page.locator("#edit-layout").click();
  await page.waitForURL(`${baseUrl}/edit`);
  assert.equal(await page.locator("#finish-editing").isVisible(), true);
  assert.equal(
    await page
      .locator("#editor-heading")
      .evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal(
    await page.locator(".dashboard-slot").count(),
    54,
    "empty editor canvas is 9x6",
  );
  await page.locator("#finish-editing").click();
  await page.waitForURL(baseUrl + "/");
  assert.equal(
    await page
      .locator("#edit-layout")
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.goBack();
  await page.waitForURL(`${baseUrl}/edit`);
  assert.equal(await page.locator("#editor-header").isVisible(), true);
  await page.goForward();
  await page.waitForURL(baseUrl + "/");
  await page.locator("#edit-layout").click();
  await page.waitForURL(`${baseUrl}/edit`);
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue(
        "--scufris-color-accent",
      ),
    ),
    "#123456",
  );
  assert.match(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue(
        "--scufris-font-mono",
      ),
    ),
    /^"Iosevka"/,
  );
  writeConfiguration("#abcdef");
  await page.waitForFunction(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue(
        "--scufris-color-accent",
      ) === "#abcdef",
  );
  writeConfiguration("yellow");
  await page
    .locator(
      "#dashboard-error:text-is('Configuration reload failed: theme.accent must be a six-digit hexadecimal color')",
    )
    .waitFor();
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue(
        "--scufris-color-accent",
      ),
    ),
    "#abcdef",
    "invalid reload retains the last valid theme",
  );
  writeConfiguration("#fedcba");
  await page.waitForFunction(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue(
        "--scufris-color-accent",
      ) === "#fedcba",
  );
  assert.equal(await page.locator("#dashboard-error").isHidden(), true);
  writeConfiguration("#fedcba", "", "DejaVu Sans Mono");
  await page.waitForFunction(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--scufris-font-mono")
      .startsWith('"DejaVu Sans Mono"'),
  );
  writeConfiguration("#fedcba", "", "Iosevka; monospace");
  await page
    .locator(
      "#dashboard-error:text-is('Configuration reload failed: theme.fonts.sans must contain only ASCII letters, digits, spaces, underscores, or hyphens')",
    )
    .waitFor();
  assert.match(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue(
        "--scufris-font-mono",
      ),
    ),
    /^"DejaVu Sans Mono"/,
  );
  writeConfiguration("#fedcba");
  await page.waitForFunction(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--scufris-font-mono")
      .startsWith('"Iosevka"'),
  );
  assert.equal(await page.locator("#dashboard-error").isHidden(), true);
  unlinkSync(configFile);
  await page.waitForFunction(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue(
        "--scufris-color-accent",
      ) === "#ffdd33",
  );
  writeConfiguration("#fedcba");
  await page.waitForFunction(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue(
        "--scufris-color-accent",
      ) === "#fedcba",
  );

  const catalogResponse = await page.request.get(`${baseUrl}/api/v1/widgets`);
  const catalog = (await catalogResponse.json()).widgets;
  assert.deepEqual(
    Object.fromEntries(catalog.map((widget) => [widget.id, widget.name])),
    {
      "claude-usage": "Claude Usage",
      "codex-usage": "Codex Usage",
      cpu: "CPU",
      memory: "RAM",
      "tatr-tasks": "Tatr Tasks",
    },
  );
  assert.deepEqual(
    catalog
      .find((widget) => widget.id === "cpu")
      .options.map((option) => [option.id, option.type, option.default]),
    [
      ["show_core_temperatures", "boolean", true],
      ["history_points", "integer", 40],
    ],
  );
  assert.deepEqual(
    catalog
      .find((widget) => widget.id === "tatr-tasks")
      .outputs.map((port) => [port.id, port.type, port.variants]),
    [["selected_task", "tatr.task-selection/v1", ["full"]]],
  );
  assert.deepEqual(
    catalog
      .find((widget) => widget.id === "tatr-tasks")
      .inputs.map((port) => [port.id, port.type, port.variants, port.required]),
    [["task", "tatr.task-selection/v1", ["details"], true]],
  );
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
      "tatr-tasks": [
        ["full", 6, 3],
        ["details", 3, 3],
      ],
    },
  );

  const cpuOne = await addWidget(page, "0", "0", "CPU", "Compact");
  const cpuOneFrame = page.locator(`[data-instance-id="${cpuOne}"]`);
  await waitForTelemetry(cpuOneFrame);
  assert.equal(
    await cpuOneFrame
      .locator(".usage")
      .evaluate((element) => getComputedStyle(element).color),
    "rgb(254, 220, 186)",
    "widget Shadow DOM inherits the live theme",
  );
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

  const memory = await addWidget(page, "2", "0", "RAM", "Compact");
  const memoryWidget = page.locator(`[data-instance-id="${memory}"]`);
  await waitForTelemetry(memoryWidget);
  await memoryWidget.locator(".bar .fill").waitFor();
  assert.equal(await instanceCount(page, baseUrl), 3);

  await waitForInstanceHealth(page, baseUrl, cpuOne, "healthy");
  const healthResponse = await page.request.get(
    `${baseUrl}/api/v1/instance-health`,
  );
  assert.equal(healthResponse.status(), 200);
  assert.deepEqual(
    (await healthResponse.json()).instances.map((health) => [
      health.instance_id,
      health.status,
    ]),
    [
      [cpuOne, "healthy"],
      [cpuTwo, "healthy"],
      [memory, "healthy"],
    ],
  );
  const cpuHealthButton = cpuOneFrame.locator(".widget-health-button");
  await cpuHealthButton.click();
  await page.locator("#widget-health").waitFor();
  assert.equal(await page.locator("#health-status").textContent(), "Healthy");
  assert.notEqual(await page.locator("#health-updated").textContent(), "Never");
  assert.equal(await page.locator("#health-restarts").textContent(), "0");
  await page.screenshot({
    path: path.join(artifacts, "widget-health-dialog-wide.png"),
  });
  await page.locator("#restart-widget").click();
  assert.equal(
    await page.locator("#restart-widget").textContent(),
    "Confirm restart",
    "restart requires explicit confirmation",
  );
  await page.locator("#restart-widget").click();
  await page
    .locator('#dashboard-announcement:text-is("Widget backend restarted")')
    .waitFor();
  await waitForInstanceHealth(page, baseUrl, cpuOne, "healthy", 1);
  assert.equal(await page.locator("#health-restarts").textContent(), "1");
  await page.locator('#widget-health .button[value="cancel"]').click();
  assert.equal(await instanceCount(page, baseUrl), 3);

  await page.locator("#finish-editing").click();
  assert.equal(
    await page.locator(".dashboard-slot").count(),
    0,
    "normal mode hides empty slots",
  );
  assert.equal(await page.locator("#edit-layout").isVisible(), true);
  assert.equal(await page.locator("#editor-header").isHidden(), true);
  assert.equal(
    await page.locator(".widget-health-button:visible").count(),
    0,
    "Zen mode hides widget health controls",
  );
  await page.screenshot({
    path: path.join(artifacts, "dashboard-zen-wide.png"),
    fullPage: true,
  });
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

  const directEditPage = await context.newPage();
  await directEditPage.goto(`${baseUrl}/edit`);
  await directEditPage.locator("#editor-header").waitFor();
  assert.equal(
    await directEditPage.locator("#finish-editing").isVisible(),
    true,
  );
  await directEditPage.close();

  const secondPage = await context.newPage();
  pages.push(secondPage);
  await secondPage.goto(baseUrl);
  await secondPage.locator(`[data-instance-id="${memory}"]`).waitFor();
  await page.locator("#edit-layout").click();
  assert.equal(await secondPage.locator("#editor-header").isHidden(), true);
  assert.equal(await secondPage.locator("#edit-layout").isVisible(), true);
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

  const memoryTwo = await addWidget(page, "1", "0", "RAM", "Compact");
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
    .locator('#dashboard-announcement:text-is("CPU swapped with RAM")')
    .waitFor();
  await secondPage
    .locator(`[data-instance-id="${cpuOne}"][data-column="1"]`)
    .waitFor();
  await secondPage
    .locator(`[data-instance-id="${memoryTwo}"][data-column="0"]`)
    .waitFor();

  await dragToWidget(page, memoryTwo, memory);
  await page
    .locator('#dashboard-announcement:text-is("RAM swapped with RAM")')
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

  const invalidOptions = await page.request.post(
    `${baseUrl}/api/v1/instances`,
    {
      data: {
        widget_id: "cpu",
        variant_id: "compact",
        position: { column: 8, row: 0 },
        options: { history_points: 40 },
      },
    },
  );
  assert.equal(invalidOptions.status(), 400);

  await page.locator('.dashboard-slot[data-column="3"][data-row="0"]').click();
  assert.equal(await page.locator(".widget-choice").count(), 5);
  await page.locator(".widget-choice", { hasText: "CPU" }).click();
  await page.locator(".variant-choice", { hasText: "Full" }).click();
  await page.locator('.widget-option input[type="number"]').fill("20");
  await page.locator('.widget-option input[type="checkbox"]').uncheck();
  const fullResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/instances") &&
      response.request().method() === "POST",
  );
  await page.locator("#confirm-add").click();
  const fullResponse = await fullResponsePromise;
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
  assert.deepEqual(fullInstance.options, {
    history_points: 20,
    show_core_temperatures: false,
  });
  assert.equal(
    await fullFrame.locator(".eyebrow").textContent(),
    "20 second history",
  );
  assert.equal(
    await fullFrame.locator(".core-temperature").first().isHidden(),
    true,
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
    3,
    "mobile edit canvas projects to three unit columns",
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.locator(".dashboard-slot").first().click();
  await page.locator(".widget-choice", { hasText: "CPU" }).click();
  assert.equal(await page.locator("#widget-catalog").isHidden(), true);
  assert.equal(await page.locator("#back-to-widgets").isVisible(), true);
  await page.locator("#back-to-widgets").click();
  assert.equal(await page.locator("#widget-catalog").isVisible(), true);
  assert.equal(
    await page
      .locator('.widget-choice[data-widget-id="cpu"]')
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.locator('#add-widget .button[value="cancel"]').click();
  await page.screenshot({
    path: path.join(artifacts, "dashboard-edit-narrow.png"),
    fullPage: true,
  });

  const unlinkedDetails = await page.request.post(
    `${baseUrl}/api/v1/instances`,
    {
      data: {
        widget_id: "tatr-tasks",
        variant_id: "details",
        position: { column: 6, row: 3 },
        options: { root: tatrRoot, recursive: true },
        links: [],
      },
    },
  );
  assert.equal(
    unlinkedDetails.status(),
    400,
    "server requires the declared Details input during creation",
  );

  await page.locator('.dashboard-slot[data-column="0"][data-row="3"]').click();
  await page.locator(".widget-choice", { hasText: "Tatr Tasks" }).click();
  const textOptions = page.locator('.widget-option input[type="text"]');
  await textOptions.nth(0).fill(tatrRoot);
  await textOptions.nth(1).fill(":status in [OPEN, IN_PROGRESS]");
  const tatrResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/instances") &&
      response.request().method() === "POST",
  );
  await page.locator("#confirm-add").click();
  const tatrResponse = await tatrResponsePromise;
  assert.equal(tatrResponse.status(), 201);
  const tatrInstance = await tatrResponse.json();
  assert.deepEqual(tatrInstance.layout, {
    column: 0,
    row: 3,
    width: 6,
    height: 3,
  });
  assert.equal(tatrInstance.options.root, tatrRoot);
  const tatrFrame = page.locator(`[data-instance-id="${tatrInstance.id}"]`);
  await tatrFrame.locator(".task-row").first().waitFor();

  await page.locator('.dashboard-slot[data-column="6"][data-row="3"]').click();
  await page.locator(".widget-choice", { hasText: "Tatr Tasks" }).click();
  await page.locator(".variant-choice", { hasText: "Details" }).click();
  await page.locator('.widget-option input[type="text"]').fill(tatrRoot);
  assert.equal(await page.locator("#widget-links-fieldset").isVisible(), true);
  assert.match(
    await page.locator("#widget-links select option").textContent(),
    /Tatr Tasks at column 1, row 4/,
  );
  const detailsResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/instances") &&
      response.request().method() === "POST",
  );
  await page.locator("#confirm-add").click();
  const detailsResponse = await detailsResponsePromise;
  assert.equal(detailsResponse.status(), 201);
  const detailsInstance = await detailsResponse.json();
  assert.deepEqual(detailsInstance.layout, {
    column: 6,
    row: 3,
    width: 3,
    height: 3,
  });
  const detailsFrame = page.locator(
    `[data-instance-id="${detailsInstance.id}"]`,
  );
  await detailsFrame.locator(".state", { hasText: "Select a task" }).waitFor();
  await page.locator(".widget-link-badge.output").waitFor();
  assert.match(
    await detailsFrame.locator(".widget-link-badge.input").textContent(),
    /Linked to Tatr Tasks at column 1, row 4/,
  );
  const linkList = await page.request.get(`${baseUrl}/api/v1/links`);
  assert.equal(linkList.status(), 200);
  assert.deepEqual((await linkList.json()).links, [
    {
      source_instance_id: tatrInstance.id,
      source_port: "selected_task",
      target_instance_id: detailsInstance.id,
      target_port: "task",
    },
  ]);
  await page.screenshot({
    path: path.join(artifacts, "tatr-linked-edit-narrow.png"),
    fullPage: true,
  });
  await page.locator("#finish-editing").click();
  await page.waitForURL(baseUrl + "/");
  assert.equal(await tatrFrame.locator(".task-row").count(), 2);
  assert.equal(
    await tatrFrame.locator(".task-id").first().textContent(),
    "20260814-120000",
  );
  assert.equal(await tatrFrame.locator(".table-head").isHidden(), true);
  assert.equal(await tatrFrame.locator(".mobile-sort").isVisible(), true);
  assert.equal(
    await tatrFrame
      .locator(".task-row")
      .first()
      .evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateRows.split(" ").length,
      ),
    2,
  );
  await tatrFrame.locator(".status", { hasText: "In progress" }).click();
  assert.equal(await tatrFrame.locator(".task-row").count(), 1);
  await tatrFrame.locator(".clear").click();
  assert.equal(await tatrFrame.locator(".task-row").count(), 2);
  await tatrFrame.locator(".tags button", { hasText: "widget" }).click();
  assert.equal(await tatrFrame.locator(".task-row").count(), 1);
  await tatrFrame.locator(".clear").click();
  await tatrFrame.locator(".title", { hasText: "Add Tatr widget" }).click();
  await detailsFrame
    .locator(".markdown h1", { hasText: "Add Tatr widget" })
    .waitFor();
  await secondPage
    .locator(`[data-instance-id="${detailsInstance.id}"] .state`, {
      hasText: "Select a task",
    })
    .waitFor();
  assert.match(
    await detailsFrame.locator(".identity").textContent(),
    /scufris \/ 20260814-120000/,
  );
  assert.equal(await detailsFrame.locator(".markdown script").count(), 0);
  assert.equal(await detailsFrame.locator(".markdown img").count(), 0);
  assert.equal(
    await detailsFrame
      .locator('.markdown a[href="https://example.com"]')
      .getAttribute("rel"),
    "noopener noreferrer",
  );
  await page.screenshot({
    path: path.join(artifacts, "tatr-tasks-narrow.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await tatrFrame.locator(".table-head").isVisible(), true);
  assert.equal(await tatrFrame.locator(".mobile-sort").isHidden(), true);
  await tatrFrame.locator('[data-sort="title"]').click();
  assert.equal(
    await tatrFrame.locator(".title").first().textContent(),
    "Add Tatr widget",
  );
  await page.screenshot({
    path: path.join(artifacts, "tatr-linked-wide.png"),
    fullPage: true,
  });
  assert.equal(
    await tatrFrame
      .locator(".dashboard-widget-mount")
      .evaluate(
        (element, rootPath) =>
          element.shadowRoot?.textContent?.includes(rootPath) ?? false,
        tatrRoot,
      ),
    false,
    "task rendering does not expose the absolute root",
  );
  await page.reload();
  await tatrFrame.locator(".task-row").first().waitFor();
  await detailsFrame.locator(".state", { hasText: "Select a task" }).waitFor();
  assert.equal(
    await tatrFrame.locator(".task-row").count(),
    2,
    "browser reload requests the unchanged task snapshot",
  );
  assert.equal(
    await tatrFrame.locator(".task-id").first().textContent(),
    "20260814-120000",
  );
  await tatrFrame.locator(".title", { hasText: "Add Tatr widget" }).click();
  await detailsFrame.locator(".markdown").waitFor();
  await page.locator("#edit-layout").click();
  await detailsFrame.locator(".widget-link-badge.input").click();
  assert.equal(await page.locator("#link-widget").isVisible(), true);
  const relinkResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/v1/links/${detailsInstance.id}/task`) &&
      response.request().method() === "PUT",
  );
  await page.locator("#confirm-link").click();
  assert.equal((await relinkResponse).status(), 200);
  const deleteTatr = await page.request.delete(
    `${baseUrl}/api/v1/instances/${tatrInstance.id}`,
  );
  assert.equal(deleteTatr.status(), 204);
  await tatrFrame.waitFor({ state: "detached" });
  await detailsFrame
    .locator(".widget-link-badge.input", { hasText: "Not linked" })
    .waitFor();
  const deleteDetails = await page.request.delete(
    `${baseUrl}/api/v1/instances/${detailsInstance.id}`,
  );
  assert.equal(deleteDetails.status(), 204);
  await detailsFrame.waitFor({ state: "detached" });

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
    4,
    "reconnect retains composition",
  );

  for (const [widgetId, variants] of [
    ["cpu", ["full", "compact"]],
    ["memory", ["full", "compact"]],
    ["claude-usage", ["full", "compact", "minimal"]],
    ["codex-usage", ["compact", "minimal"]],
    ["tatr-tasks", ["full", "details"]],
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
    4,
    "restart restores persisted composition with stable IDs",
  );
  const restoredFull = await page.request.get(
    `${baseUrl}/api/v1/instances/${fullInstance.id}`,
  );
  assert.deepEqual((await restoredFull.json()).options, {
    history_points: 20,
    show_core_temperatures: false,
  });
  await waitForTelemetry(page.locator(`[data-instance-id="${cpuOne}"]`));
  await requestGracefulStop(dashboardd);

  unlinkSync(stateFile);
  writeConfiguration(
    "#fedcba",
    `
[[dashboard.initial_widgets]]
widget = "cpu"
variant = "full"
position = [1, 1]

[dashboard.initial_widgets.options]
history_points = 20
show_core_temperatures = false
`,
  );
  dashboardd = startDashboardd();
  await waitForHealth(dashboardUrl);
  const bootstrapped = await page.request.get(`${baseUrl}/api/v1/instances`);
  const bootstrappedInstances = (await bootstrapped.json()).instances;
  assert.equal(bootstrappedInstances.length, 1);
  assert.deepEqual(bootstrappedInstances[0].layout, {
    column: 0,
    row: 0,
    width: 3,
    height: 3,
  });
  assert.deepEqual(bootstrappedInstances[0].options, {
    history_points: 20,
    show_core_temperatures: false,
  });
  await requestGracefulStop(dashboardd);

  writeConfiguration(
    "#fedcba",
    `
[[dashboard.initial_widgets]]
widget = "not-installed"
variant = "unknown"
position = [1, 1]
`,
  );
  dashboardd = startDashboardd();
  await waitForHealth(dashboardUrl);
  const retained = await page.request.get(`${baseUrl}/api/v1/instances`);
  const retainedInstances = (await retained.json()).instances;
  assert.equal(retainedInstances.length, 1);
  assert.equal(retainedInstances[0].widget_id, "cpu");
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
  if (existsSync(configFile)) unlinkSync(configFile);
  rmSync(tatrRoot, { recursive: true, force: true });
}

async function exerciseUsageCommands(page, widgetId) {
  return page.evaluate(async (id) => {
    const variant = id === "claude-usage" ? "full" : "compact";
    const module = await import(
      `/widgets/${id}/variants/${variant}/frontend.js?command-test`
    );
    const container = document.createElement("div");
    document.body.append(container);
    const commands = [];
    const frontend = module.mount(container, {
      widgetId: id,
      variantId: variant,
      instanceId: `${id}-command-test`,
      options: { display_mode: "usage" },
      links: {
        publish() {},
        subscribe() {
          return () => {};
        },
      },
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
        remaining_percent: 30,
        resets_at: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    if (!container.shadowRoot.textContent.includes("70% used"))
      throw new Error("Usage display option was not applied");
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
      options: {},
      links: {
        publish() {},
        subscribe() {
          return () => {};
        },
      },
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

function writeTatrTask(project, id, title, status, priority, tags) {
  const directory = path.join(tatrRoot, project, "tasks", id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "TASK.md"),
    `# ${title}\n\n- STATUS: ${status}\n- PRIORITY: ${priority}\n- TAGS: ${tags.join(", ")}\n\n## Notes\n\n**Fixture markdown** with [Example](https://example.com).\n\n<script>unsafe()</script>\n\n![Ignored image](secret.png)\n`,
  );
}

function writeConfiguration(accent, dashboard = "", font = "Iosevka") {
  writeFileSync(
    configFile,
    `[theme]\naccent = "${accent}"\n\n[theme.fonts]\nsans = "${font}"\nmono = "${font}"\n${dashboard}`,
  );
}

function startDashboardd() {
  return spawn(path.join(root, "target/debug/dashboardd"), [], {
    cwd: root,
    env: {
      ...process.env,
      DASHBOARDD_PORT: String(dashboardPort),
      DASHBOARDD_WIDGETS_DIR: path.join(root, ".build/widgets"),
      DASHBOARDD_STATE_FILE: stateFile,
      DASHBOARDD_CONFIG_FILE: configFile,
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
  await page.locator(".widget-choice", { hasText: name }).click();
  assert.equal(await page.locator("#widget-selection").isVisible(), true);
  await page.locator(".variant-choice", { hasText: variant }).click();
  assert.match(
    await page.locator("#widget-options").textContent(),
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

async function verifyBackendHealthProbes() {
  for (const widgetId of [
    "claude-usage",
    "codex-usage",
    "cpu",
    "memory",
    "tatr-tasks",
  ]) {
    const directory = path.join(root, ".build/widgets", widgetId);
    const manifest = JSON.parse(
      readFileSync(path.join(directory, "widget.json"), "utf8"),
    );
    const child = spawn(path.join(directory, manifest.backend), [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    let output = "";
    const pong = new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const lines = output.split("\n");
        output = lines.pop() ?? "";
        for (const line of lines) {
          const message = JSON.parse(line);
          if (message.kind === "pong" && message.data?.nonce === 42) resolve();
        }
      });
      child.once("error", reject);
    });
    child.stdin.write(
      `${JSON.stringify({ version: 1, kind: "ping", data: { nonce: 42 } })}\n`,
    );
    try {
      await withTimeout(pong, 3_000, `${widgetId} backend did not answer Ping`);
    } catch (error) {
      child.kill("SIGKILL");
      await exited;
      throw error;
    }
    child.stdin.write(
      `${JSON.stringify({ version: 1, kind: "shutdown", data: {} })}\n`,
    );
    child.stdin.end();
    let exitCode;
    try {
      exitCode = await withTimeout(
        exited,
        3_000,
        `${widgetId} backend did not exit after Shutdown`,
      );
    } catch (error) {
      child.kill("SIGKILL");
      await exited;
      throw error;
    }
    assert.equal(exitCode, 0, `${widgetId} backend exits after Shutdown`);
  }
}

async function withTimeout(promise, milliseconds, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
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

async function waitForInstanceHealth(
  page,
  baseUrl,
  instanceId,
  status,
  restartCount = 0,
) {
  const deadline = Date.now() + 10_000;
  let actual = null;
  while (Date.now() < deadline) {
    const response = await page.request.get(
      `${baseUrl}/api/v1/instances/${encodeURIComponent(instanceId)}/health`,
    );
    if (response.ok()) {
      const health = await response.json();
      actual = [health.status, health.restart_count];
      if (actual[0] === status && actual[1] === restartCount) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(actual, [status, restartCount]);
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
