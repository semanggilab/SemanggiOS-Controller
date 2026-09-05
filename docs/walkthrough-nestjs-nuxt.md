# Simulasi: project baru NestJS + NuxtJS

Panduan langkah demi langkah memakai AgentOS + Semanggi seperti keadaannya **hari ini**. Setiap langkah ditandai:

- **✅ jalan** — sudah terbukti hidup di cluster
- **⚠ manual** — mekanisme otomatisnya belum dibangun; ada penggantinya

Ditandai jujur supaya Anda tidak menunggu sesuatu yang belum ada.

---

## 0. Akses AgentOS

AgentOS **sengaja tidak mem-publish port**. Ia memegang kendali penuh atas armada agen dan hanya punya satu kredensial admin (§8.4), jadi membukanya ke jaringan adalah keputusan yang tidak pantas diambil diam-diam.

Sudah saya siapkan forwarder yang **terikat ke loopback saja** di `kub01-01` — tidak menambah paparan apa pun:

```bash
# di mesin Anda
ssh -L 13000:127.0.0.1:13000 root@kub01-01
# lalu buka
http://localhost:13000
```

**Kredensial:**

```
username: admin
password: jalankan sendiri di kub01-01 —

  docker exec $(docker ps --filter label=com.docker.swarm.service.name=semanggi_agentos -q | head -1) \
    cat /run/secrets/agentos_initial_admin_password
```

Sengaja tidak saya cetak di sini: sandi yang tertulis di transkrip akan tetap ada di sana selamanya, sementara perintah di atas memberi hasil yang sama kapan pun Anda butuh.

Forwarder-nya sementara. Menghentikannya:

```bash
docker rm -f semanggi-agentos-tunnel
```

---

## 1. Satu project, bukan dua

Godaannya membuat dua project — `backend` untuk NestJS dan `frontend` untuk Nuxt, masing-masing dengan timnya. **Jangan.**

Alasannya arsitektural, bukan selera: agen terikat pada **satu** workspace, dan tidak ada mekanisme membaca lintas workspace. Kalau backend dan frontend jadi dua project, **agen frontend secara harfiah tidak bisa membaca kontrak API yang ditulis backend.** Dokumen desain bersama tidak punya tempat tinggal.

Jadi: **satu project, monorepo.**

```text
workspaces/<project>/
├── AGENTS.md  MEMORY.md  SOUL.md  IDENTITY.md  TOOLS.md  USER.md  HEARTBEAT.md
├── memory/{blueprint,decisions}.md
├── docs/{brief,architecture,service-map,ux-notes}.md   ← kontrak API di sini
├── skills/
├── apps/
│   ├── api/     ← NestJS
│   └── web/     ← NuxtJS
├── deliverables/<TASK-ID>/
└── .openclaw/
```

Konsekuensi yang harus diterima: lease tulis berlaku untuk seluruh project, jadi dua task `write` tidak berjalan bersamaan meski satu menyentuh `apps/api` dan satunya `apps/web`. Untuk fase desain dan awal implementasi itu justru benar. Kalau nanti terasa menyempitkan, pemisahan jadi dua project bisa dilakukan **setelah** kontrak API stabil dan tidak lagi berubah.

---

## 2. Membuat project di AgentOS ✅

Di UI AgentOS → buat workspace baru:

| Pilihan | Isi | Alasan |
|---|---|---|
| `sourceMode` | `empty` (atau `clone` bila repo sudah ada) | — |
| `template` | **`software`** | bukan `backend`/`frontend`: kita butuh keduanya, dan `software` netral |
| `teamPreset` | `core` | Builder, Reviewer, Tester, Learner |
| `modelProfile` | `balanced` | → level `normal` sebagai default |
| `rules` | **semua nyalakan** | `generateStarterDocs` dan `generateMemory` yang membuat `docs/` dan `memory/` ada |

> Jangan matikan `generateStarterDocs`/`generateMemory`. Project `poc2-e1` di cluster ini dibuat dengan keduanya mati, dan akibatnya ia tidak punya `MEMORY.md` maupun `docs/` sama sekali — konteks project tidak punya tempat tinggal.

Periksa juga `networkAccess`: default semua preset adalah **`enabled`**. Untuk NestJS/Nuxt itu memang dibutuhkan (`npm install`), jadi biarkan — tetapi ketahuilah itu keputusan, bukan bawaan yang aman.

---

## 3. Menambah role yang tidak ada di template ⚠ manual

Template `software` memberi Builder, Reviewer, Tester, Learner. Untuk pengembangan **baru** Anda butuh dua lagi:

| Role | Ada di AgentOS? | Cara |
|---|---|---|
| **Architect** | **tidak ada sama sekali** | tambah manual, preset `worker` |
| **Analyst** | ada, tetapi hanya di template `content` | tambah manual, preset `worker` |
| Browser Agent | ada, hanya di template `frontend` | tambah bila ingin bukti UI otomatis, preset `browser` |

`role` di AgentOS bertipe string bebas, jadi ketiganya bisa ditambahkan lewat UI Agents → tambah agen → isi role.

Level-nya sudah disiapkan Semanggi:

```
architect → critical   (selalu, apa pun modelProfile — kesalahan desain paling mahal dibatalkan)
analyst   → mengikuti profil project
builder   → normal     reviewer → normal     tester → normal
learner   → critical
```

---

## 4. Memastikan agen terlihat Semanggi ✅

```bash
curl -s -H "authorization: Bearer $TOKEN" \
  http://semanggi-controller:8080/api/work/agents | jq '.summary, .agents[].id'
```

Yang perlu diperiksa: agen baru berstatus **`operable`**, bukan `config-only`. `config-only` berarti entri tertulis di `openclaw.json` tetapi gateway tidak pernah mengiklankannya — agen setengah jadi yang tidak akan pernah jalan (D32).

---

## 5. Menyiapkan Brain untuk tiap role ⚠ manual

**Ini bagian yang otomatisasinya belum dibangun** (provisioner brain-agent, tugas #5). Yang perlu dipahami: sebuah agen membawa **tepat satu model**, dan gateway menolak menjalankan model lain — bahkan untuk admin (D35). Jadi Brain harus sudah melekat pada agennya.

Lihat Brain yang tersedia dan level masing-masing:

```bash
curl -s -H "authorization: Bearer $TOKEN" \
  http://semanggi-controller:8080/api/work/brains | jq -r '.brains[] | "\(.level)\t\(.name)\t\(.provider)/\(.model)\t\(.effortMode)"'
```

Lalu buat agen per (role, Brain) dengan skrip provisioning yang sudah ada:

```bash
node scripts/provision-agents.mjs \
  --workspace /opt/semanggi/volumes/shared/service/semanggios/openclaw/workspaces/<project> \
  --models zai/glm-5.2,zai/glm-5.1 \
  --token-file /run/secrets/openclaw_gateway_token \
  --identity /opt/semanggi/volumes/shared/service/semanggios/controller/admin-identity.json \
  --dry-run
```

> Agen brain **harus** dibuat lewat RPC (skrip ini), **bukan** lewat UI AgentOS. Terukur: AgentOS mengabaikan model yang diminta — minta `glm-5.2`, tertulis `glm-4.7-flash` — dan model agen adalah allowlist yang menentukan Brain mana yang bisa jalan (D35).

---

## 6. Fase desain: Architect lebih dulu ✅

Ini yang membedakan pengembangan baru dari pemeliharaan. **Jangan mulai dari Builder** — skill Builder bawaan justru menjauhkannya dari desain (*"prefer direct code changes over speculative planning"*).

Task pertama, lewat Semanggi:

```bash
curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  http://semanggi-controller:8080/api/work/tasks -d '{
    "projectId": "<PRJ>",
    "workerId": "<worker architect>",
    "title": "Desain arsitektur NestJS + Nuxt",
    "description": "Rancang arsitektur monorepo: batas modul NestJS, struktur Nuxt, dan KONTRAK API di antara keduanya.\n\nTulis ke docs/architecture.md (Current shape, Dependencies, Risks) dan docs/service-map.md.\nCatat keputusan beserta alasannya di memory/decisions.md.\n\nWAJIB: tambahkan penunjuk ke dokumen itu di MEMORY.md bagian Stable facts, karena task berikutnya hanya akan menemukannya lewat sana.",
    "qualityClass": "L5",
    "workspaceMode": "write",
    "modelPolicy": { "preferred": ["glm-5-2-max"] }
  }'
```

Kalimat terakhir instruksinya bukan basa-basi. `docs/architecture.md` ada di **Tingkat 2** — tidak disuntik ke prompt. Task berikutnya hanya akan membukanya kalau `MEMORY.md` (Tingkat 1) menyebutnya (§9 spec).

Setelah selesai, periksa hasilnya:

```bash
curl -s -H "authorization: Bearer $TOKEN" \
  http://semanggi-controller:8080/api/work/tasks/<TASK-ID>/transcript | jq -r '.turns[] | "[\(.role)] \(.text)"'
```

---

## 7. Analisis proses & produk ✅

Role `analyst`, kategori `analysis`. Boleh paralel dengan desain teknis kalau `workspaceMode: "read"` — pembaca berbagi lease (D22).

```json
{
  "title": "Analisis alur bisnis dan kebutuhan produk",
  "description": "Baca docs/architecture.md. Tulis alur bisnis utama dan kebutuhan produk ke docs/brief.md (Objective, Success signals, Open questions). Tambahkan kendala dan hal yang belum diketahui ke memory/blueprint.md. WAJIB: perbarui penunjuk di MEMORY.md.",
  "workspaceMode": "read",
  "qualityClass": "L4"
}
```

---

## 8. Review desain — sesi terpisah ✅

Jangan minta Architect mereview tulisannya sendiri dalam sesi yang sama; model yang membaca ulang karangannya sendiri hampir selalu membenarkannya. Buat task baru (sesi baru) yang membaca dokumen sebagai pembaca:

```json
{
  "title": "Review desain arsitektur",
  "description": "Baca docs/architecture.md dan memory/decisions.md sebagai penilai independen. Cari asumsi yang tidak diuji, kendala yang terlewat, dan tradeoff yang tidak disebut. Tulis temuan ke deliverables/<TASK-ID>/review.md. Jangan mengubah dokumen aslinya.",
  "workspaceMode": "read",
  "qualityClass": "L5"
}
```

---

## 9. Implementasi ✅

Baru sekarang Builder. Satu task per satuan kerja yang masuk akal, bukan satu task raksasa:

```json
{ "title": "Scaffold NestJS di apps/api",   "workspaceMode": "write", "qualityClass": "L2" }
{ "title": "Scaffold Nuxt di apps/web",     "workspaceMode": "write", "qualityClass": "L2" }
{ "title": "Implementasi modul auth (API)", "workspaceMode": "write", "qualityClass": "L3" }
```

Ingat: `workspaceMode: "write"` memegang lease **seluruh project**, jadi ketiganya berjalan bergiliran. Itu disengaja pada monorepo.

Pantau lewat antrean:

```bash
curl -s -H "authorization: Bearer $TOKEN" http://semanggi-controller:8080/api/work/projects/summary | jq
```

Atau lewat Slack, kalau sudah dipasang (`slack-setup.md`):

```
/semanggi queue
/semanggi status TASK-XXXX
/semanggi model TASK-XXXX glm-5.2-max     ← naikkan Brain saat task ternyata berat
/semanggi run TASK-XXXX
```

---

## 10. Konsolidasi ✅

Terakhir, Learner (level `critical` — memadatkan pengetahuan adalah pekerjaan yang paling rugi bila effort-nya dipangkas):

```json
{
  "title": "Konsolidasi pengetahuan project",
  "description": "Baca deliverables/ dari seluruh task yang sudah selesai. Padatkan yang durabel ke MEMORY.md (Stable facts) dan memory/decisions.md. Buang yang sudah usang. Jaga MEMORY.md tetap ringkas — ia dibaca setiap run oleh setiap agen.",
  "workspaceMode": "write",
  "qualityClass": "L4"
}
```

---

## Yang belum ada, dan penggantinya sekarang

| Belum dibangun | Pengganti hari ini |
|---|---|
| Provisioner brain-agent per (project, role, brain) | `scripts/provision-agents.mjs` manual (§5) |
| Discovery project/role dari `project.json` | buat project & worker Semanggi manual |
| Planner Brain (dekomposisi otomatis) | tulis task satu per satu (§6–9) |
| `skills/semanggi-role-*/SKILL.md` | perilaku dititipkan ke instruksi task |
| Halaman UI Semanggi | API + Slack |

Empat yang pertama adalah tugas #4 dan #5 yang belum dikerjakan. Alur di atas **tetap berjalan penuh tanpanya** — hanya lebih banyak mengetik.

## Catatan keamanan yang masih terbuka

Gerbang izin ACP **belum terverifikasi** di 2026.7.1 karena token OAuth harness sudah tidak sah (§10.3 spec). Selama itu belum dibereskan, hindari task yang memakai jalur ACP (`claude-opus-high`, `claude-sonnet`, `claude-code-batch`) untuk pekerjaan yang menyentuh shell — L3 sebagian besar adalah shell, dan kegagalan gerbang izin bersifat senyap.

Brain berbasis GLM/Gemini/Groq tidak melewati jalur itu dan aman dipakai.
