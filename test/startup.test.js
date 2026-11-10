import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { SSMClient } from "@aws-sdk/client-ssm";
import { ensureParametersLoaded } from "../src/config/parameterStore.js";

test("loads more than ten missing parameters in valid SSM batches", async () => {
  const keys = Array.from({ length: 11 }, (_, i) => `STARTUP_TEST_${i}`);
  const batches = [];
  const originalSend = SSMClient.prototype.send;
  const originalPrefix = process.env.PARAMETER_STORE_PREFIX;
  process.env.PARAMETER_STORE_PREFIX = "/startup-test/";
  SSMClient.prototype.send = async function (command) {
    const names = command.input.Names;
    assert.ok(names.length <= 10);
    batches.push(names);
    return { Parameters: names.map((Name) => ({ Name, Value: Name })) };
  };

  try {
    await ensureParametersLoaded(keys);
    assert.deepEqual(batches.map((batch) => batch.length), [10, 1]);
    for (const key of keys) assert.equal(process.env[key], `/startup-test/${key}`);
  } finally {
    SSMClient.prototype.send = originalSend;
    if (originalPrefix === undefined) delete process.env.PARAMETER_STORE_PREFIX;
    else process.env.PARAMETER_STORE_PREFIX = originalPrefix;
    for (const key of keys) delete process.env[key];
  }
});

test("cache module waits until connection to read its endpoint", () => {
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    'delete process.env.MEMCACHED_ENDPOINT; const { connectToMemcached } = await import("./src/lib/cache.js"); process.env.MEMCACHED_ENDPOINT = "localhost:11211"; const client = connectToMemcached(); client.end();',
  ], { cwd: process.cwd(), encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
