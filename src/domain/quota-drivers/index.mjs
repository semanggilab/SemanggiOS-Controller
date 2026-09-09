// POC-6 registry: one driver per known provider, generic for everything else.
//
// RESOLUTION IS BY ALIAS, NOT BY NAME EQUALITY (D64). The Brain.provider
// string is the GATEWAY's label for a models-config entry — an operator-chosen
// name, not a contract. The live counterexample: the mistral models are
// registered in AgentOS under the label "mistral-custom", so a lookup that
// only compared provider === driver id silently routed a real provider to the
// generic driver (null windows, no mistral facts). Each driver therefore
// declares `providerKeys`: the gateway labels it answers to. The structural
// signal would be the provider's baseUrl host (api.mistral.ai can't lie about
// being mistral) — but models.list does not carry baseUrl today (verified on
// the live cache: provider, model, name, reasoning, available only), so the
// alias table is the mechanism until the gateway exposes it.
import { genericDriver } from "./generic.mjs";
import { googleDriver } from "./google.mjs";
import { groqDriver } from "./groq.mjs";
import { cerebrasDriver } from "./cerebras.mjs";
import { zaiDriver } from "./zai.mjs";
import { claudeCodeDriver } from "./claude-code.mjs";
import { mistralDriver } from "./mistral.mjs";
import { codexDriver } from "./codex.mjs";

const DRIVERS = Object.freeze({
  google: googleDriver,
  groq: groqDriver,
  cerebras: cerebrasDriver,
  zai: zaiDriver,
  "claude-code": claudeCodeDriver,
  mistral: mistralDriver,
  codex: codexDriver,
});

const BY_KEY = new Map();
for (const [id, driver] of Object.entries(DRIVERS)) {
  BY_KEY.set(id, driver);
  for (const key of driver.providerKeys ?? []) BY_KEY.set(String(key).toLowerCase(), driver);
}

/** The driver that owns a gateway provider label; generic when none does. */
export function quotaDriverFor(provider) {
  return BY_KEY.get(String(provider ?? "").toLowerCase()) ?? genericDriver;
}

/** Driver id for a provider label ("generic" when unmatched) — UI annotation. */
export function quotaDriverIdFor(provider) {
  return quotaDriverFor(provider).id;
}

/** Registry surface for the operator: what label maps to which driver. */
export function quotaDriverCatalog() {
  return Object.entries(DRIVERS).map(([id, driver]) => ({
    id,
    providerKeys: [id, ...(driver.providerKeys ?? [])].sort(),
    tier: driver.defaults().quotaTier ?? null,
  }));
}

export { genericDriver, googleDriver, groqDriver, cerebrasDriver, zaiDriver, claudeCodeDriver, mistralDriver, codexDriver };
