# claude-mods

A personal marketplace of [Claude Code](https://claude.com/claude-code) **mods** (plugins) — a live activity pane plus three safety guards for shell output, git commits, and in-place file edits.

| Plugin | What it does |
| --- | --- |
| **activity** | A live band above the prompt + a detail pane: turn time, tool counts, token usage, active plan / work-item / artifacts links, subagent and per-tool breakdowns, an interrupts gauge, and a 🤬 rage meter. |
| **truncation-guard** | Blocks shell commands that truncate their own output (`head`/`tail`/`sed -n`/`Get-Content -TotalCount`/`Select-Object -First`), so the full output is captured to a file and read. |
| **commit-safety** | Enforces git hygiene: blocks blanket staging (`git add -A`/`.`/`-u`), `git mv`, pushes to `main`, and inline multi-line `-m` commits; warns on `--amend`. |
| **shell-guard** | Blocks in-place file mutation via the shell (`sed -i`, `perl -i` clusters, `awk -i inplace`) — the Edit tool is the correct way to change files. Fail-closed; tight default list, extensible in `register.ts`. |

All are hooks-only and act on the **model's** tool calls — not on commands you run yourself with the `!` prefix. `activity`, `truncation-guard`, and `commit-safety` fail **open** (a mod error never blocks your real work); `shell-guard` deliberately fails **closed** — if its guard can't run, a matching in-place edit is denied rather than slipped through.

---

## Requirements

- Claude Code with plugin support (`claude plugin …`).
- The guards target a Windows/PowerShell + Bash workflow; `truncation-guard` covers both `Bash` and `PowerShell` tool calls.

---

## Install

```bash
# 1. Register this repo as a marketplace
claude plugin marketplace add d1820/claude-mods

# 2. Install the mods you want
claude plugin install activity@claude-mods
claude plugin install truncation-guard@claude-mods
claude plugin install commit-safety@claude-mods
claude plugin install shell-guard@claude-mods
```

`marketplace add` also accepts a git/https URL or a local path, e.g. `claude plugin marketplace add C:\Dev\claude-mods`.

Restart Claude Code (or `/reload-plugins`) to load them.

### Configure `activity` at install (optional)

`activity` has two optional settings (see [Configuration](#configuration)):

```bash
claude plugin install activity@claude-mods \
  --config workItemsUrl=https://your-org.visualstudio.com/PROJECT/_workitems/edit \
  --config extraRageWords="ugh,seriously,come on"
```

You can also set/change these later with `/config` (or `claude plugin configure activity@claude-mods`).

---

## activity

### Band (above the prompt)

A compact one-liner that stays out of the way:

```
session 12 tools · 19.3k tok · plan: 2026-10-14-my-task.md · WI 12744 · [ Hide ]
```

- **session tools / tok** — totals for this session (new tokens only — excludes cached-prompt re-reads).
- **plan** — the active plan file for the current branch (clickable `vscode://` link); detected from your plan Writes/Reads and persisted per branch.
- **WI** — work-item link, shown only when `workItemsUrl` is configured and the branch name contains a 4–6 digit id.
- **Hide** — hides the band for the session.

### Pane (`/activity`)

```
last 19s · 0 tools · 478 tok · view 2 artifacts            🤬 3  interrupts 1/6
Subagents                     Tools                 Recent
none                          Read ×4 · 254s        done Grep
                              Grep ×6 · 192s        done Grep
                              Bash ×2 · 83s         done Bash
```

Header row:
- **last turn** — duration, tool count, tokens of the most recent turn.
- **view N artifacts** — link to this session's artifacts folder (profile or project `.claude/artifacts`).
- **🤬 N** — the rage meter (see below).
- **interrupts A/T** — this session's hard-interrupted turns over total turns (a passive friction gauge, *not* an accuracy score).

Columns: **Subagents** (live status/elapsed/tokens via `$.agent.list()`), **Tools** (per-tool count + total time), **Recent** (last tool calls).

The pane auto-opens on session start (terminals ≥ 144 cols) and re-opens itself after `/reload-plugins`. `/activity` reopens it on demand.

### 🤬 Rage meter

A light-hearted "how rough was this session" counter. It adds **+1 per message** (never more) when your prompt:

- contains a built-in profanity / insult / hostility word (compounds like `dumbfuck` count; whole-word matching keeps `assume`/`class` from tripping it; ethnic/identity slurs are deliberately excluded), **or**
- contains any **custom** word you add via `extraRageWords`, **or**
- is written mostly in **UPPERCASE** (yelling) — a stray acronym like `SQL`/`BFF` won't trip it.

Session-scoped: it resets on a new session and survives `/reload-plugins`.

### Commands

- `/activity` — open/re-open the activity pane.
- `/plan` — show the active plan for this branch; `/plan <name-fragment>` sets it.

---

## Configuration

`activity` options (set via `--config key=value` at install, or `/config` later):

| Key | Default | Description |
| --- | --- | --- |
| `workItemsUrl` | `""` | Work-items base URL. The band's `WI <id>` link points here (e.g. `https://org.visualstudio.com/PROJECT/_workitems/edit`). Blank = no link. |
| `extraRageWords` | `""` | Comma/space-separated words **appended** to the built-in rage list (whole-word, case-insensitive). |

Profile paths (`~/.claude/plans`, `~/.claude/artifacts`) are resolved at runtime from `USERPROFILE`/`HOME`, so the mod is portable across machines and OSes.

---

## shell-guard

Blocks the **model** from editing files through the shell when the Edit tool is the right tool. Any in-place file *mutator* is denied (fail-closed); reads and redirects are always allowed.

**Default deny list** (in `hooks/register.ts`, kept deliberately tight):

| Rule | Blocks | Allows |
| --- | --- | --- |
| `sed-in-place` | `sed -i`, `-i.bak`, `--in-place` (incl. `… \| sed -i`) | `sed 's/…' f > out`, `sed -n '1,5p' f` |
| `perl-in-place` | `perl` with an `i` flag cluster (`-i`, `-pi`, `-ni`, `-i.bak`) | `perl -e`, `perl -ne` |
| `awk-in-place` | `awk`/`gawk -i inplace` | `awk '…' f`, `awk '…' f > out` |

**Expand it:** add a `{ id, re, msg }` entry to the `RULES` array in `register.ts` (one line), or add an escape-hatch regex to `ALLOW` to permit a narrow legitimate case. Keep the list to in-place *mutators* — reads and redirects must stay allowed.

Pairs with the coarse `permissions.deny` globs (`sed -i *`, `perl -i *`) in `settings.json`, which stay as the platform-level fail-closed floor if the mod is ever disabled. Covered by `claude plugin test shell-guard` (13 deny/allow cases).

---

## Updating

```bash
claude plugin marketplace update claude-mods
claude plugin update activity@claude-mods
```

Changes apply on restart.

---

## Development

This repo is both the **source** and the **fast-edit** folder when installed as a directory marketplace (`claude plugin marketplace add C:\Dev\claude-mods`):

- Edit a mod in place, then `/reload-plugins` — it re-reads the source folder live.
- To publish to new sessions, bump the plugin's `version` in its `plugin.json`, then `claude plugin marketplace update claude-mods` + `claude plugin update <name>@claude-mods`.

Each mod is a folder with:

```
<mod>/
  .claude-plugin/plugin.json   # name, version, (optional) userConfig
  hooks/hooks.json             # { "modules": ["./register.ts" | "./register.tsx"] }
  hooks/register.ts(x)         # the hooks module
  types/index.d.ts             # $.state contract (activity only)
```

The repo root `.claude-plugin/marketplace.json` lists every plugin. Adding a new mod = drop a folder + add one entry there.

Verify a mod before publishing:

```bash
claude plugin validate <mod>     # manifest + hooks + $.state contract
claude plugin test <mod>         # runs the mod's tests
tsc -p <mod>                     # type-check (needs the engine-generated types)
```

> Note: `**/.claude-plugin/types/` is git-ignored — those type stubs are generated per machine when a mod loads.


Display
╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────✕─╮
│ last 6s · 0 tools · 0 tok                                                                                                          🤬 2  interrupts 8/24 │
│ Subagents                                        Tools                                                  Recent                                           │
│ none                                             Bash ×24 · 1076s                                       done Read                                        │
│                                                  Edit ×31 · 942s                                        done Write                                       │
│                                                  Read ×27 · 891s                                        done Bash                                        │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
session 102 tools · 134.9k tok  [ Hide ]                                                                                                                [-]
