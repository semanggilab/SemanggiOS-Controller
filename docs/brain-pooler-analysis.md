# Semanggi di atas AgentOS: analisis konsep "Brain Pooler"

Analisis terhadap usulan: AgentOS memiliki project/tim/skills/tools/template/preset; Semanggi tetap memiliki engine eksekusi task (model, effort, Swarm); workspaceDir Semanggi jadi subdirektori workspaceDir AgentOS; katalog routing menjadi template **Brain** (model + thinking + effort) yang dipetakan ke role AgentOS; Semanggi berperan sebagai **Brain Pooler** yang mengelola worker.

**Kesimpulan singkat: konsepnya tepat dan sejalan dengan pembagian yang sudah terbukti — tetapi satu pengukuran mengubah cara Brain harus diterapkan.** Brain tidak bisa "dipasangkan" ke agen mana pun saat dispatch. Pooler harus **memilih** agen, bukan **mengonfigurasi ulang** agen.

---

## Status implementasi (per 2026-09-02)

Dokumen ini ditulis sebagai analisis sebelum implementasi. Sebagian besarnya kini sudah dibangun, jadi ia dibaca sebagai **alasan di balik rancangan**, bukan sebagai rencana yang masih menunggu.

| Bagian | Status | Di mana |
|---|---|---|
| Opsi B — pooler **memilih** agen | **Terpakai**, dan menjadi aturan mengikat | spec induk §4.0 |
| Model Brain (tabel + CRUD + halaman) | **Selesai** | `brains` · `/api/work/brains` · Settings → Brain |
| Pemetaan (template, role) → level | **Selesai** | `role_levels` · `/api/work/role-levels` · Settings → Role Map |
| Pemetaan (template, role) → Brain | **Selesai** | `brain_map` · `/api/work/brain-map` · Settings → Brain Map |
| Profile project → level default | **Selesai** | `projects.profile` · Settings → Project (D37) |
| Level thinking yang "benar-benar diterima" | **Selesai, lewat probe empiris** — bukan lagi dari iklan `agents.list` | `thinking_levels` · `thinking-probe.mjs` (D38) |
| `effortMode` + bukti | **Selesai** | kolom `brains.effort_mode` / `effort_evidence` |
| Uji koneksi per Brain | **Selesai** | `POST /api/work/brains/{id}/test` |
| Provisioner brain-agent | **Belum** | tugas #5 |
| Discovery project/role dari AgentOS | **Belum** | tugas #4 |
| Worker sebagai binding | **Sebagian** — maknanya sudah ditetapkan (spec §2.5), tabelnya belum diisi lewat discovery | — |
| `tools.fs.workspaceOnly` pada agen Semanggi | **Belum** | butuh penyuntingan config, bukan RPC |

Satu koreksi terhadap isi dokumen ini yang **sudah tidak berlaku**: baris "Thinking — level yang benar-benar diterima, bukan yang diiklankan `agents.list`" di §6 dulu tidak menyebutkan caranya. Caranya sekarang ada dan mengikat: **probe dispatch nyata per level, satu model pada satu waktu** (D38). Membaca iklan agen MUST NOT dipakai lagi, bahkan sebagai nilai awal.

---

## 1. Pengukuran yang menentukan

Diuji langsung: dispatch ke `semanggi-glm-5-1` (dikonfigurasi `zai/glm-5.1`) sambil meminta model lain, dengan device ber-scope `["operator.admin","operator.read","operator.write"]`.

```text
override zai/glm-5.2           → ✗ Model override "zai/glm-5.2" is not allowed
                                    for agent "semanggi-glm-5-1"
override groq/qwen3.6-27b      → ✗ (pesan sama)
thinking=max tanpa override    → ✗ Thinking level "max" is not supported for zai/glm-5.1
tanpa override (baseline)      → ✓ berjalan di zai/glm-5.1
```

**Model yang boleh dijalankan sebuah agen adalah allowlist milik agen itu — bahkan `operator.admin` tidak bisa menembusnya.** Ini mengoreksi pemahaman saya sebelumnya (D14 menyebut override "membuat model yang dirutekan benar-benar berjalan"; ternyata hanya berlaku di dalam himpunan model agen).

Konsekuensi langsung untuk usulan Anda: **satu agen per role tidak cukup.** Kalau "Builder" adalah satu agen, ia hanya bisa menjalankan satu model. Brain tidak bisa disuplai per task ke agen yang sama.

### Kosakata thinking juga bergeser

Sekaligus terukur: setelah plugin zai naik ke 2026.7.1, level yang diterima bertambah — `glm-5.1` kini menerima `off, on, low, high` (sebelumnya diiklankan `off, low`), `glm-5.2` menerima `off, on, low, high, max`. Katalog kita memakai `low` untuk `glm-5.1-on`, dan itu **masih diterima** — jadi tidak ada yang patah. Tetapi `agents.list` melaporkan daftar yang lebih sempit daripada yang sebenarnya diterima, jadi iklan itu tetap tidak bisa dipercaya (konsisten dengan D21).

## 2. Dua cara menerapkan Brain, dan mana yang saya sarankan

### Opsi A — Pooler mengonfigurasi ulang agen (ditolak)

`agents.update {agentId, model}` terbukti berfungsi. Jadi pooler bisa: ambil agen dari pool → ubah modelnya ke model Brain → dispatch → kembalikan.

Kelihatannya elegan, dan namanya cocok dengan "pooler". Tetapi:

- **Balapan.** Dua task yang mengambil agen yang sama akan saling menimpa model. Butuh lease per-agen — mekanisme baru yang menduplikasi lease workspace.
- **Churn config di NFS.** Setiap dispatch menulis `openclaw.json`. Berkas itu sudah punya dua penulis (D32); menambah tulisan berfrekuensi tinggi di atas NFS adalah tempat terakhir yang saya mau taruh jalur kritis.
- **Jendela tidak konsisten.** Antara `agents.update` dan `agent` ada celah di mana agen menjalankan model yang bukan miliknya menurut siapa pun.

### Opsi B — Pooler memilih dari agen yang sudah ada (disarankan)

Buat agen sebagai **hasil silang (role × Brain)** di dalam workspace project, lalu pooler tinggal memilih.

```text
project alpha (workspace AgentOS)
├── alpha-builder-glm52high      Builder   × Brain "deep-coding"
├── alpha-builder-glm51on        Builder   × Brain "daily-coding"
├── alpha-reviewer-glm52max      Reviewer  × Brain "critical-review"
├── alpha-tester-qwen            Tester    × Brain "fast-check"
└── alpha-learner-geminiflash    Learner   × Brain "cheap-synthesis"
```

Tidak ada mutasi, tidak ada balapan, tidak ada lease baru. Pooler menjadi **penyeleksi**, dan seleksi itu persis yang sudah dilakukan `agent-registry` hari ini (cocokkan provider+model+thinking).

**Berapa banyak agennya?** Bukan hasil silang penuh. Pemetaan role→Brain umumnya 1–3 Brain per role, bukan semua. Untuk template `software` (Builder, Reviewer, Tester, Learner) dengan rata-rata 2 Brain → **8 agen per project**. Sepuluh project → 80 agen. Itu entri config, bukan proses; `agents.list` menanganinya tanpa masalah.

Bandingkan dengan sekarang: agen per (workspace × model) yang lahir per task dan tidak pernah mati. Opsi B justru **mengurangi** jumlah agen sekaligus membuatnya bermakna.

## 3. Pemetaan konsep

| Konsep | Pemilik | Isi |
|---|---|---|
| **Project / workspace** | AgentOS | template, sourceMode, rules, scaffold docs/memory/skills |
| **Role** | AgentOS | Builder, Reviewer, Tester, Learner, Browser, … (dari template) |
| **Tools & policy agen** | AgentOS | preset worker/setup/browser/monitoring + fileAccess/networkAccess/installScope |
| **Skills** | AgentOS | 9 markdown `project-*` yang membentuk perilaku |
| **Brain** | **Semanggi** | (provider, model, thinking, effortMode) + bukti |
| **Pemetaan role → Brain** | **Semanggi** | per (project, role), dengan default global |
| **Agen (role × Brain)** | **Semanggi** (dibuat via RPC) | entitas runtime yang benar-benar dipilih saat dispatch |
| **Worker** | **Semanggi** | binding runtime: (role, Brain, batas konkurensi, akses project) |
| **Task, antrean, quota, lease, prioritas, atribusi** | **Semanggi** | seluruh engine eksekusi |

### Kenapa agen (role × Brain) HARUS dibuat Semanggi, bukan AgentOS

Terukur: **AgentOS mengabaikan model yang diminta saat membuat agen** — minta `zai/glm-5.2`, tertulis `zai/glm-4.7-flash`. Karena model agen adalah allowlist yang menentukan Brain apa yang bisa jalan, membiarkan AgentOS membuatnya berarti Brain-nya salah dan dispatch ditolak.

Jadi aturannya jelas dan bisa ditegakkan:

> AgentOS membuat **role agent** (satu per role, model apa pun — tidak dipakai untuk eksekusi Semanggi).
> Semanggi membuat **brain agent** lewat RPC `agents.create {name, workspace, model}`, yang terbukti menghormati model.

Penanda kepemilikan sudah ada dan terukur (D32): `agentDir` di `.openclaw/agents/` = buatan AgentOS; di `state/agents/` = buatan Semanggi. `GET /api/work/agents` sudah mengklasifikasikannya.

## 4. workspaceDir bersarang: berhasil, tetapi mengubah satu norma

Usulan Anda benar secara mekanis. Workspace AgentOS jadi induk:

```text
<workspace-agentos>/            ← agen terikat di sini
├── AGENTS.md  SOUL.md  MEMORY.md  TOOLS.md
├── memory/  docs/  skills/
├── source/
└── executions/<task-id>/       ← keluaran Semanggi, lease di sini
```

Ini bahkan **sudah** bentuk yang ditulis spec induk §6.1.

**Tetapi ada konsekuensi yang harus disadari.** Karena tidak ada `workspaceDir` per dispatch (D34), agen terikat pada **satu** path. Kalau agen diikat ke root project supaya bisa membaca `AGENTS.md`/`memory/`/`skills/` — dan itu justru alasan menumpang AgentOS — maka:

> Sandbox mendapat akses ke **seluruh project**, bukan hanya `executions/<task-id>`.

Spec §6.1 menyatakan sebaliknya: *"Sandbox task mendapat `workspaceAccess: rw` HANYA ke `executions/<task-id>`"*. Usulan ini **melonggarkan** itu.

Penilaian saya: **terima, dengan dua kontrol pengganti.**

1. **Lease tulis Semanggi tetap di subdirektori** — ia mencegah dua task saling menimpa, dan itu risiko yang paling nyata.
2. **Setel `tools.fs.workspaceOnly` pada agen Semanggi** — saat ini tidak disetel sama sekali, sehingga agen kita justru kurang terkurung daripada agen AgentOS. Ini mengurung ke root project, yang menjaga isolasi **antar-project**.

Yang hilang tinggal isolasi **antar-task di dalam satu project**, dan itu domain kepercayaan yang sama — mereka sudah berbagi `source/`. Yang tersisa adalah risiko agen menulis di luar direktori eksekusinya: bisa terdeteksi, tidak katastrofik.

Catatan: `tools` **tidak bisa disetel lewat RPC** (terukur ditolak di `agents.create` dan `agents.update`). Satu-satunya jalan adalah menulis config — artinya lewat AgentOS, atau lewat langkah provisioning yang menyunting berkas. Ini pekerjaan nyata yang harus dijadwalkan, bukan asumsi.

## 5. Worker vs role: menyelesaikan tumpang tindih

Sekarang ada dua taksonomi yang tidak saling tahu — role di `project.json` milik AgentOS, dan tabel `workers` milik Semanggi. Usulan Anda memberi jalan keluar yang rapi:

> **Worker Semanggi = binding runtime dari (role AgentOS, Brain, batas konkurensi, akses project).**

Jadi worker bukan lagi taksonomi tandingan, melainkan *bagaimana* sebuah role dijalankan. "Builder di project alpha, memakai Brain deep-coding, maksimum 2 bersamaan."

Ini juga menutup celah yang terukur (D29): task tanpa worker terparkir selamanya di `WAIT_WORKER`. Dengan worker diturunkan dari role project, setiap task dalam sebuah project otomatis punya kandidat worker.

Role dibaca dari `project.json` — **baca saja**, tidak pernah ditulis. Itu menjaga aturan "masing-masing memiliki miliknya".

## 6. Halaman konfigurasi Brain

Isinya harus memuat hal yang sudah terukur, bukan sekadar dropdown:

| Kolom | Kenapa |
|---|---|
| Nama Brain | mis. `deep-coding`, `fast-check` |
| Provider + model | dari katalog gateway |
| Thinking | level yang **benar-benar diterima**, bukan yang diiklankan `agents.list` |
| `effortMode` | **jaminan** vs **preferensi** |
| Bukti | mengapa ia preferensi (mis. "gemini: off 533 vs high 316, n=3") |
| Ketersediaan | dari tabel resources |

Kolom `effortMode` tidak boleh dihilangkan. Brain bernama "gemini-high" adalah janji yang providernya abaikan; operator yang memilih berdasarkan nama akan salah menilai biaya dan kualitas.

## 7. Yang perlu dibangun

Diurutkan dari yang paling menentukan. Empat butir pertama sudah selesai; coretan menandai yang tidak perlu dikerjakan lagi.

1. ~~**Model Brain di controller** — tabel + CRUD + halaman.~~ **Selesai.** Tabel `brains`, endpoint `/api/work/brains`, panel Settings → Brain dengan form modal, dropdown provider/model dari cache gateway, dan uji koneksi per baris.
2. ~~**Pemetaan (project, role) → Brain[]** dengan default global.~~ **Selesai**, dengan satu koreksi bentuk: pemetaannya **(template, role)**, bukan (project, role) — project mewarisi lewat `template`-nya, sehingga menambah project tidak menuntut menyalin ulang seluruh pemetaan. Level per role di `role_levels`, pemaku Brain di `brain_map`.
3. **Provisioner brain-agent** — untuk tiap (project, role, brain) yang dipetakan, pastikan ada agen lewat RPC. Idempoten, memakai konvensi nama yang sudah ada. **Masih terbuka** (tugas #5); sampai ada, agen dibuat tangan dan `WAIT_RESOURCE` adalah gejala yang paling sering muncul karenanya.
4. **Discovery project/role dari AgentOS** — baca `project.json` di workspace, turunkan role, sinkronkan ke tabel `projects`/`workers` Semanggi. **Masih terbuka** (tugas #4). Sementara ini pendaftaran workspace → project dilakukan operator lewat tombol di Settings → Project, dan `template` disimpan Semanggi sebagai salinan yang tidak bisa disunting (D37).
5. **Worker sebagai binding** — ubah makna tabel `workers` sesuai §5. **Maknanya sudah ditetapkan** (spec §2.5); pengisiannya menunggu butir 4.
6. **Setel `tools.fs.workspaceOnly`** pada agen Semanggi (lewat penyuntingan config, bukan RPC). **Masih terbuka**, dan tetap satu-satunya kontrol keamanan tanpa jalur RPC.
7. **Reaper disesuaikan** — kriteria "workspace lenyap" tetap benar, tetapi kini juga perlu memungut brain-agent yang pemetaannya dihapus. **Menunggu butir 3.**

**Satu butir baru yang tidak ada di daftar asli, dan ternyata prasyarat butir 1:** kosakata level thinking per model MUST diukur lewat probe, bukan dibaca dari iklan agen (D38). Tanpa itu, form Brain menawarkan level yang akan ditolak saat dispatch — dan penolakannya muncul jauh kemudian, sebagai task yang tidak jalan.

## 8. Risiko dan pertanyaan terbuka

**Yang saya anggap risiko nyata:**

- **Dua penulis config tetap ada.** AgentOS menulis berkas langsung; Semanggi lewat RPC (yang berujung gateway menulis berkas yang sama). Frekuensinya rendah pada Opsi B, tetapi tidak nol. Provisioning brain-agent sebaiknya dijalankan sebagai operasi batch terjadwal, bukan pada jalur dispatch.
- **`tools` hanya bisa lewat berkas.** Ini satu-satunya kontrol keamanan yang tidak punya jalur RPC, dan justru yang paling ingin kita tegakkan.
- **AgentOS single-admin.** Semua yang bisa masuk AgentOS bisa mengubah project, tim, dan policy agen — tanpa atribusi. Sementara sisi Semanggi punya identitas per operator. Ketimpangan ini tetap ada dan MUST disadari saat memutuskan siapa boleh masuk AgentOS.
- **Gerbang izin ACP belum terverifikasi** di 7.1 (token harness tidak sah). Ini tetap blocker keamanan terlepas dari rancangan ini.

## 9. Tiga pertanyaan terbuka — sudah terjawab (2026-08-31)

### 9.1 Satu agen = tepat satu model. Terukur.

```text
agents.create { model: ["zai/glm-5.1","zai/glm-5.2"] }  → at /model: must be string
agents.create { models: [...] }                          → unexpected property 'models'
agents.create { model, allowedModels: [...] }            → unexpected property 'allowedModels'
agents.update { model: [...] }                           → at /model: must be string
```

Tidak ada agen multi-model. Karena itu keinginan "instans paralel boleh punya model masing-masing" **hanya bisa dipenuhi lewat agen yang berbeda** — yang justru mengunci Opsi B (role × Brain) sebagai satu-satunya bentuk yang benar, bukan sekadar yang disarankan.

Semantik yang berlaku jadi: satu task = satu agen = satu model; paralelisme lintas model = paralelisme lintas agen. Batas konkurensi per worker mengatur berapa banyak yang boleh jalan bersamaan.

### 9.2 `modelProfile` → level → Brain: sudah ada mesinnya

Keputusan operator: `balanced → normal`, `fast → low`, `quality → critical`, dengan pemetaan tambahan per template yang bisa disetel admin per anggota tim.

**Level itu sudah ada di routing kita** sebagai `routeClass`. `config/routing.json` sudah memakai persis tiga kelas itu:

```jsonc
"routes": {
  "architecture":  { "critical": {...}, "normal": {...} },
  "documentation": { "normal": {...},   "low": {...} },
  "analysis":      { "critical": {...}, "normal": {...} }
}
```

Jadi yang ditambahkan bukan konsep baru, melainkan dua lapis pemetaan di atasnya:

```text
modelProfile project   →  level default        (balanced|fast|quality → normal|low|critical)
template × role        →  level override       (disetel admin, per template)
task                   →  level override       (tetap bisa per task — §5.4)
level + category       →  kandidat Brain       (routing yang sudah ada)
```

Contoh yang Anda berikan jatuh persis ke bentuk ini:

| Template | Profile | Builder | Reviewer | Tester | Learner | Browser |
|---|---|---|---|---|---|---|
| software | balanced | normal | normal | normal | **critical** | — |
| frontend | fast | low | low | low | **normal** | low |
| research | balanced | normal (Lead) | **critical** | normal (Archivist) | — | — |

Perhatikan Learner/Reviewer sering naik satu tingkat di atas profil projectnya — itu justru alasan pemetaan per-role diperlukan dan tidak bisa diturunkan otomatis dari `modelProfile` saja.

**Fleksibilitas di tengah jalan tetap terjaga** karena override per task sudah ada dan terbukti: `PATCH /api/work/tasks/{id}` dengan `modelPolicy`, lalu `run`. Konfigurasi global hanya menentukan default, bukan kunci.

### 9.3 Sandbox: OpenClaw memang membedakan dua workspace — tetapi tidak lewat jalur kita

Ditemukan di `dist/agent-tools-*.js`:

```js
function readOnlySandboxReadMounts(sandbox) {
  if (sandbox.workspaceAccess === "ro" && sandbox.agentWorkspaceDir !== sandbox.workspaceDir)
    mounts.push({ containerRoot: SANDBOX_AGENT_WORKSPACE_MOUNT,
                  hostRoot: sandbox.agentWorkspaceDir });
  ...
}
```

Jadi runtime **memang** memisahkan `agentWorkspaceDir` dari `workspaceDir`, dan ketika `workspaceAccess: "ro"` workspace agen dipasang terpisah di mount-point tersendiri. Persis bentuk yang Anda minta: sandbox punya workspace sendiri, agen punya miliknya.

**Tetapi tidak ada jalur untuk menyetelnya dari sisi kita.** Metode `agent` menolak `workspaceDir` dan `cwd` (`"cwd is reserved for plugin-owned subagent runs"`), dan `sessions.create` juga menolak keduanya. Yang tersisa: `sandbox` per agen di berkas config — dan agen POC-3 memang punya (`"sandbox": {"mode": "off"}`), jadi blok itu sah di skema agen. Yang belum terbukti adalah apakah ia menerima `workspaceDir` sendiri.

Ini kandidat terkuat berikutnya, dan ia bisa diuji dengan biaya rendah: tambahkan `sandbox.workspaceDir` pada satu agen uji di config, restart gateway, lihat apakah skema menerimanya. Pelajaran dari percobaan `agentRuntime` (D34) berlaku: kalau ditolak, **gateway gagal boot** — jadi ujinya harus dengan backup dan pada entri sekali pakai.

## 10. Worker lintas project: tegangan yang Anda tunjuk

Anda benar bahwa ini bagian paling menarik. Bentuknya:

```text
Worker  (organisasional, lintas project)  = (role, Brain, batas konkurensi)
Agent   (runtime, selalu per workspace)   = (workspace, model)
```

Karena agen selalu terikat satu workspace, **satu worker memetakan ke N agen — satu per project yang ia layani.** Worker adalah abstraksi di atas agen, bukan sinonimnya.

Tiga konsekuensi konkret:

**1. `worker.agent_ref` harus jadi petunjuk, bukan ikatan.** Skema sekarang menyimpan satu `agent_ref` per worker. Untungnya registry hanya memakainya sebagai `preferAgentId` dan tetap jatuh ke pencocokan (workspace, model, thinking) bila tidak cocok — jadi perubahannya kecil: jadikan opsional, dan resolusi agen dilakukan per (project, brain) saat dispatch.

**2. Batas konkurensi worker jadi anggaran organisasi, bukan per project.** `repos.workers.activeCount(worker.id)` sudah menghitung lintas project. Itu justru semantik yang benar untuk peran organisasi: "Builder boleh mengerjakan 2 hal sekaligus, di mana pun".

**3. Tetapi ada bahaya kelaparan.** Satu project yang sibuk bisa menghabiskan seluruh anggaran Builder dan membuat project lain menunggu tanpa batas. Scheduler WFQ kita mengatur **urutan** berdasarkan bobot project, tetapi anggaran itu sendiri milik worker.

Dua pilihan, dan menurut saya yang pertama lebih baik:

- **(a) Andalkan WFQ dengan reservasi minimum.** Tetapkan anggaran global per worker, tetapi jamin setiap project aktif mendapat minimal satu slot. Sederhana, dan menjaga makna "kapasitas organisasi".
- **(b) Sub-limit per (worker, project).** Lebih dapat diprediksi, tetapi mengubah worker menjadi kumpulan kuota kecil dan menghilangkan gunanya sebagai kapasitas bersama.

Lease workspace tidak terpengaruh sama sekali — ia per path, jadi tidak ada interferensi lintas project di disk.

**Satu hal yang MUST diputuskan bersamaan:** apakah sebuah Brain juga punya batas konkurensinya sendiri. Kuota provider sudah dijaga di tingkat resource (`resources.concurrencyLimit`), jadi menambah batas di tingkat Brain akan menduplikasi. Saran saya: **jangan** — biarkan kuota provider yang menjaga, dan worker menjaga kapasitas peran.

## 11. Lima klarifikasi operator (2026-08-31)

### 11.1 NFS ada di atas segalanya, bukan di level workspace

```text
10.10.0.1:/opt/semanggi/volumes/shared/service
   └─ dipasang di  /opt/semanggi/volumes/shared/service   (nfs4)
      ├── agentos/      runtime + cermin config AgentOS
      ├── controller/   controller.db (SQLite)
      ├── openclaw/     config/ · state/ · workspaces/
      │                 └── workspaces/<project>/executions/<task>/
      ├── browser-worker/
      └── backups/
```

Jadi workspace AgentOS bukan titik mount — ia beberapa tingkat **di dalam** satu export NFS yang menampung seluruh state layanan. Konsekuensinya penting untuk pertanyaan berikutnya: **semua workspace, semua execution dir, dan state gateway berada di satu filesystem yang sama dan terlihat oleh semua node.**

Artinya: kalau dua sandbox tidak saling melihat perubahan, itu **bukan** karena NFS. NFS sudah membuat semuanya terlihat. Yang menentukan adalah apa yang di-*mount* ke dalam container.

### 11.2 Berbagi hasil antar sandbox: NFS memungkinkan, mount yang memutuskan

Pertanyaannya tepat: kalau sandbox hanya rw ke `executions/<task-id>`, bagaimana sandbox lain melihat perubahannya?

Jawabannya: **tidak, kecuali ia juga memount path itu.** Isolasi mount adalah isolasi yang sesungguhnya; NFS hanya menjamin bahwa kalau dua container memount path yang sama, keduanya melihat byte yang sama.

Tiga bentuk berbagi, dan ketiganya sah untuk kebutuhan berbeda:

**(a) Baca-bersama lewat `workspaceAccess: "ro"`** — inilah mekanisme yang ditemukan di runtime:

```js
if (sandbox.workspaceAccess === "ro" && sandbox.agentWorkspaceDir !== sandbox.workspaceDir)
  mounts.push({ containerRoot: SANDBOX_AGENT_WORKSPACE_MOUNT, hostRoot: sandbox.agentWorkspaceDir });
```

Sandbox mendapat **rw ke direktori eksekusinya sendiri** dan **ro ke workspace induk**. Task B bisa membaca keluaran task A tanpa bisa merusaknya. Ini bentuk yang paling sesuai dengan permintaan Anda: isolasi tulis dipertahankan, hasil tetap terlihat.

**(b) Promosi eksplisit.** Keluaran yang sudah direview dipindah ke `source/` atau `artifacts/`, dan itulah yang dibaca task lain. Ini yang ditulis spec §6.1 (*"Hasil direview lalu merge ke source"*). Lebih lambat, tetapi satu-satunya bentuk yang membuat "hasil setengah jadi" tidak menular.

**(c) Lease baca-bersama.** Sudah ada dan terbukti (D22): task dengan `workspaceMode: "read"` berbagi lease dengan pembaca lain dan hanya menunggu bila ada penulis. Ini mengatur *siapa boleh jalan bersamaan*, bukan *apa yang terlihat* — jadi ia melengkapi (a), bukan menggantikannya.

**Rekomendasi:** (a) sebagai bentuk baku, (b) untuk hasil yang menjadi masukan resmi project, (c) sudah berjalan. Yang belum terbukti: apakah `sandbox.workspaceDir` bisa disetel per agen di config. Itu satu uji yang tersisa, dan risikonya nyata — skema config menolak field asing dengan cara membuat gateway gagal boot (D34).

### 11.3 Skill: mekanismenya markdown, dan Semanggi belum punya sama sekali

Terukur, skill AgentOS hidup sebagai direktori di dalam workspace:

```text
<workspace>/skills/agent-policy-<agent-id>/SKILL.md
```

dan direferensikan dari entri agen di config (`"skills": ["agent-policy-<id>"]`). Isinya markdown yang di-generate saat provisioning:

```markdown
# poc2-e1 worker Policy
Preset: Worker

## Output routing
- Final deliverables belong in the current deliverables run folder for the task.
- Treat MEMORY.md, memory/*.md, docs/brief.md ... as shared workspace context.

## Operating rules
- Install scope: none. Do not run package installation commands.
- File access: extended. / Network access: enabled when the task requires it.

## Workspace team
- Use these exact agent ids when referring to teammates or handing work off:
- poc2-e1 worker (`poc2-e1-poc2-e1-worker`) · you · Worker.
```

Tiga hal yang terbaca dari sini:

1. **Skill = perilaku, bukan kapabilitas.** Ia menerjemahkan `policy` menjadi kalimat yang dibaca model. Kapabilitas tetap dari `tools`.
2. **Bagian "Workspace team" adalah mekanisme handoff.** Agen tahu rekannya dan id persisnya. Inilah yang membuat "tim" nyata di tingkat prompt, bukan sekadar metadata.
3. **Ada ketidakcocokan yang layak dicatat**: SKILL.md tertulis *"File access: extended"* padahal config agen yang sama menyetel `tools.fs.workspaceOnly: true`. Teks kebijakan dan penegakan teknis bisa berbeda — jangan percaya salah satunya sendirian.

**Workspace Semanggi tidak punya folder `skills/` sama sekali.** Jadi agen kita berjalan tanpa perilaku terikat role: tanpa aturan output routing, tanpa kesadaran tim, tanpa terjemahan policy.

Untuk memperbaikinya, per (project, role):

```text
<workspace>/skills/semanggi-role-<role>/SKILL.md   ← ditulis provisioner Semanggi
   ├── output routing  → executions/<task-id>/ dan artifacts/
   ├── operating rules → dari preset AgentOS role tersebut
   ├── brain           → model + effort yang sedang dipakai, dan BATASNYA
   └── workspace team  → roster dari project.json (dibaca, tidak ditulis)
```

Bagian `brain` adalah tambahan kita, dan ia berguna justru karena `effortMode`: agen yang berjalan dengan Brain preferensi sebaiknya tahu bahwa level effort-nya tidak dijamin, supaya ia tidak mengandalkan penalaran panjang yang tidak pernah terjadi.

**Kendalanya sama seperti `tools`:** `agents.create`/`update` menolak `skills`, jadi pengikatan hanya bisa lewat berkas config. Menulis `SKILL.md`-nya sendiri bebas — itu hanya berkas di workspace.

### 11.4 Di mana fungsi inti Semanggi diletakkan

Pertanyaan paling penting, dan jawabannya: **tetap di Semanggi, dan AgentOS tidak bersaing di situ.**

Saya periksa planner AgentOS karena namanya menjanjikan tumpang tindih. Ternyata tidak:

```
createWorkspacePlan · updateWorkspacePlan · submitWorkspacePlanTurn
simulateWorkspacePlan · deployWorkspacePlan
```

Itu **perencana workspace** — wizard percakapan untuk menyusun *project dan timnya*, lalu men-deploy-nya. Ia merencanakan **siapa yang bekerja**, bukan **apa yang dikerjakan**. Tidak ada dekomposisi task, tidak ada assignment lintas agen, tidak ada antrean.

Jadi pembagiannya justru bersih:

```text
AgentOS planner   : permintaan → bentuk project + tim        (sekali, saat setup)
Semanggi planner  : permintaan → himpunan task + Brain       (terus-menerus)
```

Bentuk yang saya sarankan:

```text
    satu kotak input (halaman Semanggi di dalam AgentOS)
                    │
                    ▼
        Intent Router  (CHAT | WORK | TASK)          ← sudah ada, rule-based
                    │ WORK
                    ▼
        Planner Brain  (L1/L2, dijalankan lewat dispatch biasa)
                    │  keluaran: daftar task + kategori + level
                    ▼
        Task set  →  routing (level+kategori → Brain)  →  worker  →  agen
```

Yang penting dari bentuk ini: **planner adalah Brain juga.** Ia bukan komponen istimewa — ia task yang keluarannya berupa task lain, berjalan lewat dispatch, dicatat token dan biayanya, dan tunduk pada quota yang sama. Itu membuat "berapa ongkos merencanakan" bisa dijawab, dan membuat planner bisa diganti modelnya lewat halaman Brain seperti yang lain.

Yang sudah ada: intent router (§8.2), pembuatan task, routing, worker, dispatch. Yang belum: langkah dekomposisi itu sendiri — mengubah satu kalimat menjadi beberapa task dengan kategori dan level masing-masing. Itu pekerjaan yang jelas dan terbatas, bukan lapisan baru.

**Jadi menumpang di AgentOS tidak memindahkan fungsi ini ke mana-mana.** Yang pindah hanyalah *tempat kotak inputnya digambar*.

### 11.5 Kelaparan: opsi A, dan pengakuan bahwa ia tidak cukup

Keputusan: WFQ dengan reservasi minimum. Diterima.

Anda benar bahwa itu tidak menyelesaikan segalanya: **kalau jumlah project melebihi jumlah worker, kelaparan tetap terjadi** — reservasi minimum hanya bisa dipenuhi kalau ada slot untuk direservasi. Ini batas aritmetika, bukan kekurangan algoritma, dan sebaiknya ditampilkan apa adanya di UI ("7 project aktif, 4 slot Builder — 3 project menunggu").

Karena itu kontrol manual menjadi **MUST**, bukan pelengkap. Dua primitifnya sudah ada dan terbukti:

- `expedite` — menaikkan prioritas sementara, reversibel sendiri
- `stop` → `BLOCKED` → `RESUMABLE` — menghentikan tanpa membuang pekerjaan (D26)

Yang belum ada: pandangan lintas project dan UI-nya.

**Satu aturan rancangan yang saya anggap mengikat:** *preemption harus menyebut korbannya.*

"Paksa jalan" tidak boleh diam-diam menghentikan pekerjaan orang lain. Kalau tidak ada slot, UI MUST menampilkan apa yang harus berhenti agar ini bisa jalan, dan operator memilih secara eksplisit:

```text
Menjalankan TASK-91 sekarang membutuhkan 1 slot Builder.
Yang sedang berjalan:
  [ ] TASK-77  project beta   berjalan 4 menit   Builder × deep-coding
  [ ] TASK-82  project gamma  berjalan 12 detik  Builder × daily-coding
Hentikan yang dipilih lalu jalankan TASK-91?
```

Alasannya sama dengan yang mendasari konfirmasi di Slack (D27): tindakan yang menghentikan pekerjaan orang lain tidak boleh bisa dilakukan tanpa melihat siapa yang dihentikan. Dan karena setiap tindakan sudah beratribusi operator (D27), catatan "siapa menghentikan pekerjaan siapa" ada dengan sendirinya di event log.

## 12. Akses tulis ke `source/` dan `artifacts/`: diterima, dengan satu tegangan

Keputusan operator: ketiga bentuk berbagi diterapkan, dan `source/`/`artifacts/` ikut mendapat rw supaya hasil bisa dipromosikan.

Bentuk mount yang diminta:

```text
ro   <workspace>/                        induk, untuk membaca hasil orang lain
rw   <workspace>/executions/<task-id>/   ruang kerja sendiri
rw   <workspace>/artifacts/              promosi hasil
rw   <workspace>/source/                 merge ke sumber
```

Ini bisa dilakukan (mount rw bersarang di dalam ro akan menutupi bagiannya). **Tetapi ia berbenturan dengan lease.**

Lease tulis ada justru supaya dua penulis tidak bertabrakan pada satu workspace (P4-07, D22). Kalau **setiap** task punya rw ke `source/`, dua task yang berjalan bersamaan di project yang sama bisa menulis `source/` serentak — persis tabrakan yang lease cegah. Lease-nya jadi menjaga pintu yang sudah dibuka lewat jendela.

Jalan keluar yang saya sarankan, dan menurut saya ia tidak mengurangi apa pun yang Anda inginkan:

| Direktori | Akses | Alasan |
|---|---|---|
| `executions/<task-id>/` | **rw** selalu | ruang sendiri, tidak pernah bertabrakan |
| `artifacts/<task-id>/` | **rw** selalu | promosi hasil, tetapi **per task** — tidak bertabrakan |
| `<workspace>/` (induk) | **ro** | membaca hasil task lain |
| `source/` | **rw hanya bila task memegang lease tulis** | ini satu-satunya tempat yang benar-benar bersama |

Kuncinya `artifacts/<task-id>/`, bukan `artifacts/`. Promosi tetap terjadi dan hasilnya terlihat semua orang (karena induknya ro), tetapi dua task tidak pernah menulis berkas yang sama.

`source/` tetap di belakang lease karena di situlah tabrakan benar-benar merugikan — dua task menyunting repo yang sama tanpa koordinasi. Dan mekanismenya sudah ada: task dengan `workspaceMode: "write"` memegang lease eksklusif atas workspace, jadi ia memang boleh menyentuh `source/`; task `read` tidak.

**Yang jujur harus disebut:** bentuk mount di atas **belum bisa ditegakkan dari sisi kita hari ini.** Mount sandbox mengikuti workspace agen, dan tidak ada parameter per dispatch (D34). Jadi untuk sekarang penegakannya ada pada **lease**, bukan pada mount — konvensi yang dipatuhi karena instruksi, bukan karena kernel menolak.

Itu membuat satu uji jadi bernilai tinggi: apakah `sandbox.workspaceDir` bisa disetel per agen di config. Kalau bisa, seluruh tabel di atas menjadi penegakan sungguhan. Kalau tidak, ia tetap konvensi sampai upstream menyediakan jalannya.

## 13. Memakai skill atau tidak

### 13.1 Apa yang sebenarnya dibeli oleh skill

Skill bukan kapabilitas — ia perilaku. Dari SKILL.md yang terukur, isinya empat hal:

1. **Output routing** — ke mana hasil ditulis
2. **Terjemahan policy** — "jangan install", "akses jaringan bila perlu"
3. **Roster tim** — id persis rekan kerja, untuk handoff
4. **Konteks bersama** — berkas mana yang dibaca sebelum menyunting besar

### 13.2 Yang relevan untuk kita, dan yang tidak

| Isi skill | Berguna untuk Semanggi? |
|---|---|
| Output routing | **Sangat.** Hari ini tidak ada yang membuat agen menulis ke `executions/<task-id>` selain instruksi — dan mount belum menegakkannya (§12) |
| Terjemahan policy | **Berisiko.** Kita belum menyetel `tools` sama sekali; menuliskan aturan yang tidak ditegakkan justru menciptakan kebohongan (lihat §13.4) |
| Roster tim | **Kurang relevan.** Orkestrasi kita eksternal — Semanggi yang menugaskan, agen tidak saling menyerahkan pekerjaan |
| Konteks bersama | **Sangat**, dan justru inilah alasan menumpang AgentOS: `MEMORY.md`, `memory/*.md`, `docs/` |

Jadi jawabannya bukan ya/tidak. Dua dari empat bagian berguna, satu berisiko, satu tidak relevan.

### 13.3 Biaya

SKILL.md yang terukur berukuran 1.426 byte ≈ 350–400 token. Run kita yang terukur memakai ~10.176 token cache-read dan ~290 token input segar — artinya konteks sistem **sudah** ter-cache. Menambah 400 token ke bagian yang stabil akan ikut ter-cache setelah pemakaian pertama.

**Biayanya dapat diabaikan.** Ini bukan pertimbangan yang menentukan.

### 13.4 Alasan sesungguhnya untuk berhati-hati

Bukan biaya, melainkan **sinkronisasi**. Sudah ada buktinya di cluster:

```text
SKILL.md  : "File access: extended. Prefer the workspace, but you may
             touch adjacent paths when the task explicitly needs them."
config    : "tools": { "fs": { "workspaceOnly": true } }
```

Teks kebijakan dan penegakan teknis **bertentangan**, dan sudah begitu sejak Agustus. Model membaca yang pertama; kernel menegakkan yang kedua.

> Skill yang berbohong lebih buruk daripada tidak ada skill. Tanpa skill, model tidak tahu aturannya. Dengan skill yang salah, model **yakin** ia tahu.

Risiko kedua: `skills[]` pada entri agen **tidak bisa disetel lewat RPC** (terukur ditolak di `agents.create` dan `agents.update`). Mengikat skill berarti menulis berkas config — pola yang selama ini kita hindari karena AgentOS juga menulisnya (D32).

Risiko ketiga: AgentOS me-*generate* ulang `agent-policy-*` saat provisioning. Kalau kita menaruh milik kita dengan nama yang sama, ia bisa tertimpa.

### 13.5 Rekomendasi: pakai, tetapi bagi menurut apa yang stabil

Jangan pilih biner. Bagi menurut **seberapa sering isinya berubah dan seberapa fatal kalau basi**:

**Lewat berkas skill** — hal yang stabil per (project, role), jarang berubah, dan berguna dilihat operator di UI AgentOS:

```markdown
# <Role> — Semanggi

## Output routing
- Hasil akhir ke `executions/<task-id>/`; promosi ke `artifacts/<task-id>/`.
- Jangan menulis ke root workspace.

## Konteks bersama
- Baca MEMORY.md, memory/*.md, docs/ sebelum perubahan besar.
```

**Lewat instruksi task** — hal yang berubah tiap dispatch dan berbahaya kalau basi:

```text
Brain: zai/glm-5.2 @ high (jaminan)      ← atau: (preferensi — provider mengabaikannya)
Ruang kerja: executions/TASK-91/
Mode workspace: write (kamu memegang lease; source/ boleh disentuh)
```

Semanggi sudah menyusun instruksi tiap dispatch, jadi bagian kedua tidak butuh mekanisme baru sama sekali — dan ia **tidak mungkin basi**, karena dihasilkan dari sumber yang sama dengan keputusan routing.

**Dan satu aturan yang mengikat:** jangan tuliskan aturan yang tidak kita tegakkan. Selama `tools` belum disetel, skill Semanggi **tidak boleh** memuat klaim tentang akses berkas atau jaringan. Menuliskannya hanya akan mengulangi kesalahan yang sudah ada di workspace poc2-e1.

### 13.6 Ringkas

| | Tanpa skill | Dengan skill (bagi menurut stabilitas) |
|---|---|---|
| Output routing | tak terkendali | konsisten |
| Kesadaran konteks project | nihil | membaca MEMORY/docs |
| Biaya token | 0 | ~400, ter-cache — dapat diabaikan |
| Risiko basi | tidak ada | ada, dikelola dengan hanya menulis yang stabil |
| Perlu menulis config | tidak | **ya** — `skills[]` tidak tersedia lewat RPC |
| Terlihat di UI AgentOS | tidak | ya |

Saya sarankan **pakai**, dengan tiga syarat: hanya isi yang stabil, tidak pernah menyatakan kebijakan yang tidak ditegakkan, dan penamaan berprefiks `semanggi-` supaya tidak bertabrakan dengan `agent-policy-*` milik AgentOS.

Kalau salah satu syarat itu tidak bisa dipenuhi, lebih baik seluruh perilaku dititipkan pada instruksi task saja — di situ Semanggi punya kendali penuh dan tidak ada yang bisa basi.

## 14. Fase desain, dan bagaimana dokumen menjadi konteks global

### 14.1 Ada dua tingkat konteks, dan perlakuannya berbeda

Ditemukan di `dist`: OpenClaw punya mekanisme **bootstrap context** yang menyuntikkan berkas workspace ke setiap run:

```js
const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForRun({
  workspaceDir, config, agentId
});
analyzeBootstrapBudget({ files, bootstrapMaxChars, bootstrapTotalMaxChars });
// "Workspace bootstrap files exceed limits and will be truncated"
```

Berkas yang ikut, terukur dari `dist`: **AGENTS.md, SOUL.md, IDENTITY.md, MEMORY.md, USER.md, TOOLS.md, HEARTBEAT.md** — persis tujuh berkas yang di-scaffold AgentOS. Bukan kebetulan: AgentOS membuat apa yang OpenClaw memang muat.

Sisanya — `memory/*.md`, `docs/*.md` — **tidak** disuntikkan. Ia dibaca **kalau agen memutuskan membacanya**, dan yang membuatnya memutuskan adalah instruksi di AGENTS.md dan SKILL.md (*"Treat MEMORY.md, memory/\*.md, docs/brief.md, docs/architecture.md … as shared workspace context before large edits"*).

```text
Tingkat 1  disuntik tiap run, ada anggaran karakter, dipotong bila lewat
           AGENTS.md · SOUL.md · IDENTITY.md · MEMORY.md · USER.md · TOOLS.md · HEARTBEAT.md

Tingkat 2  dibaca sesuai kebutuhan, tanpa batas, tetapi hanya kalau agen tahu ia ada
           memory/*.md · docs/*.md · skills/ · source/ · artifacts/
```

Ini persis pola yang diminta spec induk §9: *"Knowledge tidak di-inject seluruhnya ke prompt; gunakan retrieval."* Ternyata sudah terimplementasi, dan kita belum memakainya.

### 14.2 Yang ada di workspace kita sekarang

```text
workspaces/semanggi/executions/T1/
  ADA    AGENTS.md (8,9 KB, diperbarui hari ini) · SOUL.md · IDENTITY.md
         TOOLS.md · HEARTBEAT.md
  TIDAK  MEMORY.md · USER.md
  TIDAK  memory/ · docs/ · skills/
```

Jadi agen Semanggi **sudah** menerima konteks identitas, tetapi **tidak punya konteks pengetahuan project sama sekali**. Tidak ada brief, tidak ada arsitektur, tidak ada keputusan, tidak ada memori.

Dan satu konsekuensi yang menguatkan rancangan Brain Pooler: bootstrap dibaca dari **workspace agen**. Agen yang terikat ke `executions/<task-id>` akan mencari tujuh berkas itu di sana dan tidak menemukan apa-apa. **Mengikat agen ke root project bukan sekadar kenyamanan — itu syarat agar konteks project terbaca sama sekali.**

### 14.3 Ke mana dokumen desain diletakkan

| Dokumen | Tempat | Tingkat |
|---|---|---|
| Spesifikasi/desain lengkap | `docs/architecture.md`, `docs/brief.md`, `docs/service-map.md`, atau berkas Anda sendiri di `docs/` | 2 |
| Keputusan desain beserta alasannya | `memory/decisions.md` | 2 |
| Kendala, hasil yang dituju, yang belum diketahui | `memory/blueprint.md` | 2 |
| **Indeks + invarian** | `AGENTS.md`, `MEMORY.md` | **1** |

**Kunci rancangannya ada di baris terakhir.** Anggaran bootstrap adalah sumber daya langka — spesifikasi 200 halaman yang ditempel ke AGENTS.md akan **dipotong diam-diam** dan agen bekerja dengan separuh aturan tanpa tahu.

Jadi disiplinnya:

> Tingkat 1 memuat **penunjuk dan invarian**, bukan isi. Tingkat 2 memuat dokumen lengkapnya.

Contoh isi `MEMORY.md` yang benar:

```markdown
## Current brief
Migrasi layanan billing dari monolit ke service terpisah. Target Q4.

## Stable facts
- Spesifikasi lengkap: docs/architecture.md (baca sebelum mengubah skema)
- Keputusan yang mengikat: memory/decisions.md
- Batasan mutlak: tidak ada perubahan skema tanpa approval L3
- Repo utama di source/; jangan menyunting langsung tanpa lease tulis
```

Empat baris terakhir itulah yang membuat dokumen tingkat 2 benar-benar terbaca. Tanpa penunjuk, `docs/architecture.md` hanya berkas yang tidak pernah dibuka.

### 14.4 Fase desain adalah task, bukan lapisan baru

Pertanyaan Anda menyiratkan fase sebelum perencanaan: analisis dan desain lebih dulu, baru task-task pelaksana. Itu tidak butuh mekanisme baru — **fase desain adalah task juga**, hanya dengan keluaran yang berbeda:

```text
Permintaan operator
      │
      ▼
[Task desain]   role: Architect · Brain: critical · workspaceMode: write
      │         keluaran: docs/architecture.md, memory/blueprint.md,
      │                   dan pembaruan MEMORY.md (penunjuk + invarian)
      ▼
[Planner Brain] membaca dokumen itu → memecah jadi task pelaksana
      │
      ▼
[Task pelaksana ×N]  role sesuai · Brain sesuai level
```

Yang membuat ini bekerja: task desain menulis ke Tingkat 2 **dan** memperbarui Tingkat 1. Kalau ia hanya menulis `docs/architecture.md` tanpa menyebutnya di `MEMORY.md`, task berikutnya tidak akan tahu dokumen itu ada.

Karena itu saya sarankan satu aturan yang ditegakkan Semanggi:

> Task yang menghasilkan dokumen desain MUST juga memperbarui penunjuknya di `MEMORY.md`. Instruksi task desain menyertakan kewajiban ini secara eksplisit.

Alternatifnya — Semanggi yang menulis penunjuk itu sendiri setelah task selesai — lebih dapat diandalkan tetapi butuh controller menulis ke workspace. Keduanya sah; yang pertama lebih sederhana, yang kedua lebih tahan terhadap model yang lupa.

### 14.5 Kalau desainnya sudah ada dan tinggal diunggah

Dua jalan, dan keduanya butuh satu langkah yang mudah terlewat:

1. **`sourceMode: existing`** saat membuat project di AgentOS — folder yang sudah ada dilampirkan dan isinya dipertahankan.
2. **Salin ke `docs/`** pada workspace yang sudah jadi.

Langkah yang mudah terlewat: **dokumen yang diunggah tidak otomatis diketahui siapa pun.** Ia ada di disk, tidak ada di Tingkat 1, jadi tidak ada agen yang tahu harus membacanya.

Jadi setiap unggahan MUST diikuti **task ingest** — task pendek dengan Brain murah yang membaca dokumen, lalu menulis ringkasan dan penunjuknya ke `MEMORY.md` dan `memory/blueprint.md`. Keluarannya bukan analisis mendalam, melainkan indeks: apa isinya, kapan harus dibaca, invarian apa yang mengikat.

Ini juga jawaban untuk pertanyaan "bagaimana agar dipahami agen": bukan dengan menyuntikkan seluruhnya, melainkan dengan memastikan ada satu kalimat di Tingkat 1 yang membuat agen membukanya pada saat yang tepat.

### 14.6 Batas yang harus dijaga

- **Pantau anggaran bootstrap.** OpenClaw memperingatkan lewat `analyzeBootstrapBudget` bila berkas terpotong, tetapi peringatan itu ada di lognya sendiri. Semanggi sebaiknya ikut memeriksa ukuran tujuh berkas itu saat provisioning project dan menolak/memperingatkan bila membengkak.
- **`MEMORY.md` bukan tempat sampah.** Ia dibaca setiap run oleh setiap agen di project itu. Setiap baris yang ditambahkan dibayar berkali-kali.
- **Konteks project ≠ konteks task.** Deskripsi task tetap milik instruksi dispatch. Menaruh detail per task di `MEMORY.md` akan membuatnya basi dan mahal sekaligus.
