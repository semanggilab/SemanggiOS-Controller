// Pembaca docs/tasks.md untuk pendaftaran task (PREPARE "daftarkan…").
//
// Format yang dibaca adalah format yang diminta prompt PREPARE "Create tasks"
// sendiri (control-page createTasksText): checklist `- [ ] **T-XX — Judul**`
// diikuti baris metadata `**Role:** … · **Dep:** … · **Kompleksitas:** … ·
// **Effort:** …` dan `**Deskripsi:** …`. Parser ini mentolerir variasi kecil
// (bold hilang, dash en/em, `[x]` besar) karena dokumen itu ditulis model,
// bukan mesin — satu variasi ejaan tidak boleh menggagalkan pendaftaran.
//
// Sengaja hanya parser murni (tanpa store, tanpa fs): keputusan "task mana
// dibuat, status apa, dependensi bagaimana" hidup di caller supaya bisa
// diuji terpisah dari bentuk dokumennya.

const CHECKBOX = /^\s*-\s\[( |x|X)\]\s+(?:\*\*)?(T-\d+)\s*[—–-]+\s*(.+?)(?:\*\*)?\s*$/;
const ROLE = /\*\*Role:\*\*\s*([^·\n]+)/i;
const DEP = /\*\*Dep:\*\*\s*([^·\n]+)/i;
const DESC = /\*\*Deskripsi:\*\*\s*(.+)$/i;

/**
 * @returns {Array<{localId: string, done: boolean, title: string,
 *   role: string | null, deps: string[], description: string | null}>}
 *   Urut sesuai dokumen; `deps` berisi localId (`T-XX`, uppercase).
 */
export function parseTasksMd(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const tasks = [];
  let current = null;
  for (const line of lines) {
    const head = CHECKBOX.exec(line);
    if (head) {
      current = {
        localId: head[2].toUpperCase(),
        done: head[1].toLowerCase() === "x",
        title: head[3].trim(),
        role: null,
        deps: [],
        description: null,
      };
      tasks.push(current);
      continue;
    }
    if (!current) continue;
    // Heading mengakhiri blok task: metadata task selalu item daftar
    // berindentasi di bawah checkbox-nya, bukan di bawah section berikutnya.
    if (/^#{1,6}\s/.test(line)) {
      current = null;
      continue;
    }
    // Role, Dep dan Deskripsi biasanya duduk di SATU baris dipisah "·" —
    // ketiganya harus diperiksa pada baris yang sama, bukan if/continue.
    const role = ROLE.exec(line);
    if (role) current.role = role[1].trim().toLowerCase() || null;
    const dep = DEP.exec(line);
    if (dep) {
      current.deps = Array.from(dep[1].matchAll(/T-\d+/gi)).map((m) => m[0].toUpperCase());
    }
    const desc = DESC.exec(line);
    if (desc) current.description = desc[1].trim();
  }
  return tasks;
}

/**
 * “…dan langsung jalankan” — permintaan operator agar task yang didaftarkan
 * tidak parkir di CREATED. Dilonggarkan ejaannya ("lansung", "langunng",
 * "dijalankan", "jalanakan") karena kalimat ini diketik bebas di chat, dan
 * konsekuensi salah baca kecil: QUEUED tetap melewati admission, bukan
 * eksekusi buta. Polanya: kata berawalan "lan" tepat sebelum "jalankan".
 */
export function wantsImmediateRun(text) {
  return /lan[a-z]*\s+(di)?jalan/i.test(String(text ?? ""));
}
