import { readFileSync } from "node:fs";
import { RedisClient } from "bun";

class LocalSharedState {
  #values = new Map();
  #locks = new Set();

  async getJson(key) {
    const value = this.#values.get(key);
    return value === undefined ? null : structuredClone(value);
  }

  async setJson(key, value, { ttlMs = null } = {}) {
    this.#values.set(key, structuredClone(value));
    if (ttlMs) setTimeout(() => this.#values.delete(key), ttlMs).unref?.();
  }

  async delete(key) {
    this.#values.delete(key);
  }

  async withLock(key, _ttlMs, fn) {
    if (this.#locks.has(key)) return null;
    this.#locks.add(key);
    try {
      return await fn();
    } finally {
      this.#locks.delete(key);
    }
  }

  close() {}
}

class RedisSharedState {
  #redis;
  #prefix;

  constructor(uri, { prefix = "semanggi" } = {}) {
    // Bun 1.2.22: opsi {password} pada RedisClient gagal — koneksi ditutup
    // server (ERR_REDIS_CONNECTION_CLOSED) pada handshake; password yang
    // di-embed di userinfo URI bekerja (terukur: PING +PONG vs FAIL).
    const password = this.#readPassword();
    this.#redis = new RedisClient(this.#uri, {
      connectionTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? 5_000),
      idleTimeout: Number(process.env.REDIS_IDLE_TIMEOUT_MS ?? 30_000),
      enableOfflineQueue: false,
      autoReconnect: true,
    });
    this.#prefix = prefix;
    this.#uri = this.#withPassword(uri, password);
  }

  #withPassword(uri, password) {
    if (!password) return uri;
    const url = new URL(uri);
    url.password = encodeURIComponent(password);
    return url.toString();
  }

  #readPassword() {
    const file = process.env.REDIS_PASSWORD_FILE;
    if (file) return readFileSync(file, "utf8").trim();
    return process.env.REDIS_PASSWORD ?? undefined;
  }

  key(key) {
    return `${this.#prefix}:${key}`;
  }

  async connect() {
    await this.#redis.connect();
    await this.#redis.send("PING", []);
    return this;
  }

  async getJson(key) {
    const raw = await this.#redis.get(this.key(key));
    return raw == null ? null : JSON.parse(raw);
  }

  async setJson(key, value, { ttlMs = null } = {}) {
    const args = [this.key(key), JSON.stringify(value)];
    if (ttlMs) args.push("PX", String(ttlMs));
    await this.#redis.send("SET", args);
  }

  async delete(key) {
    await this.#redis.del(this.key(key));
  }

  async withLock(key, ttlMs, fn) {
    const redisKey = this.key(`lock:${key}`);
    const token = crypto.randomUUID();
    let acquired;
    try {
      acquired = await this.#redis.send("SET", [redisKey, token, "NX", "PX", String(ttlMs)]);
    } catch (e) {
      // Blip koneksi sesaat setelah boot (terukur: connect()+PING sukses,
      // SET pertama ratusan ms kemudian ERR_REDIS_CONNECTION_CLOSED) tidak
      // boleh membunuh pass scheduler — reconnect sekali, coba lagi sekali.
      console.error(JSON.stringify({
        at: new Date().toISOString(), svc: "controller", sev: "warn",
        evt: "shared-state.lock-blip", key, code: e.code ?? null,
        message: e.message ?? String(e),
      }));
      try { this.#redis.close(); } catch {}
      await this.#reconnect();
      acquired = await this.#redis.send("SET", [redisKey, token, "NX", "PX", String(ttlMs)]);
    }
    if (acquired !== "OK") return null;
    const renewEvery = Math.max(1_000, Math.floor(ttlMs / 3));
    const renew = setInterval(() => {
      void this.#redis.send("EVAL", [
        "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) else return 0 end",
        "1", redisKey, token, String(ttlMs),
      ]).catch(() => {});
    }, renewEvery);
    renew.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(renew);
      await this.#redis.send("EVAL", [
        "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",
        "1", redisKey, token,
      ]).catch(() => {});
    }
  }

  async #reconnect() {
    this.#redis = new RedisClient(this.#uri, {
      connectionTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? 5_000),
      idleTimeout: Number(process.env.REDIS_IDLE_TIMEOUT_MS ?? 30_000),
      enableOfflineQueue: false,
      autoReconnect: true,
    });
    await this.#redis.connect();
    await this.#redis.send("PING", []);
  }

  close() {
    this.#redis.close();
  }
}

export async function createSharedState({ driver = "memory", uri = null, prefix = "semanggi" } = {}) {
  if (driver === "memory") return new LocalSharedState();
  if (driver !== "redis") throw new Error(`unsupported STATE_DRIVER "${driver}"; expected memory or redis`);
  if (!uri) throw new Error("REDIS_URI is required when STATE_DRIVER=redis");
  return new RedisSharedState(uri, { prefix }).connect();
}
