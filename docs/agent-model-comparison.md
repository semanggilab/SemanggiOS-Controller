# Agen di AgentOS vs agen di Semanggi

Semuanya diukur langsung di cluster (2026-08-30, OpenClaw 2026.7.1). Dokumen ini untuk keputusan: apakah AgentOS dipertahankan, dan bagaimana kepemilikan agen dibagi.

Kesimpulan singkat di depan: **keduanya menulis ke registry yang sama, tetapi memodelkan hal yang berbeda.** AgentOS memodelkan *tim di dalam sebuah project*; Semanggi memodelkan *kapasitas eksekusi per (workspace, model, effort)*. Itu bukan dua implementasi dari satu konsep — itu dua konsep yang kebetulan memakai tabel yang sama.

---

## 1. Model mental

| | AgentOS | Semanggi |
|---|---|---|
| Agen itu apa | **anggota tim** dalam sebuah project | **slot eksekusi** untuk satu kombinasi (workspace, model, effort) |
| Dibuat kapan | saat operator membuat project / menambah anggota | saat routing butuh kombinasi yang belum ada |
| Umur | selama project hidup | selama workspace-nya hidup; dipungut setelah itu |
| Identitas | punya **role** (`"Backend Engineer"`), emoji, tema, primary/tidak | tidak punya role; namanya deterministik dari (workspace, model) |
| Dipilih oleh | manusia | katalog routing |

AgentOS menyimpan ini di `.openclaw/project.json` per workspace:

```json
{
  "slug": "poc2-e1", "template": "software",
  "teamPreset": "core", "modelProfile": "balanced", "agentTemplate": "core-team",
  "rules": { "workspaceOnly": true, "generateStarterDocs": false, ... },
  "agents": [{ "id": "poc2-e1-worker", "role": "Backend Engineer",
               "isPrimary": true, "skillIds": [], "modelId": null,
               "policy": { "fileAccess": "workspace-only",
                           "networkAccess": "restricted", "preset": "worker" } }]
}
```

**Ini penting untuk keputusan Anda:** `role: "Backend Engineer"` adalah konsep yang di spec induk kita disebut **Worker** (§3.1). Jadi ada dua model organisasi yang tumpang tindih — AgentOS menyimpan role pada agen, Semanggi menyimpannya di tabel `workers` miliknya sendiri dengan akses project dan batas konkurensi. Keduanya tidak saling tahu.

## 2. Bentuk entri di `openclaw.json`

Diukur dari 24 agen yang ada:

```jsonc
// Semanggi — 9 agen
{ "id", "name", "workspace", "agentDir", "model", "identity" }

// AgentOS / POC — 15 agen
{ "id", "name", "workspace", "agentDir", "model", "identity",
  "skills",                       // ["agent-policy-<id>"]
  "tools": { "fs": { "workspaceOnly": true } } }
```

Dua field yang hanya dimiliki AgentOS, dan **keduanya menyangkut keamanan**:

- `tools.fs.workspaceOnly: true` — mengurung akses filesystem agen ke workspace-nya.
- `skills: ["agent-policy-<id>"]` — kebijakan per agen.

> **Agen Semanggi tidak punya keduanya.** Artinya agen kita **kurang terkurung** di filesystem dibanding agen buatan AgentOS. Ini selisih nyata, bukan gaya penulisan, dan menurut saya inilah temuan paling penting di dokumen ini.

## 3. Struktur di disk

**AgentOS** — di dalam workspace:

```text
<workspace>/.openclaw/
├── project.json                     ← project + tim + policy
├── agents/<id>/agent/
│   ├── models.json                  ← KATALOG MODEL PER AGEN
│   └── plugins/{google,groq,anthropic,zai,nvidia}/catalog.json
├── tools/                           ← tool kustom (mis. telegram-delegate-agent.mjs)
├── project-shell/
└── sandbox-skills/
```

**Semanggi** — di state dir bersama:

```text
state/agents/semanggi-glm-5-2/
└── sessions/                        ← trajectory + jsonl saja
```

Tiga akibat:

1. **Agen AgentOS punya katalog model sendiri** (`models.json` + `plugins/*/catalog.json`), jadi ia bisa menawarkan model yang berbeda dari config global. Agen Semanggi mewarisi katalog global — konsisten, tetapi tidak bisa di-override per agen.
2. **`agentDir` agen Semanggi tidak ada di disk.** Config menyebut `state/agents/<id>/agent`, direktori itu tidak pernah dibuat, dan tidak ada yang mengeluh — agen tetap berjalan. Jadi `agentDir` bagi kita adalah deklarasi yang tidak dipakai.
3. **AgentOS mengikat agen ke workspace secara fisik**; direktorinya ikut kalau workspace dipindah/disalin. Milik kita tidak.

## 4. Jalur penulisan dan izin

| | AgentOS | Semanggi |
|---|---|---|
| Cara menulis | **menulis `openclaw.json` langsung** (butuh `openclaw.json.lock`) | **RPC gateway** `agents.create` / `update` / `delete` |
| Izin yang dibutuhkan | akses tulis filesystem sebagai uid 1000 | scope **`operator.admin`** pada device |
| Siapa yang boleh | siapa pun yang login ke AgentOS (single-admin) | hanya skrip operator dengan identitas admin |
| Controller boleh? | — | **tidak.** Controller hanya `operator.write` (D14) |

Ini pemisahan yang disengaja di sisi kita: controller bisa **menjalankan** pekerjaan tetapi tidak bisa **membentuk ulang armada** yang menjalankannya. AgentOS tidak punya pemisahan setara — login berarti bisa mengubah agen.

Dibuktikan: mount config read-only membuat AgentOS gagal dengan `EROFS ... openclaw.json.lock`, sementara Semanggi tetap bisa membuat agen lewat RPC.

## 5. Siklus hidup dan field yang bisa diubah

Diukur terhadap RPC 2026.7.1:

| Operasi | Diterima |
|---|---|
| `agents.create` | `{name, workspace, model}` — `id` diturunkan dari `name`; `agentRuntime`, `acp`, `tools` **ditolak** |
| `agents.update` | `{agentId, workspace, model, name}` — `identity`, `tools`, `thinking`, `agentRuntime` **ditolak** |
| `agents.delete` | `{agentId}` → `{ok, removedBindings}` |

Jadi lewat RPC, **workspace dan model sebuah agen bisa diubah**, tetapi postur keamanannya (`tools.fs.workspaceOnly`) tidak. Satu-satunya cara menyetel itu adalah menulis config — yang berarti lewat AgentOS, atau lewat penyuntingan berkas.

Pembuatan lewat AgentOS punya dua cacat terukur:

- **Model yang diminta diabaikan.** Minta `zai/glm-5.2`, yang tertulis `zai/glm-4.7-flash` (ia menuntut `workspaceId`, bukan path, dan bentuk field modelnya berbeda).
- **Bisa setengah jadi.** Entri config tertulis lengkap, lalu scaffolding filesystem gagal (`EACCES` saat `mkdir .openclaw/tools`). Hasilnya agen yang selamanya ada di berkas dan tidak pernah bisa dijalankan.

## 6. Pembeda operabilitas

```text
ada di openclaw.json  →  AgentOS menampilkannya
ada di agents.list    →  gateway benar-benar akan menjalankannya
```

Agen setengah jadi tadi **tidak pernah muncul di `agents.list`**. Karena registry Semanggi hanya memakai `agents.list`, ia **sudah kebal** terhadap kelas kesalahan ini — sedangkan halaman AgentOS menampilkannya sebagai agen sungguhan.

## 7. Penamaan dan idempotensi

| | AgentOS | Semanggi |
|---|---|---|
| Pola | dari nama project + role (`poc2-e1-worker`) | deterministik dari (workspace, model): `sem-<leaf>-<provider>-<model>` |
| Ulang buat | menambah anggota baru | **idempoten** — provisioning ulang tidak menggandakan |
| Konsekuensi | jumlah agen mengikuti ukuran tim | jumlah agen mengikuti (workspace × model × effort) |

Karena `workspaceDir` bukan parameter dispatch (D34), pola Semanggi **berlipat**: setiap workspace baru berarti satu set agen baru. Terhitung sekarang: 9 agen Semanggi, 4 di antaranya milik task yang sudah lama selesai. Itu sebabnya `reap-agents.mjs` ada.

## 8. Ringkasan selisih yang menentukan

| Aspek | AgentOS | Semanggi | Yang lebih kuat |
|---|---|---|---|
| Pengurungan filesystem | `tools.fs.workspaceOnly` | tidak ada | **AgentOS** |
| Katalog model per agen | ada | warisan global | AgentOS (fleksibel) / Semanggi (konsisten) |
| Pemisahan hak tulis | tidak ada | admin vs write terpisah | **Semanggi** |
| Kebal agen setengah jadi | tidak | ya (`agents.list`) | **Semanggi** |
| Idempotensi | tidak | ya | **Semanggi** |
| Konsep role/tim | ada | ada, tetapi di tabel terpisah | tumpang tindih |
| Model yang diminta dihormati | **tidak** (terukur) | ya | **Semanggi** |

## 9. Implikasi untuk keputusan Anda

**Kalau AgentOS dipertahankan:** ia memberi tiga hal yang Semanggi tidak punya — pengurungan filesystem per agen, katalog model per agen, dan konsep project/tim. Yang MUST ditambahkan di sisi kita: **set `tools.fs.workspaceOnly` untuk agen Semanggi**. Selisih keamanan ini tidak boleh dibiarkan hanya karena tidak ada yang mengeluh.

**Kalau AgentOS dibuang:** yang harus diserap bukan hanya CRUD agen, melainkan juga konsep project/tim yang tersimpan di `project.json`, katalog model per agen, dan penyetelan `tools`/`skills` yang **tidak tersedia lewat RPC** — jadi Semanggi harus ikut menulis berkas config, persis pola yang selama ini saya sebut berbahaya. Dan karena penyetelan itu butuh `operator.admin`, itu berarti melebarkan hak controller yang sengaja dipersempit.

Menurut saya selisih di baris terakhir tabel §8 yang paling menentukan: **AgentOS tidak menghormati model yang diminta saat membuat agen.** Untuk sistem yang seluruh aturan routingnya dibangun di atas larangan silent downgrade (P4-03), itu bukan ketidaknyamanan kecil — itu jalur yang bisa menghasilkan agen yang menjalankan model berbeda dari yang tertulis.
