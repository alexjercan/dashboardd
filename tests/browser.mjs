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
writeTatrArtifacts("scufris", "20260814-120000");
writeProjectRepositories();
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
  await page.locator("#dashboard-empty").waitFor();
  assert.equal(await page.locator(".dashboard-card").count(), 0);
  page.once("dialog", (dialog) => dialog.accept("Main"));
  await page.locator("#create-dashboard").click();
  await page.waitForURL(new RegExp(`${baseUrl}/d/[^/]+/edit$`));
  const dashboardId = decodeURIComponent(page.url().split("/").at(-2));
  const dashboardPath = `/d/${encodeURIComponent(dashboardId)}`;
  const dashboardViewUrl = `${baseUrl}${dashboardPath}`;
  const dashboardEditUrl = `${dashboardViewUrl}/edit`;
  const dashboardApi = `/api/v1/dashboards/${encodeURIComponent(dashboardId)}`;
  const dashboardApiUrl = `${baseUrl}${dashboardApi}`;
  await page.locator('#connection-status:text-is("Connected")').waitFor();
  await page.locator("#finish-editing").click();
  await page.waitForURL(dashboardViewUrl);
  const layoutResponse = await page.request.get(dashboardApiUrl);
  assert.equal(layoutResponse.status(), 200);
  assert.equal((await layoutResponse.json()).columns, 9);
  assert.equal(
    await instanceCount(page, dashboardApiUrl),
    0,
    "startup is empty",
  );
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
  await page.waitForURL(dashboardEditUrl);
  assert.equal(await page.locator("#finish-editing").isVisible(), true);
  assert.equal(
    await page
      .locator("#editor-heading")
      .evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal(
    await page.locator(".dashboard-slot").count(),
    63,
    "empty editor canvas derives seven rows from the viewport",
  );
  assert.equal(await page.locator("#column-count").textContent(), "9");
  const fullCanvas = await page.locator("#widgets").boundingBox();
  assert.equal(Math.round(fullCanvas.width), 1424);
  assert.equal(Math.round(fullCanvas.height), 984);
  await page.locator("#increase-columns").click();
  await page.locator("#column-count:text-is('10')").waitFor();
  await page.locator("#decrease-columns").click();
  await page.locator("#column-count:text-is('9')").waitFor();
  await page.locator("#finish-editing").click();
  await page.waitForURL(dashboardViewUrl);
  assert.equal(
    await page
      .locator("#edit-layout")
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.goBack();
  await page.waitForURL(dashboardEditUrl);
  assert.equal(await page.locator("#editor-header").isVisible(), true);
  await page.goForward();
  await page.waitForURL(dashboardViewUrl);
  await page.locator("#edit-layout").click();
  await page.waitForURL(dashboardEditUrl);
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
      disk: "Disk",
      memory: "RAM",
      network: "Network",
      projects: "Projects",
      "tatr-tasks": "Tatr Tasks",
    },
  );
  assert.deepEqual(
    catalog.find((widget) => widget.id === "projects").options[0],
    {
      id: "roots",
      name: "Roots",
      description: "One absolute or ~/ project root per line",
      variants: [],
      default: "~/personal\n~/personal/_tests\n~/work\n~/third-party",
      type: "text",
      multiline: true,
    },
  );
  assert.deepEqual(
    catalog
      .find((widget) => widget.id === "projects")
      .outputs.map((port) => [port.id, port.type, port.variants]),
    [["selected_project", "scufris.project-selection/v1", ["list", "pinned"]]],
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
    [
      ["project", "scufris.project-selection/v1", ["full"], false],
      ["task", "tatr.task-selection/v1", ["details"], true],
    ],
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
      disk: [
        ["full", 3, 2],
        ["compact", 1, 1],
      ],
      memory: [
        ["full", 3, 3],
        ["compact", 1, 1],
      ],
      network: [
        ["full", 3, 2],
        ["compact", 1, 1],
      ],
      projects: [
        ["list", 3, 3],
        ["pinned", 3, 1],
        ["project", 3, 3],
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
    62,
    "occupied first unit retains the viewport-derived canvas",
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
  assert.equal(await instanceCount(page, dashboardApiUrl), 3);

  await waitForInstanceHealth(page, dashboardApiUrl, cpuOne, "healthy");
  const healthResponse = await page.request.get(
    `${dashboardApiUrl}/instance-health`,
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
  await waitForInstanceHealth(page, dashboardApiUrl, cpuOne, "healthy", 1);
  assert.equal(await page.locator("#health-restarts").textContent(), "1");
  await page.locator('#widget-health .button[value="cancel"]').click();
  assert.equal(await instanceCount(page, dashboardApiUrl), 3);

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
  assert.ok(boxes.every((box) => box.height > 120));
  assert.ok(boxes.every((box) => box.height === boxes[0].height));

  const keyboardCursor = page.locator(".dashboard-keyboard-cursor");
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  assert.equal(
    await keyboardCursor.evaluate((element) =>
      element.style.getPropertyValue("--widget-column"),
    ),
    "1",
  );
  await page.keyboard.press("l");
  assert.equal(
    await keyboardCursor.evaluate((element) =>
      element.style.getPropertyValue("--widget-column"),
    ),
    "2",
  );
  await page.keyboard.press("i");
  assert.equal(await page.locator("#keyboard-mode").textContent(), "WIDGET");
  await page.keyboard.press("e");
  assert.equal(
    await page.locator("#editor-header").isHidden(),
    true,
    "widget mode receives dashboard command keys",
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#keyboard-mode").textContent(), "DASHBOARD");
  await page.keyboard.press("d");
  const commandInput = page.locator(".command-input");
  assert.equal(await commandInput.inputValue(), "dashboard ");
  await commandInput.pressSequentially("Ma");
  await commandInput.press("Tab");
  assert.equal(await commandInput.inputValue(), "dashboard Main");
  await commandInput.press("Escape");
  await page.keyboard.press("l");
  assert.equal(
    await keyboardCursor.evaluate((element) =>
      element.style.getPropertyValue("--widget-column"),
    ),
    "3",
  );
  await page.keyboard.press("?");
  await page.locator("#keyboard-help").waitFor();
  await page.locator("#keyboard-help .button.primary").click();
  await page.keyboard.press(":");
  await commandInput.fill("he");
  assert.deepEqual(
    await page.locator(".command-completions li").allTextContents(),
    ["help"],
  );
  await commandInput.press("Tab");
  await commandInput.press("Enter");
  await page.locator("#keyboard-help").waitFor();
  await page.locator("#keyboard-help .button.primary").click();
  await page.keyboard.press("e");
  await page.locator("#editor-header").waitFor();
  assert.equal(
    await keyboardCursor.evaluate((element) =>
      element.style.getPropertyValue("--widget-column"),
    ),
    "3",
    "Editor preserves the Zen cursor",
  );
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await page.keyboard.press("h");
  assert.equal(
    await keyboardCursor.evaluate((element) =>
      element.style.getPropertyValue("--widget-column"),
    ),
    "1",
    "cursor does not wrap past the canvas edge",
  );
  await page.keyboard.press("v");
  assert.equal(await page.locator("#keyboard-mode").textContent(), "MOVE");
  await page.keyboard.press("j");
  assert.equal(
    await keyboardCursor.evaluate((element) =>
      element.style.getPropertyValue("--widget-row"),
    ),
    "2",
  );
  await page.screenshot({
    path: path.join(artifacts, "dashboard-move-wide.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#keyboard-mode").textContent(), "EDITOR");
  assert.equal(
    await keyboardCursor.evaluate((element) =>
      element.style.getPropertyValue("--widget-row"),
    ),
    "1",
    "cancelling Move restores the original cursor",
  );
  await page.keyboard.press("v");
  await page.keyboard.press("l");
  await page.keyboard.press("Enter");
  await page
    .locator(`[data-instance-id="${cpuOne}"][data-column="1"]`)
    .waitFor();
  await page.keyboard.press("v");
  await page.keyboard.press("h");
  await page.keyboard.press("Enter");
  await page
    .locator(`[data-instance-id="${cpuOne}"][data-column="0"]`)
    .waitFor();
  await page.keyboard.press("x");
  await page.locator("#remove-widget").waitFor();
  await page.locator('#remove-widget .button[value="cancel"]').click();
  await page.keyboard.press("l");
  await page.keyboard.press("l");
  await page.keyboard.press("l");
  await page.keyboard.press("a");
  await page.locator("#add-widget").waitFor();
  await page.keyboard.press("?");
  await page.locator("#add-keyboard-help").waitFor();
  await page.locator("#add-keyboard-help .button.primary").click();
  await page.keyboard.press("G");
  assert.equal(
    await page
      .locator(".widget-choice.selected")
      .getAttribute("data-widget-id"),
    "tatr-tasks",
  );
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  assert.equal(
    await page
      .locator(".widget-choice.selected")
      .getAttribute("data-widget-id"),
    "cpu",
  );
  await page.keyboard.press("l");
  assert.match(
    await page.locator(".variant-choice.selected").textContent(),
    /Full/,
  );
  const keyboardOption = page.locator('.widget-option input[type="number"]');
  await keyboardOption.focus();
  await keyboardOption.press("j");
  assert.match(
    await page.locator(".variant-choice.selected").textContent(),
    /Full/,
    "option controls do not trigger Add Widget navigation",
  );
  await page.locator("#widget-selection").focus();
  await page.keyboard.press("j");
  assert.match(
    await page.locator(".variant-choice.selected").textContent(),
    /Compact/,
  );
  const keyboardAddResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/instances") &&
      response.request().method() === "POST",
  );
  await page.keyboard.press("a");
  const keyboardAdded = await (await keyboardAddResponse).json();
  await page.locator(`[data-instance-id="${keyboardAdded.id}"]`).waitFor();
  await page.keyboard.press("x");
  await page.locator("#remove-widget").waitFor();
  await page.locator("#confirm-remove").click();
  await page
    .locator(`[data-instance-id="${keyboardAdded.id}"]`)
    .waitFor({ state: "detached" });
  await page.keyboard.press("Escape");
  await page.locator("#edit-layout").waitFor();

  await page.reload();
  await page.locator(`[data-instance-id="${cpuOne}"]`).waitFor();
  assert.equal(
    await page.locator("#edit-layout").isVisible(),
    true,
    "refresh retains composed dashboard",
  );

  const directEditPage = await context.newPage();
  await directEditPage.goto(dashboardEditUrl);
  await directEditPage.locator("#editor-header").waitFor();
  assert.equal(
    await directEditPage.locator("#finish-editing").isVisible(),
    true,
  );
  await directEditPage.close();

  const secondPage = await context.newPage();
  pages.push(secondPage);
  await secondPage.goto(dashboardViewUrl);
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
    await instanceCount(page, dashboardApiUrl),
    2,
    "confirmed removal synchronizes across pages",
  );

  const memoryTwo = await addWidget(page, "1", "0", "RAM", "Compact");
  await secondPage.locator(`[data-instance-id="${memoryTwo}"]`).waitFor();
  assert.equal(
    await instanceCount(page, dashboardApiUrl),
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
  const cpuMoveHandle = cpuFrame.locator(".drag-handle");
  await cpuMoveHandle.focus();
  await cpuMoveHandle.press("ArrowDown");
  await page
    .locator('#dashboard-announcement:text-is("CPU moved to column 1, row 2")')
    .waitFor();
  await secondPage
    .locator(`[data-instance-id="${cpuOne}"][data-row="1"]`)
    .waitFor();
  await cpuMoveHandle.press("ArrowRight");
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

  const collision = await page.request.post(`${dashboardApiUrl}/instances`, {
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
    `${dashboardApiUrl}/instances`,
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
  assert.equal(await page.locator(".widget-choice").count(), 8);
  await page.locator(".widget-choice", { hasText: "CPU" }).click();
  await page.locator(".variant-choice", { hasText: "Full" }).click();
  await page.locator('.widget-option input[type="number"]').fill("20");
  await page.locator('.widget-option input[type="checkbox"]').uncheck();
  const fullResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/dashboards/") &&
      response.url().endsWith("/instances") &&
      response.request().method() === "POST",
  );
  await page.locator("#confirm-add").click();
  const fullResponse = await fullResponsePromise;
  assert.equal(fullResponse.status(), 201);
  const fullInstance = await fullResponse.json();
  const fullFrame = page.locator(`[data-instance-id="${fullInstance.id}"]`);
  await fullFrame.waitFor();
  await waitForTelemetry(fullFrame);
  await fullFrame.locator(".drag-handle").focus();
  const expandedCursor = page.locator(".dashboard-keyboard-cursor.expanded");
  assert.deepEqual(
    await expandedCursor.evaluate((element) => [
      element.style.getPropertyValue("--widget-column"),
      element.style.getPropertyValue("--widget-row"),
      element.style.getPropertyValue("--widget-width"),
      element.style.getPropertyValue("--widget-height"),
    ]),
    ["4", "1", "3", "3"],
    "Editor cursor expands to the complete occupied widget",
  );
  await page.keyboard.press("l");
  assert.equal(
    await page
      .locator(".dashboard-keyboard-cursor")
      .evaluate((element) => element.style.getPropertyValue("--widget-column")),
    "7",
    "normal cursor skips the complete widget under it",
  );
  await page.keyboard.press("h");
  await page.keyboard.press("h");
  await page.keyboard.press("l");
  await page.keyboard.press("v");
  await page.keyboard.press("h");
  await page.keyboard.press("h");
  assert.equal(
    await page
      .locator(".dashboard-keyboard-cursor")
      .evaluate((element) => element.style.getPropertyValue("--widget-column")),
    "1",
    "Move ghost skips completely beyond an overlapping widget",
  );
  await page.keyboard.press("Escape");
  const fullBox = await fullFrame.boundingBox();
  assert.ok(fullBox);
  assert.ok(fullBox.height > 350);
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
    `${dashboardApiUrl}/instances`,
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
      response.url().includes("/api/v1/dashboards/") &&
      response.url().endsWith("/instances") &&
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
  await page.locator(".variant-choice", { hasText: "Artifact" }).click();
  await page.locator('.widget-option input[type="text"]').fill(tatrRoot);
  assert.equal(await page.locator("#widget-links-fieldset").isVisible(), true);
  assert.match(
    await page.locator("#widget-links select option").textContent(),
    /Tatr Tasks at column 1, row 4/,
  );
  const detailsResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/dashboards/") &&
      response.url().endsWith("/instances") &&
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
    /Linked task list: Tatr Tasks at column 1, row 4/,
  );

  await page.locator('.dashboard-slot[data-column="0"][data-row="6"]').click();
  await page.locator('.widget-choice[data-widget-id="projects"]').click();
  const rootsControl = page.locator(".widget-option textarea");
  assert.equal(
    await rootsControl.isVisible(),
    true,
    "roots use a multiline editor",
  );
  await rootsControl.fill(tatrRoot);
  const projectsListResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/dashboards/") &&
      response.url().endsWith("/instances") &&
      response.request().method() === "POST",
  );
  await page.locator("#confirm-add").click();
  const projectsListResponse = await projectsListResponsePromise;
  assert.equal(projectsListResponse.status(), 201);
  const projectsListInstance = await projectsListResponse.json();
  const projectsListFrame = page.locator(
    `[data-instance-id="${projectsListInstance.id}"]`,
  );
  await projectsListFrame.locator(".project-row").first().waitFor();

  await page.locator('.dashboard-slot[data-column="3"][data-row="6"]').click();
  await page.locator('.widget-choice[data-widget-id="projects"]').click();
  await page.locator(".variant-choice", { hasText: "Project" }).click();
  await page.locator(".widget-option textarea").fill(tatrRoot);
  assert.match(
    await page.locator("#widget-links select option").textContent(),
    /Projects at column 1, row 7/,
  );
  const projectResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/dashboards/") &&
      response.url().endsWith("/instances") &&
      response.request().method() === "POST",
  );
  await page.locator("#confirm-add").click();
  const projectResponse = await projectResponsePromise;
  assert.equal(projectResponse.status(), 201);
  const projectInstance = await projectResponse.json();
  const projectFrame = page.locator(
    `[data-instance-id="${projectInstance.id}"]`,
  );
  await projectFrame
    .locator(".state", { hasText: "Select a project" })
    .waitFor();

  await page.locator('.dashboard-slot[data-column="6"][data-row="6"]').click();
  await page.locator('.widget-choice[data-widget-id="projects"]').click();
  await page.locator(".variant-choice", { hasText: "Pinned" }).click();
  await page.locator(".widget-option textarea").fill(tatrRoot);
  const pinnedResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/dashboards/") &&
      response.url().endsWith("/instances") &&
      response.request().method() === "POST",
  );
  await page.locator("#confirm-add").click();
  const pinnedResponse = await pinnedResponsePromise;
  assert.equal(pinnedResponse.status(), 201);
  const pinnedInstance = await pinnedResponse.json();
  assert.deepEqual(pinnedInstance.layout, {
    column: 6,
    row: 6,
    width: 3,
    height: 1,
  });
  const pinnedFrame = page.locator(`[data-instance-id="${pinnedInstance.id}"]`);
  await pinnedFrame.locator(".empty-card").first().waitFor();
  assert.equal(await pinnedFrame.locator(".empty-card").count(), 3);

  const projectFilterBadge = tatrFrame.locator(".widget-link-badge.input");
  assert.equal(
    await projectFilterBadge.textContent(),
    "Project filter: Not linked",
  );
  await projectFilterBadge.click();
  assert.equal(
    await page.locator("#link-input-name").textContent(),
    "Project filter",
  );
  await page
    .locator("#link-source")
    .selectOption(`${projectsListInstance.id}\u0000selected_project`);
  const projectFilterResponse = page.waitForResponse(
    (response) =>
      response
        .url()
        .includes(`${dashboardApi}/links/${tatrInstance.id}/project`) &&
      response.request().method() === "PUT",
  );
  await page.locator("#confirm-link").click();
  assert.equal((await projectFilterResponse).status(), 200);
  assert.match(
    await projectFilterBadge.textContent(),
    /^Project filter: Projects at/,
  );
  assert.equal(
    await projectsListFrame.locator(".widget-link-badge.output").textContent(),
    "Selected project -> 2 widgets",
  );

  const linkList = await page.request.get(`${dashboardApiUrl}/links`);
  assert.equal(linkList.status(), 200);
  assert.equal((await linkList.json()).links.length, 3);
  assert.equal(
    await detailsFrame.locator(".widget-focus-button").isHidden(),
    true,
    "Focus is unavailable in editor mode",
  );
  await page.screenshot({
    path: path.join(artifacts, "tatr-linked-edit-narrow.png"),
    fullPage: true,
  });
  await page.locator("#finish-editing").click();
  await page.waitForURL(dashboardViewUrl);

  const projectSearch = projectsListFrame.locator(".search");
  const projectSort = projectsListFrame.locator(".sort");
  const projectRows = projectsListFrame.locator(".project-row");
  assert.deepEqual(await projectRows.locator("strong").allTextContents(), [
    "idle",
    "other",
    "scufris",
    "tatr",
  ]);
  await projectSearch.click();
  await projectSearch.pressSequentially("iehjkl");
  assert.equal(await projectSearch.inputValue(), "iehjkl");
  assert.equal(page.url(), dashboardViewUrl);
  assert.equal(await page.locator("#keyboard-mode").textContent(), "WIDGET");
  await projectSearch.fill("");
  await projectSort.selectOption("recent");
  assert.deepEqual(await projectRows.locator("strong").allTextContents(), [
    "scufris",
    "tatr",
    "idle",
    "other",
  ]);
  await projectSort.selectOption("name");
  await projectSearch.fill("SCF RS");
  assert.deepEqual(await projectRows.locator("strong").allTextContents(), [
    "scufris",
  ]);
  assert.equal(
    await projectsListFrame.locator(".summary").textContent(),
    "1 of 4 projects",
  );
  await projectSearch.fill("i");
  assert.deepEqual(await projectRows.locator("strong").allTextContents(), [
    "idle",
    "scufris",
  ]);
  await projectSearch.fill("[");
  await projectsListFrame
    .locator(".empty", { hasText: "No matching projects" })
    .waitFor();
  await projectSearch.fill("");

  await projectsListFrame.locator(".filters summary").click();
  const dirtyFilter = projectsListFrame.locator(
    '.filter-menu input[value="dirty"]',
  );
  const activeTasksFilter = projectsListFrame.locator(
    '.filter-menu input[value="active-tasks"]',
  );
  await dirtyFilter.check();
  assert.deepEqual(await projectRows.locator("strong").allTextContents(), [
    "scufris",
  ]);
  await activeTasksFilter.check();
  assert.deepEqual(await projectRows.locator("strong").allTextContents(), [
    "scufris",
  ]);
  await dirtyFilter.uncheck();
  assert.deepEqual(await projectRows.locator("strong").allTextContents(), [
    "scufris",
    "tatr",
  ]);
  await activeTasksFilter.uncheck();
  await projectsListFrame.locator(".filters summary").click();

  await projectsListFrame
    .locator(".project-row", { hasText: "scufris" })
    .locator(".project-choice")
    .click();
  await projectFrame.locator('.identity:text-is("scufris")').waitFor();
  await projectSearch.fill("tatr");
  const hiddenProjectSelection = projectsListFrame.locator(".hidden-selection");
  await hiddenProjectSelection
    .locator("span", { hasText: "Selected: scufris" })
    .waitFor();
  assert.equal(
    await projectFrame.locator(".identity").textContent(),
    "scufris",
    "search does not clear hidden selection",
  );
  await page.screenshot({
    path: path.join(artifacts, "projects-list-filtered-narrow.png"),
    fullPage: true,
  });
  await hiddenProjectSelection.locator("button", { hasText: "Clear" }).click();
  await projectFrame
    .locator(".state", { hasText: "Select a project" })
    .waitFor();
  await projectSearch.fill("");
  await tatrFrame.locator(".task-row").nth(1).waitFor();

  const initialProjectState = await page.request.get(
    `${baseUrl}/api/v1/widget-state/projects`,
  );
  assert.deepEqual(await initialProjectState.json(), {
    widget_id: "projects",
    revision: 0,
    value: {},
  });
  const secondProjectsListFrame = secondPage.locator(
    `[data-instance-id="${projectsListInstance.id}"]`,
  );
  await secondProjectsListFrame.locator(".project-row").nth(3).waitFor();
  await Promise.all([
    projectsListFrame
      .locator(".project-row", { hasText: "scufris" })
      .locator(".pin-button")
      .click(),
    secondProjectsListFrame
      .locator(".project-row", { hasText: "tatr" })
      .locator(".pin-button")
      .click(),
  ]);
  await pinnedFrame.locator(".project-card", { hasText: "scufris" }).waitFor();
  await pinnedFrame.locator(".project-card", { hasText: "tatr" }).waitFor();
  await projectsListFrame
    .locator(".project-row", { hasText: "idle" })
    .locator(".pin-button")
    .click();
  await pinnedFrame.locator(".project-card", { hasText: "idle" }).waitFor();
  assert.equal(await pinnedFrame.locator(".empty-card").count(), 0);
  assert.equal(
    await projectsListFrame.locator(".pin-button.pinned").count(),
    3,
  );
  const otherPin = projectsListFrame
    .locator(".project-row", { hasText: "other" })
    .locator(".pin-button");
  assert.equal(await otherPin.isDisabled(), true);
  assert.equal(
    await otherPin.getAttribute("title"),
    "Pinned project limit reached",
  );
  await secondPage
    .locator(`[data-instance-id="${pinnedInstance.id}"] .project-card`, {
      hasText: "idle",
    })
    .waitFor();

  await pinnedFrame.locator(".manage").click();
  const pinManager = pinnedFrame.locator(".manager");
  await pinManager.waitFor();
  const cardsBeforeMove = await pinnedFrame
    .locator(".cards .project-card strong")
    .allTextContents();
  await pinManager
    .locator(".pinned-row")
    .first()
    .locator(".move-button", { hasText: "Later" })
    .click();
  await pinnedFrame
    .locator(".cards .project-card strong")
    .nth(1)
    .filter({ hasText: cardsBeforeMove[0] })
    .waitFor();
  assert.deepEqual(
    await pinnedFrame.locator(".cards .project-card strong").allTextContents(),
    [cardsBeforeMove[1], cardsBeforeMove[0], cardsBeforeMove[2]],
  );
  await pinManager.locator(".search").fill("OTH");
  const managerOtherPin = pinManager
    .locator(".manage-row", { hasText: "other" })
    .locator(".pin-button");
  assert.equal(await managerOtherPin.isDisabled(), true);
  await pinManager
    .locator(".pinned-row", { hasText: "idle" })
    .locator(".pin-button")
    .click();
  await managerOtherPin.click();
  await pinnedFrame.locator(".project-card", { hasText: "other" }).waitFor();
  await page.screenshot({
    path: path.join(artifacts, "pinned-projects-manage-narrow.png"),
  });
  await pinManager.locator(".done").click();
  await page.screenshot({
    path: path.join(artifacts, "pinned-projects-narrow.png"),
    fullPage: true,
  });
  const persistedPins = await page.request.get(
    `${baseUrl}/api/v1/widget-state/projects`,
  );
  const persistedPinState = await persistedPins.json();
  assert.equal(persistedPinState.value.pins.length, 3);
  assert.ok(persistedPinState.revision >= 5);

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
  await projectsListFrame
    .locator(".project-row", { hasText: "scufris" })
    .click();
  await tatrFrame
    .locator(".project-filter", { hasText: "Project: scufris" })
    .waitFor();
  assert.equal(await tatrFrame.locator(".task-row").count(), 1);
  await projectFrame.locator(".identity", { hasText: "scufris" }).waitFor();
  await projectFrame
    .locator(".recent-changes code", { hasText: "README.md" })
    .waitFor();
  await secondPage
    .locator(`[data-instance-id="${projectInstance.id}"] .state`, {
      hasText: "Select a project",
    })
    .waitFor();
  await projectsListFrame
    .locator(".project-row", { hasText: "scufris" })
    .click();
  await tatrFrame.locator(".task-row").nth(1).waitFor();
  assert.equal(await tatrFrame.locator(".task-row").count(), 2);
  assert.equal(
    await projectFrame.locator(".state").textContent(),
    "Select a project",
  );
  await projectsListFrame
    .locator(".project-row", { hasText: "scufris" })
    .click();
  await tatrFrame
    .locator(".project-filter", { hasText: "Project: scufris" })
    .waitFor();
  await tatrFrame.locator(".title", { hasText: "Add Tatr widget" }).click();
  await detailsFrame
    .locator(".markdown h1", { hasText: "Add Tatr widget" })
    .waitFor();
  await secondPage
    .locator(`[data-instance-id="${detailsInstance.id}"] .state`, {
      hasText: "Select a task",
    })
    .waitFor();
  assert.equal(
    await detailsFrame.locator(".identity").textContent(),
    "scufris // 20260814-120000/TASK.md",
  );
  assert.equal(await detailsFrame.locator(".markdown script").count(), 0);
  assert.equal(await detailsFrame.locator(".markdown img").count(), 0);
  assert.equal(
    await detailsFrame
      .locator('.markdown a[href="https://example.com"]')
      .getAttribute("rel"),
    "noopener noreferrer",
  );

  const scufrisProjectRow = projectsListFrame.locator(".project-row", {
    hasText: "scufris",
  });
  assert.deepEqual(
    await scufrisProjectRow.locator(".worktree option").allTextContents(),
    ["Primary", "feature/projects"],
  );
  await scufrisProjectRow
    .locator(".worktree")
    .selectOption({ label: "feature/projects" });
  await tatrFrame
    .locator(".project-filter", {
      hasText: "Project: scufris // feature/projects",
    })
    .waitFor();
  await tatrFrame
    .locator(".title", { hasText: "Worktree Tatr widget" })
    .waitFor();
  await detailsFrame.locator(".state", { hasText: "Select a task" }).waitFor();
  await projectFrame
    .locator(".identity", { hasText: "scufris // feature/projects" })
    .waitFor();
  await projectFrame
    .locator(".recent-changes code", { hasText: "worktree-notes.txt" })
    .waitFor();
  assert.equal(
    await secondPage
      .locator(`[data-instance-id="${projectsListInstance.id}"] .project-row`, {
        hasText: "scufris",
      })
      .locator(".worktree")
      .inputValue(),
    await secondPage
      .locator(`[data-instance-id="${projectsListInstance.id}"] .project-row`, {
        hasText: "scufris",
      })
      .locator('.worktree option:text-is("Primary")')
      .getAttribute("value"),
    "worktree choice remains page-local",
  );
  await tatrFrame
    .locator(".title", { hasText: "Worktree Tatr widget" })
    .click();
  await detailsFrame
    .locator(".markdown h1", { hasText: "Worktree Tatr widget" })
    .waitFor();
  assert.equal(
    await detailsFrame.locator(".identity").textContent(),
    "scufris // feature/projects // 20260814-120000/TASK.md",
  );
  await page.screenshot({
    path: path.join(artifacts, "projects-worktree-narrow.png"),
    fullPage: true,
  });
  await scufrisProjectRow
    .locator(".worktree")
    .selectOption({ label: "Primary" });
  await detailsFrame.locator(".state", { hasText: "Select a task" }).waitFor();
  await tatrFrame.locator(".title", { hasText: "Add Tatr widget" }).waitFor();
  await projectFrame.locator('.identity:text-is("scufris")').waitFor();
  await tatrFrame.locator(".title", { hasText: "Add Tatr widget" }).click();
  await detailsFrame
    .locator(".markdown h1", { hasText: "Add Tatr widget" })
    .waitFor();

  await detailsFrame.locator(".identity").click();
  assert.deepEqual(
    await detailsFrame.locator(".artifact-menu button").allTextContents(),
    ["TASK.md", "notes/related.md", "report.html", "result.png", "summary.txt"],
  );
  assert.equal(
    await detailsFrame
      .locator('.artifact-menu button:text-is(".secret.txt")')
      .count(),
    0,
  );
  await page.screenshot({
    path: path.join(artifacts, "tatr-artifact-menu-narrow.png"),
    fullPage: true,
  });
  await detailsFrame
    .locator('.artifact-menu button:text-is("TASK.md")')
    .click();
  assert.equal(
    await detailsFrame
      .locator(".picker")
      .evaluate((picker) => picker.hasAttribute("open")),
    false,
    "selecting the active artifact closes the menu",
  );
  await detailsFrame.locator(".identity").click();
  await detailsFrame
    .locator('.artifact-menu button:text-is("summary.txt")')
    .click();
  await detailsFrame
    .locator(".text-artifact", { hasText: "Plain artifact text" })
    .waitFor();
  assert.match(
    await detailsFrame.locator(".identity").textContent(),
    /\/summary\.txt$/,
  );
  await detailsFrame.locator(".identity").click();
  await detailsFrame
    .locator('.artifact-menu button:text-is("report.html")')
    .click();
  await detailsFrame
    .locator(".html-artifact h1", { hasText: "HTML report" })
    .waitFor();
  assert.equal(await detailsFrame.locator(".html-artifact script").count(), 0);
  assert.equal(await detailsFrame.locator(".html-artifact form").count(), 0);
  assert.equal(await detailsFrame.locator(".html-artifact img").count(), 0);
  assert.equal(
    await detailsFrame
      .locator(".html-artifact [class], .html-artifact [id]")
      .count(),
    0,
  );
  await detailsFrame.locator(".identity").click();
  await page.screenshot({
    path: path.join(artifacts, "tatr-artifact-html-menu-narrow.png"),
    fullPage: true,
  });
  await detailsFrame
    .locator('.artifact-menu button:text-is("summary.txt")')
    .click();
  await detailsFrame.locator(".identity").click();
  await detailsFrame
    .locator('.artifact-menu button:text-is("report.html")')
    .click();
  await detailsFrame
    .locator(".html-artifact h1", { hasText: "HTML report" })
    .waitFor();
  await detailsFrame
    .locator(".html-artifact a", { hasText: "Related artifact" })
    .click();
  await detailsFrame
    .locator(".markdown h1", { hasText: "Related artifact" })
    .waitFor();
  assert.match(
    await detailsFrame.locator(".identity").textContent(),
    /\/notes\/related\.md$/,
  );
  await detailsFrame.locator(".identity").click();
  await detailsFrame
    .locator('.artifact-menu button:text-is("result.png")')
    .click();
  const artifactImage = detailsFrame.locator(
    '.image-artifact img[alt="result.png"]',
  );
  await artifactImage.waitFor();
  assert.equal(
    await artifactImage.evaluate(
      (image) => image instanceof HTMLImageElement && image.naturalWidth,
    ),
    1,
  );
  await page.screenshot({
    path: path.join(artifacts, "tatr-artifact-image-narrow.png"),
    fullPage: true,
  });
  await detailsFrame.locator(".identity").click();
  await detailsFrame
    .locator('.artifact-menu button:text-is("TASK.md")')
    .click();
  await detailsFrame
    .locator(".markdown h1", { hasText: "Add Tatr widget" })
    .waitFor();
  await projectsListFrame
    .locator(".project-row", { hasText: "scufris" })
    .click();
  await tatrFrame.locator(".title", { hasText: "Document filters" }).click();
  await detailsFrame
    .locator(".markdown h1", { hasText: "Document filters" })
    .waitFor();
  assert.equal(
    await detailsFrame.locator(".identity").textContent(),
    "tatr // 20260814-110000/TASK.md",
    "a new task resets artifact selection to TASK.md",
  );
  await projectsListFrame
    .locator(".project-row", { hasText: "scufris" })
    .click();
  await detailsFrame.locator(".state", { hasText: "Select a task" }).waitFor();
  await tatrFrame.locator(".title", { hasText: "Add Tatr widget" }).click();
  await detailsFrame
    .locator(".markdown h1", { hasText: "Add Tatr widget" })
    .waitFor();
  assert.equal(
    await detailsFrame.locator(".widget-focus-button").isVisible(),
    true,
  );
  assert.equal(
    await tatrFrame.locator(".widget-focus-button").isHidden(),
    true,
    "variants must opt in to Focus",
  );
  await detailsFrame.locator(".widget-focus-button").click();
  await page.waitForURL(`${dashboardViewUrl}/focus/${detailsInstance.id}`);
  assert.equal(await page.locator("#focus-layer").isVisible(), true);
  assert.equal(
    await page.locator(".dashboard-shell").getAttribute("inert"),
    "",
  );
  assert.equal(await detailsFrame.getAttribute("data-presentation"), "focus");
  assert.equal(
    await detailsFrame
      .locator(".dashboard-widget-mount")
      .evaluate(
        (element) =>
          element.shadowRoot?.host.getAttribute("data-presentation") ?? null,
      ),
    "focus",
    "the mounted frontend receives the Focus lifecycle state",
  );
  const focusedBox = await detailsFrame.boundingBox();
  assert.ok(focusedBox.width > 380 && focusedBox.height > 750);
  await page.screenshot({
    path: path.join(artifacts, "tatr-artifact-focus-markdown-narrow.png"),
  });
  await detailsFrame.locator(".identity").click();
  await detailsFrame
    .locator('.artifact-menu button:text-is("result.png")')
    .click();
  await detailsFrame.locator('.image-artifact img[alt="result.png"]').waitFor();
  await page.screenshot({
    path: path.join(artifacts, "tatr-artifact-focus-image-narrow.png"),
  });
  await page.locator("#close-focus").click();
  await page.waitForURL(dashboardViewUrl);
  assert.match(
    await detailsFrame.locator(".identity").textContent(),
    /\/result\.png$/,
    "Focus preserves widget selection when it closes",
  );
  assert.equal(await detailsFrame.getAttribute("data-presentation"), "tile");
  await detailsFrame.locator(".widget-focus-button").click();
  await page.waitForURL(`${dashboardViewUrl}/focus/${detailsInstance.id}`);
  await page.locator("#close-focus").click();
  await page.waitForURL(dashboardViewUrl);
  await detailsFrame.locator(".widget-focus-button").click();
  await page.waitForURL(`${dashboardViewUrl}/focus/${detailsInstance.id}`);
  await page.goBack();
  await page.waitForURL(dashboardViewUrl);
  await detailsFrame.locator(".identity").click();
  await detailsFrame
    .locator('.artifact-menu button:text-is("TASK.md")')
    .click();
  await detailsFrame
    .locator(".markdown h1", { hasText: "Add Tatr widget" })
    .waitFor();
  const directFocusPage = await context.newPage();
  pages.push(directFocusPage);
  await directFocusPage.goto(`${dashboardViewUrl}/focus/${detailsInstance.id}`);
  await directFocusPage.locator("#focus-layer").waitFor();
  assert.equal(
    await directFocusPage.locator("#focus-title").textContent(),
    "Tatr Tasks - Artifact",
  );
  await directFocusPage.locator("#close-focus").click();
  await directFocusPage.waitForURL(dashboardViewUrl);
  await directFocusPage.goto(`${dashboardViewUrl}/focus/${tatrInstance.id}`);
  await directFocusPage.waitForURL(dashboardViewUrl);
  await directFocusPage
    .locator("#dashboard-error", {
      hasText: "Could not focus widget: variant does not support Focus",
    })
    .waitFor();
  await directFocusPage.close();
  await page.screenshot({
    path: path.join(artifacts, "tatr-tasks-narrow.png"),
    fullPage: true,
  });
  await projectFrame.locator(".widget-focus-button").click();
  await page.waitForURL(`${dashboardViewUrl}/focus/${projectInstance.id}`);
  await projectFrame.locator(".overview-grid").waitFor();
  await page.screenshot({
    path: path.join(artifacts, "project-focus-overview-narrow.png"),
  });
  await projectFrame.locator('[data-tab="changes"]').click();
  await projectFrame
    .locator(".changes-list code", { hasText: "README.md" })
    .waitFor();
  await projectFrame
    .locator('.search[aria-label="Search changes"]')
    .fill("project-notes");
  assert.equal(await projectFrame.locator(".changes-list > div").count(), 1);
  await projectFrame.locator('[data-tab="branches"]').click();
  await projectFrame
    .locator(".branches-list strong", { hasText: "feature/projects" })
    .waitFor();
  await page.locator("#close-focus").click();
  await page.waitForURL(dashboardViewUrl);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await detailsFrame.locator(".widget-focus-button").click();
  await page.waitForURL(`${dashboardViewUrl}/focus/${detailsInstance.id}`);
  await page.screenshot({
    path: path.join(artifacts, "tatr-artifact-focus-markdown-wide.png"),
  });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#keyboard-mode").textContent(), "DASHBOARD");
  await page.keyboard.press("Escape");
  await page.waitForURL(dashboardViewUrl);
  await projectSearch.click();
  await projectSearch.pressSequentially("iehjkl");
  assert.equal(await projectSearch.inputValue(), "iehjkl");
  assert.equal(page.url(), dashboardViewUrl);
  await projectSearch.fill("");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#keyboard-mode").textContent(), "DASHBOARD");
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
  await projectFrame.locator(".widget-focus-button").click();
  await page.waitForURL(`${dashboardViewUrl}/focus/${projectInstance.id}`);
  await projectFrame.locator('[data-tab="overview"]').click();
  await page.screenshot({
    path: path.join(artifacts, "project-focus-overview-wide.png"),
  });
  await projectFrame.locator('[data-tab="changes"]').click();
  await page.screenshot({
    path: path.join(artifacts, "project-focus-changes-wide.png"),
  });
  await page.locator("#close-focus").click();
  await page.waitForURL(dashboardViewUrl);
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
  for (const frame of [projectsListFrame, pinnedFrame, projectFrame]) {
    assert.equal(
      await frame
        .locator(".dashboard-widget-mount")
        .evaluate(
          (element, rootPath) =>
            element.shadowRoot?.textContent?.includes(rootPath) ?? false,
          tatrRoot,
        ),
      false,
      "project rendering does not expose configured roots",
    );
  }
  await page.reload();
  await tatrFrame.locator(".task-row").first().waitFor();
  await projectsListFrame.locator(".project-row").nth(3).waitFor();
  await pinnedFrame.locator(".project-card").nth(2).waitFor();
  assert.equal(await pinnedFrame.locator(".empty-card").count(), 0);
  assert.equal(
    await projectsListFrame.locator(".pin-button.pinned").count(),
    3,
    "pins persist across browser reload",
  );
  const pinSnapshotResponse = await page.request.get(
    `${baseUrl}/api/v1/widget-state/projects`,
  );
  const pinSnapshot = await pinSnapshotResponse.json();
  const displacedPin = pinSnapshot.value.pins[2];
  const unavailableState = await page.request.put(
    `${baseUrl}/api/v1/widget-state/projects`,
    {
      data: {
        revision: pinSnapshot.revision,
        value: {
          pins: [
            ...pinSnapshot.value.pins.slice(0, 2),
            { project_id: "project-unavailable", project: "missing-project" },
          ],
        },
      },
    },
  );
  assert.equal(unavailableState.status(), 200);
  await pinnedFrame
    .locator(".project-card.unavailable", { hasText: "missing-project" })
    .waitFor();
  await pinnedFrame.locator(".manage").click();
  await pinnedFrame
    .locator(".pinned-row", { hasText: "missing-project" })
    .locator(".pin-button")
    .click();
  await pinnedFrame.locator(".done").click();
  await projectsListFrame
    .locator(".project-row", { hasText: displacedPin.project })
    .locator(".pin-button")
    .click();
  await pinnedFrame
    .locator(".project-card", { hasText: displacedPin.project })
    .waitFor();
  assert.equal(await projectsListFrame.locator(".search").inputValue(), "");
  assert.equal(await projectsListFrame.locator(".sort").inputValue(), "name");
  assert.equal(
    await projectsListFrame
      .locator('.filter-menu input[type="checkbox"]:checked')
      .count(),
    0,
    "reload resets page-local project controls",
  );
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
  assert.equal(
    await projectsListFrame
      .locator(".project-row", { hasText: "scufris" })
      .locator(".worktree")
      .inputValue(),
    await projectsListFrame
      .locator(".project-row", { hasText: "scufris" })
      .locator('.worktree option:text-is("Primary")')
      .getAttribute("value"),
    "reload resets worktree choice to Primary",
  );
  await projectsListFrame
    .locator(".project-row", { hasText: "scufris" })
    .click();
  await tatrFrame
    .locator(".project-filter", { hasText: "Project: scufris" })
    .waitFor();
  await tatrFrame.locator(".title", { hasText: "Add Tatr widget" }).click();
  await detailsFrame.locator(".markdown").waitFor();
  await page.locator("#edit-layout").click();
  await detailsFrame.locator(".widget-link-badge.input").click();
  assert.equal(await page.locator("#link-widget").isVisible(), true);
  const relinkResponse = page.waitForResponse(
    (response) =>
      response
        .url()
        .includes(`${dashboardApi}/links/${detailsInstance.id}/task`) &&
      response.request().method() === "PUT",
  );
  await page.locator("#confirm-link").click();
  assert.equal((await relinkResponse).status(), 200);
  await projectFilterBadge.click();
  await page.locator("#link-source").selectOption("");
  const unlinkProjectFilter = page.waitForResponse(
    (response) =>
      response
        .url()
        .includes(`${dashboardApi}/links/${tatrInstance.id}/project`) &&
      response.request().method() === "DELETE",
  );
  await page.locator("#confirm-link").click();
  assert.equal((await unlinkProjectFilter).status(), 204);
  await tatrFrame.locator(".task-row").nth(1).waitFor();
  assert.equal(await tatrFrame.locator(".task-row").count(), 2);
  assert.equal(
    await projectFilterBadge.textContent(),
    "Project filter: Not linked",
  );
  await projectFilterBadge.click();
  await page
    .locator("#link-source")
    .selectOption(`${projectsListInstance.id}\u0000selected_project`);
  const restoreProjectFilter = page.waitForResponse(
    (response) =>
      response
        .url()
        .includes(`${dashboardApi}/links/${tatrInstance.id}/project`) &&
      response.request().method() === "PUT",
  );
  await page.locator("#confirm-link").click();
  assert.equal((await restoreProjectFilter).status(), 200);
  await tatrFrame
    .locator(".project-filter", { hasText: "Project: scufris" })
    .waitFor();

  const projectInputBadge = projectFrame.locator(".widget-link-badge.input");
  await projectInputBadge.click();
  await page
    .locator("#link-source")
    .selectOption(`${pinnedInstance.id}\u0000selected_project`);
  const projectFromPinned = page.waitForResponse(
    (response) =>
      response
        .url()
        .includes(`${dashboardApi}/links/${projectInstance.id}/project`) &&
      response.request().method() === "PUT",
  );
  await page.locator("#confirm-link").click();
  assert.equal((await projectFromPinned).status(), 200);
  await projectFilterBadge.click();
  await page
    .locator("#link-source")
    .selectOption(`${pinnedInstance.id}\u0000selected_project`);
  const tatrFromPinned = page.waitForResponse(
    (response) =>
      response
        .url()
        .includes(`${dashboardApi}/links/${tatrInstance.id}/project`) &&
      response.request().method() === "PUT",
  );
  await page.locator("#confirm-link").click();
  assert.equal((await tatrFromPinned).status(), 200);
  await page.locator("#finish-editing").click();
  await pinnedFrame.locator(".project-card", { hasText: "scufris" }).click();
  await projectFrame.locator('.identity:text-is("scufris")').waitFor();
  await tatrFrame
    .locator(".project-filter", { hasText: "Project: scufris" })
    .waitFor();
  assert.equal(
    await pinnedFrame
      .locator(".project-card", { hasText: "scufris" })
      .evaluate((element) => element.classList.contains("selected")),
    true,
    "Pinned publishes the Primary project selection",
  );

  await page.locator("#edit-layout").click();
  await projectInputBadge.click();
  await page
    .locator("#link-source")
    .selectOption(`${projectsListInstance.id}\u0000selected_project`);
  await page.locator("#confirm-link").click();
  await projectFilterBadge.click();
  await page
    .locator("#link-source")
    .selectOption(`${projectsListInstance.id}\u0000selected_project`);
  await page.locator("#confirm-link").click();
  await projectFrame.locator('.identity:text-is("scufris")').waitFor();

  const deleteProjectsList = await page.request.delete(
    `${dashboardApiUrl}/instances/${projectsListInstance.id}`,
  );
  assert.equal(deleteProjectsList.status(), 204);
  await projectsListFrame.waitFor({ state: "detached" });
  await projectFrame
    .locator(".state", { hasText: "Select a project" })
    .waitFor();
  await tatrFrame.locator(".task-row").nth(1).waitFor();
  assert.equal(
    await tatrFrame.locator(".task-row").count(),
    2,
    "deleting the project source clears the page-local Tatr filter",
  );
  const deleteProject = await page.request.delete(
    `${dashboardApiUrl}/instances/${projectInstance.id}`,
  );
  assert.equal(deleteProject.status(), 204);
  await projectFrame.waitFor({ state: "detached" });
  const deletePinned = await page.request.delete(
    `${dashboardApiUrl}/instances/${pinnedInstance.id}`,
  );
  assert.equal(deletePinned.status(), 204);
  await pinnedFrame.waitFor({ state: "detached" });
  const retainedPins = await page.request.get(
    `${baseUrl}/api/v1/widget-state/projects`,
  );
  assert.equal((await retainedPins.json()).value.pins.length, 3);
  const deleteTatr = await page.request.delete(
    `${dashboardApiUrl}/instances/${tatrInstance.id}`,
  );
  assert.equal(deleteTatr.status(), 204);
  await tatrFrame.waitFor({ state: "detached" });
  await detailsFrame
    .locator(".widget-link-badge.input", { hasText: "Not linked" })
    .waitFor();
  await page.locator("#finish-editing").click();
  await detailsFrame.locator(".widget-focus-button").click();
  await page.waitForURL(`${dashboardViewUrl}/focus/${detailsInstance.id}`);
  const deleteDetails = await page.request.delete(
    `${dashboardApiUrl}/instances/${detailsInstance.id}`,
  );
  assert.equal(deleteDetails.status(), 204);
  await detailsFrame.waitFor({ state: "detached" });
  await page.waitForURL(dashboardViewUrl);
  await page
    .locator("#dashboard-error", {
      hasText: "Could not focus widget: instance was not found",
    })
    .waitFor();
  await page.locator("#edit-layout").click();

  const diskFull = await addWidget(page, "0", "3", "Disk", "Full");
  const networkFull = await addWidget(page, "3", "3", "Network", "Full");
  const diskCompact = await addWidget(page, "6", "3", "Disk", "Compact");
  const networkCompact = await addWidget(page, "7", "3", "Network", "Compact");
  const diskFullFrame = page.locator(`[data-instance-id="${diskFull}"]`);
  const networkFullFrame = page.locator(`[data-instance-id="${networkFull}"]`);
  await waitForRenderedValue(diskFullFrame.locator(".usage"));
  await waitForRenderedValue(networkFullFrame.locator(".down-rate"));
  await waitForRenderedValue(
    page.locator(`[data-instance-id="${diskCompact}"] .usage`),
  );
  await waitForRenderedValue(
    page.locator(`[data-instance-id="${networkCompact}"] .down strong`),
  );
  const diskFullHeight = (await diskFullFrame.boundingBox()).height;
  const networkFullHeight = (await networkFullFrame.boundingBox()).height;
  assert.ok(diskFullHeight > 230);
  assert.equal(networkFullHeight, diskFullHeight);
  await waitForInstanceHealth(page, dashboardApiUrl, diskFull, "healthy");
  await waitForInstanceHealth(page, dashboardApiUrl, networkFull, "healthy");
  assert.doesNotMatch(
    await diskFullFrame.locator(".filesystem").textContent(),
    /\//,
    "disk telemetry does not expose a mount path",
  );
  await page.screenshot({
    path: path.join(artifacts, "disk-network-edit-wide.png"),
    fullPage: true,
  });
  await page.locator("#finish-editing").click();
  await page.screenshot({
    path: path.join(artifacts, "disk-network-wide.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 420, height: 900 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "disk and network widgets do not cause mobile overflow",
  );
  await page.screenshot({
    path: path.join(artifacts, "disk-network-narrow.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#edit-layout").click();
  for (const instanceId of [
    diskFull,
    networkFull,
    diskCompact,
    networkCompact,
  ]) {
    const response = await page.request.delete(
      `${dashboardApiUrl}/instances/${instanceId}`,
    );
    assert.equal(response.status(), 204);
    await page
      .locator(`[data-instance-id="${instanceId}"]`)
      .waitFor({ state: "detached" });
  }

  await proxy.stop();
  await page
    .locator('#connection-indicator[data-status="disconnected"]')
    .waitFor();
  await proxy.start();
  await page
    .locator('#connection-indicator[data-status="connected"]')
    .waitFor();
  assert.equal(
    await instanceCount(page, dashboardApiUrl),
    4,
    "reconnect retains composition",
  );

  for (const [widgetId, variants] of [
    ["cpu", ["full", "compact"]],
    ["disk", ["full", "compact"]],
    ["memory", ["full", "compact"]],
    ["network", ["full", "compact"]],
    ["projects", ["list", "pinned", "project"]],
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

  const homePage = await context.newPage();
  pages.push(homePage);
  await homePage.goto(baseUrl);
  const mainCard = homePage.locator(".dashboard-card", { hasText: "Main" });
  await mainCard.waitFor();
  await homePage.keyboard.press("g");
  await homePage.keyboard.press("g");
  await homePage
    .locator(".dashboard-card.keyboard-selected", {
      hasText: "Main",
    })
    .waitFor();
  await homePage.keyboard.press(":");
  const homeCommandInput = homePage.locator(".command-input");
  await homeCommandInput.fill("dash Ma");
  await homeCommandInput.press("Tab");
  assert.equal(await homeCommandInput.inputValue(), "dashboard Main");
  await homeCommandInput.press("Escape");
  await homePage.locator(".command-palette-modal").waitFor({ state: "hidden" });
  await homePage.keyboard.press("Shift+/");
  await homePage.locator("#home-keyboard-help").waitFor();
  await homePage.locator("#home-keyboard-help .button.primary").click();
  homePage.once("dialog", (dialog) => dialog.dismiss());
  await homePage.keyboard.press("a");
  await homePage.keyboard.press("e");
  await homePage.waitForURL(dashboardEditUrl);
  await homePage.goBack();
  await mainCard.waitFor();
  assert.equal(await mainCard.locator(".dashboard-preview-widget").count(), 4);
  assert.match(
    await mainCard.locator(".dashboard-card-health").textContent(),
    /widgets/i,
  );
  homePage.once("dialog", (dialog) => dialog.accept("System"));
  await mainCard.locator("summary", { hasText: "Manage" }).click();
  await mainCard.getByRole("button", { name: "Rename" }).click();
  await homePage.locator(".dashboard-card", { hasText: "System" }).waitFor();
  const systemCard = homePage.locator(".dashboard-card", { hasText: "System" });
  await systemCard.locator("summary", { hasText: "Manage" }).click();
  await systemCard.getByRole("button", { name: "Duplicate" }).click();
  await homePage.waitForURL(new RegExp(`${baseUrl}/d/[^/]+/edit$`));
  const duplicateId = decodeURIComponent(homePage.url().split("/").at(-2));
  assert.notEqual(duplicateId, dashboardId);
  const duplicateApiUrl = `${baseUrl}/api/v1/dashboards/${encodeURIComponent(duplicateId)}`;
  assert.equal(await instanceCount(homePage, duplicateApiUrl), 4);
  const originalInstances = (
    await (await page.request.get(`${dashboardApiUrl}/instances`)).json()
  ).instances;
  const duplicateInstances = (
    await (await homePage.request.get(`${duplicateApiUrl}/instances`)).json()
  ).instances;
  assert.equal(
    duplicateInstances.some((copy) =>
      originalInstances.some((original) => original.id === copy.id),
    ),
    false,
    "duplicate uses new globally unique instance IDs",
  );
  assert.equal(
    await page.locator(".dashboard-widget").count(),
    4,
    "another dashboard does not alter the routed tab",
  );
  assert.equal(
    await homePage
      .locator("#dashboard-switcher")
      .locator("option", { hasText: "System (1)" })
      .count(),
    1,
  );
  await homePage.goto(baseUrl);
  await homePage
    .locator(".dashboard-card", { hasText: "System (1)" })
    .waitFor();
  await homePage.screenshot({
    path: path.join(artifacts, "dashboard-home-wide.png"),
    fullPage: true,
  });
  await homePage.setViewportSize({ width: 420, height: 900 });
  assert.equal(
    await homePage.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await homePage.screenshot({
    path: path.join(artifacts, "dashboard-home-narrow.png"),
    fullPage: true,
  });
  const duplicateCard = homePage.locator(".dashboard-card", {
    hasText: "System (1)",
  });
  homePage.once("dialog", (dialog) => dialog.accept());
  await duplicateCard.locator("summary", { hasText: "Manage" }).click();
  await duplicateCard.getByRole("button", { name: "Delete" }).click();
  await duplicateCard.waitFor({ state: "detached" });
  const deleteDuplicate = await homePage.request.get(duplicateApiUrl);
  assert.equal(deleteDuplicate.status(), 404);
  homePage.once("dialog", (dialog) => dialog.accept("Projects"));
  await homePage.locator("#create-dashboard").click();
  await homePage.waitForURL(new RegExp(`${baseUrl}/d/[^/]+/edit$`));
  const projectsDashboardId = decodeURIComponent(
    homePage.url().split("/").at(-2),
  );
  await addWidget(homePage, 0, 0, "CPU", "Compact");
  assert.equal(
    await instanceCount(
      homePage,
      `${baseUrl}/api/v1/dashboards/${encodeURIComponent(projectsDashboardId)}`,
    ),
    1,
  );
  assert.equal(await instanceCount(page, dashboardApiUrl), 4);
  await homePage.goto(baseUrl);
  const projectsDashboardCard = homePage.locator(".dashboard-card", {
    hasText: "Projects",
  });
  await projectsDashboardCard.waitFor();
  homePage.once("dialog", (dialog) => dialog.accept());
  await projectsDashboardCard.locator("summary", { hasText: "Manage" }).click();
  await projectsDashboardCard.getByRole("button", { name: "Delete" }).click();
  await projectsDashboardCard.waitFor({ state: "detached" });

  await requestGracefulStop(dashboardd);
  assert.equal(existsSync(stateFile), true, "composition is persisted");
  assert.equal(
    JSON.parse(readFileSync(stateFile, "utf8")).widget_state.projects.pins
      .length,
    3,
    "shared widget state persists without Projects instances",
  );
  dashboardd = startDashboardd();
  await waitForHealth(dashboardUrl);
  await page.locator(`[data-instance-id="${cpuOne}"]`).waitFor();
  assert.equal(
    await instanceCount(page, dashboardApiUrl),
    4,
    "restart restores persisted composition with stable IDs",
  );
  const restoredFull = await page.request.get(
    `${dashboardApiUrl}/instances/${fullInstance.id}`,
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
  const bootstrapped = await page.request.get(`${dashboardApiUrl}/instances`);
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
  const retained = await page.request.get(`${dashboardApiUrl}/instances`);
  const retainedInstances = (await retained.json()).instances;
  assert.equal(retainedInstances.length, 1);
  assert.equal(retainedInstances[0].widget_id, "cpu");
  const dashboardsResponse = await page.request.get(
    `${baseUrl}/api/v1/dashboards`,
  );
  const finalDashboards = (await dashboardsResponse.json()).dashboards;
  assert.equal(finalDashboards.length, 1);
  const deleteFinal = await page.request.delete(
    `${baseUrl}/api/v1/dashboards/${encodeURIComponent(finalDashboards[0].id)}`,
  );
  assert.equal(deleteFinal.status(), 204);
  await homePage.goto(baseUrl);
  await homePage.locator("#dashboard-empty").waitFor();
  assert.equal(await homePage.locator(".dashboard-card").count(), 0);
  await homePage.screenshot({
    path: path.join(artifacts, "dashboard-home-empty-narrow.png"),
    fullPage: true,
  });
  await requestGracefulStop(dashboardd);
  dashboardd = startDashboardd();
  await waitForHealth(dashboardUrl);
  const emptyAfterRestart = await page.request.get(
    `${baseUrl}/api/v1/dashboards`,
  );
  assert.deepEqual(await emptyAfterRestart.json(), { dashboards: [] });
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
  writeTatrTaskAt(
    path.join(tatrRoot, project),
    id,
    title,
    status,
    priority,
    tags,
  );
}

function writeTatrTaskAt(project, id, title, status, priority, tags) {
  const directory = path.join(project, "tasks", id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "TASK.md"),
    `# ${title}\n\n- STATUS: ${status}\n- PRIORITY: ${priority}\n- TAGS: ${tags.join(", ")}\n\n## Notes\n\n**Fixture markdown** with [Example](https://example.com).\n\n<script>unsafe()</script>\n\n![Ignored image](secret.png)\n`,
  );
}

function writeTatrArtifacts(project, id) {
  const directory = path.join(tatrRoot, project, "tasks", id);
  mkdirSync(path.join(directory, "notes"), { recursive: true });
  writeFileSync(
    path.join(directory, "notes/related.md"),
    "# Related artifact\n\nArtifact navigation works.\n",
  );
  writeFileSync(path.join(directory, "summary.txt"), "Plain artifact text\n");
  writeFileSync(
    path.join(directory, "report.html"),
    '<header class="content" id="report-header"><h1>HTML report</h1></header><script>unsafe()</script><form><input></form><img src="https://example.com/tracker.png"><a href="notes/related.md">Related artifact</a>',
  );
  writeFileSync(
    path.join(directory, "result.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  writeFileSync(path.join(directory, ".secret.txt"), "hidden");
}

function writeProjectRepositories() {
  const commitDates = {
    scufris: "2026-08-14T12:00:00Z",
    tatr: "2026-08-13T12:00:00Z",
    idle: "2026-08-12T12:00:00Z",
    other: "2026-08-11T12:00:00Z",
  };
  for (const project of ["scufris", "tatr", "idle", "other"]) {
    const directory = path.join(tatrRoot, project);
    mkdirSync(directory, { recursive: true });
    runGitFixture(directory, ["init", "-q", "-b", "main"]);
    runGitFixture(directory, ["config", "user.name", "Fixture"]);
    runGitFixture(directory, [
      "config",
      "user.email",
      "fixture@example.invalid",
    ]);
    writeFileSync(path.join(directory, "README.md"), `# ${project}\n`);
    runGitFixture(directory, ["add", "."]);
    runGitFixture(directory, ["commit", "-q", "-m", `Initialize ${project}`], {
      GIT_AUTHOR_DATE: commitDates[project],
      GIT_COMMITTER_DATE: commitDates[project],
    });
  }
  runGitFixture(path.join(tatrRoot, "scufris"), ["branch", "feature/projects"]);
  const worktree = path.join(tatrRoot, ".worktrees", "scufris-projects");
  mkdirSync(path.dirname(worktree), { recursive: true });
  runGitFixture(path.join(tatrRoot, "scufris"), [
    "worktree",
    "add",
    "-q",
    worktree,
    "feature/projects",
  ]);
  writeTatrTaskAt(
    worktree,
    "20260814-120000",
    "Worktree Tatr widget",
    "OPEN",
    120,
    ["widget", "worktree"],
  );
  writeFileSync(
    path.join(worktree, "README.md"),
    "# scufris\n\nWorktree fixture change.\n",
  );
  writeFileSync(path.join(worktree, "worktree-notes.txt"), "Linked checkout\n");
  writeFileSync(
    path.join(tatrRoot, "scufris", "README.md"),
    "# scufris\n\nProjects fixture change.\n",
  );
  writeFileSync(
    path.join(tatrRoot, "scufris", "project-notes.txt"),
    "Untracked project notes\n",
  );
}

function runGitFixture(directory, args, environment = {}) {
  const result = spawnSync("git", args, {
    cwd: directory,
    env: { ...process.env, ...environment },
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`git fixture failed: ${result.stderr || result.stdout}`);
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
      response.url().includes("/api/v1/dashboards/") &&
      response.url().endsWith("/instances") &&
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
    "disk",
    "memory",
    "network",
    "projects",
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
  dashboardApiUrl,
  instanceId,
  status,
  restartCount = 0,
) {
  const deadline = Date.now() + 10_000;
  let actual = null;
  while (Date.now() < deadline) {
    const response = await page.request.get(
      `${dashboardApiUrl}/instances/${encodeURIComponent(instanceId)}/health`,
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

async function waitForRenderedValue(locator) {
  await locator.waitFor();
  await locator.evaluate(
    (element) =>
      new Promise((resolve, reject) => {
        if (!element.textContent?.startsWith("--")) return resolve();
        const observer = new MutationObserver(() => {
          if (!element.textContent?.startsWith("--")) {
            observer.disconnect();
            resolve();
          }
        });
        observer.observe(element, { childList: true, characterData: true });
        setTimeout(() => {
          observer.disconnect();
          reject(new Error("widget value did not render"));
        }, 5_000);
      }),
  );
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

async function instanceCount(page, dashboardApiUrl) {
  const response = await page.request.get(`${dashboardApiUrl}/instances`);
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
