# POC-4 Evidence Log — Work Controller

- **Spec:** `outputs/semanggi-poc4-work-controller-development-spec.md`
- **Scope of this entry:** implementation phases 1–3 (§12.2), deliberately runtime-free
- **Repo:** `outputs/semanggi-work-controller/`
- **Status:** phases 1–3 SELESAI dan lulus 55 test tanpa cluster; fase 4+ menunggu verifikasi §11 butir 1 dan penutupan POC-3

## Mengapa fase 1–3 dijalankan paralel dengan POC-3

§12.2 memisahkan "admission pipeline (tanpa runtime; unit test dengan fake AgentOS)" dari "dispatcher AgentOS (integration pada stack lab)". Pemisahan itu yang dipakai: seluruh pekerjaan di bawah ini **tidak menyentuh cluster sama sekali**, repo-nya baru, dan tidak ada file yang beririsan dengan `semanggi-agent-platform` yang sedang dikerjakan untuk POC-3. Risiko tabrakan yang nyata (file stack yang sama, restart gateway, kuota model bersama, disk kub01-01) semuanya berada di fase 4+, dan fase itu belum disentuh.

## Hasil test

```
npm test → 101 tests, 101 pass, 0 fail (node --test, tanpa dependency, tanpa jaringan)
```

## Fase 4 (2026-08-19): rekonsiliasi, Slack, intent router

| Komponen | Berkas | Inti |
|---|---|---|
| Rekonsiliasi status | `src/runtime/reconciler.mjs` | Status terminal dipercaya langsung; status non-terminal hanya dipercaya setelah **diam tak berubah** selama `staleAfterMs`, dan hasilnya `BLOCKED` (bisa dipulihkan lewat revision), **bukan** `FAILED`. Dipicu perubahan `revision` pada `/api/snapshot`, bukan polling per task |
| Intent router (P4-12) | `src/interface/intent.mjs` | CHAT/WORK/TASK berbasis aturan; klasifikasi gagal → `CONFIRM`, tidak pernah aksi. Verb dua bahasa, parsing durasi (`30m`, `2 jam`) |
| Slack minimal | `src/interface/slack.mjs` | `task`/`status`/`pause`/`expedite`/`approve`/`reject`/`continue`/`review <TASK-ID>` + notifikasi ACTION REQUIRED untuk approval |

Aturan rekonsiliasi diturunkan langsung dari POC-2 E3/E7, yang menemukan record dispatch tetap `running` atau melaporkan `timeout` padahal pekerjaan sukses. Karena itu satu kali baca tidak dianggap bukti, dan status macet tidak pernah menghasilkan `FAILED`.

**Tiga bug tertangkap test fase ini:**

1. `TASK-ABCD` diklasifikasi sebagai perintah `task` — `\b` cocok tepat sebelum tanda hubung, sehingga sebuah task id akan **membuat task baru** alih-alih menampilkan status. Diperbaiki jadi `(\s|$)`.
2. `DISPATCHED → COMPLETE` ditolak state machine. Rekonsiliasi mengamati hasil, bukan setiap langkah: task pendek bisa selesai di antara dua polling dan `RUNNING` tidak pernah terlihat. Transisinya diizinkan, karena mengarang langkah yang hilang berarti mencatat sesuatu yang tidak terjadi.
3. Dispatch menimpa `session_ref` warisan (lihat retrofit di atas).

## Retrofit POC-2/POC-3 (2026-08-19)

Fase 1–3 ditulis di atas asumsi yang kemudian dibantah cluster. Empat perubahan, masing-masing berasal dari pengukuran nyata — rinciannya di `docs/decisions.md` D11/D12.

| Temuan | Perubahan di controller |
|---|---|
| E8: 8 token input segar vs **92.663 cache-read** | Kolom `tokens_cache_read`/`tokens_cache_creation`; `billableTokens()` menyertakannya; `recordUsage()` menormalkan dua bentuk usage (batch JSON dan ACP `usage_update`) |
| E3–E6: `sessions_spawn resumeSessionId` mustahil | `session_ref` = id sesi harness; CONTINUE/FORK mewarisi, FRESH mengambil sesi baru; dispatch **tidak lagi menimpa** ref warisan |
| E8: 429 membawa `resetsAt` absolut + `rateLimitType` | `applyQuotaSignal()` → `QUOTA_EXHAUSTED` + ETA nyata; kegagalan dispatch berkuota parkir di `WAIT_QUOTA`, bukan `WAIT_RUNTIME` |
| Permission bridge menahan tool call di tengah turn | `RUNNING → WAIT_HUMAN` kini legal; APPROVE mengembalikan ke `RUNNING`, REJECT ke `BLOCKED` |
| §11: `POST /api/mission` 403 dari origin non-loopback | Adapter AgentOS memakai **loopback forwarder** + login sesi + cookie; pola yang sama dengan POC-1 |

Dua bug tertangkap oleh test retrofit, keduanya nyata dan bukan salah test:

1. Dispatch menimpa `session_ref` warisan dengan nilai dari runtime — persis mekanisme yang membuat resume palsu lolos di POC-3. Diperbaiki: ref warisan menang.
2. `RUNNING → WAIT_HUMAN` ditolak state machine, sehingga approval mid-turn tidak pernah bisa memarkir task. Sebelumnya errornya ditelan `try/catch` — itu dihapus, karena gerbang yang gagal diam-diam adalah gerbang yang tidak ada.

Satu test lain gagal karena trigger immutability menolak penulisan ke eksekusi yang sudah final. Itu schema bekerja sesuai rancangan; test-nya yang diperbaiki.

| Berkas | Fokus | Test |
|---|---|---|
| `state-machine.test.mjs` | P4-01, P4-10 (sisi kontrol plane) | 8 |
| `eventlog.test.mjs` | P4-01 append-only, P4-13 redaksi | 5 |
| `admission.test.mjs` | P4-02 sembilan blocker, P4-03 | 15 |
| `fairness.test.mjs` | P4-04, P4-05 | 7 |
| `lease-quota.test.mjs` | P4-06, P4-07, P4-11 | 8 |
| `api.test.mjs` | §7.1, P4-13 | 7 |
| `routing-config.test.mjs` | policy contoh benar-benar valid | 5 |

## Matriks acceptance (§10) — status jujur

| ID | Status | Bukti / alasan |
|---|---|---|
| P4-01 state machine | **PASS (unit + live)** | Transisi §5.1 + WAIT_* POC-4; kosakata lama (`pending/running/done`) ditolak; revision membuat Execution baru dan yang lama beku; EventLog append-only ditegakkan **trigger database**, bukan konvensi — UPDATE/DELETE gagal walau dicoba langsung lewat SQL |
| P4-02 admission pipeline | **PASS (unit + live)** | Sembilan blocker menghasilkan sembilan WAIT_* berbeda dengan `wait_reason` yang bisa dibaca operator; satu test memastikan tidak ada jalur admission mana pun yang menghasilkan FAILED | **Live:** WAIT_RESOURCE teramati pada cluster saat tidak ada agen untuk model yang dirutekan, dengan alasan terbaca operator
| P4-03 no silent downgrade | **PASS (unit + live)** | Task L5 architecture dengan `fallback: none`, kedua model resmi quota-exhausted → WAIT_QUOTA + ETA = waktu reset sebenarnya; `gemini-flash` yang tersedia dan murah TIDAK pernah dipilih. Test terpisah membuktikan perpindahan ke model preferensi kedua **di dalam** policy tetap boleh | **Akuntansi (D17):** usage nyata tercatat live — `in 8631 / out 60 / cacheRead 1664 → billable 10355`, cost USD untuk provider metered. Gemini melaporkan nol dan sengaja tidak dicatat agar tidak terbaca 'gratis'
| P4-04 weighted fairness | **PASS (unit)** | WFQ virtual finish time: bobot 5/3/1 → 5/3/1 slot per ronde; project bobot 1 selalu dapat giliran; counter diambil dari tabel executions sehingga selamat restart |
| P4-05 expedite | **PASS (unit)** | Boost TTL mengubah urutan lalu kembali sendiri tanpa job pembersih; `priority` tersimpan tidak pernah ditulis ulang |
| P4-06 quota reset | **PASS (unit)** | Jendela 5 jam ditutup → pass scheduler sendiri yang membalik availability dan men-dispatch; tanpa intervensi operator |
| P4-07 lease exclusivity | **PASS (unit)** | Dua task satu path → satu DISPATCHED satu WAIT_WORKSPACE; lease kedaluwarsa direklaim dan pemilik lama ditandai BLOCKED; heartbeat menahan lease |
| P4-08 approval L3 | **PASS (live)** | Kontrak interposer terimplementasi dan teruji: `POST /api/work/approvals` memetakan id sesi harness → task, memarkir `WAIT_HUMAN`, APPROVE → `RUNNING`, REJECT → `BLOCKED`, sesi tak dikenal ditolak 400. Gap Bash (warisan POC-3) **ditutup** di gateway `2026081906`: perintah shell kini tiba sebagai `kind:"execute"` → L3, ditahan, diputus operator bernama, REJECT dihormati. Ketiga kasus `permission-bridge-verify.sh` PASS pada cluster |
| P4-09 dispatch contract | **PASS (live)** | Jalur AgentOS HTTP tertutup (403 `unsafe-forwarded-client`, D12). Jalur Gateway WS: handshake protokol 4, method dinegosiasi **`agent`**, device ter-pair memberi `scopes:["operator.read","operator.write"]`. Tiga dispatch nyata selesai — log gateway: `D13-OK` / `[agent] run D13-LIVE-1787304777268#1 ended with stopReason=stop`, provider=zai model=glm-4.7 status=200. Bentuk param diukur langsung ke gateway pin, bukan disalin dari source yang lebih baru: `cwd`/`workspaceDir` ditolak, override provider/model tidak diizinkan pada `operator.write` (D14) |
| P4-14 stack contract | **PASS (live)** | Service `semanggi-controller` berjalan 1/1 di stack (`semanggi/work-controller:2026082103`), replica 1, stop-first, tanpa port publish, secret eksternal, mount source==target. DB SQLite hidup di `/opt/semanggi/volumes/shared/service/semanggios/controller/controller.db` — path itu NFS `10.10.0.1:/opt/semanggi/volumes/shared/service` (nfs4) di ketiga node; berkas `-wal`/`-shm` terbentuk normal |
| P4-10 CONTINUE/FORK/FRESH | **PASS (live)** | Lima revisi pada satu task, semuanya mencapai COMPLETE sendiri lewat `sessions.subscribe`. FRESH rev1 → sesi `5fac2dcc…`; CONTINUE rev2 dan rev3 **tetap** di `5fac2dcc…`; FORK rev4 → `fde7eeb8…`; FRESH rev5 → `58fe0666…`. Catatan jujur: FORK memulai percakapan **kosong**, bukan salinan induknya — pada versi gateway ini percakapan hanya dialamati lewat `sessionKey` dan tidak ada API untuk mengkloning sesi (D15) |
| P4-11 controller failure | **PASS (live)** | Controller di-update dan **berpindah node kub01-02 → kub01-02**; seluruh state selamat: 2 project, 3 task dengan status masing-masing terbaca utuh setelah restart. Idempotensi dispatch ditegakkan gateway (`idempotencyKey` sama → `runId` identik, `status:"in_flight"`) | **D20:** watchdog dispatch melepas eksekusi yang diam (→ BLOCKED + lease dilepas) dan lease yatim; terbukti di cluster
| P4-11 controller failure | **PASS (unit + live)** | Watchdog berulang tidak menduplikasi dispatch; scheduler baru di atas store yang sama tidak men-dispatch ulang; rekonsiliasi tidak mengubah apa pun saat status tak terbaca. **Live:** kirim ulang `idempotencyKey` yang sama ke gateway mengembalikan `runId` identik dengan `status:"in_flight"` (bukan `"accepted"`) — jaminan ini ditegakkan gateway, bukan hanya oleh controller |
| P4-12 intent minimal | **PASS (unit)** | CHAT/WORK/TASK + ekstraksi task id dan durasi; pesan tak terklasifikasi menghasilkan pertanyaan berisi contoh perintah, bukan aksi; verb tanpa task id juga bertanya |
| P4-13 secret hygiene | **PASS (unit)** | Payload EventLog diredaksi sebelum disimpan; response dibangun field-per-field sehingga kolom baru tidak bisa bocor; tujuh endpoint diperiksa tidak memuat nama field bergaya kredensial maupun token controller |


## Keputusan yang diambil karena spec membiarkannya terbuka

Tercatat lengkap dengan alasannya di `docs/decisions.md`. Yang paling berkonsekuensi:

- **D1 SQLite dulu, portabel ke Postgres sejak awal.** Controller `replicas: 1` = satu penulis, jadi alasan utama memakai Postgres tidak berlaku; menambah service Postgres berarti menambah service + volume NFS + secret di cluster yang disk manager-nya tinggal 5.6 GB saat POC-3. Portabilitas dibayar di muka: interface store **async** meski driver SQLite sinkron, placeholder positional di satu adapter. Konsekuensinya controller punya **nol dependency runtime**. Catatan: `node:sqlite` masih experimental di Node 22 (stabil di 24, yang sudah dipakai image gateway).
- **D2 sembilan waiting state, bukan tiga.** Spec induk menyebut tiga; P4-02 menuntut sembilan blocker bisa dibedakan. Invarian yang sama-sama dipegang kedua spec — gagal admission = WAIT_*, bukan FAILED — ditegakkan di tabel transisi: tidak ada edge dari QUEUED/WAIT_* ke FAILED.
- **D6 lease di-peek di langkah 3, diambil di langkah 9.** Kalau lease diambil di langkah 3 sesuai urutan harfiah, task akan menahan workspace sambil menunggu kuota lima langkah kemudian dan memblokir task lain tanpa manfaat.
- **D8 kontrak dispatch AgentOS sengaja tidak diimplementasikan.** Ini beda antara "belum dibuat" dan "dibuat salah lalu lulus test terhadap karangan sendiri".

## Gap yang diwarisi dari POC-3 (bukan pekerjaan repo ini)

1. ~~**Bridge approval untuk task ACP (P4-08).**~~ **Selesai.** Sinyalnya kini ada: dengan `permissions.ask:["Bash"]` di `settings.json` harness, penolakan tidak lagi diserap di dalam harness — request naik ke interposer dan controller yang memegang statusnya. *Catatan asli:* Bukti E1 POC-3: dengan `permissionMode=approve-reads` + `nonInteractivePermissions=deny`, penolakan permission diserap di dalam harness — Claude berhenti sopan dan **tidak ada WAITING_HUMAN yang naik ke kontrol plane**. Controller sudah siap menerima sinyal itu; sinyalnya yang belum ada. Subjek POC-3 E3/E4.
2. **Rekonsiliasi status (kandidat untuk fase 4).** POC-2 E3/E7 menemukan record dispatch AgentOS yang tetap `running` atau melaporkan `timeout` padahal pekerjaan sukses. Dispatcher POC-4 karena itu tidak boleh mempercayai satu kali polling.
3. **Angka biaya `claude-code` (P4-03/§4).** Resource class-nya sudah ada dan ditegakkan (`claude-code` hanya boleh lewat jalur ACP/batch — dicek di runtime maupun di test config). Angkanya dari POC-3 E8. Catatan desain: limit paket Pro sebenarnya jendela pemakaian bergulir, bukan hitungan concurrency — pemodelannya perlu ditinjau ulang begitu E8 selesai.

## Yang dibutuhkan untuk memulai fase 4

1. Verifikasi §11 butir 1–3 dan 5–6 terhadap AgentOS 0.7.6 (read-only, tidak mengubah state cluster).
2. POC-3 tutup, atau window akses cluster eksklusif — fase 4 menambah service ke `stack/semanggi-stack.yml`, file yang sama yang dipakai POC-3.
3. Keputusan operator soal storage bila SQLite dianggap tidak memadai untuk lab jangka panjang.

## Catatan integritas

- Seluruh angka test di atas adalah keluaran `npm test` yang benar-benar dijalankan, bukan estimasi.
- Tidak ada test yang di-skip untuk menutupi kegagalan; butir yang belum dikerjakan ditandai NOT STARTED/BLOCKED, bukan PASS.
