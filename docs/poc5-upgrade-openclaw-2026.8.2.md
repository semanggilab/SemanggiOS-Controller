# POC-5 — OpenClaw 2026.8.2 di atas AgentOS 0.7.7

**Tanggal review/eksekusi:** 2026-09-08  
**Target:** OpenClaw Gateway 2026.8.2 (commit rilis 0965053f)  
**Baseline produksi:** OpenClaw 2026.7.1, AgentOS fork agentos-v0.7.7  
**Status:** **POC lab selesai — LULUS BERSYARAT. Produksi belum dinaikkan.**

Dokumen ini memperbarui POC-5 setelah POC-7 berhasil menaikkan AgentOS ke
0.7.7. Semua pengujian upgrade dilakukan pada salinan state dan gateway lab
terisolasi di kub01-01. Gateway produksi tetap memakai 2026.7.1.

---

## 1. Keputusan

OpenClaw 2026.8.2 dapat dipakai bersama AgentOS 0.7.7 dengan satu perubahan
kompatibilitas wajib: konfigurasi agen 8.2 memakai agents.entries berbentuk map,
sedangkan 7.1 memakai agents.list berbentuk array. Adapter AgentOS sekarang membaca
dan menulis format 8.2, dengan fallback untuk 7.1.

Hasil utama:

- gateway 8.2 lab hidup dan healthy di 127.0.0.1:18790;
- doctor --fix memigrasikan config/state dan mempertahankan **17 agen**;
- probe RPC nyata lulus untuk protocol 4, 372 metode, dispatch agent,
  create/delete agen, dan agents.entries;
- patch AgentOS lulus **103/103 test terarah** dan typecheck;
- permission bridge ACP lulus tiga kasus: level rendah otomatis, L3 approve
  dieksekusi, serta reject tidak dieksekusi dan tidak bocor;
- token OAuth harness valid; direct ACP membalas POC5-AUTH-OK;
- plugin resmi lab acpx, groq, zai, dan cerebras aktif dengan capability consent;
- backup SQLite diuji restore dan seluruh integrity check lulus.

Produksi belum di-upgrade. Syarat rollout yang tersisa adalah mengulang pemeriksaan
administratif dengan identitas device AgentOS yang memiliki scope lengkap, lalu
melakukan deploy stop-first dalam jendela perubahan.

## 2. Koreksi atas dokumen lama

| Asumsi lama | Kondisi aktual |
|---|---|
| AgentOS belum 0.7.7 | POC-7 selesai; fork 0.7.7 berjalan di cluster. |
| Ada 5 agen | State aktual berisi **17 agen**; semuanya bertahan di lab 8.2. |
| OAuth tidak valid | Sudah valid; direct ACP menghasilkan POC5-AUTH-OK. |
| Controller pasti perlu diubah | Controller sudah menangani UUID frame, device connect top-level, message + idempotencyKey, dan normalisasi thinking. |
| Permission bridge belum diuji | Sudah lulus tiga skenario wajib. |
| AgentOS hanya menulis agents.list | Patch dual-format agents.entries/list sudah diterapkan dan diuji. |
| Plugin lama sekadar bisa dimuat | Paket resmi 8.2 acpx/groq/zai/cerebras aktif di lab dengan consent. |
| Migrasi mengganti semua transkrip | **214 JSONL legacy dan 5 SQLite agen hidup berdampingan**; keduanya harus dipertahankan selama masa rollback. |

## 3. Topologi POC

### 3.1 Produksi

Pada saat pengukuran:

~~~text
AgentOS     semanggi/agentos:2026090601
Gateway     semanggi/openclaw-gateway:2026083001 (OpenClaw 2026.7.1)
Controller  semanggi/work-controller:2026090405
~~~

Gateway produksi tidak disentuh oleh POC upgrade.

### 3.2 Lab

~~~text
root        /root/poc5-20260907/lab
container   poc5-gateway-20260907
image       semanggi/openclaw-gateway:poc5-20260907
listen      127.0.0.1:18790
status      healthy
~~~

Lab memakai salinan independen state, config, dan secret. Create/delete agen hanya
terjadi di lab. Tidak ada dua gateway yang menulis state root produksi yang sama.

## 4. Bukti eksekusi

### 4.1 Snapshot dan restore

Snapshot berada di /root/poc5-20260907/snapshot. Database SQLite dicadangkan,
dipulihkan ke lokasi uji, lalu diperiksa integritasnya. Semua pemeriksaan lulus.

Inventaris menemukan:

- 214 transkrip JSONL legacy;
- 5 database SQLite per-agen;
- 17 agen aktif setelah normalisasi config;
- tidak ada execution aktif saat snapshot;
- keadaan task: 1 BLOCKED, 15 COMPLETE, 35 WAIT_DEP.

JSONL dan SQLite harus dipertahankan bersama. Rollback image saja tidak memulihkan
visibilitas riwayat untuk gateway lama.

### 4.2 Migrasi config/state

Boot awal 8.2 pada salinan state meminta migrasi. Jalur resmi doctor --fix:

- mengubah agents.list array menjadi agents.entries map;
- menetapkan agents.ownership menjadi explicit;
- menulis metadata config versi 2026.8.2;
- menyelesaikan migrasi database;
- membersihkan registry yatim tanpa menghapus 17 agen aktif.

Sesudah capability consent plugin, gateway ready dan health check live. Peringatan
lab yang tersisa tidak memblokir POC: beberapa file secret provider tidak tersedia
di salinan, metadata skill lama, heartbeat owner kosong, dan memory main tidak ikut
dibuat di lab terisolasi.

### 4.3 Probe RPC nyata

| Pemeriksaan | Hasil |
|---|---|
| Protocol | 4 |
| Metode yang diiklankan | 372 |
| Metode dispatch | agent |
| Frame ID | UUID/string diterima |
| Payload dispatch | message dan idempotencyKey |
| Create agen uji | Berhasil |
| Delete agen uji | Berhasil; jumlah kembali ke 17 |
| agents.entries | Hadir, 17 entri |
| agents.list | Tidak hadir setelah migrasi |
| Schema baru | Ditemukan |
| Binding ikut terhapus | 0 |

Ada satu agen probe tersisa sebelum run terakhir sehingga hitungan awal probe adalah
18; create/delete terakhir mengembalikan state ke 17. Controller saat ini sudah
kompatibel dengan handshake dan dispatch 8.2.

### 4.4 Patch AgentOS 0.7.7

Perubahan:

- lib/openclaw/domains/agent-config.ts membaca entries lebih dulu, mengubah map ke
  bentuk internal, menulis entries tanpa duplikasi id, dan fallback ke list;
- lib/openclaw/client/native-ws-gateway-client.ts menyimpan kedua bentuk raw config
  serta memakai replace path agents.entries.*.skills;
- test domain, native client, dan boundary safety diperbarui untuk dua format.

Patch masuk ke commit fork AgentOS **5f7357db** bersama perubahan UI D77/D78 dari
sesi deploy lain. Lima berkas POC-5 tercatat dalam stat commit itu, tetapi commit-nya
tidak berdiri sendiri.

Hasil test:

~~~text
test terarah + typecheck     103/103 lulus, exit 0
full suite awal              1061/1065 lulus
boundary setelah update      79/81 lulus
~~~

Empat kegagalan awal terdiri dari dua assertion boundary yang diperbarui oleh patch
dan dua baseline UI Semanggi yang sudah dikenal. Setelah update, dua kegagalan yang
tersisa adalah:

1. tipe sidebar upstream tidak memasukkan route Semanggi;
2. daftar grup Settings upstream tidak memasukkan grup Semanggi.

Keduanya berasal dari ekstensi UI Semanggi, bukan regresi OpenClaw. Klaim yang benar:
**suite patch hijau; full suite mempunyai dua expected failure**.

### 4.5 Permission bridge dan OAuth

Permission bridge lulus:

1. level rendah diizinkan otomatis;
2. L3 approve mengeksekusi operasi;
3. L3 reject tidak mengeksekusi operasi dan tidak bocor.

Interposer ACP ini tidak bergantung pada scope operator.approvals atau
operator.questions milik UI AgentOS. Token OAuth juga valid dan direct ACP
menghasilkan POC5-AUTH-OK.

### 4.6 Compatibility matrix AgentOS

Script kompatibilitas AgentOS 0.7.7 dijalankan terhadap gateway lab:

~~~text
native gateway coverage  65/74 operasi (88%)
CLI fallback             0 (CLI tidak dipasang di container probe)
exit                     1
~~~

Exit 1 bukan kegagalan parsing agents.entries. Sebanyak 29 operasi administratif
ditolak karena token probe tidak memiliki operator.read/operator.admin; misalnya
update.status menghasilkan FORBIDDEN: missing scope: operator.admin. Sembilan operasi
lain belum didukung matriks 0.7.7. Sementara itu, probe schema khusus, create/delete
RPC, dan test adapter semuanya lulus.

Sebelum rollout, command ini harus diulang dengan device identity AgentOS yang sudah
dipasangkan. Token lab terbatas tidak boleh dipakai untuk memberi vonis seluruh
permukaan administratif.

## 5. Perubahan kontrak 7.1 → 8.2

| Permukaan | 7.1 | 8.2 |
|---|---|---|
| connect device | di dalam auth | level atas payload connect |
| frame id | angka dapat diterima | string/UUID |
| dispatch | bentuk lama | agent + message + idempotencyKey |
| update/delete agen | id | agentId |
| config agen | agents.list array | agents.entries map |
| config set/patch | path/value | raw config + hash |
| thinking levels | nilai sederhana | objek id/label |
| sesi | JSONL dominan | SQLite per-agen + arsip legacy |
| plugin | tanpa gerbang baru | capability consent wajib |

Controller sudah menangani handshake/dispatch. Patch AgentOS menangani dua bentuk
config. Sesi, usage, dan operasi administratif tetap wajib masuk smoke test rollout.

## 6. Harness binding 8.2

Pengikatan harness tersedia di:

~~~text
agents.entries.<agent-id>.runtime = {
  type: \"acp\",
  acp: { agent: \"<harness-id>\", backend: \"...\", mode: \"...\", cwd: \"...\" }
}
~~~

Field runtime tidak diterima oleh agents.create/update; provisioner harus menulis
config 8.2. Penegakan terjadi saat target ACP di-resolve, bukan dengan dispatch
harness ID langsung. Adopsi binding ini bukan syarat upgrade dasar dan sebaiknya
menjadi perubahan terpisah setelah rollout stabil.

## 7. Kriteria penerimaan

| Kriteria | Status | Bukti |
|---|---|---|
| Image gateway 8.2 dibangun | LULUS | semanggi/openclaw-gateway:poc5-20260907 |
| Backup dapat dipulihkan | LULUS | restore + integrity check SQLite |
| Config/state dapat dimigrasikan | LULUS | doctor selesai, gateway healthy |
| Semua agen bertahan | LULUS | 17 entri |
| Kontrak controller dasar | LULUS | protocol 4, 372 metode, create/delete |
| AgentOS memahami config 8.2 | LULUS | patch dual-format + 103/103 test |
| Plugin resmi | LULUS | acpx/groq/zai/cerebras + consent |
| OAuth harness | LULUS | POC5-AUTH-OK |
| Permission bridge | LULUS | auto/approve/reject |
| Matrix administratif penuh | BERSYARAT | ulangi dengan device identity berscope |
| Upgrade gateway produksi | BELUM | sengaja di luar POC lab |

**Vonis:** POC-5 lulus bersyarat. Tidak ditemukan blocker pada skema agen,
handshake, dispatch dasar, plugin, OAuth, atau permission bridge.

## 8. Runbook rollout produksi

### Fase 0 — sebelum perubahan

1. Pastikan tidak ada task DISPATCHED/RUNNING dan execution aktif.
2. Rekam digest image dan status service.
3. Buat snapshot state/config/secrets serta backup SQLite; uji restore.
4. Pertahankan 214 JSONL dan 5 SQLite; jangan cleanup migrasi.
5. Verifikasi scope device AgentOS untuk operasi yang benar-benar digunakan.

### Fase 1 — deploy

1. Gunakan image POC atau rebuild reproducibly dari 2026.8.2.
2. Gunakan update order stop-first.
3. Jalankan doctor --fix hanya bila gateway memintanya.
4. Berikan consent hanya kepada plugin yang disetujui.
5. Pastikan task service baru Running dan tidak diam-diam rollback.

### Fase 2 — smoke test

1. Health/readiness, log, pairing device, dan secrets audit.
2. AgentOS: tampilkan 17 agen; create/update/delete agen uji; pastikan config tetap
   agents.entries dan tidak menumbuhkan agents.list.
3. Controller: satu task kecil sampai COMPLETE; periksa lifecycle, usage, dan
   transkrip dua sisi.
4. Ulangi compatibility matrix dengan device identity AgentOS.
5. Ulangi permission bridge tiga kasus.
6. Periksa pembacaan riwayat SQLite dan keberadaan JSONL legacy.

### Fase 3 — observasi dan cleanup

Amati transaksi SQLite lambat, error provider/plugin, usage, lifecycle, dan restart.
Cleanup arsip migrasi hanya sesudah masa rollback ditutup dan harus diawali dry-run.

### Rollback

Rollback image saja tidak cukup. Jalur aman:

1. scale gateway ke 0;
2. pulihkan state/config dari snapshot teruji;
3. kembalikan image 2026.7.1;
4. scale naik dan verifikasi health serta visibilitas sesi.

Rollback AgentOS 0.7.7 juga harus memulihkan instance-protection.json versi yang
cocok sesuai POC-7; rollback source saja dapat mengunci login.

## 9. Artefak

~~~text
snapshot lab     /root/poc5-20260907/snapshot
state lab        /root/poc5-20260907/lab
gateway lab      poc5-gateway-20260907
image POC        semanggi/openclaw-gateway:poc5-20260907
AgentOS fork     /root/agentos-fork
patch commit     5f7357db
~~~

File AgentOS yang membawa perubahan POC-5:

~~~text
lib/openclaw/domains/agent-config.ts
lib/openclaw/client/native-ws-gateway-client.ts
tests/openclaw-agent-config.test.ts
tests/openclaw-native-ws-gateway-client.test.ts
tests/openclaw-boundary-safety.test.ts
~~~
