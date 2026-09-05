# Halaman agen: pisahkan, jangan lebur

Rekomendasi: **pisahkan.** Halaman Agents bawaan AgentOS dibiarkan apa adanya, dan Semanggi mendapat halamannya sendiri yang meniru tampilannya. Alasannya bukan selera arsitektur — peleburan yang sudah dicoba memang berhenti setengah matang, dan bekasnya bisa ditunjukkan satu per satu.

## Kenapa peleburannya setengah matang

Yang berhasil dari D32 hanya **satu hal**: setelah `OPENCLAW_CONFIG_PATH` diarahkan ke config gateway, AgentOS akhirnya melihat kesembilan agen Semanggi. Visibilitas beres.

Yang tidak beres, semuanya terukur:

**Dua penulis, dua cara.** Semanggi membuat agen lewat RPC gateway; AgentOS menulis `openclaw.json` **langsung** di disk — terbukti saat mount read-only memblokirnya dengan `EROFS ... openclaw.json.lock`. Tidak ada yang mengoordinasikan keduanya, dan berkasnya hidup di NFS, tempat lockfile paling tidak bisa diandalkan.

**Pembuatan bisa setengah jadi.** Membuat agen lewat API AgentOS menulis entri config yang tampak lengkap, lalu gagal membangun direktori agennya (`EACCES` saat `mkdir .openclaw/tools`). Hasilnya agen yang selamanya ada di berkas, ditampilkan AgentOS sebagai agen sungguhan, dan tidak pernah diiklankan gateway. Operator yang melihatnya akan wajar saja mencoba mengarahkan pekerjaan ke sana.

**Model yang diminta diabaikan.** Saya minta `zai/glm-5.2`; yang tertulis `zai/glm-4.7-flash`. Bentuk fieldnya memang berbeda — AgentOS berpikir dalam `workspaceId`, Semanggi dalam path absolut.

**`agentDir` tidak disepakati.** AgentOS melaporkan `/home/node/.openclaw/agents/<id>/agent` untuk agen yang di config tertulis `/opt/.../state/agents/<id>/agent`. Ia menghitungnya relatif terhadap `$HOME` containernya sendiri. Satu penyuntingan lewat AgentOS bisa memakukan path yang hanya masuk akal di dalam container itu.

**Kosakata "agen" pun tidak sama.** AgentOS menempelkan `skills` dan `tools.fs.workspaceOnly` pada agen buatannya; agen Semanggi tidak punya keduanya — artinya agen kita justru **kurang terkurung** di filesystem daripada agen buatan AgentOS. Itu perbedaan yang menyangkut keamanan, bukan gaya.

Menyatukan dua model yang berbeda di lima titik seperti ini menghasilkan satu halaman yang berbohong dalam dua arah sekaligus.

## Bentuk yang saya sarankan

### Biarkan halaman Agents bawaan apa adanya

Jangan ubah, jangan filter, jangan sisipkan kolom. Ia adalah tampilan jujur atas `openclaw.json` — termasuk agen setengah jadi, karena memang begitulah isi berkasnya. Menyembunyikan sesuatu di situ hanya memindahkan kebingungan.

### Halaman "Runtime Agents" milik Semanggi

Rute terpisah, tata letak meniru halaman bawaan (`OperationsPageLayout`, `SectionCard`, `StatusBadge`, `SearchToolbar` — komponen yang sudah ada), sehingga terasa satu keluarga tanpa berbagi kode yang sama.

Sumbernya **hanya** `GET /api/work/agents`, yang sudah menggabungkan `agents.list` gateway dengan berkas config dan mengklasifikasikan tiap agen. Kolomnya:

| Kolom | Isi |
|---|---|
| Status | `operable` / `config-only` / `live-only` |
| Asal | `semanggi` / `agentos` / `unknown`, dari letak `agentDir` |
| Model | provider/model yang benar-benar diiklankan gateway |
| Effort | level yang diiklankan, dan mana yang `guaranteed` vs `preference` |
| Rute | entri katalog yang bisa mengarah ke sana; kosong berarti tak pernah kebagian kerja |
| Workspace | path, karena inilah yang mengikat agen ke project |

Baris `config-only` diberi peringatan eksplisit — itu satu-satunya kelas yang benar-benar menyesatkan, dan halaman ini adalah satu-satunya tempat yang bisa mengenalinya.

### Pengelolaan: masing-masing pegang miliknya

- **AgentOS** membuat dan menyunting agennya sendiri, seperti sekarang.
- **Semanggi** membuat agen lewat `provision-agents.mjs` dan memungutnya lewat `reap-agents.mjs`, keduanya lewat RPC gateway dan keduanya butuh `operator.admin`.
- Halaman Semanggi **read-only** untuk agen ber-asal `agentos`. Ia menampilkannya — karena mereka nyata dan ikut menghuni workspace yang sama — tetapi tidak menawarkan tombol sunting. Tidak ada gunanya menyediakan dua pintu ke satu berkas yang tidak punya penjaga bersama.

Ini bukan kompromi: setiap pihak menulis dengan cara yang memang dipahaminya, dan tidak ada jalur baru yang bisa menghasilkan agen setengah jadi.

### Satu penyesuaian yang tetap perlu dipertahankan

`OPENCLAW_CONFIG_PATH` **tetap diarahkan** ke config gateway. Tanpa itu AgentOS kembali membaca cermin basi miliknya sendiri (D28) dan operator melihat dua kenyataan yang berbeda tanpa tanda apa pun. Memisahkan halaman bukan berarti memisahkan sumber kebenaran — justru sebaliknya: keduanya membaca berkas yang sama, lalu menampilkannya menurut yang masing-masing pahami.

## Yang saya sarankan TIDAK dilakukan

**Jangan bikin Semanggi menulis lewat AgentOS.** Itu menambah penulis ketiga dan mewarisi bug model-diabaikan.

**Jangan filter agen Semanggi dari halaman bawaan.** Menyembunyikan agen dari halaman yang membaca berkas apa adanya membuat halaman itu berbohong, dan orang akan menemukan selisihnya lewat cara yang lebih buruk.

**Jangan tunggu upstream memperbaikinya.** D34 sudah menunjukkan pola ini: menunggu 7.1 untuk `workspaceDir` dan `agentRuntime` membuang waktu karena keduanya memang tidak pernah ada. Pemisahan ini berdiri di atas apa yang ada sekarang.
