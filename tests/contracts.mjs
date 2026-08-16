import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";

const root = path.resolve(import.meta.dirname, "..");
const runtimeSchema = json("schemas/widget-runtime-v2.schema.json");
const protocolSchema = json("schemas/widget-backend-v1.schema.json");
const fixtureRoot = path.join(root, "tests/fixtures/external-widget");
const fixtureManifest = json("tests/fixtures/external-widget/widget.json");
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(runtimeSchema);
ajv.addSchema(protocolSchema);

const validateRuntime = requiredSchema(runtimeSchema.$id);
assertValid(validateRuntime, fixtureManifest, "external runtime fixture");
validateRuntimeSemantics(fixtureManifest);

const invalidRuntime = structuredClone(fixtureManifest);
invalidRuntime.backend = "../python-widget";
assert.equal(
  validateRuntime(invalidRuntime),
  false,
  "runtime paths reject traversal",
);

const invalidId = structuredClone(fixtureManifest);
invalidId.id = "External Fixture";
assert.equal(
  validateRuntime(invalidId),
  false,
  "runtime IDs use stable kebab case",
);

for (const [name, definition] of [
  ["server-to-widget", "serverToWidget"],
  ["widget-to-server", "widgetToServer"],
]) {
  const validate = requiredSchema(`${protocolSchema.$id}#/$defs/${definition}`);
  for (const [index, line] of readLines(
    `tests/protocol-fixtures/${name}.jsonl`,
  ).entries())
    assertValid(validate, JSON.parse(line), `${name} fixture ${index + 1}`);
}

await verifyPythonBackend();
console.log("widget contract scenarios passed");

function json(relative) {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8"));
}

function readLines(relative) {
  return readFileSync(path.join(root, relative), "utf8").trim().split("\n");
}

function requiredSchema(id) {
  const validate = ajv.getSchema(id);
  assert.ok(validate, `schema is registered: ${id}`);
  return validate;
}

function assertValid(validate, value, label) {
  assert.equal(
    validate(value),
    true,
    `${label}: ${ajv.errorsText(validate.errors, { separator: "; " })}`,
  );
}

function validateRuntimeSemantics(manifest) {
  const variantIds = new Set();
  for (const variant of manifest.variants) {
    assert.equal(variantIds.has(variant.id), false, "variant IDs are unique");
    variantIds.add(variant.id);
  }
  const optionIds = new Set();
  for (const option of manifest.options) {
    assert.equal(optionIds.has(option.id), false, "option IDs are unique");
    optionIds.add(option.id);
    for (const variant of option.variants)
      assert.equal(variantIds.has(variant), true, "option variants exist");
  }
  const portIds = new Set();
  for (const port of [...manifest.inputs, ...manifest.outputs]) {
    assert.equal(
      portIds.has(port.id),
      false,
      "port IDs are package-wide unique",
    );
    portIds.add(port.id);
    for (const variant of port.variants)
      assert.equal(variantIds.has(variant), true, "port variants exist");
  }
}

async function verifyPythonBackend() {
  const backend = path.join(fixtureRoot, "bin/python-widget");
  const child = spawn(backend, [], {
    cwd: fixtureRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = readline.createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  try {
    assert.deepEqual(await nextMessage(iterator), {
      version: 1,
      kind: "ready",
      data: { widget_id: "external-fixture" },
    });
    send(child, {
      version: 1,
      kind: "initialize",
      data: {
        instance_id: "external-fixture-1",
        widget_id: "external-fixture",
        variant_id: "summary",
        options: {},
      },
    });
    assert.deepEqual(await nextMessage(iterator), {
      version: 1,
      kind: "update",
      data: {
        instance_id: "external-fixture-1",
        payload: { source: "python", initialized: true },
      },
    });
    send(child, { version: 1, kind: "ping", data: { nonce: 42 } });
    assert.deepEqual(await nextMessage(iterator), {
      version: 1,
      kind: "pong",
      data: { nonce: 42 },
    });
    send(child, {
      version: 1,
      kind: "message",
      data: {
        instance_id: "external-fixture-1",
        payload: { command: "refresh" },
      },
    });
    assert.deepEqual(await nextMessage(iterator), {
      version: 1,
      kind: "update",
      data: {
        instance_id: "external-fixture-1",
        payload: { command: "refresh" },
      },
    });
    send(child, { version: 1, kind: "shutdown", data: {} });
    const [code, signal] = await withTimeout(once(child, "exit"), 3_000);
    assert.equal(code, 0, `Python backend exited with ${code}: ${stderr}`);
    assert.equal(signal, null);
    assert.equal(stderr, "");
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function nextMessage(iterator) {
  const result = await withTimeout(iterator.next(), 3_000);
  assert.equal(result.done, false, "backend stdout closed early");
  return JSON.parse(result.value);
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("backend timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
