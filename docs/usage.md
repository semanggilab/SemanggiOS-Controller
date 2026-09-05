# Menjalankan dan memakai Work Controller

## Apa yang bisa dipakai hari ini

| Bagian | Status |
|---|---|
| HTTP API `/api/work/*` | **Jalan** |
| Chat surface (`POST /api/work/slack`) | **Jalan** — transport-agnostic, belum ada app Slack yang menembaknya |
| Penjadwalan, fairness, lease, kuota, approval | **Jalan** |
| Dispatch ke runtime nyata | **Belum** — menunggu device pairing (`docs/decisions.md` D13) |

Artinya: Anda bisa membuat project, worker, task, memantau antrean, dan memutuskan approval sekarang. Yang belum adalah task benar-benar dijalankan agent. Sampai pairing selesai, semua task berhenti di `WAIT_RUNTIME` dengan alasan yang terbaca.

---

## 1. Coba cepat di laptop (tanpa cluster)

```sh
cd semanggi-work-controller
node demo-smoke.mjs
```

Membuat project, worker, resource dan task, lalu mencetak antrean. Memakai fake runtime, jadi tidak butuh kredensial maupun kuota model. Gunakan ini untuk melihat bentuk API sebelum menyentuh cluster.

```
project : PRJ-BFC097FB (weight 5)
worker  : WRK-86638B81 -> agent doc-worker
resource: google/gemini-flash
task    : TASK-8098067D -> DISPATCHED
queue   : running=1 waiting=1
          TASK-F17F6C40 WAIT_WORKER no worker assigned
```

## 2. Menjalankan sebagai service

```sh
CONTROLLER_TOKEN_FILE=/run/secrets/semanggi_controller_token \
SEMANGGI_ROUTING_CONFIG=/app/config/routing.json \
SEMANGGI_DB=/opt/semanggi/volumes/shared/service/semanggios/controller/controller.db \
SEMANGGI_GATEWAY_URL=ws://openclaw-gateway:18789 \
SEMANGGI_GATEWAY_TOKEN_FILE=/run/secrets/openclaw_gateway_token \
node src/main.mjs
```

Di cluster ini dilakukan lewat stack (`semanggi-controller`, satu replica, tanpa port publik). Startup **sengaja gagal keras** bila token atau routing policy tidak ada — controller yang hidup tapi tidak bisa menjadwalkan apa pun lebih berbahaya daripada yang mati.

---

## 3. Urutan yang harus dibuat (dan kenapa)

Ketiganya prasyarat. Melewatkan salah satu membuat task menunggu, bukan gagal — antrean akan memberi tahu yang mana.

### Project — unit penjadwalan adil

```sh
curl -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"semanggi","weight":5,"workspacePath":"/opt/semanggi/volumes/shared/service/semanggios/openclaw/workspaces/semanggi"}' \
  http://controller:8080/api/work/projects
```

`weight` menentukan porsi throughput. Bobot 5 dilayani ~5× lebih sering daripada bobot 1, tetapi bobot 1 **tidak pernah** kelaparan.

### Worker — pemetaan ke agent OpenClaw

```sh
curl ... -d '{"role":"documentation","agentRef":"doc-worker","maxConcurrent":2,"projectAccess":["PRJ-..."]}' \
  http://controller:8080/api/work/workers
```

`agentRef` harus agent yang benar-benar ada di OpenClaw. Tanpa worker, task berhenti di `WAIT_WORKER`.

### Resource — model yang boleh dipakai

```sh
curl ... -d '{"provider":"zai","model":"glm-4.7","concurrencyLimit":4}' \
  http://controller:8080/api/work/resources
```

Untuk paket langganan: `{"creditClass":"subscription"}`. Tanpa resource, routing policy tidak menemukan kandidat dan task berhenti di `WAIT_RESOURCE`.

---

## 4. Membuat dan mengelola task

```sh
curl ... -d '{
  "projectId":"PRJ-...",
  "workerId":"WRK-...",
  "title":"perbaiki bug login",
  "description":"instruksi lengkap untuk agent",
  "priority":2,
  "qualityClass":"L2",
  "approvalLevel":"L0",
  "dependsOn":[]
}' http://controller:8080/api/work/tasks
```

Response **sudah memuat hasil admission** — pembuatan task langsung memicu satu pass penjadwalan, jadi Anda melihat `DISPATCHED` atau alasan menunggunya seketika.

| Field | Arti |
|---|---|
| `priority` | 0 P0 Emergency … 4 P4 Background. P0 melewati fairness |
| `qualityClass` | L0–L5 → tier routing (`critical`/`normal`/`low`) di `config/routing.json` |
| `approvalLevel` | `L3` selalu berhenti minta persetujuan manusia sebelum dispatch |
| `dependsOn` | Task tidak jalan sampai semua dependensinya `COMPLETE` |

Operasi lain:

```sh
GET  /api/work/tasks/{id}              # task + semua execution + approval
POST /api/work/tasks/{id}/revisions    # {"session_mode":"CONTINUE","instruction":"..."}
POST /api/work/tasks/{id}/expedite     # {"ttl":1800000} — boost ber-TTL, prioritas asli utuh
POST /api/work/tasks/{id}/cancel
```

`session_mode`: `CONTINUE` melanjutkan sesi harness yang sama, `FORK` bercabang darinya, `FRESH` mulai baru.

---

## 5. Lewat bahasa operator

```sh
curl ... -d '{"text":"task perbaiki bug login","user":"satria"}' \
  http://controller:8080/api/work/slack
```

Perintah yang dikenali (dua bahasa):

```
task <deskripsi>              buat & antrekan
status TASK-XXXX              status + alasan menunggu
expedite TASK-XXXX 30m        boost sementara (juga "2 jam")
approve TASK-XXXX             setujui approval yang menunggu
reject TASK-XXXX              tolak
lanjutkan TASK-XXXX <instruksi>   revision CONTINUE
review TASK-XXXX              hasil eksekusi terakhir + token terpakai
pause TASK-XXXX               batalkan
```

Kalau maksudnya tidak jelas, controller **bertanya**, tidak menebak:

```
I'm not sure what you meant — could not classify; ask the operator.
Try: `task <description>`, `status TASK-XXXX`, ...
```

Ini disengaja (P4-12). Menebak adalah cara sebuah pertanyaan "status" berubah jadi task yang dibatalkan.

**Menyambungkan Slack sungguhan:** endpoint ini transport-agnostic. Slack app Anda (slash command atau Events API) mem-POST `{text, user}` ke sini dan menampilkan `reply`. Belum ada app yang dibuat — itu pekerjaan berikutnya, dan sengaja di luar controller supaya intent router bisa diuji tanpa Slack.

---

## 6. Memantau

```sh
GET /api/work/queue       # apa yang jalan, apa yang menunggu, kenapa, ETA
GET /api/work/resources   # kuota & jendela reset per model
GET /api/work/leases      # workspace yang sedang dikunci
GET /api/work/stats       # token terpakai per model (termasuk cache-read)
```

`/api/work/queue` adalah tempat pertama yang dilihat kalau ada yang tidak bergerak. Setiap task menyebutkan `waitReason` — sembilan kemungkinan, masing-masing spesifik:

| Status | Artinya |
|---|---|
| `WAIT_DEP` | Menunggu task lain selesai |
| `WAIT_HUMAN` | Menunggu approval Anda |
| `WAIT_WORKSPACE` | Task lain memegang lease workspace itu |
| `WAIT_RESOURCE` | Tidak ada model yang cocok policy, atau semuanya mati |
| `WAIT_QUOTA` | Model resmi kehabisan kuota; `etaAt` = waktu reset sebenarnya |
| `WAIT_CONCURRENCY` | Model penuh |
| `WAIT_WORKER` | Tidak ada worker, atau worker penuh |
| `WAIT_RUNTIME` | Runtime penuh atau menolak handoff |

Tidak ada admission yang menghasilkan `FAILED`. Kalau Anda melihat `FAILED`, itu eksekusi yang benar-benar gagal, bukan task yang tidak kebagian giliran.

---

## 7. Approval

Dua sumber, satu mekanisme:

1. **Task L3** — berhenti sebelum dispatch.
2. **Interposer permission** (POC-3) — menahan tool call di tengah turn dan memanggil `POST /api/work/approvals`.

Menjawab:

```sh
curl ... -d '{"decision":"APPROVE","decided_by":"satria","note":"sudah dicek"}' \
  http://controller:8080/api/work/approvals/{id}/decide
```

`decided_by` **wajib** — approval yang tidak bisa diatribusikan bukan approval. `COMMENT` tidak menutup approval; pakai `/comment` untuk itu. `APPROVE` melanjutkan turn yang sama; `REJECT` memindahkan task ke `BLOCKED`, yang bisa dipulihkan lewat revision.

---

## 8. Menyetujui device pairing controller

Token bersama hanya memberi controller `role: operator` **tanpa scope**, sehingga dispatch ditolak `missing scope: operator.write`. Scope berasal dari device yang dipasangkan — mekanisme yang sama dengan AgentOS di POC-1.

### Cara kerjanya

Saat pertama menyambung, controller:

1. Membuat kunci Ed25519 dan menyimpannya di `/opt/semanggi/volumes/shared/service/semanggios/controller/device-identity.json` (mode 0600, di NFS supaya identitasnya tetap sama lintas restart dan redeploy — kunci baru tiap boot berarti Anda menyetujui service yang sama berulang kali).
2. Menandatangani nonce `connect.challenge` dengan payload v3 yang dibandingkan byte-per-byte oleh gateway.
3. Ditolak `NOT_PAIRED` dan masuk antrean pending.

### Pending request kedaluwarsa dalam 5 menit

`PAIRING_PENDING_TTL_MS = 5 * 60 * 1000` (source OpenClaw), dan request di-*refresh* setiap kali client mencoba menyambung lagi. Satu kali connect karena itu membuat request yang keburu hilang sebelum siapa pun sempat bertindak — gejalanya `openclaw devices approve` menjawab **`unknown requestId`** dan `devices list` menunjukkan `pending: []`.

Jadi jalankan helper yang terus mencoba selama Anda menyetujui:

```sh
gw=$(docker ps -q --filter 'label=com.docker.swarm.service.name=semanggi_openclaw-gateway' | head -1)
tok=$(docker exec "$gw" cat /run/secrets/openclaw_gateway_token)
ctrl=/opt/semanggi/volumes/shared/service/semanggios/controller

docker run --rm --network semanggi_semanggi_internal \
  -e SEMANGGI_GATEWAY_TOKEN="$tok" --user 1000:1000 \
  -v /srv/ctrl-src:/app:ro -v "$ctrl":"$ctrl" node:24-bookworm-slim \
  node /app/scripts/pair-device.mjs --identity "$ctrl/device-identity.json"
```

Helper mencetak `requestId` dan perintah approve-nya, menyegarkan request tiap 20 detik, dan berhenti sendiri begitu pairing diterima. Setelah controller berjalan sebagai service, helper tidak diperlukan lagi — service itu sendiri yang menyegarkan request setiap kali mencoba menyambung.

### Melihat antrean

```sh
gw=$(docker ps -q --filter 'label=com.docker.swarm.service.name=semanggi_openclaw-gateway' | head -1)
tok=$(docker exec "$gw" cat /run/secrets/openclaw_gateway_token)

docker exec "$gw" openclaw devices list --token "$tok" --json
```

```json
{
  "requestId": "ff786a3c-e944-4f7d-b9b4-73713e1994a5",
  "deviceId": "55c917e13957f9443a51…",
  "clientId": "gateway-client",
  "clientMode": "backend",
  "role": "operator",
  "scopes": ["operator.write"]
}
```

**Periksa sebelum menyetujui.** `clientId: gateway-client`, `clientMode: backend`, dan scope tepat `operator.write` (bukan `operator.admin`). `deviceId` harus cocok dengan sha256 kunci publik di berkas identitas — kalau ada dua request pending, jangan menebak.

### Menyetujui

```sh
docker exec "$gw" openclaw devices approve <requestId> --token "$tok"
```

Sekali saja. Setelah itu controller mendapat scope pada setiap connect berikutnya, dan dispatch berjalan.

### Membatalkan

```sh
docker exec "$gw" openclaw devices list   --token "$tok"     # lihat deviceId
docker exec "$gw" openclaw devices remove <deviceId> --token "$tok"
docker exec "$gw" openclaw devices revoke <deviceId> --token "$tok"   # cabut token peran
```

Menghapus `device-identity.json` juga memutus akses — controller akan membuat identitas baru dan meminta pairing lagi.

### Kenapa `operator.write`, bukan `operator.admin`

Controller hanya perlu menjalankan agent. `operator.admin` juga mengizinkan mengubah konfigurasi gateway, memasang plugin, dan menyetujui device lain — kemampuan yang tidak dibutuhkan admission controller dan tidak seharusnya dimiliki. Kalau nanti ternyata ada method yang butuh admin, itu keputusan sadar berikutnya, bukan default.

## 9. Yang belum ada

- **Dispatch nyata** — menunggu device pairing (D13). Sampai itu beres, task berhenti di `WAIT_RUNTIME`.
- **Slack app** — endpointnya siap, transportnya belum dibuat.
- **UI** — tidak ada; `/api/work/queue` dimaksudkan untuk disedot AgentOS UI atau dashboard kecil (§8.1), bukan dilayani controller.
