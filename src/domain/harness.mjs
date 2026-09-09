const HARNESS_PROVIDERS = new Set(["claude-code", "codex"]);

export function isHarnessProvider(provider) {
  return HARNESS_PROVIDERS.has(String(provider ?? "").toLowerCase());
}

export function isHarnessBrain(candidate) {
  return isHarnessProvider(candidate?.provider) && ["acp", "batch"].includes(candidate?.mode);
}
