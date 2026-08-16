import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(path.join(os.tmpdir(), "dashboardd-widget-sdk-"));
try {
  const packed = capture(
    "npm",
    [
      "pack",
      "--workspace",
      "@dashboardd/widget-sdk",
      "--json",
      "--pack-destination",
      temporary,
    ],
    root,
  );
  const [record] = JSON.parse(packed);
  assert.ok(record, "npm pack returns one SDK package");
  assert.equal(record.name, "@dashboardd/widget-sdk");
  assert.equal(record.version, "0.1.0");
  assert.deepEqual(
    record.files.map(({ path: file }) => file).sort(),
    [
      "LICENSE",
      "README.md",
      "dist/css.d.ts",
      "dist/index.d.ts",
      "dist/index.js",
      "dist/theme.css",
      "dist/widget.css",
      "package.json",
    ],
    "tarball contains only supported public files",
  );

  const consumer = path.join(temporary, "consumer");
  cpSync(path.join(root, "tests/fixtures/sdk-consumer"), consumer, {
    recursive: true,
  });
  writeFileSync(
    path.join(consumer, "package.json"),
    `${JSON.stringify({ name: "external-widget", private: true, type: "module" }, null, 2)}\n`,
  );
  const tarball = path.join(temporary, record.filename);
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    consumer,
  );
  const typescript = path.join(root, "node_modules/typescript/bin/tsc");
  run(process.execPath, [typescript, "--project", "tsconfig.json"], consumer);

  writeFileSync(
    path.join(consumer, "verify.mjs"),
    `import { isWidgetModule } from "@dashboardd/widget-sdk";
if (!isWidgetModule({ mount() {} })) throw new Error("runtime export failed");
for (const asset of ["theme.css", "widget.css"])
  if (!import.meta.resolve("@dashboardd/widget-sdk/" + asset).endsWith(asset))
    throw new Error("CSS export failed: " + asset);
`,
  );
  run(process.execPath, ["verify.mjs"], consumer);

  const installed = JSON.parse(
    readFileSync(
      path.join(consumer, "node_modules/@dashboardd/widget-sdk/package.json"),
      "utf8",
    ),
  );
  assert.equal(
    installed.private,
    undefined,
    "published package is not private",
  );
  console.log("external widget SDK package scenarios passed");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

function run(command, args, cwd) {
  capture(command, args, cwd);
}
