# POC-5 — Upgrade Gateway OpenClaw 2026.7.1 → 2026.8.2

Disusun 2026-09-02, dikerjakan langsung di `kub01-01`. Semua klaim kontrak di bawah
**diverifikasi dengan mengirim permintaan** ke gateway 2026.8.2 yang nyata berjalan
(sebagaimana pelajaran D34/D38/D41 — membaca `dist` bukan bukti), kecuali yang secara
eksplisit ditandai belum teruji. Bukti mentah: probe di `/tmp/kilo/poc5-probe/` dan log lab.

---

## 0. Ringkasan satu paragraf

2026.8.2 adalah rilis stabil terbaru (dirilis 2026-09-01) dan **memang membawa mekanisme
pengikatan harness** yang ditunggu sejak D18 — tetapi bentuknya bukan `agentRuntime.acp.agent`
di RPC, melainkan **`agents.entries.<id>.runtime.acp.agent` di config**, yang ditegakkan di
resolusi target ACP saat spawn, bukan di dispatch `agent`. Lompatan 7.1→8.2 sekaligus
menabrak pergantian kontrak besar "OpenClaw 2.0" (8.1): handshake WS, nama parameter RPC,
format config, penyimpanan sesi ke SQLite per-agen, dan gerbang persetujuan kapabilitas
plugin. Adapter controller **pasti** harus berubah. Yang membuat POC ini mendesak bukan
hanya fiturnya: **gateway 8.1 sudah pernah dijalankan terhadap state produksi hari ini
(13:12Z) dan memigrasikan sesi ke SQLite, lalu 7.1 dikembalikan di atasnya** — klaster
sedang berjalan dalam keadaan hibrida yang tidak pernah direncanakan.

## 1. Fakta rilis (diverifikasi terhadap registry dan image)

```
ghcr.io/openclaw/openclaw:2026.7.1   terpasang sekarang (dasar image semanggi 202609021233)
ghcr.io/openclaw/openclaw:2026.8.1   ADA  rilis 2026-08-31  commit ea806575  "OpenClaw 2.0"
ghcr.io/openclaw/openclaw:2026.8.2   ADA  rilis 2026-09-01  commit 0965053f  ← target POC ini
ghcr.io/openclaw/openclaw:2026.8.3   TIDAK ADA — 8.2 adalah yang terbaru
```

- 8.1 adalah rilis raksasa (~2.400+ PR): UI web baru, onboarding, **sesi & transkrip
  pindah ke SQLite per-agen**, konsolidasi config, kepercayaan plugin, paket provider resmi.
- 8.2 didominasi perbaikan atas 8.1, dan justru **tentang keselamatan upgrade**:
  *"stop incomplete session migrations before claiming success"*, *"keep newer
  configuration"*, *"repair supported legacy v17 agent databases"*, ditambah
  `openclaw update cleanup --dry-run` untuk mengelola arsip rollback migrasi.
- Peringatan downgrade 8.1 (kutipan rilis): sesi yang dibuat setelah migrasi SQLite
  *"will not appear in older releases"*; sebelum turun versi harus me-restore arsip
  transkrip legacy lewat CLI versi baru. **Peringatan ini sudah terlanggar di produksi
  hari ini — lihat §5.**
- Gerbang deprecation SDK plugin bertanggal **2026-09-01 — sudah aktif** (subpath
  `plugin-sdk-*` pindah ke `openclaw/plugin-sdk/...`). Plugin eksternal kita (`acpx`,
  `zai`, pin 2026.7.1) masih termuat di atas 8.2 (dibuktikan §3), tetapi ini area yang
  harus diukur ulang tiap kali plugin di-re-pin.

## 2. Yang dicari sejak D18/D34, dan bentuk aslinya di 8.2

Pertanyaan lama: bagaimana membuat `acpAgent` di katalog Brain menjadi **routing yang
ditegakkan**, bukan niat. Jawaban 8.2 — diukur dari config schema, dist, dan gateway hidup:

1. **Bidangnya ada di entri agen config, namanya `runtime`, bukan `agentRuntime`.**
   `AgentEntrySchema` menerima `runtime: {type:"acp", acp:{agent, backend, mode, cwd}}`.
   Kunci `agentRuntime` di config adalah hal lain (kebijakan referensi id di peta model)
   dan **tetap ditolak** sebagai pengikat harness.

2. **RPC tidak bisa menyetelnya.** `agents.create` dan `agents.update` menolak `runtime`
   maupun `agentRuntime` (`unexpected property`). Pengikatannya hanya lewat config —
   berkas, atau CLI `openclaw config set` (terbukti masih bekerja di 8.2). Konsekuensi
   untuk provisioner (tugas #5): menulis config, bukan RPC.

3. **Penegakkannya hidup di resolusi target ACP, bukan di dispatch `agent`.** Dari
   `acp-spawn` 8.2: saat sebuah sesi/spawn menunjuk `agentId = X` dan X adalah config
   agent dengan `runtime.type:"acp"`, gateway memetakan X → `X.runtime.acp.agent` secara
   deterministik; menunjuk config agent biasa sebagai target ACP **ditolak eksplisit**:
   > `agentId "X" is an OpenClaw config agent, not an ACP harness. Use runtime="subagent"
   > or omit runtime ... or configure agents.entries.*.runtime.type="acp" with runtime.acp.agent.`

4. **Dispatch `agent` tetap tidak mengenal harness.** `agent {agentId:"claude-opus"}` →
   `unknown agent id "claude-opus"` (harness bukan agen; ini yang membuat Test Connection
   Brain claude-code/* cocok secara literal gagal — D18 tetap akurat untuk gejalanya).
   Menyetel `runtime` pada agen `main` **tidak** mengubah dispatch ke `main` — terukur:
   dispatch tetap jalan sebagai agen OpenClaw biasa dan gagal di provider modelnya.
   `sessions_spawn` bukan metode operator (372 metode, tidak ada).

Jadi pola penegakan yang benar untuk Semanggi di 8.2:

```
acp.allowedAgents dibatasi (jangan berisi id harness mentah)
agents.entries.claude-opus  = { runtime: {type:"acp", acp:{agent:"claude-opus"}} }   ← alias
agents.entries.claude-sonnet= { runtime: {type:"acp", acp:{agent:"claude-sonnet"}} }
katalog Brain: acpAgent = "claude-opus" (nama alias/config agent)
instruksi orchestrator: spawn ACP agentId "claude-opus"
→ gateway menegaskan: alias itu hanya bisa berarti harness claude-opus, selamanya
```

Instruksi tetap diperlukan untuk MEMICU spawn (itu sifat ACP: harness dipanggil
per-sesi oleh orchestrator), tetapi **pemetaan nama→harness kini milik gateway**, dan
menamai harness mentah di luar `allowedAgents` ditolak. Itu perbedaan nyata dari
`acp.defaultAgent` global yang tidak bisa ditegakkan per-Brain (D18).

**Belum terbukti end-to-end**: lab tidak punya docker.sock untuk spawn sandbox harness
dan token OAuth langganan Claude memang sedang tidak sah (butir 4b readiness). Bukti
routing hidup (kegagalan yang menyebut harness yang dipilih) wajib diulang di jendela
upgrade dengan kredensial yang valid.

## 3. Bukti lab — 8.2 di atas salinan state produksi

Metode: salinan state kritis (tanpa `npm`, 98 MB; `npm` di-bind-mount read-only dari
produksi) dijalankan sebagai container biasa di kub01-01, port lokal, token lab.
Identitas perangkat controller direplikasi sehingga pairing dan scope `operator.admin`
terbukti hidup. Gateway produksi tidak disentuh.

### 3.1 Boot pertama ditolak — tiga gerbang sekaligus

```
Invalid config at /lab/config/openclaw.json:
  openclaw.json:150 — meta: Unrecognized key: "lastTouchedAt"
  agents.ownership: multi-agent rosters require agents.ownership="explicit" ...
OpenClawStateDatabaseSchemaMigrationRequiredError: ... (audit-events-v2) ...
  run openclaw doctor --fix to migrate it.
```

`doctor --fix` (jalur yang disarankan pesan galatnya sendiri) menuntaskan semuanya:

- `agents.list` (array) → **`agents.entries`** (map, kunci = id agen); kelima agen selamat.
- `agents.ownership: "explicit"` ditambahkan; `meta` ditulis ulang menjadi
  `{lastTouchedVersion:"2026.8.2", migrations:{...}}`.
- State DB dimigrasikan bertingkat (v10, v12–v15, 48, audit-events-v2) — tabel mati
  dihapus, ledger audit dipindah ke skema lifecycle ber-versi.
- Entri registry basis-data agen yang foldernya sudah tidak ada dibersihkan
  (sisa agen POC lama), dengan peringatan yang jujur.

### 3.2 Gerbang persetujuan kapabilitas plugin — gateway menolak siap

```
OpenClaw plugin verification failed; refusing to report the gateway ready.
- Plugin "acpx" requires capability consent; rerun with --accept-capabilities.
- Plugin "zai" requires capability consent; ...
- Plugin "groq" requires capability consent; ...
```

Ini perilaku baru 8.x (plugin trust): tanpa persetujuan operator, gateway **keluar**,
bukan jalan tanpa plugin. Setelah `openclaw plugins enable <p> --accept-capabilities`
untuk ketiganya, gateway hidup sehat:

```
http server listening (15 plugins: acpx, anthropic, browser, ..., google, ...)
[plugins] embedded acpx runtime backend registered lazily
healthz → {"ok":true,"status":"live"}
```

**acpx dan zai pin 2026.7.1 termuat bersih di atas 8.2.** Itu bukti termuat, bukan bukti
jalur kritisnya (spawn harness, interposer izin di stdio) — lihat §6.

### 3.3 Perubahan kontrak WS/RPC yang mematahkan klien 7.1 (semua terukur)

| Permukaan | 7.1 | 8.2 (bukti galat asli) |
|---|---|---|
| connect `auth` | `auth:{token, device}` | `device` **pindah ke param connect level atas**; `auth` hanya token/password/deviceToken — `unexpected property 'device'` |
| connect `client.id` | bebas | enum resmi; `gateway-client` masih sah, nilai lain `must be equal to one of the allowed values` |
| id frame | angka diterima | `at /id: must be string` |
| protokol | 4 | 4 (ok) |
| metode | 218 | **372**; `agent.run` **hilang**, kembali `agent` (negosiasi DISPATCH_METHODS di `gateway-ws.mjs` menyelamatkan kita, lagi) |
| dispatch prompt | `prompt` | **`message`** wajib (`unexpected property 'prompt'`) |
| idempotensi | opsional (dihormati) | **`idempotencyKey` wajib** |
| `deliver` | boolean | boolean (`must be boolean`) — tetap |
| `workspaceDir` di dispatch | ditolak | tetap ditolak (D14 berlanjut) |
| `agents.create` | `{name, workspace, model}` | sama + `id` tidak diterima; `runtime`/`agentRuntime` ditolak |
| `agents.update`/`agents.delete` | `{id}` | **`agentId`** (`must have required property 'agentId'`) |
| `config.set`/`config.patch` | path/value | **`raw`** (config utuh) — CLI `openclaw config set/get` tetap bekerja |
| `agents.list` bentuk agen | `agentRuntime:{id,source}` | `agentRuntime:{id, cloudPlacementSupported, devicePlacementSupported, source}` + `thinkingLevels` kini `[{id,label}]` |

Yang menggembirakan: `sessions.subscribe`, `sessions.messages.subscribe`,
`sessions.compaction.branch` semuanya masih ada, dan ada pendatang baru yang relevan:
**`sessions.fork`** (kandidat menutup "FORK tidak membawa riwayat"), `sessions.rewind`,
`models.probe`.

## 4. Estimasi kerja adapter controller (BREAKING, tidak opsional)

Setiap titik di §3.3 yang disentuh controller harus diubah dan diuji ulang:

1. `gateway-ws.mjs`: connect (device ke level atas), id frame string, dispatch
   `message` + `idempotencyKey` selalu.
2. Registry agen: bentuk `agents.list` baru; pemetaan agen-Brain tetap berjalan
   (id/model/workspace tak berubah bentuk).
3. Penyelesaian run: event `agent` lifecycle masih teramati di lab (`phase:"error"`
   dengan `runId`+`sessionKey` terbawa) — jalur `session-events.mjs` kemungkinan besar
   selamat, tetapi bentuk payload `session.message` (transkrip D33/D40) dan usage
   (akuntansi D17) **harus diukur ulang**, bukan diasumsikan.
4. Probe level thinking (D38): `thinkingLevels` kini objek — probe dan penyimpanan
   `thinking_levels` menyesuaikan; dan validasi `thinking` terhadap model default
   (D21) harus diukur ulang apakah sudah diperbaiki di 8.2.
5. Interposer izin: kontrak `acp-permission-interposer.mjs` terhadap acpx 2026.7.1
   di atas gateway 8.2 — jalur stdio tidak berubah oleh gateway, tapi ini gerbang
   yang gagalnya senyap; wajib `permission-bridge-verify.sh` tiga kasus.

## 5. Keadaan produksi yang sudah tidak murni (temuan paling penting hari ini)

Jejak di `/opt/semanggi/volumes/shared/service/semanggios/openclaw/state`:

```
11:13:51Z  openclaw.sqlite.bak.20260902111351          (backup sebelum sesuatu)
13:11:49Z  openclaw.sqlite.bak.20260902131149          (backup sebelum migrasi)
13:12:15Z  session-sqlite-migration-runs/session-sqlite-1788354735212-13b0c960.json
           openClawVersion: 2026.8.1 · startedAt 13:12:15.212Z · completedAt .771Z
13:23Z     openclaw.json ditulis ulang (semua .bak seharian)
~13:26Z    service kini: semanggi/openclaw-gateway:202609021233 — dasar 2026.7.1
```

Artinya: **gateway 8.1 (image custom 202609021250, ada di node) sudah dijalankan
terhadap state produksi pukul 13:12Z**, memigrasikan sesi ke SQLite per-agen
(`agents/*/agent/openclaw-agent.sqlite`, berkas lama dipindah ke
`session-sqlite-import-archive/*.imported-*`), lalu **7.1 dikembalikan di atasnya**
tanpa me-restore arsip transkrip legacy — persis jalur yang diperingatkan rilis 8.1.

Kondisi saat ini (diverifikasi):

- Tidak ada sesi file-backed baru yang dibuat 7.1 setelah 13:26Z (klaster diam) —
  belum ada generasi ganda.
- Riwayat sesi lama kini **hanya hidup di dalam SQLite per-agen yang 7.1 tidak baca**:
  CONTINUE pada task lama akan diam-diam mulai sesi kosong (gejala yang sama dengan
  batasan FORK). Tidak ada korupsi — hanya kebutaan.
- Controller dan AgentOS ikut restart di jendela yang sama (image 20260902121 /
  202609021121) dan 324 test controller tetap hijau — tapi tidak ada yang menguji
  transkrip lama lewat 7.1.

Kesimpulan untuk POC ini: state produksi **sudah setengah dimigrasikan**. Upgrade ke
8.2 bukan lagi lompatan bersih 7.1→8.2 melainkan **melanjutkan migrasi yang sudah
dimulai** — dan justru karena manifest migrasinya ada, 8.2 tahu harus idempoten.
Menghindari 8.2 sekarang berarti membiarkan riwayat sesi terkunci di format yang
gateway yang berjalan tidak bisa baca. Argumen "tunda upgrade" dari
`upgrade-openclaw.md` tidak lagi berlaku: kerusakan bertahapnya sudah dimulai.

## 6. Risiko yang tersisa, terurut dari yang paling nyata

1. **Adapter controller + registry + transkrip (§4)** — pasti, diperkirakan 1–1,5 hari
   termasuk tes regresi per perubahan kontrak.
2. **AgentOS.** D32: AgentOS menulis `openclaw.json` langsung dengan bentuk 7.1
   (`agents.list`, `workspaceId`, `modelId`). Di 8.2 config kanoniknya `agents.entries`.
   Doctor mentolerir `list` saat migrasi, tapi tulisan AgentOS pasca-upgrade bisa
   menumbuhkan kembali bentuk lama. AgentOS dan gateway satu compatibility changeset
   (D30): validasi ulang, kemungkinan rebuild. 0,5–2 hari (paling tidak pasti).
3. **Jalur ACP kritis: acpx spawn + interposer izin + sandbox.** acpx 2026.7.1 termuat
   di 8.2 (§3.2) tapi spawn harness lewat docker.sock dan sadapan stdio interposer
   tidak teruji di lab. `permission-bridge-verify.sh` tiga kasus TIDAK BOLEH dilewati —
   dan sekarang masih terhalang token OAuth yang tidak sah (butir 4b readiness,
   `claude setup-token` + secret `claude_code_oauth` adalah prasyarat operator).
4. **Plugin di gerbang SDK 2026-09-01.** acpx/zai pin 2026.7.1 masih lolos hari ini;
   re-pin ke 8.2 wajib disertai pengukuran ulang effort GLM (D19: katalog plugin bisa
   mempersempit level) dan level thinking per model (D38).
5. **SQLite per-agen di atas NFS.** Lab berjalan di disk lokal; produksi menaruh
  `openclaw-agent.sqlite` per agen di NFS — area WAL yang sudah dua kali muncul di
   changelog 8.x. Awasi `slow SQLite transaction hold` (sudah terlihat sekali di lab
   dengan disk lokal) dan pertimbangkan `openclaw backup sqlite` sebagai alat backup
   baru (ada di 8.x: `sqlite create|list|verify|restore`).
6. **Perilaku default baru**: `tools.sessions.visibility` default melebar di 8.2
   ("shared-agent operators should set ... when they need narrower access") — setel
   eksplisit agar tidak bergantung pada default; `agents.defaults.heartbeat.agentId`
   diperingatkan saat kosong (harmless, tapi setelah doctor layak diisi).

## 7. Rencana eksekusi (jendela upgrade)

Fase 0 — prasyarat operator (blokir bila tidak):
- Perbarui token harness: `claude setup-token`, secret `claude_code_oauth`.
- Backup + **uji restore** (pola D30): state kritis + config; tambahkan
  `openclaw backup sqlite create|verify` dari image 8.2 bila ingin arsip kanonis.

Fase 1 — latihan di lab (ulangi §3 di atas, bila mau):
- Salin state ke direktori kerja; jalankan 8.2; `doctor --fix`; konfirmasi boot sehat,
  `agents.list` utuh, device pairing + scope terbaca, `secrets audit` bersih
  **sebagai uid 1000** (jebakan root di readiness.md masih berlaku).

Fase 2 — image custom:
- `docker buildx build --build-arg OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.8.2`
  di atas `images/openclaw-gateway/Dockerfile` (ARG sudah ada; entripoint, wrapper,
  interposer tidak menyentuh kontrak yang berubah — tapi lihat fase 4).
- Bersihkan disk node build dulu (D41); JANGAN hapus tag yang sedang dipakai service.
- Verifikasi entrypoint SEBELUM deploy: `docker inspect --format '{{json .Config.Entrypoint}}'`
  (pembalap Dockerfile yang salah — D41 — masih di sekitar).

Fase 3 — deploy gateway:
- Setelah adapter controller (fase 4) siap dan teruji; `stop-first` sudah kontrak stack.
- Boot pertama akan menolak config/state 7.1 → jalankan `doctor --fix` (sekali; §3.1
  membuktikan jalurnya), lalu `plugins enable acpx|zai|groq --accept-capabilities`
  (keputusan operator yang disengaja — kepercayaan plugin), restart.
- Distribusi image tanpa registry tetap `docker save | scp | docker load` ke
  10.10.0.10/12/13/14 (`nohup`, polling log — jebakan timeout SSH).

Fase 4 — verifikasi terautentikasi (urutan mengecek yang paling bisa gagal senyap):
1. `healthz` + `docker service ps` (task baru Running, bukan Failed — "converged"
   bisa berarti rollback, D41).
2. Pairing device controller, `secrets audit` bersih, kelima agen terlihat,
   `agents.list` bentuk baru terbaca adapter baru.
3. Dispatch E2E lewat controller: task → COMPLETE + usage tercatat (D17) + transkrip
   dua sisi (D33/D40) + blok mentah.
4. Probe level thinking per model (D38) — kalibrasi ulang setelah schema berubah.
5. `permission-bridge-verify.sh` tiga kasus (gerbang izin L0–L3).
6. Pengikatan harness: setel `agents.entries.*.runtime.acp.agent` + `allowedAgents`
   terbatas; buktikan routing hidup (kegagalan yang menyebut harness yang benar)
   dengan kredensial valid.
7. AgentOS: buat/ubah agen dari UI AgentOS; pastikan tulisannya tidak menumbuhkan
   kembali `agents.list`; halaman Semanggi terbuka terautentikasi.

Fase 5 — setelah stabil:
- `openclaw update cleanup --dry-run` dulu, baru buang arsip original migrasi
  (menyimpan ruang; melepas hak rollback — kesengajaan, bukan kebetulan).

Rollback: `docker service rollback` mengembalikan image, **bukan state**. Karena sesi
sudah dimigrasikan ke SQLite (bahkan sebelum POC ini), turun ke 7.1 kembali berarti
kebutaan riwayat — keadaan hari ini. Jalur pulih yang sebenarnya: scale 0, restore
state dari backup fase 0, kembalikan tag lama, naikkan lagi. Jangan pernah dua
gateway terhadap satu state root (kontrak POC-1).

## 8. Perkiraan effort

| Tahap | Isi | Perkiraan |
|---|---|---|
| Prasyarat + backup | token harness, backup + uji restore | 0,5 hari |
| Adapter controller + tes regresi | §4 penuh | 1–1,5 hari |
| Build + lab + deploy | image 8.2, doctor, consent, distribusi | 0,5–1 hari |
| Verifikasi kontrak | dispatch, transkrip, usage, probe level, gerbang izin | 1 hari |
| AgentOS | validasi tulis config bentuk baru, rebuild bila perlu | 0,5–2 hari |
| Pengikatan harness + katalog Brain | alias runtime.acp.agent, allowedAgents, uji routing | 0,5 hari |
| **Total** | | **4–6,5 hari kerja** |

Bandingkan 6.11→7.1 (5,5–8 hari): lompatan kontraknya lebih besar, tetapi kali ini
ada lab yang terbukti, negosiasi metode sudah ada di adapter, dan state sudah
setengah jalan termigrasi.

## 9. Rekomendasi

1. **Lanjutkan ke 8.2 sebagai pekerjaan tersendiri** — bukan karena fitur, tapi karena
   state produksi sudah disentuh 8.1 dan riwayat sesi saat ini terkunci dari gateway
   yang berjalan. Menunda tidak menjaga status quo; status quo-nya sudah retak.
2. Selesaikan dulu prasyarat token harness (sudah menjadi butir tersendiri di
   readiness.md sejak D34) — tanpa itu, verifikasi gerbang izin dan routing harness
   sama-sama buta.
3. Kerjakan adapter controller sebagai PR terpisah yang lulus 324+ test terhadap
   kontrak 8.2 **sebelum** jendela deploy, supaya jendela itu hanya berisi infrastruktur.
4. Jangan mengadopsi `sessions.fork`/`sessions.rewind`/`sessions.compaction.branch`
   dalam pekerjaan ini — catat sebagai kandidat pekerjaan lanjutan (menutup batasan
   FORK), agar upgrade tetap satu-ubahannya.

## Lampiran A — jejak eksekusi lab (ringkas)

```
lab    : docker run ghcr.io/openclaw/openclaw:2026.8.2 (state salinan, npm RO, port 18790)
boot-1 : ditolak — meta.lastTouchedAt; agents.ownership; audit-events-v2
doctor : list→entries (5 agen), ownership=explicit, v10–v15+48, registry bersih
consent: plugins enable acpx|zai|groq --accept-capabilities → ready, 15 plugins
hello  : protocol 4, 372 metode, scopes [operator.admin] (device identity lama diterima)
probe  : prompt→message; idempotencyKey wajib; deliver boolean; workspaceDir ditolak;
         id→agentId; runtime/agentRuntime ditolak di agents.create/update;
         config.set/patch→raw; agent{claude-opus}→unknown agent id;
         main.runtime=acp tidak mengubah dispatch; sessions_spawn bukan RPC
cli    : openclaw config set/get bekerja; `openclaw acp` (bridge) kini subcommand resmi
```

Probe lengkap: `/tmp/kilo/poc5-probe/{probe,enforce,route}.mjs` (berjalan di dalam
container image 8.2, memakai `device-identity.mjs` controller apa adanya).
