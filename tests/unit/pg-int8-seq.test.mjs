// Regression for the live 2026-09-11 incident: chat_messages.seq grew as
// 1, 11, 111, ... 1111111111111111111 until the 20th message bind exceeded
// bigint and Postgres rejected the insert with `value "11111111111111111111"
// is out of range for type bigint`. Root cause: pg drivers return int8
// (bigint) columns as JS strings, so (max ?? 0) + 1 concatenated instead of
// adding — SQLite-based tests never see this because sqlite returns numbers.
// These tests pin the coercion contract with a store that mimics pg.
import test from "node:test";
import assert from "node:assert/strict";
import { createRepositories } from "../../src/domain/repositories.mjs";

// Minimal store double: only the queries chatMessages.append and
// executions.create touch, with int8 MAX() results returned as strings
// exactly like node-postgres does by default.
const fakeStore = (maxSeq, maxRevision) => {
  const inserts = [];
  const store = {
    inserts,
    async get(sql) {
      if (sql.includes("MAX(seq)")) return { m: maxSeq };
      if (sql.includes("MAX(revision_no)")) return { n: maxRevision };
      if (sql.includes("FROM chat_sessions")) return { id: "CHS-1" };
      if (sql.includes("FROM chat_messages WHERE id")) return { id: "CHM-1", seq: 0 };
      if (sql.includes("FROM tasks")) return { id: "TSK-1" };
      return null;
    },
    async run(sql, params) {
      if (sql.startsWith("INSERT INTO chat_messages")) inserts.push({ table: "chat_messages", params });
      if (sql.startsWith("INSERT INTO executions")) inserts.push({ table: "executions", params });
    },
    async tx(fn) {
      return fn();
    },
  };
  return store;
};

test("chatMessages.append: seq numerik saat driver pg mengembalikan MAX(int8) sebagai string", async () => {
  const store = fakeStore("11", null); // pg would hand back the string "11"
  const repos = createRepositories(store, { append: async () => {} });
  await repos.chatMessages.append({ sessionId: "CHS-1", role: "operator", content: "x" });
  const insert = store.inserts.find((i) => i.table === "chat_messages");
  assert.ok(insert, "append issues the INSERT");
  assert.equal(insert.params[2], 12, '"11" + 1 harus 12 (number), bukan string "111"');
  assert.equal(typeof insert.params[2], "number", "seq terikat sebagai number, bukan string");
});

test("executions.create: revision_no numerik saat MAX(int8) kembali sebagai string", async () => {
  const store = fakeStore(null, "5");
  const repos = createRepositories(store, { append: async () => {} });
  await repos.executions.create({ taskId: "TSK-1", plan: { run: () => {} }, mode: "FRESH" });
  const insert = store.inserts.find((i) => i.table === "executions");
  assert.ok(insert, "create issues the INSERT");
  const revisionNo = insert.params.find((p) => p === 6);
  assert.equal(revisionNo, 6, '"5" + 1 harus 6 (number), bukan string "51"');
});
