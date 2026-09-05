# Memasang aplikasi Slack

Urutannya sengaja: **daftarkan operator dulu, baru sambungkan Slack.** Aplikasi ini
menolak siapa pun yang belum terdaftar, jadi memasang Slack lebih dulu hanya
menghasilkan bot yang menjawab "you're not registered" kepada semua orang.

## 1. Rahasia penandatanganan

Slack menandatangani setiap request dengan HMAC-SHA256 atas **byte mentah**
badan request. Controller memverifikasinya sebelum apa pun terjadi.

```
Basic Information → App Credentials → Signing Secret
```

Simpan sebagai Docker secret, bukan sebagai env literal:

```bash
printf '%s' '<signing secret>' | docker secret create semanggi_slack_signing_secret -
```

Lalu di stack, arahkan `SLACK_SIGNING_SECRET` ke isinya.

**Tanpa rahasia ini, kedua endpoint menolak semua request (401).** Itu disengaja:
endpoint ini bisa membuat, menghentikan, dan mengganti model task, jadi gagal
tertutup adalah satu-satunya default yang aman. Controller juga menulis
peringatan `slack.no-signing-secret` saat boot agar kondisi itu tidak senyap.

## 2. Daftarkan operator

Butuh token admin. Slack user id ada di profil Slack → **Copy member ID**
(bentuknya `U…` atau `W…`, bukan `@nama` — nama tampilan bisa berubah, id tidak).

```bash
curl -sS -X POST http://controller:8080/api/work/operators \
  -H "authorization: Bearer $SEMANGGI_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"Satria","slackUserId":"U01ABCDEF","role":"admin"}'
```

Balasannya memuat token operator **satu kali saja**; database hanya menyimpan
hash-nya. Kalau hilang, `POST /api/work/operators/{id}/rotate`.

Peran:

| role | boleh |
|---|---|
| `readonly` | `queue`, `status`, `review` |
| `operator` | semua di atas + buat, hentikan, ganti model, jalankan, putuskan approval |
| `admin` | semua di atas + kelola operator |

Tidak ada pendaftaran otomatis saat seseorang pertama kali mengetik. Kalau ada,
siapa pun di workspace bisa memberi dirinya identitas hanya dengan mengetik satu
kata, dan `decided_by` di jejak audit berhenti berarti apa-apa.

## 3. Buat aplikasinya

`config/slack-manifest.yaml` sudah berisi cakupan dan URL-nya. Ganti
`REPLACE-ME` dengan hostname publik controller, lalu buat app dari manifest itu.

Controller **tidak** mem-publish port ke luar cluster, dan itu tetap benar —
Slack butuh URL yang bisa dijangkau internet, sedangkan controller memegang
kendali penuh atas antrean kerja. Pilihannya:

1. **Reverse proxy** (disarankan) di depan, hanya meneruskan dua path
   `/api/work/slack/command` dan `/api/work/slack/interactive`. Path lain tidak
   perlu terekspos sama sekali.
2. **Socket Mode** — menghilangkan kebutuhan URL publik seluruhnya, tetapi
   membutuhkan koneksi WebSocket keluar dan penanganan frame yang berbeda dari
   verifikasi tanda tangan di sini. Belum diimplementasikan; kalau paparan
   publik jadi masalah, ini jalur yang benar untuk ditempuh berikutnya.

## 4. Kosakata perintah

```
/semanggi queue                          apa yang sedang jalan dan menunggu
/semanggi status TASK-ABCD               detail satu task
/semanggi task tulis runbook deployment  buat dan antrikan
/semanggi stop TASK-ABCD                 hentikan (minta konfirmasi dulu)
/semanggi model TASK-ABCD glm-5.2 high   ganti model dan effort
/semanggi run TASK-ABCD                  jalankan lagi setelah dihentikan
/semanggi approve TASK-ABCD              putuskan approval yang tertunda
/semanggi expedite TASK-ABCD 30m         naikkan prioritas sementara
```

Verba yang menghentikan pekerjaan **selalu bertanya lebih dulu**, dan
pertanyaannya menyebut task yang persis akan dihentikan beserta statusnya. Jadi
`yes` hanya bisa mengiyakan hal yang barusan dibacakan kembali. Konfirmasi itu
milik satu orang, kedaluwarsa dalam dua menit, dan tidak selamat dari restart —
konfirmasi yang bertahan lebih lama adalah konfirmasi yang tidak diingat siapa
pun.

`ok` dianggap "ya" **hanya** bila ada pertanyaan yang menggantung. Tanpa itu, ia
kembali menjadi kata yang dibaca router sebagai `approve`, dan `approve` tanpa
task id selalu bertanya.

## 5. Nama model

`model` bekerja dengan nama katalog di `config/routing.json`, bukan teks bebas.
`glm-5.2 high` diterjemahkan ke `glm-5.2-high`; `glm-5.2` saja **ditolak sebagai
ambigu** karena katalog menyediakan `high` dan `max`, dan memilihkan salah
satunya berarti operator meminta model lalu mendapat level effort yang tidak
pernah ia sebut. Balasannya menyebutkan pilihan yang ada.

Nama yang tidak ada di katalog ditolak seketika beserta daftar yang tersedia,
bukan diterima lalu memarkir task di `WAIT_RESOURCE` untuk ditemukan nanti.

## 6. Notifikasi approval

Approval L2/L3 dirender sebagai kartu Block Kit dengan tombol Approve/Reject.
Nilai tombolnya adalah id approval, dan orang yang menekannya diambil dari
`payload.user.id` yang ditandatangani Slack — jadi keputusan tercatat atas nama
orang, bukan atas nama aplikasi.
