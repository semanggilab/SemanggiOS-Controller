// POC-6 registry: one driver per known provider, generic for everything else.
// Selection is by Brain.provider (lowercased); an unknown id falls to the
// generic driver so a provider newly configured in the gateway behaves today
// — the D51 way — until someone writes its driver.
import { genericDriver } from "./generic.mjs";
import { googleDriver } from "./google.mjs";
import { groqDriver } from "./groq.mjs";
import { cerebrasDriver } from "./cerebras.mjs";
import { zaiDriver } from "./zai.mjs";
import { claudeCodeDriver } from "./claude-code.mjs";
import { mistralDriver } from "./mistral.mjs";

const DRIVERS = Object.freeze({
  google: googleDriver,
  groq: groqDriver,
  cerebras: cerebrasDriver,
  zai: zaiDriver,
  "claude-code": claudeCodeDriver,
  mistral: mistralDriver,
});

export function quotaDriverFor(provider) {
  return DRIVERS[String(provider ?? "").toLowerCase()] ?? genericDriver;
}

export { genericDriver, googleDriver, groqDriver, cerebrasDriver, zaiDriver, claudeCodeDriver, mistralDriver };
