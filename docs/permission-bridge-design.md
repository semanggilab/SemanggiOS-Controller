# Desain: Permission Bridge (P3-04 / P4-08)

**Masalah:** permintaan izin dari Claude Code tidak pernah sampai ke kontrol plane. Ia diputuskan otomatis di dalam harness, sehingga tidak ada status `WAITING_HUMAN`, tidak ada catatan siapa memutuskan apa, dan tidak ada jalur resume.

**Status dokumen:** desain, belum diimplementasikan. Ditulis sebagai masukan untuk POC-3 E3/E4 (Kilo Code) dan sebagai prasyarat P4-08.

---

## 1. Apa yang sudah dibuktikan

### Protokol ACP memang mengirim permintaan izin

Probe langsung (`tests/acp-client-probe.mjs` sebagai klien ACP) menerima ini dari adapter, apa adanya:

```json
{"method":"session/request_permission",
 "params":{"toolCall":{"title":"Write acp-e1.txt"},
           "options":[{"optionId":"allow_always"},{"optionId":"allow"},{"optionId":"reject"}]}}
```

Jadi sinyalnya **ada dan lengkap** — ada judul tool call, ada daftar opsi. Yang hilang bukan datanya.

### Yang menelannya adalah acpx, bukan protokol

Ketika acpx menjadi klien ACP (jalur produksi), ia menjawab sendiri berdasarkan `permissionMode` dan `nonInteractivePermissions`, lalu meneruskan hasilnya ke harness. Dari E1 dengan `approve-reads` + `deny`, Claude melapor:

> *"I was unable to create the file — both the Write and Bash tools were denied permission."*

Task tetap "selesai" dari sudut pandang OpenClaw. Tidak ada `WAITING_HUMAN`.

### Jalur exec-approval OpenClaw tidak tersambung ke acpx

Gateway punya surface RPC approval yang lengkap:

```
exec.approval.request / .list / .get / .resolve
events: exec.approval.requested / .approved / .denied / .resolved
```

Tetapi pencarian pada dist plugin `@openclaw/acpx@2026.6.11` untuk `exec.approval` mengembalikan **nol kecocokan**. Ini mengonfirmasi catatan dokumentasi di POC-3 §11 butir 3: permission harness acpx dipisahkan dari exec approval OpenClaw. Relay `src/acp/permission-relay.ts` yang ada di dist `acp-cli` melayani topologi lain (`openclaw acp client`), bukan runtime backend acpx.

**Kesimpulan:** jembatan ini tidak bisa dinyalakan lewat konfigurasi. Ia harus dibangun.

---

## 2. Opsi yang dipertimbangkan

| # | Pendekatan | Granularitas | Perubahan di mana | Penilaian |
|---|---|---|---|---|
| A | Pra-otorisasi saat admission: klasifikasi L0–L3, minta persetujuan **sebelum** dispatch, lalu jalankan `approve-all` | Per task | Controller saja (sudah ada) | Jalan hari ini, tapi kasar: menyetujui task, bukan tindakan. Tidak menjawab "boleh `rm -rf` ini?" |
| B | Hook `PreToolUse` Claude Code di image sandbox, callback ke controller | Per tool call | Image sandbox + settings | **Ditolak.** Hook berjalan di dalam container, dan container ACP berada di network `semanggi-acp` yang terbukti tidak bisa menjangkau `openclaw-gateway` maupun `agentos` (ENOTFOUND, diverifikasi E1). Menyambungkannya berarti membongkar isolasi yang baru saja dibuktikan |
| C | **Interposer ACP di dalam wrapper**: sisipkan proxy stdio antara acpx dan adapter, tahan `session/request_permission` | Per tool call | `semanggi-acp-claude` (artefak milik kita) | **Direkomendasikan.** Titik keputusan berada di host gateway — di luar sandbox, tepat di tempat kontrol plane seharusnya |
| D | Ubah acpx di hulu | Per tool call | Proyek OpenClaw | Di luar kendali; tidak untuk POC |

### Mengapa C, bukan A

A dan C tidak saling meniadakan. A sudah terimplementasi di controller dan tetap berguna sebagai gerbang kasar untuk task L3. C menambahkan apa yang A tidak bisa berikan: keputusan atas **tindakan konkret** yang belum diketahui saat task dibuat. Spec induk §10 menuntut yang kedua — "production deploy, DB migration, secret rotation" adalah sifat perintah, bukan sifat task.

### Mengapa C aman secara arsitektur

Wrapper `semanggi-acp-claude` sudah menjadi proses di host gateway yang mem-*pipe* stdio ke `docker run -i`. Menambah interposer tidak mengubah batas keamanan mana pun: container tetap `cap-drop ALL`, read-only, tanpa docker.sock, di network terisolasi. Yang berubah hanya siapa yang menjawab satu jenis pesan JSON-RPC.

---

## 3. Desain yang diusulkan

### Topologi

```text
acpx (klien ACP)
   │ stdio JSON-RPC
   ▼
semanggi-acp-claude  ──► interposer  ──HTTP──►  Work Controller /api/work/approvals
   │                        │                        │
   │                        │  tahan request         ▼
   │                        │                   task → WAIT_HUMAN
   │                        │  ◄── keputusan ───  operator (UI/Slack)
   ▼
docker run -i  →  claude-agent-acp  →  Claude Code
```

### Perilaku interposer

Semua pesan diteruskan apa adanya, **kecuali** `session/request_permission` dari arah adapter:

1. Tahan pesan (jangan teruskan ke acpx, jangan jawab).
2. `POST` ke controller: `{sessionId, toolCall.title, options[], workspacePath, riskLevel}`.
3. Controller membuat `Approval`, task berpindah ke `WAIT_HUMAN` — ini menjadi pemicu `WakeReason.APPROVAL_DECIDED` yang sudah ada.
4. Tunggu keputusan (long-poll atau SSE), dengan **timeout wajib**.
5. Jawab ke adapter dengan `optionId` hasil pemetaan:

| Keputusan operator | `optionId` |
|---|---|
| APPROVE | `allow` |
| APPROVE + "jangan tanya lagi untuk tool ini" | `allow_always` |
| REJECT / MODIFY | `reject` |
| Timeout | `reject`, dengan alasan tercatat |

Sesi ACP **tidak pernah mati** selama menunggu. Ini lebih baik daripada pola "mati lalu resume": tidak ada konteks yang hilang dan tidak perlu `session/load`.

### Klasifikasi risiko

Interposer tidak menilai risiko. Ia mengirim `toolCall.title` mentah; **controller** yang memetakan ke L0–L3 memakai aturan yang sudah dimilikinya. Alasannya: kebijakan harus hidup di satu tempat yang dapat diaudit, bukan tersebar di wrapper shell.

Default yang diusulkan (dapat dikonfigurasi):

| Level | Contoh | Perilaku |
|---|---|---|
| L0 | `Read`, `Glob`, `Grep` | auto-approve, tidak dicatat sebagai approval |
| L1 | `Write`/`Edit` di dalam `executions/<task-id>` | auto-approve, dicatat di EventLog |
| L2 | `Bash` non-destruktif, instalasi paket | auto-approve bila task `approval_level ≤ L2`, selain itu tanya |
| L3 | tulis di luar workspace, `docker`, `kubectl`, migrasi DB, rotasi secret, `rm -rf` | **selalu** `WAIT_HUMAN` |

### Konfigurasi acpx yang menyertainya

Interposer hanya efektif bila acpx berhenti menjawab lebih dulu. Kombinasi yang harus diuji di E3:

```
plugins.entries.acpx.config.permissionMode        = approve-reads
plugins.entries.acpx.config.nonInteractivePermissions = fail
```

`fail` (default upstream) memunculkan `PermissionPromptUnavailableError` alih-alih menolak diam-diam. Jika interposer sudah menjawab lebih dulu, acpx tidak pernah sampai ke kondisi itu — dan bila interposer mati, kegagalannya **berisik**, bukan senyap. Itu properti yang diinginkan: mode `deny` yang dipakai E1 justru menyembunyikan masalah.

---

## 4. Yang harus dibuktikan E3/E4

| Uji | Kondisi lulus |
|---|---|
| E3-a | `Write` di luar workspace memunculkan `session/request_permission`, task → `WAIT_HUMAN`, approval tercatat dengan `toolCall.title` yang benar |
| E3-b | APPROVE → adapter menerima `allow`, Claude melanjutkan **sesi yang sama**, task → `RUNNING` → `COMPLETE`; tidak ada session baru |
| E4-a | REJECT → adapter menerima `reject`, Claude berhenti bersih, sesi tetap hidup, task → `BLOCKED` |
| E4-b | Revision `CONTINUE` setelah reject membawa konteks penolakan ke giliran berikutnya |
| E3-c | Timeout tanpa keputusan → `reject` + alasan; tidak ada proses menggantung |
| E3-d | Interposer mati mid-turn → kegagalan berisik (`nonInteractivePermissions=fail`), bukan auto-approve diam-diam |
| E9-tambahan | Batas sandbox tidak berubah: bind, cap, network, tanpa docker.sock — sama seperti hasil E1 |

---

## 5. Risiko dan batasan yang diketahui

- **Kompatibilitas versi.** Interposer bergantung pada bentuk pesan `session/request_permission` pada adapter `0.39.0`. Pin versi wajib, dan upgrade adapter harus menjalankan ulang E3/E4.
- **`allow_always` bersifat per sesi harness**, bukan kebijakan permanen. Jangan disajikan ke operator sebagai "selalu izinkan" tanpa kualifikasi itu.
- **Satu titik serialisasi.** Semua permission satu sesi lewat satu proses wrapper. Untuk POC ini tidak masalah (satu sesi = satu container), tapi perlu diingat kalau kelak satu wrapper melayani banyak sesi.
- **Jalur ini tidak memakai `exec.approval.*` OpenClaw.** Konsekuensinya, approval Claude Code tidak akan muncul di surface approval bawaan OpenClaw. Itu keputusan sadar: spec POC-4 §6 menempatkan approval pada kontrol plane Semanggi, bukan pada OpenClaw. Bila kelak acpx menyambungkan dirinya ke `exec.approval.*` di hulu, desain ini dapat diganti dengan relay native — dan controller tidak perlu berubah karena kontraknya tetap `Approval` + `WAIT_HUMAN`.

---

## 6. Perkiraan usaha

| Bagian | Perkiraan |
|---|---|
| Interposer ACP (Node, ~200 baris) + unit test | 0,5–1 hari |
| Endpoint `POST /api/work/approvals` + long-poll keputusan di controller | 0,5 hari (model `Approval` sudah ada) |
| Peta klasifikasi risiko + konfigurasi | 0,5 hari |
| E3/E4 di cluster | 0,5 hari |

Sisi controller sebagian besar sudah berdiri: `Approval`, `WAIT_HUMAN`, atribusi `decided_by`, `REJECT → BLOCKED`, dan `WakeReason.APPROVAL_DECIDED` semuanya sudah diimplementasikan dan diuji pada fase 1–3.
