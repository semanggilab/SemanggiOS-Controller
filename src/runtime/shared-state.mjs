import { RedisClient } from "bun";
import { withStartupRetry } from "./startup-retry.mjs";

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
  #uri;
  #options;
  #reconnectPromise = null;
  #prefix;

  constructor(uri, { prefix = "semanggi" } = {}) {
    this.#uri = uri;
    this.#options = {
      connectionTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? 5_000),
      // A controller can legitimately be idle for minutes. Disabling the
      // client-side idle close avoids a stale Bun 1.2 connection being reused.
      idleTimeout: Number(process.env.REDIS_IDLE_TIMEOUT_MS ?? 0),
      enableOfflineQueue: false,
      autoReconnect: true,
    };
    this.#redis = this.#newClient();
    this.#prefix = prefix;
  }

  #newClient() {
    return new RedisClient(this.#uri, this.#options);
  }

  async #reconnect() {
    if (!this.#reconnectPromise) {
      this.#reconnectPromise = (async () => {
        try { this.#redis.close(); } catch {}
        this.#redis = this.#newClient();
        await this.#redis.connect();
        await this.#redis.send("PING", []);
      })().finally(() => { this.#reconnectPromise = null; });
    }
    await this.#reconnectPromise;
  }

  async #command(operation) {
    try {
      return await operation(this.#redis);
    } catch (error) {
      const code = String(error?.code ?? "");
      const message = String(error?.message ?? error);
      if (!code.includes("REDIS_CONNECTION") && !/connection (?:has failed|closed)/i.test(message)) throw error;
      await this.#reconnect();
      return operation(this.#redis);
    }
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
    const raw = await this.#command((redis) => redis.get(this.key(key)));
    return raw == null ? null : JSON.parse(raw);
  }

  async setJson(key, value, { ttlMs = null } = {}) {
    const args = [this.key(key), JSON.stringify(value)];
    if (ttlMs) args.push("PX", String(ttlMs));
    await this.#command((redis) => redis.send("SET", args));
  }

  async delete(key) {
    await this.#command((redis) => redis.del(this.key(key)));
  }

  async withLock(key, ttlMs, fn) {
    const redisKey = this.key(`lock:${key}`);
    const token = crypto.randomUUID();
    const acquired = await this.#command((redis) => redis.send("SET", [redisKey, token, "NX", "PX", String(ttlMs)]));
    if (acquired !== "OK") return null;
    const renewEvery = Math.max(1_000, Math.floor(ttlMs / 3));
    const renew = setInterval(() => {
      void this.#command((redis) => redis.send("EVAL", [
        "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) else return 0 end",
        "1", redisKey, token, String(ttlMs),
      ])).catch(() => {});
    }, renewEvery);
    renew.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(renew);
      await this.#command((redis) => redis.send("EVAL", [
        "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",
        "1", redisKey, token,
      ])).catch(() => {});
    }
  }

  close() {
    this.#redis.close();
  }
}

export async function createSharedState({ driver = "memory", uri = null, prefix = "semanggi" } = {}) {
  if (driver === "memory") return new LocalSharedState();
  if (driver !== "redis") throw new Error(`unsupported STATE_DRIVER "${driver}"; expected memory or redis`);
  if (!uri) throw new Error("REDIS_URI is required when STATE_DRIVER=redis");
  return withStartupRetry("redis", async () => {
    const state = new RedisSharedState(uri, { prefix });
    try {
      return await state.connect();
    } catch (error) {
      state.close();
      throw error;
    }
  });
}
