# Upgrade OpenClaw: 2026.6.11 → apa yang sebenarnya bisa dipasang

Disusun 2026-08-22. Semua angka dan status di bawah **diverifikasi langsung** terhadap registry dan image, bukan dibaca dari dokumentasi.

## Temuan yang mengubah pertanyaannya

Anda benar bahwa 2026.8.1 masih preview — dan kenyataannya lebih tegas dari itu.

```
ghcr.io/openclaw/openclaw:2026.6.11   ADA   dibangun 2026-06-30   ← terpasang sekarang
ghcr.io/openclaw/openclaw:2026.7.1    ADA   dibangun 2026-07-13   ← satu-satunya target bertag versi
ghcr.io/openclaw/openclaw:2026.8.1    TIDAK ADA
ghcr.io/openclaw/openclaw:latest      ADA   dibangun 2026-08-04   revision 81ac4f3
ghcr.io/openclaw/openclaw:beta        TIDAK ADA
```

Source tree `work/openclaw-source` menyebut dirinya `2026.8.1`, tetapi di CHANGELOG isinya berada di section **`## Unreleased`** — bukan rilis. Satu-satunya versi yang benar-benar dirilis antara pin kita dan source itu adalah **2026.7.1**.

Jadi pertanyaannya bukan "upgrade ke 8.1 atau tidak", melainkan dua pertanyaan terpisah:

1. Upgrade ke **2026.7.1** (rilis, bertag, immutable)?
2. Atau ikut **`latest`** (preview 2026.8.x, tanpa tag versi)?

## Kabar baik: yang kita inginkan sudah ada di 2026.7.1

Diperiksa langsung di dalam image `ghcr.io/openclaw/openclaw:2026.7.1`:

| Yang dibutuhkan | Status di 2026.7.1 | Menutup masalah |
|---|---|---|
| `agent.run` sebagai metode | **Terdaftar** | — (adapter kita sudah menegosiasi nama metode, jadi ini otomatis) |
| `workspaceDir` | Ada di 391 berkas dist | Workspace per dispatch → menghapus keharusan satu agen per workspace |
| `agentRuntime` | Ada di 93 berkas dist | `agentRuntime.acp.agent` → pemilihan harness opus/sonnet yang **ditegakkan**, bukan sekadar niat (D18) |

Changelog 2026.7.1 juga memuat: *"ACP runtime controls can now truly clear saved model, thinking, working-directory, permission, timeout, mode, and backend-extra settings"* — persis wilayah yang menyakiti kita.

**Artinya: tidak perlu menyentuh preview sama sekali.** Semua yang saya sebut "menunggu upgrade" di `readiness.md` tersedia di versi rilis.

## Risiko, diurut dari yang paling nyata

### 1. State 3,2 GB dan migrasi yang belum pernah dijalankan — **risiko tertinggi**

```
/opt/semanggi/volumes/shared/service/semanggios/openclaw/state   3.2G
```

Kabar baiknya spesifik: **baik 2026.6.11 maupun 2026.7.1 tidak mendeklarasikan `schemaVersions` sama sekali.** Field itu (`{state: 9, agent: 17}`) baru muncul di preview 8.x. Jadi lompatan 6.11 → 7.1 menghindari mesin migrasi baru itu sepenuhnya — sedangkan 6.11 → preview akan menabraknya.

Ini argumen terkuat untuk memilih 7.1 daripada `latest`.

Tetap saja 6.11 → 7.1 melewati ~2.400 baris changelog, termasuk beberapa yang menyentuh SQLite:

- *"State snapshot verification: run SQLite snapshot verification in a separate process so worker-thread file closes no longer drop the Gateway's POSIX WAL locks"* — perbaikan, tapi menandakan area WAL memang rapuh. Kita menjalankan SQLite di atas **NFS**.
- *"SQLite maintenance schema validation: reject current-version databases with missing or drifted canonical tables… before compaction"* — validasi lebih ketat. Kalau state kita pernah tersentuh manual, ini yang akan menolaknya.

**Mitigasi wajib: backup penuh `openclaw/state` + `config` sebelum apa pun, dan uji restore.** Bukan "backup lalu berdoa" — restore harus dicoba sekali.

### 2. `latest` itu mutable — melanggar kontrak stack kita

Kalau Anda memilih preview, tidak ada tag versi. Menulis `image: ghcr.io/openclaw/openclaw:latest` di stack berarti dua node bisa menjalankan build berbeda — persis yang diperingatkan Swarm saat deploy. Kalau tetap ingin preview, **pin ke digest**:

```
ghcr.io/openclaw/openclaw@sha256:a1244a907a20cde7553389386aa2c70af44f9713ae87011c69ee5a6039caafd3
```

Immutable dan jujur. Tapi digest tidak memberi tahu siapa pun versi apa itu, dan tidak ada catatan rilis untuk dibaca saat ada masalah.

### 3. Plugin terpasang di luar image

`acpx` dan `zai` hidup di `state/npm/projects/`, bukan di dalam image. Keduanya tidak ikut ter-upgrade, dan keduanya adalah jalur kritis kita:

- `acpx` — seluruh jalur ACP/harness Claude, termasuk perintah wrapper per-model.
- `zai` — provider GLM, termasuk `isGlm52ModelId()` yang menentukan level effort.

Setelah upgrade gateway, keduanya perlu diperiksa ulang kompatibilitasnya dan mungkin di-reinstall. Kalau `zai` ikut diperbarui, pemetaan effort GLM bisa berubah — dan itu **bagus** (mungkin memperbaiki `low`≡`high` yang sekarang), tetapi katalog routing harus diukur ulang, bukan diasumsikan.

### 4. Device auth — **risiko rendah, sudah diperiksa**

Changelog memuat *"Gateway device clock skew: sign device proofs with the Gateway-issued challenge timestamp"*, yang terdengar seperti perubahan merusak. Diperiksa di source: `buildDeviceAuthPayloadV3` **byte-for-byte identik** dengan implementasi kita, dan helper server masih memakai `signedAtMs ?? Date.now()`. Perubahannya di sisi klien dan kompatibel mundur. Pairing controller seharusnya selamat.

### 5. AgentOS satu paket dengan gateway

Runbook menyatakan AgentOS dan OpenClaw adalah satu compatibility change set. AgentOS kita `2026081805` dibangun terhadap gateway 6.11. Upgrade gateway berarti **AgentOS juga harus divalidasi ulang**, dan mungkin dibangun ulang. Ini bagian yang tidak bisa diperkirakan dari luar — butuh dijalankan.

### 6. Image gateway kustom kita

`images/openclaw-gateway/Dockerfile` mem-`FROM` image upstream dan menambah: entrypoint, wrapper ACP, tiga perintah tipis per-model, dan interposer izin. Yang perlu diverifikasi ulang setelah base berubah:

- lokasi `claude-agent-acp` dan kontrak argumennya
- jalur stdio yang disadap interposer (kalau acpx berubah, gerbang izin bisa diam-diam berhenti bekerja — **ini yang paling berbahaya**, karena gagalnya senyap)
- kontrak mount sandbox (`source == target`)
- `openclaw sandbox` CLI

## Perkiraan effort

Angka ini untuk **6.11 → 2026.7.1**, bukan preview.

| Tahap | Isi | Perkiraan |
|---|---|---|
| Persiapan | Backup `state` + `config` (3,2 GB), **uji restore**, catat baseline: `doctor`, `models list`, `agents list`, `devices list`, `secrets audit` | 0,5 hari |
| Build | Rebuild image gateway kustom di atas 7.1; perbaiki apa pun yang tidak lagi cocok | 0,5–1 hari |
| Verifikasi kontrak | Ulangi pengukuran yang jadi dasar D13/D14/D15/D17/D18: param `agent.run`, `cwd`/`workspaceDir`, otorisasi override model, `sessions.subscribe`, bentuk `usage`, level thinking per model | 1 hari |
| Plugin | Periksa/reinstall `acpx` dan `zai`; ukur ulang level effort GLM | 0,5 hari |
| Gerbang izin | Jalankan `permission-bridge-verify.sh` — ketiga kasus. **Tidak boleh dilewati**: kegagalannya senyap | 0,5 hari |
| AgentOS | Validasi kompatibilitas, kemungkinan rebuild | 0,5–2 hari (paling tidak pasti) |
| Bukti POC | Ulangi POC-1..3 secukupnya + P4-09/10/11 di controller | 1 hari |
| Penyederhanaan | Manfaatkan `workspaceDir` (hapus agen-per-workspace) dan `agentRuntime.acp.agent` (tegakkan pilihan harness) | 1 hari |
| **Total** | | **5,5–8 hari kerja**, ditambah cadangan rollback |

Yang membuat rentangnya lebar hanya satu hal: AgentOS. Sisanya cukup terprediksi karena kita punya harness pengujian untuk hampir semuanya.

## Rollback

`docker service rollback` mengembalikan spec service, **tetapi tidak mengembalikan state yang sudah bermigrasi.** Kalau 7.1 menulis ulang format state, rollback ke 6.11 berarti restore dari backup. Karena itu urutan wajibnya:

1. Backup + uji restore.
2. Upgrade di luar jam sibuk, dengan `stop-first` (sudah jadi kontrak stack kita).
3. Kalau gagal: scale ke 0, restore state, kembalikan tag, naikkan lagi.

Jangan pernah menjalankan dua gateway terhadap satu state root — kontrak POC-1 masih berlaku.

## Rekomendasi

**Upgrade ke 2026.7.1, jangan ke preview.** Alasannya bukan kehati-hatian umum melainkan tiga fakta konkret:

1. Semua fitur yang kita tunggu **sudah ada di 7.1** — `workspaceDir`, `agentRuntime`, `agent.run`. Preview tidak menambah apa pun yang kita butuhkan.
2. Preview memperkenalkan `schemaVersions` dan karenanya mesin migrasi state baru terhadap data 3,2 GB kita. 7.1 tidak.
3. Preview tidak punya tag versi. Pin digest bisa, tetapi menghilangkan catatan rilis justru saat paling dibutuhkan.

**Namun jangan lakukan sekarang.** Kontrol plane baru saja berdiri dan baru terbukti utuh hari ini. Nilai upgrade adalah penyederhanaan (menghapus agen-per-workspace, menegakkan pilihan harness) — bukan memperbaiki sesuatu yang rusak. Menumpuk perubahan besar di atas sesuatu yang baru berjalan akan mengaburkan sebab kalau ada yang salah.

Urutan yang saya sarankan: jalankan sistem apa adanya beberapa waktu, kumpulkan pengalaman operasional, lalu upgrade sebagai pekerjaan tersendiri dengan jendela dan rencana rollback yang jelas.
