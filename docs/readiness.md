# Kesiapan menuju tahap berikutnya

Ditinjau 2026-08-21; **diperbarui 2026-09-04** setelah migrasi state ke root `semanggios`, repair gateway, dan deploy `2026090401`. Aturan penilaian tidak berubah: sesuatu disebut siap kalau **terbukti hidup di cluster**, bukan kalau kodenya ada dan tesnya hijau. Unit test membuktikan logika, bukan kontrak dengan sistem lain. Sebagian besar temuan POC-3 dan POC-4 justru berupa selisih antara dokumen dan versi yang terpasang.

**Keadaan saat ini:** `semanggi/agentos:2026090601`, `semanggi/work-controller:2026090405`, `semanggi/openclaw-gateway:2026083001`; klaster secara kontrak hanya melibatkan dua node — `kub01-01`/`kub01-02` berlabel `type=app` (semua placement `node.labels.type == app`), node lain tidak dilibatkan; 436 test controller lulus semua. Pembaruan terakhir 2026-09-06: whitelist proxy PUT docs + modal dokumen Command Center (D56) + copy-to-clipboard task-id/markdown dan Cancel modal, terbukti hidup di `agentos-src` tanpa rebuild image.

## Yang terbukti hidup

| Kemampuan | Bukti |
|---|---|
| Controller sebagai service | `semanggi_semanggi-controller` 1/1, image `2026082103`, replica 1, stop-first, tanpa port publish |
| SQLite di NFS | DB pada `/opt/.../controller/controller.db`; path itu mount `10.10.0.1:/opt/semanggi/volumes/shared/service` (nfs4) di ketiga node. `-wal`/`-shm` terbentuk normal, tanpa gejala locking |
| Durabilitas restart (P4-11) | Update image memindahkan task **kub01-02 → kub01-02**; 2 project + 3 task beserta statusnya terbaca utuh sesudahnya |
| Task nyata dari API ke model | Task dibuat lewat `POST /api/work/tasks` → dirutekan → dicocokkan ke agen → dispatch → `P410-FRESH-OK`, `stopReason=stop`, provider=zai **model=glm-5.1** status=200 |
| Otorisasi controller | Device ter-pair dengan `["operator.admin","operator.read","operator.write"]` |
| Anti-downgrade (P4-03) | Task dengan model tanpa agen parkir di `WAIT_RESOURCE` beserta alasannya, bukan jalan diam-diam di model lain |
| Brain dari halaman Settings benar-benar dirutekan (D42) | Sebelumnya nama Brain ter-slug (`glm-5-2-max`) tak pernah cocok dengan kunci katalog `routing.json` (`glm-5.2-max`) → `unmapped model names` → `WAIT_RESOURCE`. Kini admission menyelesaikan nama dari tabel `brains`. Probe admission terhadap DB hidup: **keenam role SDMK Kader** (architect/analyst/builder/tester/reviewer/learner) rute ke model yang persis dibawa agennya. Image `2026090301`, 4 tes regresi |
| Idempotensi dispatch | `idempotencyKey` sama → `runId` identik, `status:"in_flight"`. Ditegakkan **gateway**, bukan hanya controller |
| Gerbang izin L0–L3 termasuk `Bash` | 3 kasus `permission-bridge-verify.sh` PASS; `kubectl version --client` tiba sebagai `kind:"execute"` → L3, ditahan, diputus operator bernama |
| Kontrak stack | `tests/stack-schema.sh` PASS termasuk asersi service controller |
| Kebersihan secret | `Secrets audit: clean. plaintext=0, unresolved=0` (dijalankan sebagai uid pemilik proses) |
| Penyelesaian otomatis (D15) | `sessions.subscribe` terpasang; task mencapai COMPLETE sendiri — `[session-events] run TASK-41497D65#1 -> COMPLETE` |
| Sesi CONTINUE/FORK/FRESH (P4-10) | Lima revisi: FRESH `5fac2dcc…`, CONTINUE rev2+rev3 tetap `5fac2dcc…`, FORK `fde7eeb8…`, FRESH `58fe0666…` |
| Groq dan Gemini | `PROBE-GROQ-OK` dan `PROBE-GEMINI-OK`, keduanya `stopReason=stop` |
| Akuntansi token (D17/D19) | zai: `in 8631 / out 60 / cacheRead 1664 → billable 10355`, cost USD. Gemini setelah flag compat: `in 10804 / out 12 → billable 10816` |
| Watchdog dispatch (D20) | Dua task menggantung → `BLOCKED`, lease dilepas, `leases: []` |
| Qwen lewat controller | `COMPLETE \| groq/qwen/qwen3.6-27b \| in 10408 out 6 \| billable 10414` |
| Logging terstruktur (D24) | Satu baris JSON per peristiwa; `task`/`exec` menembus controller → gateway → sandbox |
| Lease baca/tulis (D22) | Pembaca berbagi; penulis tetap eksklusif (P4-07 utuh) |
| Backoff percobaan (D24) | Dari tiap 30 detik menjadi 1 per 2 menit, melebar |
| Kontrol manual model/effort (D26) | Stok → `PATCH` → `start`: `glm-5.2@max` lalu revisi ke `glm-5.1@low`, keduanya COMPLETE |
| Stop → ganti → jalankan lagi (D26) | Run hidup dihentikan di gateway (`abortedAtGateway:true`) → BLOCKED → model diganti → `COMPLETE \| zai/glm-5.2` |
| Verifikasi Slack (D27) | Tanda tangan salah → 401, timestamp basi → 401, tanda tangan benar → 200. Dibuktikan lewat HTTP sungguhan di dalam container |
| Identitas Slack per operator (D27) | User Slack tak terdaftar ditolak meski tanda tangannya sah; `actor` di setiap baris log adalah nama orang, bukan "slack" |
| Kontrol penuh dari Slack (D27) | `task` → `stop` (dengan konfirmasi) → `model` → `run` → `COMPLETE \| zai/glm-5.1`, satu lingkaran penuh |
| Perbaikan rencana task (D29) | `PATCH` dengan `workspacePath`/`workerId` melepas task yang terdampar; backoff direset → `DISPATCHED` dalam 5 detik, lalu `COMPLETE` |
| Antrean bersih | Tiga task tersangkut selesai; `waiting: 0` |
| Gateway 2026.7.1 (D30) | `semanggi/openclaw-gateway:2026083001`; pairing, secrets, 9 agen, plugin 6.11, `sessions.subscribe` semua selamat |
| Backup + uji restore (D30) | 6,8 MB state kritis; `integrity_check: ok`, 64 tabel, dua salinan md5 identik |
| Effort GLM terbukti bertingkat (D31) | n=3: off 137 → low 217 → max 284 token keluaran |
| Effort Gemini terbukti hiasan (D31) | n=3: off 533 vs high 316, sebaran 9–479 — diterima, tidak diterapkan |
| Mode preferensi (D31) | Pratinjau routing menyebut `PREFERENSI` beserta buktinya; task lewat entri preferensi tetap COMPLETE |
| Agen Semanggi terlihat di AgentOS (D32) | 24 agen di `/api/agents`, kesembilan agen Semanggi tampak |
| Penanda kompatibilitas agen (D32) | `GET /api/work/agents` memisahkan `operable` / `config-only`, dan `origin` semanggi vs agentos |
| Empat tambahan UI (D33) | Ringkasan project, event log, katalog model, transkrip — semuanya menjawab 200 dengan data nyata |
| Transkrip dua sisi (D33) | `[operator] … / [assistant] SISI MODEL TEREKAM.` |
| Upgrade penuh 7.1 (D34) | Gateway + acpx + zai + groq-provider semuanya 2026.7.1; dispatch, transkrip, dan penyelesaian tetap utuh |
| `deliver` boolean ditegakkan (D34) | Tipenya diuji, bukan hanya nilainya — 7.1 menolak string |
| Pemungutan agen (D34) | `agents.delete` terbukti (`removedBindings: 0`); `scripts/reap-agents.mjs` menolak tanpa `operator.admin` |
| Brain, Role Map, Brain Map (D35) | Katalog routing diangkat jadi Brain bernama; level per (template, role); pemaku Brain tidak bisa menurunkan level — terbukti hidup di image `2026083101` |
| UI Semanggi di dalam AgentOS (D36) | Halaman `/summary`, `/control`, dan grup Settings hidup di dalam AgentOS; hanya 51 baris hulu disentuh, sisanya berkas baru |
| Proxy API sisi server (D36) | `/api/semanggi/[...path]` meneruskan dengan token dari secret; token tidak pernah sampai ke peramban, dan penjaga `instance-protection` terlewati dengan benar karena panggilannya se-origin |
| Dekomposisi WORK yang menolak rencana setengah jadi (D36) | Permintaan ditolak dengan *"3 fase belum punya Brain: builder (normal), tester (normal), learner (critical)"* — diagnosis benar, katalog benih memang tidak punya Brain kategori `coding` |
| Setelan project (D37) | `template` + `profile` menjadi kolom `projects`, disetel di Settings → Project; kartu Context per permintaan dihapus |
| Probe level thinking empiris (D38) | Probe per model, asinkron, dengan status yang bisa ditanyakan; hasilnya dipersistensi di `thinking_levels` dan dipakai ulang sebagai pilihan dropdown |
| Cache model gateway (D38) | `gateway_models` dipersistensi; form Brain tidak perlu bertanya ke gateway tiap kali dibuka |
| Transkrip dengan penalaran dan tool call (D40) | `execution_messages.blocks` sampai ke UI; Response / Reasoning / Tool call dibedakan, blok rusak merosot jadi `null` tanpa menggagalkan transkrip |
| Revisi untuk task BLOCKED (D40) | Gerbang UI diperbaiki: `BLOCKED → RESUMABLE → QUEUED` bisa dijalankan operator; `CANCELLED` tetap jalan buntu |
| Pendaftaran workspace jadi project | Workspace AgentOS yang belum punya project Semanggi tampil di Settings → Project dengan tombol pendaftaran yang hilang sendiri setelah terdaftar |
| Jalur build image AgentOS (D41) | `images/agentos/Dockerfile` + build context `agentos-src`; entrypoint terverifikasi `/usr/local/bin/semanggi-agentos-entrypoint` sebelum deploy |
| Migrasi state ke root `semanggios` — repair setelah insiden | Pemindahan state ke `.../service/semanggios/*` (3 Sep malam) dilanjutkan ganti env service (4 Sep, 16:28 WIB) **tanpa** `SEMANGGI_OPENCLAW_ROOT`, dengan `plugins.load.paths` yang menunjuk path yang hanya ada di image agentos, dan 6 workspace agen masih menunjuk root lama yang sudah tidak ada → gateway crash-loop, agentos ikut gagal. Repair: env `SEMANGGI_OPENCLAW_ROOT` (sudah disiapkan di `stack/semanggi-stack.yml`), `openclaw.json` diperbaiki di NFS (backup `openclaw.json.bak.prefix-20260904`), semua service kembali Running |
| Uji koneksi Brain claude-code | `POST /api/work/brains/{id}/test` kini menyelesaikan Brain `claude-code` lewat `acpAgent`-nya, bukan cocok model — sebelumnya Brain claude selalu terbaca "no agent provisioned" meski harness sehat (regresi di `tests/unit/brains.test.mjs`) |
| `workers.match` (D43) | Pencocokan worker least-loaded diangkat ke repository; semua permukaan pembuat task memakai aturan yang sama |
| role_levels tanpa sumbu profile (D44) | `controller.db` live di-reshape dari PK `(template, profile, role)` ke `(template, role)` oleh `#migrate()` saat boot image `2026090401`; `PUT /api/work/role-levels` terbukti 200 set-restore di cluster |
| UI `2026090401` | "Command Center" (nav + heading) dan filter Summary "Current Project" (satu project pertama yang cocok, tie-break sama dengan Control) terverifikasi di bundle terautentikasi |
| Role Level Map per (template, profile, role) (D44) | Grid kolom dropdown fast/balanced/quality di Settings; `DEFAULT_ROLE_LEVELS` bersarang sesuai spec §4.0; migrasi shape-based dua arah di cluster live-DB (dua-kolom → tiga-profil, builder×3) |
| Project Role Level modal (D44) | Register dan Edit membuka modal yang sama: dropdown profile + level per role aktual (template ∪ worker ∪ tersimpan), kolom brain hasil resolusi; snapshot menang pada dekomposisi WORK (terbukti: reviewer/tester SDMK ikut snapshot lama, bukan default template) |
| Brain Map per (template, role, level) (D45) | Grid kolom dropdown low/normal/critical dengan default `DEFAULT_BRAIN_MAP`; pemaku di bawah level dipakai dan ditandai `belowLevel`; pin lama ter-migrasi ke sel legal (14 baris live) |
| Whitelist proxy Semanggi ikut endpoint baru | `GET/PUT /work/projects/{id}/role-levels` ditambahkan ke ALLOWED di `app/api/semanggi/[...path]/route.ts` — ditemukan dari modal Edit yang gagal di cluster ("proxy does not expose"), terverifikasi 200 lewat jalur terautentikasi di image `2026090403` |
| Whitelist proxy untuk PUT docs (D56) | Kegagalan kedua dari jenis yang sama: PUT `/work/projects/{id}/docs/{name}` ada di controller sejak D55 tapi tak terdaftar di proxy, setiap Edit/Save modal Command Center gagal 404 "does not expose PUT". Entri ALLOWED ditambahkan; terverifikasi 2026-09-06 di `agentos-src` (fork commit `97dd5b12`): probe project tak dikenal mencapai controller ("unknown project", bukan "does not expose"), dan round-trip PUT dokumen asli mengembalikan byte identik, 200 |
| Modal dokumen Command Center (D56) | Edit/Save pindah ke header modal di sebelah judul (slot `actions` baru di `Modal`); scroll textarea dan pratinjau markdown tersinkron proporsional. Build standalone terautentikasi 2026-09-06 |
| Copy-to-clipboard + Cancel modal dokumen | Icon copy di sebelah kanan setiap text task-id (Summary, TaskDialog, Command Center — termasuk baris task terdaftar, yang menyalin id task asli) dan di pojok kanan-atas setiap region markdown, menyalin source asli; tombol Cancel muncul/hilang bersama Save. `copyToClipboard` memakai fallback textarea karena UI dilayani HTTP polos non-localhost (tanpa `navigator.clipboard`). Terbukti di `agentos-src` fork `327531d0`, 2026-09-06 |
| Dokumen memory/ ikut disunting operator (D58) | Pembatasan D55 dibatalkan atas keputusan operator: PUT `/work/projects/{id}/docs/{name}` menerima semua nama whitelist termasuk `memory/blueprint.md` dan `memory/decisions.md`; UI menampilkan Edit untuk keduanya. Whitelist nama, audit `project.doc-updated` per simpan, dan "controller hanya menulis atas PUT eksplisit" tetap dijaga; tes penolakan memory diganti tes simpan+audit |
| Provider `aliyuncs` DIHAPUS PENUH (D60) | Semua jejak Alibaba Model Studio dicabut 2026-09-06 atas permintaan operator: 5 Brain `alibaba-*` dihapus lewat `DELETE /api/work/brains/{id}` (endpoint baru D60), 5 agen probe `sem-workspaces-probe-alibaba-*` dipungut lewat `agents.delete` (`scripts/remove-provider-agents.mjs`), provider keluar dari `models.providers` config gateway, 5 kunci `agents.defaults.models` dibersihkan, katalog model state (`state/agents/main/agent/models.json`, tabel sqlite `agent_model_catalogs`) di-prune, registry sandbox probe dibersihkan, arsip state agen probe disimpan di `~/aliyuncs-probe-agent-state-20260906.tar.gz`. `models.list` gateway dan cache `gateway_models` controller kini 9 model / 4 provider (cerebras, google, groq, zai). Catatan: baris `thinking_levels` aliyuncs (5) dibiarkan sebagai catatan pengukuran historis — tak ada permukaan hidup yang membacanya; kunci API workspace ws-pyewjaac2j* tinggal direvokasi di konsol Alibaba |
| Cerebras `qwen-3.8-27b` — terdaftar, TERTAHAN billing (402), level menyusut | Provider `cerebras` ditambahkan operator lewat AgentOS (`api.cerebras.ai`, openai-completions); model `available` di daftar hidup gateway. Probe awal 2026-09-06: ketujuh kandidat level dispatch diterima, tetapi SETIAP run nyata gagal **HTTP 402 (billing)**. **Diukur ulang 2026-09-06 (D61, lewat tombol Test):** agen probe `sem-workspaces-probe-cerebras-cerebras-qwen-3-8-27b` kini hanya mengiklankan `["off"]` — Test dengan thinking=`high` ditolak run-start: `Thinking level "high" is not supported for cerebras/qwen-3.8-27b. Use one of: off.`; TANPA level, run mencapai provider dan gagal `FailoverError: 402 status code (no body)` (2,5 dtk). Jadi dua dinding berlapis: kosakata level menyusut + billing. Brain `cerebras-qwen-3-8-27b` (BRN-3CA78DD7, normal, thinking=`high`, effort `guaranteed`) tetap terdaftar dengan bukti 402 di effortEvidence. **Tindak lanjut operator:** isi kredit/paket Cerebras, turunkan thinking ke `off`/null bila level tetap menyusut, lalu probe ulang |
| Cerebras `qwen-3.8-27b` — TERTAHAN billing (402), level = `["off"]` permanen (D62) | Probe langsung `api.cerebras.ai` 2026-09-06: **402 payment_required**, `x-should-retry: false` — akun tanpa kredit. `models.list` gateway: `reasoning: false` → agen mengiklankan `["off"]` saja (kosakata off…high di probe awal ternyata validasi terhadap model default zai — pelajaran D21 terulang). Brain `cerebras-qwen-3-8-27b` ditambal `thinking: null` + evidence D62, jadi Test kini menunjukkan dinding tunggal yang tersisa: 402. **Tindak lanjut operator:** isi kredit, Test ulang (harus lolos tanpa level), lalu Probe level untuk karakterisasi. Catatan: kunci API cerebras tertulis inline di `openclaw.json` — pindahkan ke file-secret saat rotasi |
| Groq `qwen/qwen3.6-27b` — dinding struktural ITPM, BUKAN rate limit yang reset (D62) | Agen probe `sem-workspaces-probe-groq-groq-qwen-qwen3-6-27b` hidup di `workspaces/probe/groq`, level `off\|minimal\|low\|medium\|high`. Probe langsung `api.groq.com`: permintaan mungil 200 OK, tapi ITPM free tier = **7000 token/menit** (model qwen) / 8000 (gpt-oss) dan prompt run gateway ~10,4rb+ token → **413 "Request too large … Limit 7000"**, `x-should-retry: false`. `qwen/qwen3-32b` tersedia, dinding sama. Jendela per-menit+harian D59 ada di API, tapi dinding efektif tidak pernah hilang oleh reset. **Tindak lanjut operator:** upgrade groq Dev Tier berbayar — tanpa itu, Brain qwen-high/qwen-medium hanya bisa menunggu `WAIT_QUOTA` lalu BLOCKED |
| Driver kuota per provider (D63, POC-6 fase 1) | Registry `src/domain/quota-drivers/` (google/groq/cerebras/zai/claude-code/mistral + fallback generik): klasifikasi galat, ETA reset (sinyal > prediksi; fixed-time sadar DST via `Intl`; token-bucket pace 60 dtk; credits-anniversary), dan defaults (tier + tipe jendela + laju — google per model: 2.5-FL 10/20, 3.1-FL & 3.5-FL 15/500, 3.7-Flash 5/20, harian = tengah malam Pasifik; groq tpm terukur 7000; mistral laju null-jujur sampai Admin Panel terbaca). `brains` +9 kolom, migrasi D63 backfill dari registry (patch operator tak ditimpa). Fatal (groq 413 struktural D62, 402/401) → `BLOCKED` langsung dengan alasan; refusal tanpa jam di jendela panjang → parkir pada ETA jendela panjang driver (zai 7 hari), bukan backoff 30 dtk. Fase 2 `promptBudget` §6 spec POC-6 belum |
| Resolusi driver alias + `brains.category` dihapus + form Brain dari registry (D64) | `quotaDriverFor` mencocokkan `providerKeys` per driver (bukan kesamaan nama) — label `mistral-custom` di AgentOS kini jatuh ke driver mistral, bukan generic senyap; `GET /api/work/quota-drivers` + anotasi `quotaDriver` per brain. `brains.category` DROP (jalur dispatch tidak pernah membacanya sejak Brain Map grid); form Brain: opsi provider/model dari cache gateway + brain yang ada, katalog statis hanya jadi "Copy from catalog", field provider menunjuk driver pemilik label. UI di fork `2273e2fa` |
| Form Brain mengekspos fakta D63 + gerbang provider live (D64 rev.3) | Field Plan tier, RPM, RPD, TPM, TPD, Context window (tokens) di form Add/Edit Brain — kosong = default driver saat create / pertahankan tersimpan saat edit, terisi = override operator permanen (aturan D51); PATCH live diverifikasi dua arah (set 200, clear eksplisit 200, field lain tak tersentuh). Dropdown provider = (brain ∪ providerKeys driver) ∩ `models.list` LIVE (dipanggil tiap panel dibuka; cache hanya cat pertama); carve-out `claude-code` (harness ACP, tak pernah di models.list). Fork `86962855` + `38423cdf` |
| Test Brain auto-provision tuntas + jujur (D65 rev.2) | Tombol Test/Test Connection kini benar-benar berjalan tanpa agen pra-ada: `mistral-custom/codestral-latest` terverifikasi live 2026-09-06 — probe agent `sem-workspaces-probe-mistral-custom-mistral-custom-codestral-la` dibuat otomatis (workspace absolut …/workspaces/probe/mistral-custom), run ok 7,3 dtk; tes kedua & brain tersimpan `mistral-codestral` me-resolve agen yang sama tanpa provisioning ulang. Akar masalah lama: implementasi D65 pertama menelan kegagalan provisioning (jawaban selalu pesan "No agent provisioned" basi) DAN `workspaces/probe/` di NFS root-owned 755 sementara gateway PID 1 menjalankan mkdir workspace sebagai uid 1000 → EACCES struktural; perbaikan ops sekali: `chown 1000:1000` direktori `probe/` (provider baru kini self-service). Respons membawa `provisioned:true/false`; kegagalan `agents.create` disurfasikan dengan error gateway + petunjuk chown untuk EACCES |
| Model Map: resources + thinking-levels jadi milik operator (D66) | `GET /api/work/model-map` join kedua tabel per (provider, model), baris satu sisi tampil apa adanya (`no resource entry` / `not measured`); `PATCH /api/work/resources?provider=&model=` (query param — model id groq mengandung `/`) mengubah kebijakan tanpa me-reset sinyal live (availability/next_available_at terbawa, bukan dipilih); `PUT /api/work/thinking-levels` menolak preference tanpa evidence; semua tulis admin-only + event_log (`resource.policy`, `thinking-levels.updated`); boot kini seed thinking-levels hanya saat tabel kosong — restart tidak lagi menimpa suntingan operator (tes file-backed DB). Panel UI Settings → Model Map di `settings-panels.tsx` + patch `apply.sh` + whitelist proxy; JSON tetap seed instalasi baru |
| Penghapusan baris Model Map + Brain, menu Model Map dipindah (D67) | `DELETE /api/work/model-map?provider=&model=` menghapus KEDUA sisi baris (resources + thinking_levels), admin-only + event `change:"delete"`; GET membawa `deleteBlockers` per baris (models.list, seed resources.json — baris yang dihapus tapi masih di-seed hidup kembali saat restart, brains perujuk, eksekusi aktif) dan DELETE menolak dengan alasan yang sama — aturan penghapusan fakta server, UI tinggal men-disable tombol. Form Add/Edit Model & Edit Brain: aksi kanan bawah (Delete \| Cancel \| Save); Delete brain hanya aktif bila tidak dipaku brain_map dan bukan default grid; whitelist proxy +`DELETE work/brains/{id}`. Menu: Project → Model Map → Role Level Map (patch `patch_settings_model_map_position`, jangkar id) |
| Brain Map memegang daftar failover terurut (D68) | brain_map PK (template, role, level, position); pemaku tunggal lama menjadi list satu-anggota posisi 0 (migrasi bentuk ulang). `PUT /api/work/brain-map` menerima `brainIds[]` terurut ([]/null melepas); menolak kembar/tak dikenal/seluruhnya-dimatikan. `resolve()` mengembalikan `candidates` (hidup, terurut) + `skipped` (alasan per anggota) + `names` (preferred termasuk yang dimatikan) — task membawa seluruh rantai di `model_policy.preferred`, admission (D42) memilih penyintas pertama PER PERCOBAAN DISPATCH: failover dan fail-back tanpa penunjuk tersimpan, parkir kuota pada ETA terkecil lintas anggota, dispatch log +`preferredIndex`. Pool level kini daftar penuh; registerTasksFromDoc ikut membawa preferred — tidak ada lagi permukaan Semanggi yang membuat task kategori-tanpa-preferred (routes routing.json tinggal fallback API tangan). UI: sel grid menampilkan daftar bernomor, modal editor ↑/↓/×; rantai tampil "+N" di Project Role Level dan langkah rencana |
| Suite controller | **476 test**, semua lulus, tanpa dependensi runtime |

## Yang masih menghalangi

### ~~1. Dispatch yang ditolak menyumbat antrean~~ — **SELESAI (D20/D21)**

Watchdog dispatch terpasang: eksekusi yang diam melebihi ambang menjadi `BLOCKED` dan lease-nya dilepas, begitu pula lease yatim yang pemiliknya tidak lagi berjalan. Terbukti di cluster — dua task yang menggantung terlepas dan `leases: []` tercapai.

Akar sebenarnya lebih dalam dari dugaan awal, dan tercatat sebagai D21: **gateway menjawab satu permintaan dua kali** — `accepted` lebih dulu, lalu `res ✗` menyusul. Klien sudah menyelesaikan promise-nya pada frame pertama, jadi penolakan itu hilang tanpa jejak. Adapter kini memunculkannya sebagai `gateway.late-error`, dan watchdog tetap menjadi jaring pengaman.

Ikut ditemukan: **`thinking` divalidasi terhadap model default (`zai/glm-4.7`), bukan model agen**, sehingga level bertingkat pada groq selalu ditolak meski `agents.list` mengiklankannya. Katalog qwen kini tanpa level, dan dispatch-nya berhasil: `COMPLETE | groq/qwen/qwen3.6-27b | in 10408 out 6 | billable 10414`. Pelajaran yang lebih luas: **iklan `thinkingLevels` tidak bisa dipercaya untuk provider tanpa plugin.**

### 2. Akuntansi token — **diperbaiki, termasuk Gemini (D17, dikoreksi D19)**

Dua bug saya sudah diperbaiki: `session.message` ternyata **tidak membawa `runId`** (korelasi kini lewat `sessionKey`), dan nama fieldnya `input`/`output`/`cacheRead`/`cacheWrite`, bukan ejaan gaya Anthropic yang saya tebak. Terbukti hidup:

```
status: COMPLETE | model zai/glm-5.1
tokens: in 8631  out 60  cacheRead 1664
billable: 10355  | cost 0.010996 usd
```

Kesimpulan awal bahwa "Gemini tidak melapor" ternyata **salah** dan sudah dikoreksi. Gemini melapor usage pada permintaan non-stream, dan pada stream bila diminta `stream_options.include_usage`. Gateway tidak pernah memintanya karena heuristik `supportsUsageInStreaming` mematikan flag itu untuk endpoint kustom. Diperbaiki lewat config, dan terbukti: `google/gemini-3.1-flash-lite … in 10804 out 12 billable 10816`. Groq tidak perlu diapa-apakan — streamnya sudah menyertakan usage.

Penjaga "frame nol tidak dicatat" tetap dipertahankan: ia benar untuk provider yang memang diam, dan mencegah nol terbaca sebagai gratis.

### 3. FORK tidak membawa riwayat induknya — **batasan, bukan bug**

Pada versi gateway ini percakapan hanya dialamati lewat `sessionKey` dan tidak ada API untuk mengkloning sesi. FORK karena itu memulai percakapan **kosong** yang dicatat berasal dari induknya. Kalau percabangan berikut riwayat memang dibutuhkan, pilihannya: kemampuan baru dari upstream, atau memutar ulang transkrip induk ke sesi baru di tingkat aplikasi.

### 4. Pemilihan agen ACP belum bisa ditegakkan controller — **masih berlaku di 2026.7.1 (D18, dikonfirmasi D30)**

Upgrade **tidak** menutup ini. `agentRuntime` dan `workspaceDir` tetap ditolak metode `agent` di 7.1 dengan `unexpected property`. Dokumen upgrade menduga sebaliknya berdasarkan jumlah berkas di `dist`; dugaan itu salah.

### 4b. Gerbang izin belum terverifikasi di 7.1 — **butuh token baru dari operator**

`permission-bridge-verify.sh` FAIL. Ditelusuri dua kali: pertama `429 — You've hit your session limit`, lalu `"Not logged in · Please run /login"`. Jadi token OAuth langganan **sudah tidak sah**, bukan sekadar habis kuota — dan bukan regresi 7.1.

**Tindakan operator:** jalankan `claude setup-token`, perbarui secret `claude_code_oauth`, lalu ulangi ketiga kasus. Sampai itu dilakukan, status jalur ACP di 7.1 tidak diketahui, dan kegagalan gerbang izin bersifat senyap — jadi ini bukan hal yang aman untuk ditunda diam-diam.

### 4c. Catatan lama (tetap relevan)

Effort untuk opus/sonnet **tidak bisa** dikirim sebagai parameter dispatch: `thinking` sampai ke agen OpenClaw, bukan ke harness. Jalur perintah tipis per (model, effort) memang mekanismenya, dan itu berfungsi — wrapper menulis `{"effort":"high", ...}`.

Yang belum bisa: mengikat pilihan itu ke dispatch. `agentRuntime.acp.agent` ditolak baik oleh RPC (`unexpected property`) maupun skema config (`Unrecognized key`) — field itu milik 2026.8.1, bukan 2026.6.11. Jadi agen ACP mana yang benar-benar jalan ditentukan `acp.defaultAgent` global atau oleh orkestrator saat spawn, yang bersifat instruksi dan tidak bisa ditegakkan. **`acpAgent` di katalog karena itu adalah niat yang dideklarasikan, bukan routing yang ditegakkan** — dan sebaiknya dibaca begitu sampai gateway di-upgrade.

Selain itu masih belum dibuktikan bahwa Claude Code menghormati kunci `effort` di settings (bukan hanya flag `--effort`).

### ~~5. Satu workspace per project berarti task menjadi berurutan~~ — **diperlunak (D22)**

Hanya **penulis** yang bergiliran. Task dengan `workspaceMode: "read"` berbagi workspace dengan pembaca lain dan hanya menunggu bila ada penulis. Defaultnya tetap `write`, jadi tidak ada yang menjadi berbagi karena kelalaian — dan saya sengaja tidak menebak kategori mana yang aman untuk dibaca-saja. Itu keputusan per task.

### 6. Ambang waktu perlu ditinjau operator

`SEMANGGI_LEASE_TTL_MS` (15 menit) harus nyaman lebih besar dari interval pass scheduler, karena perpanjangan lease menumpang di pass itu. Controller kini memperingatkan bila terlalu rapat, tetapi angkanya tetap keputusan Anda — begitu pula `SEMANGGI_DISPATCH_TIMEOUT_MS` (30 menit) dan `SEMANGGI_MAX_INSTRUCTION_BYTES` (64 KB).

### 7. Atribusi lewat UI adalah label, bukan bukti — **batas yang diketahui (D36)**

Halaman Semanggi memakai satu token bersama, jadi setiap tindakan dari sana tercatat atas satu identitas. Header `x-semanggi-actor` membawa nama pengguna AgentOS supaya linimasa tetap menyebut seseorang, tetapi nama itu berasal dari sesi peramban, bukan dari kredensial. Spec §8.4 belum terpenuhi lewat permukaan ini; **Slack tetap satu-satunya jalur yang atribusinya bisa dipercaya.**

Akarnya di hulu: AgentOS **single-admin** — `instance-protection.json` menyimpan satu username dan satu hash, tanpa konsep peran. Menutup ini berarti membangun lapisan identitas sendiri di dalam UI, bukan menambal AgentOS.

### 8. Jembatan AgentOS → Semanggi masih manual — **pekerjaan berikutnya, bukan kerusakan**

Empat hal masih dikerjakan tangan, dan UI menampilkannya apa adanya alih-alih berpura-pura sudah selaras:

| Hal | Sekarang | Yang menutupnya |
|---|---|---|
| Workspace → project | tombol "Daftar sebagai Semanggi Project" | pembaca `/api/snapshot` yang menyelaraskan project (tugas #4) |
| Template project | kolom milik Semanggi, default `software`, tidak bisa disunting | dibaca dari `project.json` AgentOS |
| Role per template | konstanta di `decompose.mjs` | dibaca dari tim di `project.json` |
| Brain agent per (project, role, Brain) | belum ada provisioner | penulis agen lewat RPC + pemungut (tugas #5) |

### 9. Distribusi image tanpa registry — **rapuh, dan sudah menggigit dua kali**

Tidak ada registry di klaster. Image dibangun di `kub01-01` lalu disalin `docker save` → `scp` → `docker load` ke empat node lain lewat IP overlay (`10.10.0.10` … `10.10.0.12`; nama netbird tidak resolvable dari dalam node). Dua kegagalan nyata yang berasal dari sini:

- Swarm menjadwalkan service di node yang tidak punya image → `Rejected` lalu rollback (D36).
- Disk node build mencapai 100% dan build mati di tengah `apt-get` (D41). Pembersihan tag lama MUST mendahului build, dan MUST NOT menyentuh tag yang sedang dipakai service.

Registry internal akan menutup keduanya sekaligus.

## Perangkap operasional yang ditemukan hari ini

**Perintah lewat `docker exec` berjalan sebagai root dan itu mengubah apa yang Anda lihat — dan bisa merusak.**

- `openclaw secrets audit` sebagai root melaporkan `unresolved=1 ... not-owned`; sebagai uid 1000 hasilnya `clean`. Laporannya benar untuk root, sudut pandangnya yang salah.
- Lebih berbahaya: `openclaw config set` sebagai root **menulis ulang `openclaw.json` menjadi milik root**, dan gateway (uid 1000) langsung gagal boot dengan `EACCES`, yang muncul menyamar sebagai `existing config is missing gateway.mode`. Saya menabraknya sendiri hari ini. Selalu `-u <uid>`, dan periksa kepemilikan sesudah mengubah config.

## Urutan yang saya sarankan

1. ~~Putuskan soal upgrade ke 2026.7.1~~ — **selesai (D30, D34)**, tetapi **dua dari tiga janjinya tidak terbukti**: `workspaceDir` per dispatch dan `agentRuntime.acp.agent` tidak ada di 7.1. Yang benar-benar didapat hanyalah versi yang lebih baru dan `sessions.compaction.branch` sebagai kandidat FORK berikut riwayat.
2. **Perbarui kredensial harness dan luluskan `permission-bridge-verify.sh` di 7.1** (butir 4b di atas). Ini blocker keamanan yang gagal secara senyap — satu-satunya butir di dokumen ini yang tidak aman untuk ditunda.
3. ~~Slack app~~ — **selesai (D27)**, terbukti hidup di image `2026082208`. Yang tersisa hanyalah keputusan operasional: cara mengekspos dua path Slack ke internet (reverse proxy, atau Socket Mode bila paparan publik tidak diinginkan), lalu memasang signing secret asli dan mendaftarkan operator sungguhan. Lihat `slack-setup.md`.
4. ~~UI operator di dalam AgentOS~~ — **selesai (D36–D41)**, berjalan di `semanggi/agentos:2026090205`. Keempat tambahan backend yang dulu disebut kurang (ringkasan project, event log, katalog model, transkrip) semuanya ada, dan transkrip kini bahkan membawa blok mentahnya (D40).

   Yang **belum** ada dari rencana UI awal: halaman agen Semanggi tersendiri (§8.5 spec induk). Endpoint `GET /api/work/agents` sudah memisahkan `operable`/`config-only` dan `origin`; tinggal halamannya.

   Catatan dari D28 tetap berlaku: UI ini **tidak boleh** membaca daftar agent dari AgentOS, karena snapshot AgentOS tidak memuat satu pun agent Semanggi.
5. **Discovery project/role dari AgentOS** (butir 8 di atas) — ini yang mengubah jembatan manual menjadi otomatis, dan sekaligus menghapus satu-satunya alasan `projects.template` disimpan Semanggi.
6. **Provisioner brain-agent + penulis skill peran** — satu-satunya bagian model Brain (D35) yang masih dikerjakan tangan.
7. **Registry image internal** (butir 9 di atas).
