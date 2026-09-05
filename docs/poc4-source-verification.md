# POC-4 §11 Source Verification

**Dijalankan:** 2026-08-19, read-only terhadap cluster berjalan (AgentOS `0.7.6` image `2026081805`, OpenClaw `2026.6.11` gateway `2026081903`).
**Aturan:** POC-1 §17 — butir yang tidak terverifikasi ditandai blocked dengan menyebut sumbernya; tidak ada konfigurasi spekulatif.
**Butir 4** (`requires_approval`) sengaja tidak dikerjakan di sini: itu kelanjutan POC-3 E3/E4 yang sedang dipegang Kilo Code.

Semua hasil di bawah berasal dari probe nyata terhadap service yang hidup, bukan pembacaan dokumentasi.

---

## Butir 1 — API AgentOS untuk membuat assignment/work item — **VERIFIED, dengan syarat**

### Kontrak dispatch

```http
POST /api/mission
{"mission": "<teks misi>", "workspaceId": "<id>"}
→ {"dispatchId": "dispatch-<uuid>", ...}
```

Workspace dibuat lebih dulu lewat `POST /api/workspaces` (`sourceMode: "existing"`, `existingPath` di bawah root kanonik, plus definisi `agents[]` berisi `modelId`, `policy`, `sandbox`). Keduanya sudah terbukti dipakai POC-2 (`tests/poc2-run.sh`).

### Autentikasi: tiga lapis, dan satu di antaranya menghalangi controller

Instance protection aktif. Probe langsung dari service lain:

| Percobaan | Hasil |
|---|---|
| `POST /api/mission` + Bearer token saja | **401** `instance-auth-required` |
| `POST /api/mission` tanpa auth | **401** `instance-auth-required` |
| `GET /api/health` | 200 (satu-satunya endpoint terbuka) |

Jadi token API **tidak cukup**. Harus login sesi lebih dulu:

```http
POST /api/auth/login  {"username","password"}   → Set-Cookie: agentos_instance_session=…
```

Setelah itu setiap request membawa cookie + `Authorization: Bearer <agentos_api_token>` + `x-agentos-api-token`.

### Temuan yang menentukan desain: GET boleh lintas-service, POST tidak

Diuji dengan cookie sesi valid, tanpa header `Origin`, host `agentos:3000` (persis posisi controller):

| Endpoint | Metode | Hasil |
|---|---|---|
| `/api/operations` | GET | **200** |
| `/api/snapshot` | GET | **200** |
| `/api/models/providers` | GET | **200** |
| `/api/runtime/capabilities` | GET | **200** |
| `/api/mission` | POST | **403** `Unsafe remote mutation blocked. Use same-origin localhost or configure an exact HTTPS origin with AGENTOS_TRUSTED_OPERATOR_ORIGINS` |

Dari bundle AgentOS: `GET/HEAD/OPTIONS` dibebaskan dari origin guard, sedangkan metode tulis harus memenuhi salah satu dari:

1. same-origin **localhost**, atau
2. origin persis yang terdaftar di `AGENTOS_TRUSTED_OPERATOR_ORIGINS` — dan pesan errornya menyebut **HTTPS**, plus guard tambahan mencocokkan `observedHosts` dengan host origin. Ada juga penolakan terpisah: *"Forwarded non-local clients cannot use AgentOS write APIs"*, jadi kehadiran `X-Forwarded-For` pun memblokir tulis.

### Konsekuensi untuk controller

Controller **tidak bisa** memanggil `/api/mission` langsung dari `http://agentos:3000`. Dua jalan:

| Opsi | Biaya | Penilaian |
|---|---|---|
| **(a) Loopback forwarder di dalam container controller** — TCP `127.0.0.1:3000 → agentos:3000`, lalu bicara ke `http://127.0.0.1:3000` dengan origin loopback | ~40 baris, tanpa TLS, tanpa perubahan AgentOS | **Direkomendasikan.** Pola ini sudah terbukti di stack yang sama: `images/agentos/loopback-proxy.mjs` melakukan persis ini untuk AgentOS→Gateway, karena alasan yang sejenis (device-scope auth hanya aktif pada URL loopback) |
| (b) TLS + `AGENTOS_TRUSTED_OPERATOR_ORIGINS` | sertifikat, exact host match, `X-Forwarded-For` harus bersih | Lebih banyak bagian bergerak untuk trafik yang tidak pernah keluar overlay |

Opsi (a) diadopsi. Ini juga menjawab pertanyaan desain yang lebih besar: loopback proxy bukan artefak sementara POC-1, melainkan pola yang berulang setiap kali sebuah service perlu memakai surface AgentOS yang di-gate oleh origin.

---

## Butir 2 — Subscribe event vs polling — **VERIFIED (dengan satu gap nyata)**

`GET /api/stream` adalah **SSE sungguhan** (`content-type: text/event-stream`), dan **dapat diakses lintas-service** (GET tidak kena origin guard). Byte pertama dari probe:

```
event: ready
data: {"ok":true,"eventBridge":{"mode":"live","connected":true,"reconnecting":false,
       "reconnectAttempt":0,"lastEventAt":"2026-08-19T06:10:36.407Z","lastError":null}}

event: system-status
data: {"gatewayReachable":true,"gatewayReady":true,...,"modelStatus":{...}}
```

Ada juga `GET /api/tasks/[taskId]/stream` untuk aliran per-task, serta `POST /api/tasks/[taskId]/control` dan `/abort`.

### Gap: tidak ada API untuk membaca status satu dispatch

Record dispatch hanya hidup sebagai berkas JSON:

```
/agentos/.mission-control/dispatches/dispatch-<uuid>.json
  → symlink ke /opt/semanggi/volumes/shared/service/semanggios/agentos/runtime/mission-control  (NFS, fix POC-2 E6)
```

Skema record (dibaca dari berkas nyata):

```
id, clientRequestId, status, agentId, sessionId, mission, routedMission, thinking,
requestedModelId, workspaceId, workspacePath, submittedAt, updatedAt,
outputDir, outputDirRelative, notesDirRelative, runner, observation, result, error
```

`status` yang teramati: `completed`, `stalled`, `running`, `cancelled`; `result.status` terpisah (mis. `ok`). Bundle AgentOS juga memuat penanda `dispatch-derived` dan `dispatch-stalled`.

**Rekomendasi controller:** langganan SSE `/api/stream` sebagai pemicu, `GET /api/snapshot` (punya `revision`, cocok untuk deteksi perubahan) sebagai rekonsiliasi berkala, dan **jangan** membaca berkas `mission-control` dari NFS — itu state privat AgentOS dan menembus batas yang dijaga spec. Bila korelasi `dispatchId` ternyata tidak tersedia lewat SSE, itu jadi permintaan endpoint ke hulu AgentOS, bukan alasan membaca berkas orang lain.

**Peringatan operasional:** `GET /api/tasks/health` **timeout dua kali** dari dua probe berbeda, sementara endpoint lain merespons cepat. Jangan taruh endpoint itu di jalur kritis dispatcher tanpa timeout ketat.

Rate limiting: AgentOS memuat deteksi `rate limit reached`, `too many requests`, `HTTP 429`, dan `retry after` — jadi sinyal kuota hulu memang disurface, bukan ditelan.

---

## Butir 3 — Konfigurasi model/provider OpenClaw via API — **VERIFIED, DIREVISI 2026-08-21**

Sisi AgentOS: `GET /api/models/providers` berfungsi lintas-service (200), mengembalikan mis. `{"providers":[{"id":"zai","baseUrl":"https://api.z.ai/api/coding/paas/v4","modelCount":0}]}`. Tersedia juga `/api/models/catalog`, `/api/onboarding/models`, `/api/sessions/model`.

Sisi gateway OpenClaw, RPC config lengkap tersedia: `config.get`, `config.set`, `config.patch`, `config.apply`, `config.schema`, `config.resolve`, `config.snapshot(.read/.read.env/.read.file/.read.hash)`, `config.observe`, `config.normalize`.

**Catatan desain penting:** `modelCount: 0` pada provider `zai` sementara model tetap berjalan menunjukkan katalog AgentOS tidak selalu mencerminkan model yang benar-benar bisa dipakai. Controller karena itu **tidak boleh** memakai `/api/models/providers` sebagai sumber kebenaran kelayakan model. Model policy tetap dipegang controller (`routing.json`), dan ketersediaan diputuskan dari tabel `resources` miliknya sendiri — persis seperti yang sudah diimplementasikan.

**Koreksi (D14).** Kesimpulan semula — *"model per-task diteruskan lewat `requestedModelId` pada record dispatch, jadi kanalnya ada"* — hanya berlaku untuk jalur tulis AgentOS, dan jalur itu ditutup oleh D12. Pada transport yang benar-benar dipakai (Gateway WS), model per-dispatch **ditolak**:

```
agent {provider:"zai", model:"glm-4.7", ...}
  → INVALID_REQUEST "provider/model overrides are not authorized for this caller."
```

Gerbangnya otorisasi, bukan skema: `canClientUseModelOverride()` menuntut `operator.admin`, dan cek itu masih ada di 2026.8.1 — jadi upgrade tidak menyelesaikannya. `config.set` memang tersedia, tetapi mengubah model sebuah agen lewat config untuk setiap task adalah mutasi global yang membalapi dispatch lain; itu bukan kanal per-task.

Kanal yang benar karena itu **pemilihan agen**, bukan override model: satu agen per (workspace, model), dan routing memilih agen yang model terkonfigurasinya cocok. Diimplementasikan di `src/runtime/agent-registry.mjs`; bila tidak ada agen yang cocok, dispatch **ditolak** dan task parkir di `WAIT_RESOURCE` alih-alih diam-diam berjalan di model lain (P4-03). Provisioning agen butuh `operator.admin`, jadi ia berada di `scripts/provision-agents.mjs` — tindakan operator, bukan perilaku runtime controller.

---

## Butir 5 — Format konfigurasi quota + parsing 429 — **VERIFIED**

Dari dist OpenClaw: `retry-after`, `retryAfter`, `resetsAt`, `rateLimitType`, `five_hour`.

Ini cocok dengan yang teramati langsung pada POC-3 E0/E1 — stream Claude Code memuat:

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1787113200,
  "rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false}}
```

Jadi jendela kuota tersedia sebagai **epoch absolut** (`resetsAt`), bukan durasi relatif. Ini langsung dapat dipetakan ke kolom `resources.next_available_at` milik controller, dan `WAIT_QUOTA` bisa melaporkan ETA yang sungguhan alih-alih tebakan. Implementasi `releaseExpiredQuota()` di `src/scheduler/scheduler.mjs` sudah berbentuk demikian.

Untuk provider HTTP biasa, header `retry-after` adalah sumber yang setara.

---

## Butir 6 — Kontrak `subagents.*` dan `tools.sessions.visibility` — **VERIFIED**

Nilai runtime saat verifikasi:

```json
{"subagents": {"maxSpawnDepth": 2}, "tools": {"sessions": {"visibility": "tree"}}}
```

Kunci yang dikenali dist: `maxSpawnDepth`, `allowAgents`. Keduanya sudah dibuktikan berlaku di POC-2 (guard preflight) dan dipakai lagi di POC-3 (`sessions_spawn` menghormati `allowAgents` lewat `acp.allowedAgents`).

Untuk enforcement worker policy, `Worker.subagent_policy` di controller memetakan ke `agents.list[].subagents.allowAgents` + `maxSpawnDepth`. Batasannya: keduanya adalah config gateway, bukan parameter per-dispatch — jadi perubahan policy worker berarti perubahan config + restart gateway, **bukan** sesuatu yang bisa diubah per task. Ini membatasi desain: `subagent_policy` bersifat semi-statis per worker, dan itu harus tercermin di dokumentasi controller.

---

## Butir 4 — `requires_approval` / approval dispatch — **VERIFIED 2026-08-21**

Semula dilewati karena menjadi bagian POC-3 E3/E4. Keduanya kini selesai, dan hasilnya mengubah bentuk jawabannya: approval **tidak** berjalan lewat mekanisme `requires_approval` AgentOS sama sekali.

Alasannya empiris. Pada baseline `permissionMode=approve-reads` + `nonInteractivePermissions=deny`, penolakan izin **diserap di dalam harness** — Claude berhenti sopan dan tidak ada `WAITING_HUMAN` yang pernah naik ke kontrol plane. Tidak ada sinyal untuk disambungkan ke API mana pun.

Yang dipakai: interposer pada jalur stdio ACP (`acp-permission-interposer.mjs`), yang menahan `session/request_permission`, mengklasifikasi L0–L3, dan meneruskannya ke controller (`POST /api/work/approvals`). Diverifikasi hidup pada cluster:

| Kasus | Hasil |
|---|---|
| L1 tulis di dalam workspace | Auto-approve; klien tidak pernah melihat request; berkas tertulis |
| L3 (`kubectl version --client`) + APPROVE | Ditahan, diangkat dengan tool/sesi/waktu, diputus operator bernama, lanjut |
| L3 + REJECT | Penolakan sampai ke agen; tool `failed`; sesi berakhir tanpa aksi |

Batas yang harus diingat: gerbang hanya menilai apa yang **diminta** harness. `Bash` baru meminta izin setelah `settings.json` di `$HOME` harness memuat `permissions.ask:["Bash"]` (gateway `2026081906`). Tool yang tidak pernah meminta izin tetap tidak tergerbang — ini properti Claude Code, bukan interposer.

---

## Ringkasan status

| Butir | Status | Konsekuensi utama |
|---|---|---|
| 1 API assignment | VERIFIED | Jalur tulis AgentOS tertutup untuk klien non-loopback (D12). Keputusan: **tidak** memakai loopback forwarder, melainkan Gateway WS + device pairing (D13). AgentOS tetap dipakai untuk baca |
| 2 Event subscribe | VERIFIED + gap | SSE tersedia; **tidak ada API baca status per-dispatch** — jangan baca berkas NFS AgentOS |
| 3 Config model | VERIFIED (direvisi) | Katalog AgentOS bukan sumber kebenaran kelayakan; policy tetap di controller. **Model per-task tidak bisa dioper lewat dispatch** (butuh `operator.admin`, D14) — kanalnya adalah pemilihan agen per model |
| 4 `requires_approval` | **VERIFIED** | POC-3 E3/E4 selesai. Approval tidak lewat `requires_approval` AgentOS melainkan interposer ACP: request ditahan di jalur stdio, diangkat ke controller, diputus operator bernama. Gerbang `Bash` ditutup di gateway `2026081906` |
| 5 Quota/429 | VERIFIED | `resetsAt` epoch absolut → langsung ke `next_available_at` |
| 6 subagents/visibility | VERIFIED | `subagent_policy` semi-statis per worker, bukan per task |

Tidak ada butir yang berstatus blocked. Fase 4 dapat dimulai dengan kontrak yang terverifikasi.
