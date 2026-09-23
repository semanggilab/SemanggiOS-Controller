# docs/ — hanya ledger keputusan

Berkas dokumentasi lain **pindah ke repo dokumentasi terpusat** `semanggi-docs/`
(lokal: `outputs/semanggi-docs/`). Yang tetap di sini hanya:

- `decisions.md` — ledger keputusan D1–Dn, append-only. Rumahnya memang di repo ini supaya satu commit
  membawa perubahan kode + entri keputusan + tes regresinya. Status tiap keputusan: `semanggi-docs/04-decisions/index.md`.

| Dulu di sini | Sekarang |
|---|---|
| `readiness.md` | `semanggi-docs/05-readiness/readiness.md` (ditulis ulang; versi lama di `99-archive/superseded/`) |
| `workspace-layout.md` | `semanggi-docs/02-design/workspace-and-memory.md` |
| `usage.md`, `walkthrough-nestjs-nuxt.md` | `semanggi-docs/99-archive/` (digantikan `02-design/operator-surfaces.md` + runbook) |
| `slack-setup.md` | `semanggi-docs/07-runbooks/slack-setup.md` |
| `upgrade-openclaw.md`, `poc5-upgrade-openclaw-2026.8.2.md` | `semanggi-docs/99-archive/superseded/`, `06-poc/poc-05-openclaw-8.2/` |
| `poc4-evidence.md`, `poc4-source-verification.md`, `permission-bridge-design.md` | `semanggi-docs/06-poc/poc-04-work-controller/`, `06-poc/poc-03-claude-code-acp/` |
| `brain-pooler-analysis.md`, `agentos-project-model.md`, `agent-model-comparison.md`, `agent-page-recommendation.md` | `semanggi-docs/99-archive/analyses/` |

Dokumen arsitektur dan desain yang berlaku: `semanggi-docs/01-architecture/` dan `semanggi-docs/02-design/`.
