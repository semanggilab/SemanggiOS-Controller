# Model project, tim, dan agen di AgentOS

Dibaca langsung dari source yang berjalan (`/agentos/lib/openclaw/workspace-presets.ts`, `agent-presets.ts`, `tool-catalog.ts`, `workspace-docs.ts`) pada 2026-08-30. Bukan dari dokumentasi.

Tujuan dokumen: memberi gambaran utuh sebelum diputuskan apakah AgentOS dipertahankan, karena sebagian dari yang ada di sini **mengisi bagian spec induk kita yang masih kosong**.

---

## 1. Empat sumbu saat membuat project

AgentOS tidak membuat "agen" lebih dulu — ia membuat **workspace/project**, dan tim lahir dari situ. Ada empat pilihan yang saling menyilang:

| Sumbu | Nilai |
|---|---|
| `sourceMode` | `empty` · `clone` (klon repo dulu) · `existing` (lampirkan folder yang sudah ada) |
| `template` | `software` 🛠 · `frontend` 🎨 · `backend` ⚙️ · `research` 🧠 · `content` 📣 |
| `teamPreset` | `solo` · `core` · `custom` |
| `modelProfile` | `balanced` · `fast` · `quality` |

Plus empat sakelar `rules` (default semuanya `true`):

```text
workspaceOnly        kurung pekerjaan di dalam workspace
generateStarterDocs  buat docs/ dan deliverables/
generateMemory       buat memory/
kickoffMission       langsung mulai satu misi pembuka
```

Project `poc2-e1` di cluster kita dibuat dengan `template: software`, `teamPreset: core`, `modelProfile: balanced`, tetapi tiga dari empat rules dimatikan — jadi ia tidak pernah mendapat docs/memory scaffold.

## 2. Tim lahir dari template

`TEMPLATE_AGENT_SEEDS` menentukan siapa saja anggota tim untuk tiap template. Setiap benih membawa `role`, `name`, `emoji`, `theme`, `skillId`, dan satu ditandai `isPrimary`.

| Template | Anggota tim |
|---|---|
| **software** | Builder* 🛠️ · Reviewer 🔍 · Tester 🧪 · Learner 🧠 |
| **frontend** | Builder* · Reviewer · Tester · Learner · **Browser Agent** 🌐 |
| **backend** | Builder* · Reviewer · Tester · Learner |
| **research** | **Research Lead*** 🔬 · Reviewer · **Archivist** 🧠 |
| **content** | **Strategist*** 📣 · **Writer** ✍️ · Reviewer · **Analyst** 📈 |

`*` = primary.

`teamPreset` menyaringnya:

- `solo` → **hanya yang primary**
- `core` dan `custom` → seluruh benih (pada `custom`, operator lalu menyalakan/mematikan per anggota)

Perhatikan: role-nya berorientasi **fungsi kerja** (Builder, Reviewer, Tester, Learner), bukan jabatan seperti daftar tujuh role di spec induk kita (Engineering Manager, Architect, Developer, QA, DevOps, Security, Technical Writer). Keduanya konsep yang sama tetapi taksonominya berbeda.

## 3. Preset agen menentukan tools dan postur keamanan

Terpisah dari role, tiap agen punya **preset** yang menentukan alat dan kebijakannya. Default: `worker`.

| Preset | Tools | Skills bawaan |
|---|---|---|
| **worker** 🛠️ | `exec, read, write, edit, apply_patch` | project-builder, project-reviewer, project-tester |
| **setup** 🧰 | `exec, process, gateway, read, write` | project-builder, project-analyst, project-learner |
| **browser** 🌐 | `browser, web_search, web_fetch, image` | project-browser, project-tester, project-researcher |
| **monitoring** 🛰️ | `cron, gateway, sessions_list, message, web_fetch` | project-analyst, project-reviewer, project-learner |
| **custom** 🧩 | `exec, read, edit, message` | — |

Kebijakan default per preset:

| Preset | missingToolBehavior | installScope | fileAccess | networkAccess |
|---|---|---|---|---|
| worker | `fallback` | `none` | `workspace-only` | **`enabled`** |
| setup | `allow-install` | **`workspace`** | `workspace-only` | `enabled` |
| browser | `ask-setup` | `none` | `workspace-only` | `enabled` |
| monitoring | `fallback` | `none` | `workspace-only` | `enabled` |
| custom | `fallback` | `none` | `workspace-only` | `enabled` |

Nilai yang mungkin untuk tiap sumbu kebijakan:

```text
missingToolBehavior  fallback | ask-setup | route-setup | allow-install
installScope         none | workspace | system
fileAccess           workspace-only | extended
networkAccess        restricted | enabled
```

**Satu hal yang layak diperhatikan:** default `networkAccess` untuk **semua** preset adalah `enabled`. Project `poc2-e1` kita punya `restricted` — jadi itu override yang disengaja saat pembuatan, bukan bawaan. Siapa pun yang membuat project lewat UI tanpa mengubahnya akan mendapat agen dengan akses jaringan menyala.

Hanya preset `setup` yang boleh memasang dependensi, dan hanya di lingkup workspace. Tidak ada preset bawaan yang memakai `installScope: system` atau `fileAccess: extended` — keduanya ada sebagai opsi tetapi harus dipilih manual.

## 4. Katalog tool bawaan (26)

```text
eksekusi     exec  process  bash  code_execution
web          browser  web_search  x_search  web_fetch
berkas       read  write  edit  apply_patch
komunikasi   message  canvas  nodes
terjadwal    cron
gateway      gateway
gambar       image  image_generate
sesi         sessions_list  sessions_history  sessions_send
             sessions_spawn  sessions_yield  session_status
agen         subagents  agents_list
```

Preset hanya memilih **subset** dari katalog ini. Sebuah agen tidak pernah otomatis mendapat semuanya.

## 5. Skill: sembilan, dan isinya prompt

Ada sembilan skill id yang dikenal:

```text
project-builder     project-reviewer   project-tester
project-learner     project-browser    project-researcher
project-strategist  project-writer     project-analyst
```

Skill di sini **bukan kode** — ia markdown yang di-generate saat provisioning (`renderSkillMarkdown`) ke folder `skills/` di workspace. Contoh `project-builder`:

```markdown
# Project Builder

Use this skill when implementing changes in the current project.

- Prefer direct code or artifact changes over speculative planning.
- Respect AGENTS.md, TOOLS.md, MEMORY.md, and memory/*.md before large edits.
- Put task-specific artifacts under the current deliverables run folder
  instead of the workspace root.
- Verify impact before finishing and leave the workspace in a clearer state.
```

Jadi skill adalah **instruksi perilaku**, bukan kapabilitas. Kapabilitas datang dari `tools`. Dua hal ini sering tertukar dan konsekuensinya berbeda: menambah skill mengubah cara agen bekerja; menambah tool mengubah apa yang bisa ia lakukan.

## 6. Scaffold dokumen — dan ini menyentuh §9 spec kita

Saat project dibuat dengan rules default, AgentOS menulis:

```text
<workspace>/
├── AGENTS.md          # Workspace · Team · Customize · Safety defaults · Daily memory · Output
├── SOUL.md            # My Purpose · How I Operate · My Quirks · Active Focus
├── IDENTITY.md        # Role
├── MEMORY.md
├── TOOLS.md
├── USER.md
├── HEARTBEAT.md
├── memory/
│   ├── blueprint.md
│   └── decisions.md
├── docs/              # per template: architecture.md · brief.md · service-map.md
│                      #               ux-notes.md · research-plan.md · content-brief.md
├── deliverables/
│   └── README.md
├── skills/            # sembilan skill markdown di atas
└── .openclaw/
    ├── project.json
    ├── agents/<id>/agent/{models.json, plugins/*/catalog.json}
    ├── project-shell/{runs,tasks}
    └── tools/
```

> **Ini penting.** Spec induk kita §9 (memory dan knowledge) saya tandai "**belum dikerjakan** — gap terbesar yang tersisa". Ternyata AgentOS sudah mengimplementasikan sebagian besar bentuknya:
>
> | Spec kita §9 | Padanan AgentOS |
> |---|---|
> | Global `/organization` | `AGENTS.md`, `TOOLS.md`, `SOUL.md` |
> | Project `/project/<id>/memory` | `MEMORY.md`, `memory/blueprint.md`, `memory/decisions.md` |
> | Task `executions/<task-id>/` | `.openclaw/project-shell/{runs,tasks}`, `deliverables/<run>/` |
>
> Bukan padanan sempurna — milik AgentOS berorientasi workspace, milik kita berorientasi task di dalam project — tetapi cukup dekat sehingga membangunnya dari nol akan jadi pekerjaan duplikat.

## 7. Bagaimana ini berbeda dari agen Semanggi

| | AgentOS | Semanggi |
|---|---|---|
| Titik awal | project/workspace | katalog routing |
| Tim | otomatis dari template + preset | tidak ada konsep tim |
| Role | melekat pada agen (`Builder`, `Reviewer`, …) | di tabel `workers` terpisah |
| Tools | subset eksplisit dari 26 katalog | tidak disetel — mewarisi bawaan |
| Skills | 9 markdown, di-generate | tidak ada |
| Kebijakan file/network | eksplisit per preset | tidak disetel |
| Model | `modelProfile` + `models.json` per agen | katalog routing global, per (model, effort) |
| Memory scaffold | 7 berkas + `memory/` + `docs/` | tidak ada |

Keduanya menulis ke registry agen yang sama, tetapi **AgentOS memodelkan cara kerja tim, Semanggi memodelkan kapasitas eksekusi.** Tidak ada yang lebih benar — keduanya menjawab pertanyaan berbeda.

## 8. Implikasi untuk keputusan

**Yang akan hilang kalau AgentOS dibuang** — bukan sekadar UI:

1. Scaffold memory/knowledge (§6) yang justru mengisi gap terbesar spec kita.
2. Taksonomi tim dan skill markdown yang membentuk perilaku agen.
3. Pengurungan `tools`/`fileAccess`/`networkAccess` per agen — dan ini **tidak bisa disetel lewat RPC** (terukur: `agents.create`/`update` menolak `tools`), jadi Semanggi harus menulis config langsung untuk menggantikannya.
4. Katalog model per agen (`models.json`).

**Yang tetap perlu diperbaiki di sisi Semanggi apa pun keputusannya:** agen kita tidak punya `tools.fs.workspaceOnly` sementara agen AgentOS punya. Selisih keamanan ini nyata dan tidak bergantung pada apakah AgentOS dipertahankan.

**Peluang yang saya lihat:** alih-alih memilih salah satu, biarkan pembagiannya mengikuti apa yang sudah masing-masing kuasai — AgentOS memiliki **bentuk** project (tim, skill, memory, kebijakan agen), Semanggi memiliki **penjadwalan** kerja (antrean, quota, lease, prioritas, atribusi). Itu persis pembagian yang sudah tertulis di spec induk §1.2, hanya saja sekarang kita tahu isi kolom "AgentOS" jauh lebih kaya daripada yang dulu diperkirakan.
