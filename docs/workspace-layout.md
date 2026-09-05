# Bentuk akhir workspace agen

Disusun dari yang terukur di cluster (2026-08-31), bukan dari rancangan. Menggantikan tata letak di spec induk §6.1, dengan alasan yang dijelaskan di §4 dokumen ini.

---

## 1. Bentuk akhirnya

Satu workspace = satu project AgentOS. Semua agen project itu terikat ke root yang sama.

```text
/opt/semanggi/volumes/shared/service/semanggios/            ← titik mount NFS
└── openclaw/workspaces/<project>/               ← WORKSPACE AGEN (root)
    │
    │  ── Tingkat 1: disuntik ke setiap run, ada anggaran karakter ──
    ├── AGENTS.md            aturan kerja, tim, output routing, safety
    ├── MEMORY.md            brief berjalan + fakta stabil + PENUNJUK ke Tingkat 2
    ├── SOUL.md              tujuan, cara kerja, fokus aktif
    ├── IDENTITY.md          role agen ini
    ├── USER.md              profil & preferensi operator
    ├── TOOLS.md             contoh & catatan pemakaian tool
    ├── HEARTBEAT.md         prosedur pemeriksaan berkala
    │
    │  ── Tingkat 2: dibaca sesuai kebutuhan, tanpa batas ukuran ──
    ├── memory/
    │   ├── blueprint.md     hasil yang dituju, kendala, yang belum diketahui
    │   └── decisions.md     keputusan desain beserta alasannya
    ├── docs/
    │   ├── brief.md         objective, success signals, open questions
    │   ├── architecture.md  bentuk sekarang, dependensi, risiko
    │   └── …                spesifikasi yang Anda unggah, per template
    ├── skills/
    │   ├── agent-policy-<agent-id>/SKILL.md      ← ditulis AgentOS
    │   └── semanggi-role-<role>/SKILL.md         ← ditulis Semanggi
    │
    │  ── Kode: repo ada DI ROOT, bukan di source/ ──
    ├── src/  package.json  README.md  …          ← isi repo apa adanya
    │
    │  ── Keluaran kerja ──
    ├── deliverables/
    │   ├── TASK-91/         satu folder per task Semanggi
    │   └── 2026-08-31-…/    folder otomatis bila tak ada instruksi eksplisit
    │
    └── .openclaw/           internal runtime — JANGAN disentuh agen
        ├── project.json     template, teamPreset, modelProfile, roster
        ├── agents/<id>/agent/{models.json, plugins/*/catalog.json}
        ├── project-shell/{runs, tasks, events.jsonl}
        └── tools/
```

## 2. Yang berubah dari spec §6.1, dan kenapa

Spec induk menuliskan:

```text
workspaces/<project-id>/
├── source/          # repo utama
├── executions/      # satu direktori per task
│   └── <task-id>/
├── artifacts/
└── docs/
```

Tiga bagian tidak cocok dengan kenyataan:

### 2.1 `source/` tidak ada — repo berada di root

`WORKSPACE_SOURCE_OPTIONS` AgentOS: *"Clone a repository first, then layer workspace docs, memory, and agents on top."* Repo di-klon **ke root workspace**, lalu dokumen dilapisi di atasnya. Workspace `poc2-e1` yang terukur tidak punya `source/` sama sekali.

Membuat `source/` sendiri berarti melawan cara AgentOS membuat project — dan setiap project yang dibuat lewat UI akan berbentuk lain dari yang kita harapkan. Jadi: **kode di root**, berdampingan dengan berkas konteks.

### 2.2 `artifacts/` → `deliverables/`

AgentOS sudah punya konvensinya, dan **agen sudah diinstruksikan memakainya**. Terukur di `AGENTS.md`:

```markdown
## Output
- Put task-specific deliverables, drafts, reports, and docs inside per-run folders
  under deliverables/.
- Avoid writing final artifacts to the workspace root unless explicitly requested.
```

Dan di workspace `poc2-e1` folder itu memang terisi:

```text
deliverables/2026-08-18-13-11-44-gunakan-shell-untuk-membuat-file-hello-txt-di-di/
deliverables/2026-08-18-13-32-16-gunakan-shell-untuk-membuat-file-hello-txt-di-di/
```

Memakai nama `artifacts/` berarti setiap instruksi task harus menimpa instruksi bawaan — dan satu kali lalai, hasilnya menclok di tempat lain. **Ikuti konvensi yang sudah ada.**

Yang Semanggi ubah hanya **penamaan foldernya**: alih-alih slug otomatis dari teks permintaan, instruksikan `deliverables/<TASK-ID>/` supaya berkorelasi dengan basis data. Penamaan otomatis tetap berlaku sebagai jaring pengaman bila tidak ada instruksi.

### 2.3 `executions/<task-id>/` sebagai level workspace hilang

Sekarang workspace kita adalah `workspaces/semanggi/executions/T1` — `executions/T1` menjadi **bagian dari path workspace**, warisan penamaan POC-2. Dalam bentuk akhir, root workspace adalah project itu sendiri, dan pemisahan per task terjadi di `deliverables/<TASK-ID>/`.

Ini juga menghapus satu sebab kegagalan yang terukur (D29): task yang diberi `workspace_path` berupa subdirektori bersarang terparkir permanen karena tidak ada agen yang terikat di sana.

**Path agen ≠ path NFS.** Di dalam sandbox, workspace agen ter-mount di
`/workspace`, jadi jawaban agen yang menyebut `/workspace/deliverables/<TASK-ID>/…`
ada di `openclaw/workspaces/<project>/deliverables/<TASK-ID>/…` pada NFS.
Kasus nyata (2026-09-06): TASK-4F59F63A menulis laporannya ke
`/workspace/deliverables/TASK-4F59F63A/01-laporan-verifikasi-akhir.md`; operator
mencarinya di root `workspaces/` dan tidak menemukannya — folder itu hidup di
`workspaces/sdmk-kader/deliverables/TASK-4F59F63A/`.

## 3. Siapa menulis apa

| Path | Penulis | Kapan |
|---|---|---|
| Tujuh berkas Tingkat 1 | AgentOS saat scaffold; agen saat memperbarui memori | pembuatan project, lalu berjalan |
| `memory/`, `docs/` | task desain & ingest (Semanggi), agen saat bekerja | terus-menerus |
| `skills/agent-policy-*` | **AgentOS** | provisioning agen |
| `skills/semanggi-role-*` | **Semanggi** | provisioning role×Brain |
| repo di root | agen dengan lease tulis | saat task menyunting kode |
| `deliverables/<TASK-ID>/` | agen pelaksana task itu | tiap task |
| `.openclaw/` | runtime | jangan disentuh |

Prefiks `semanggi-` pada skill bukan kosmetik — AgentOS me-*generate* ulang `agent-policy-*` saat provisioning, dan nama yang sama akan tertimpa.

## 4. Akses per task

Bentuk yang diinginkan (§12 `brain-pooler-analysis.md`):

| Path | Akses |
|---|---|
| `deliverables/<TASK-ID>/` | **rw** selalu — ruang sendiri, tidak pernah bertabrakan |
| workspace root | **ro** — membaca konteks, kode, dan hasil task lain |
| repo di root | **rw hanya bila task memegang lease tulis** |

**Peringatan yang harus jujur disebut:** ini **belum ditegakkan mount** hari ini. Mount sandbox mengikuti workspace agen, dan tidak ada parameter per dispatch (D34). Yang menegakkan sekarang adalah **lease** — konvensi yang dipatuhi karena instruksi, bukan karena kernel menolak.

Uji yang masih tersisa: apakah `sandbox.workspaceDir` bisa disetel per agen di berkas config. Kalau bisa, tabel di atas menjadi penegakan sungguhan. Risikonya nyata — skema config menolak field asing dengan membuat gateway gagal boot (D34), jadi ujinya dengan backup dan pada entri sekali pakai.

## 5. Anggaran Tingkat 1

Tujuh berkas Tingkat 1 disuntik ke **setiap run oleh setiap agen**, dengan `bootstrapMaxChars` per berkas dan `bootstrapTotalMaxChars` total. Melewatinya berarti **dipotong diam-diam**.

Karena itu:

> `MEMORY.md` memuat penunjuk dan invarian, bukan isi. Spesifikasi lengkap tinggal di `docs/`.

Contoh yang benar:

```markdown
## Current brief
Migrasi layanan billing dari monolit ke service terpisah. Target Q4.

## Stable facts
- Spesifikasi lengkap: docs/architecture.md (baca sebelum mengubah skema)
- Keputusan mengikat: memory/decisions.md
- Tidak ada perubahan skema tanpa approval L3
- Hasil kerja ke deliverables/<TASK-ID>/, bukan ke root
```

Semanggi sebaiknya memeriksa ukuran ketujuh berkas itu saat provisioning project dan memperingatkan bila membengkak — OpenClaw memang memperingatkan lewat `analyzeBootstrapBudget`, tetapi peringatan itu hanya masuk lognya sendiri.

## 6. Bentuk per-agen vs per-project

Pertanyaannya "workspace yang ada di setiap agen" — jawabannya: **semua agen dalam satu project berbagi workspace yang sama persis.** Yang membedakan mereka bukan folder, melainkan:

- `IDENTITY.md` — role agen itu (satu-satunya berkas Tingkat 1 yang spesifik per agen)
- `skills/<agent atau role>/SKILL.md` — perilaku yang mengikatnya
- `.openclaw/agents/<id>/` — state runtime dan katalog modelnya
- model yang dibawanya — satu agen tepat satu model (terukur), jadi Brain-nya melekat di sini

Tidak ada folder kerja terpisah per agen. Pemisahan kerja terjadi **per task** di `deliverables/<TASK-ID>/`, bukan per agen — karena satu agen mengerjakan banyak task, dan satu task bisa berpindah agen saat di-*retry* dengan Brain berbeda.
