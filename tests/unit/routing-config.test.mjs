// The shipped example policy must actually work: a routing file that looks
// plausible but references an unmapped model would fail only at dispatch time,
// in production, as a WAIT_RESOURCE nobody can explain.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RoutingPolicy, assertDispatchPathAllowed } from "../../src/scheduler/routing.mjs";

const config = JSON.parse(
  readFileSync(new URL("../../config/routing.example.json", import.meta.url), "utf8"),
);
const policy = new RoutingPolicy(config);

test("every model named in a route exists in the catalog", () => {
  for (const [category, tiers] of Object.entries(config.routes)) {
    for (const [tier, route] of Object.entries(tiers)) {
      const names = [...(route.preferred ?? []), ...(Array.isArray(route.fallback) ? route.fallback : [])];
      assert.ok(names.length > 0, `${category}/${tier} lists no models`);
      for (const name of names) {
        assert.ok(config.catalog[name], `${category}/${tier} references unknown model "${name}"`);
      }
    }
  }
});

test("quality classes resolve to a real route", () => {
  for (const [qualityClass, tier] of Object.entries(config.classMap)) {
    const task = { quality_class: qualityClass, model_policy: { category: "documentation" } };
    const resolved = policy.resolve(task);
    if (config.routes.documentation[tier]) {
      assert.ok(resolved.ok, `documentation/${tier} (from ${qualityClass}) should resolve`);
    }
  }
});

test("critical tiers refuse to fall back", () => {
  for (const [category, tiers] of Object.entries(config.routes)) {
    const critical = tiers.critical;
    if (!critical) continue;
    assert.equal(
      critical.fallback,
      "none",
      `${category}/critical must not silently widen its candidate set (P4-03)`,
    );
  }
});

test("claude-code is only ever routed through acp or batch", () => {
  for (const [name, entry] of Object.entries(config.catalog)) {
    if (entry.provider !== "claude-code") continue;
    assert.doesNotThrow(() => assertDispatchPathAllowed(entry), `${name} uses a forbidden dispatch path`);
  }
});

test("the default category is one that exists", () => {
  assert.ok(config.routes[config.defaultCategory], "defaultCategory must name a real route");
});

// --- effort: jaminan vs preferensi -------------------------------------------
//
// Diukur 2026-08-30 terhadap gateway 2026.7.1. Yang membuat pembedaan ini perlu
// bukan kerapian melainkan dua kegagalan nyata: gemini menerima setiap level dan
// menerapkan tidak satu pun, dan groq/qwen menerima minimal|medium|high lalu
// menggantung sampai watchdog memungutnya.

test("effort preferensi tidak pernah dikirim ke gateway", async () => {
  const { effortIsGuaranteed } = await import("../../src/runtime/gateway-ws.mjs");
  assert.equal(effortIsGuaranteed({ thinking: "max", effortMode: "guaranteed" }), true);
  assert.equal(effortIsGuaranteed({ thinking: "high", effortMode: "preference" }), false);
  // Entri yang belum dikarakterisasi diperlakukan sebagai klaim yang harus
  // diuji, bukan sebagai alasan menahan parameter.
  assert.equal(effortIsGuaranteed({ thinking: "low" }), true);
});

test("katalog nyata menandai setiap entri ber-effort", async () => {
  const { readFileSync } = await import("node:fs");
  const routing = JSON.parse(readFileSync(new URL("../../config/routing.json", import.meta.url), "utf8"));
  const entries = Object.entries(routing.catalog).filter(([n, e]) => !n.startsWith("_") && e && typeof e === "object");

  for (const [name, entry] of entries) {
    if (!entry.thinking) continue;
    assert.ok(
      ["guaranteed", "preference"].includes(entry.effortMode ?? "guaranteed"),
      `${name}: effortMode harus guaranteed atau preference`,
    );
    // Sebuah klaim tanpa alasan tercatat adalah klaim yang tidak bisa ditinjau
    // ulang saat provider berubah.
    if (entry.effortMode) assert.ok(entry.effortEvidence, `${name}: effortMode tanpa effortEvidence`);
  }

  // Yang terukur tidak berlaku harus tetap preference — regresi di sini berarti
  // label mahal menumpang pada run yang tidak melakukan apa-apa.
  for (const n of ["gemini-flash-high", "gemini-flash-medium", "qwen-medium"]) {
    assert.equal(routing.catalog[n].effortMode, "preference", `${n} terukur tidak menerapkan effort`);
  }
  for (const n of ["glm-5.2-max", "glm-5.2-high", "glm-5.2-low"]) {
    assert.equal(routing.catalog[n].effortMode, "guaranteed", `${n} terukur berlaku (137 -> 217 -> 284)`);
  }
});
