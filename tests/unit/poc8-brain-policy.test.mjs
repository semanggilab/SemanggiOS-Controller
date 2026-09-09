import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createController } from "../../src/app.mjs";

const routing = JSON.parse(await readFile(new URL("../../config/routing.json", import.meta.url), "utf8"));

test("POC-8 policy registers four Claude and five Codex ACP Brains", async () => {
  const controller = await createController({ routing, runtime: {} });
  const names = new Set((await controller.brains.list()).map((b) => b.name));
  for (const name of [
    "claude-sonnet-medium", "claude-sonnet-high", "claude-opus-medium", "claude-opus-high",
    "codex-terra-medium", "codex-terra-high", "codex-sol-low", "codex-sol-medium", "codex-astra-low",
  ]) assert.ok(names.has(name), `missing ${name}`);

  const coding = await controller.brainMap.resolve({
    template: "software", role: "builder", level: "critical", brains: controller.brains,
  });
  assert.deepEqual(coding.names.slice(0, 3), ["claude-sonnet-high", "claude-opus-medium", "codex-sol-medium"]);
  const analysis = await controller.brainMap.resolve({
    template: "software", role: "analyst", level: "critical", brains: controller.brains,
  });
  assert.deepEqual(analysis.names.slice(0, 2), ["claude-opus-high", "codex-astra-low"]);

  const marker = await controller.store.get(
    `SELECT COUNT(*) AS n FROM event_log WHERE kind = ? AND subject_id = ?`,
    ["brain.policy-applied", routing.brainPolicyVersion],
  );
  assert.equal(Number(marker.n), 1);
  await controller.store.close();
});
