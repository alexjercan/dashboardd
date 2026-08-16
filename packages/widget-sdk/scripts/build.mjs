import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const executable = process.platform === "win32" ? "tsc.cmd" : "tsc";
const result = spawnSync(executable, ["--project", "tsconfig.json"], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

for (const asset of ["theme.css", "widget.css"])
  copyFileSync(path.join(root, asset), path.join(dist, asset));
copyFileSync(path.join(root, "src/css.d.ts"), path.join(dist, "css.d.ts"));
