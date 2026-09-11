// POC-10 T3 — pengiriman pesan chat: transkrip → injeksi konteks (T4) →
// resolusi sandbox (T2) → dispatch → balasan. SATU-SATUNYA penulis armada
// `sem-chat-*` di sisi pesan, dan TIDAK PERNAH menyentuh tasks/executions.
//
// Bentuk pengiriman: async + polling (rekomendasi §8). POST menulis dua baris
// transkrip — operator (DONE) dan brain (PENDING, kosong) — lalu menjalankan
// pekerjaan di latar dan menjawab segera. UI memungut hasilnya dengan GET
// sesi; kolom status pesan brain adalah kontrak polling-nya.

import { buildChatContext } from "./chat-context.mjs";

/** Kunci sesi gateway untuk sesi chat baru — belum pernah dispatch. */
function freshSessionKey(sessionId, nowMs) {
  // Sufiks waktu: dua sesi TIDAK mungkin berbagi kunci karena kunci memuat id
  // sesi; sufiks hanya memutus tabrakan dengan kunci lama setelah ganti Brain
  // (confirmReset melepas ref; kunci baru TIDAK boleh sama dengan kunci pra-
  // reset — itulah reset context-nya, §10.2).
  return `chat:${sessionId}:${nowMs}`;
}

export function createChatDispatch({ repos, events, chatSandbox, runtime, brainFor, log, now = () => Date.now() }) {
  if (typeof brainFor !== "function") throw new Error("chat-dispatch requires brainFor(session)");

  /**
   * Satu giliran percakapan. SELALU menulis kedua baris transkrip dan
   * mengembalikan keduanya — kegagalan provisioning/dispatch TIDAK pernah
   * throw ke pemanggil HTTP; ia menjadi baris brain FAILED dengan alasan.
   * (Janji D80/D81 versi HTTP: 500 hanya untuk bug, bukan untuk jawaban.)
   */
  async function sendMessage({ session, text, attachments = null, actor = "operator" }) {
    const operatorMessage = await repos.chatMessages.append({
      sessionId: session.id,
      role: "operator",
      content: String(text ?? ""),
      attachments,
      actor,
    });
    const brainMessage = await repos.chatMessages.append({
      sessionId: session.id,
      role: "brain",
      content: "",
      // Pesan brain lahir PENDING: baris inilah yang di-poll UI, jadi ia
      // harus ada SEBELUM pekerjaan mulai, bukan sesudah balasan tiba.
      status: "PENDING",
    });

    // Latar, bukan await: pemanggil menjawab 200 dengan pasangan transkrip
    // sekarang; puluhan detik latensi Brain tidak boleh menahan koneksi HTTP
    // (§8 — masalah yang sama dengan alasan D74 memberi /doc seksi live).
    void deliver({ session, text: String(text ?? ""), attachments, brainMessageId: brainMessage.id, actor }).catch(
      (err) => {
        log.error("chat.dispatch-unexpected", { session: session.id, error: String(err?.message ?? err).slice(0, 200) });
      },
    );

    return { operatorMessage, brainMessage };
  }

  async function deliver({ session, text, attachments, brainMessageId, actor }) {
    const mark = (status, extra = {}) =>
      repos.chatMessages.updateDelivery(brainMessageId, { status, ...extra }).catch(() => {});

    try {
      // T4 dulu: blok konteks menempel pada PESAN INI, bukan pada sesi —
      // pertanyaan berikutnya boleh sama sekali topik lain.
      const project = await repos.projects.get(session.project_id);
      const brain = await brainFor(session);
      if (!project || !brain) {
        await mark("FAILED", { error: `session refers to missing ${!project ? "project" : "brain"}` });
        return;
      }

      const { block } = await buildChatContext({ repos, events, text, project });
      let message = block ? `${block}\n\n---\n\n${text}` : text;
      if (Array.isArray(attachments) && attachments.length > 0) {
        // Lampiran sudah ada di workspace (T3 uploads); path relatif cukup —
        // agen membacanya dengan tool bawaan (§7.1, revisi putaran 1).
        message += `\n\n[attachments: ${attachments.join(", ")}]`;
      }

      const resolved = await chatSandbox.resolveChatSandbox({ project, brain, actor, reason: "message" });
      if (!resolved.ok) {
        await mark("FAILED", { error: `sandbox:${resolved.why}${resolved.error ? ` — ${resolved.error}` : ""}` });
        return;
      }

      await mark("RUNNING");
      const fresh = session.gateway_session_ref ?? freshSessionKey(session.id, now());
      const result = await runtime.dispatchChat({
        agentId: resolved.agentId,
        message,
        sessionKey: fresh,
        idempotencyKey: brainMessageId,
        label: session.id,
      });

      // Kunci pertama diingat SEKALI; ganti Brain melepasnya (switchBrain),
      // dan dispatch berikutnya menyabit kunci baru = context kosong.
      if (!session.gateway_session_ref && result.sessionRef) {
        await repos.chatSessions.setGatewayRef(session.id, result.sessionRef);
      } else {
        await repos.chatSessions.touch(session.id);
      }

      // Gateway fork (metode `agent` bare) menjawab dispatch dengan
      // {"status":"accepted"} saja — balasan tiba belakangan sebagai event
      // dan hanya utuh di transkrip gateway; poller chat-completion yang
      // menyegel giliran dari chat.history (diukur di CHS-E6A3263B: baris
      // DONE berisi kosong karena jawaban tidak pernah ada di frame res).
      // Gateway yang mengembalikan run sekaligus (agent.run keluarga 2026.8)
      // tetap selesai di sini — dua bentuk gateway, satu jalur kode.
      if (result.reply) {
        await mark("DONE", { content: result.reply });
      }
    } catch (err) {
      // Termasuk penolakan kuota/gateway apa pun: chat tidak punya state
      // machine parkir (§5) — FAILED dengan teks yang bisa dibaca operator.
      await mark("FAILED", { error: String(err?.message ?? err).slice(0, 400) });
    }
  }

  return { sendMessage };
}
