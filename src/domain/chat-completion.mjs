// POC-10 T5 — penyelesaian giliran chat lewat polling `chat.history`.
//
// Gateway fork menjawab dispatch (metode `agent` bare, diukur 2026-09-11 di
// CHS-E6A3263B) dengan {"status":"accepted"} — bukan balasan. Teks jawaban
// tiba belakangan sebagai event stream, dan SATU-SATUNYA tempat ia tertulis
// utuh adalah transkrip sesi gateway, terbaca lewat `chat.history`.
//
// Kenapa polling, bukan langganan event (sessions.subscribe punya jalur itu):
// pola reconciler D72 — polling bertahan melewati restart controller dan
// putusnya socket, dua hal yang membuat langganan kehilangan frame TANPA
// ada yang kehilangan status. Volume chat POC (puluhan giliran, bukan ribuan)
// membuat biaya satu chat.history per giliran hidup per 2 dtk tidak terasa;
// skala lebih besar menuntut jalur event, dan itulah catatan keputusannya.

import { replyText } from "../runtime/gateway-ws.mjs";

/**
 * Ratakan konten pesan transkrip gateway menjadi teks. Bentuk yang diukur di
 * gateway fork: ARRAY BLOK mentah [{type:"text",text:"…"}] — bentuk yang
 * tidak ditangani replyText jalur dispatch ({content:[…]}); string polos dan
 * bentuk warisan tetap diterima.
 */
function blocksText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : null))
      .filter((s) => typeof s === "string" && s.length > 0)
      .join("\n");
  }
  return replyText(content) ?? "";
}

/**
 * Teks balasan dari satu pesan asisten transkrip gateway: gabung blok teks,
 * lalu lepaskan pembungkus <final> dan komentar HTML.
 *
 * <final> TIDAK diminta preamble chat (T4) — tapi agen ini lahir dari
 * workspace project yang memorinya memuat kebiasaan task, dan pada kenyataan
 * (CHS-E6A3263B) model membungkus jawabannya juga. Komentar HTML (mis.
 * penanda project yang disisipkan runtime fork) adalah metadata, bukan
 * kalimat untuk operator.
 */
export function extractReplyText(content) {
  const raw = blocksText(content);
  const finals = [...raw.matchAll(/<final>([\s\S]*?)<\/final>/g)];
  let text = finals.length > 0 ? finals[finals.length - 1][1] : raw;
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  return text.trim();
}

/**
 * Cari balasan giliran INI di transkrip: pesan user yang gateway catat dengan
 * idempotencyKey kita (diukur: kunci `CHM-…` dikirim, transkrip menyimpan
 * `CHM-…:user`), lalu pesan asisten PERTAMA sesudahnya. Asisten sebelum pesan
 * user adalah giliran sebelumnya — sesi chat dipakai ulang lintas giliran,
 * jadi posisi, bukan sekadar keberadaan, yang menentukan kepemilikan jawaban.
 *
 * @returns {object | null} pesan asisten, atau null bila giliran belum
 *   berbuah jawaban.
 */
export function findTurnReply(messages, brainMessageId) {
  if (!Array.isArray(messages)) return null;
  const keys = new Set([`${brainMessageId}:user`, brainMessageId]);
  const userIdx = messages.findIndex(
    (m) => m?.role === "user" && keys.has(String(m?.idempotencyKey ?? "")),
  );
  if (userIdx < 0) return null;
  for (let i = userIdx + 1; i < messages.length; i += 1) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    if ((extractReplyText(m.content) ?? "").length > 0) return m;
  }
  return null;
}

export function createChatCompletion({ repos, events, runtime, log, now = () => Date.now(), config = {} }) {
  const turnTimeoutMs = () => Number(config?.turnTimeoutMs ?? 600_000);

  /**
   * Satu baris in-flight. Urutannya sengaja: cek transkrip DULU, timeout
   * KEMUDIAN — giliran yang balasannya baru saja tiba pada detik ke-600
   * harusnya selesai, bukan digantung oleh jam.
   */
  async function completeOne(row) {
    if (row.status === "RUNNING" && row.gateway_session_ref) {
      let history = null;
      try {
        history = await runtime.request("chat.history", { sessionKey: row.gateway_session_ref }, { timeoutMs: 15_000 });
      } catch (err) {
        // Bukan kegagalan giliran: socket sesaat, gateway restart. Polling
        // berikutnya mencoba lagi; timeout tetap menjadi batu terakhir.
        log.warn("chat.completion-history-failed", {
          message: row.id,
          error: String(err?.message ?? err).slice(0, 200),
        });
      }
      const reply = findTurnReply(history?.messages, row.id);
      if (reply) {
        await repos.chatMessages.updateDelivery(row.id, { status: "DONE", content: extractReplyText(reply.content) });
        await repos.chatSessions.touch(row.session_id);
        await events.append({
          kind: "chat.message-completed",
          subjectType: "chat_session",
          subjectId: row.session_id,
          actor: "controller",
          payload: { messageId: row.id, gateway: row.gateway_session_ref },
        });
        return "done";
      }
    }

    const ageMs = now() - Number(row.created_at);
    if (ageMs >= turnTimeoutMs()) {
      // PENDING tanpa ref adalah giliran yang dispatch-nya tak pernah selesai
      // (controller mati di antara append dan deliver) — yatim yang sama
      // berhak atas vonis jujur dengan yang berjalan lama tanpa jawaban.
      await repos.chatMessages.updateDelivery(row.id, {
        status: "FAILED",
        error: `turn timed out after ${Math.round(ageMs / 1000)}s without a brain reply`,
      });
      await events.append({
        kind: "chat.message-timed-out",
        subjectType: "chat_session",
        subjectId: row.session_id,
        actor: "controller",
        payload: { messageId: row.id, ageMs, status: row.status },
      });
      return "failed";
    }
    return "waiting";
  }

  async function completeOnce() {
    const rows = await repos.chatMessages.listInFlight();
    const out = { done: 0, failed: 0, waiting: 0 };
    for (const row of rows) {
      const r = await completeOne(row).catch((err) => {
        log.error("chat.completion-row-failed", { message: row.id, error: String(err?.message ?? err).slice(0, 200) });
        return null;
      });
      if (r && out[r] !== undefined) out[r] += 1;
    }
    return out;
  }

  return { completeOnce };
}
