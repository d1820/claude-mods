import type { Register } from 'claude-code'

// Shell tools whose command strings we inspect.
const SHELLS = new Set(['Bash', 'PowerShell'])

// Default deny list: in-place file MUTATORS the model must not run via the shell — the
// Edit tool is the correct way to modify files. Deliberately TIGHT: reads and redirects
// (`sed 's/…' f > out`, `awk '…' f`, `perl -e`, `perl -ne`) are allowed. To expand the
// guard, add a { id, re, msg } entry — each regex is tested against the trimmed command.
// `[^|&;]*` keeps a match inside one command segment, so `… | sed -i …` is still caught.
const RULES: ReadonlyArray<{ id: string; re: RegExp; msg: string }> = [
  {
    id: 'sed-in-place',
    re: /\bsed\b[^|&;]*(\s-i\b|\s--in-place)/i,
    msg: 'in-place editing via `sed -i` is blocked — use the Edit tool to modify files.',
  },
  {
    id: 'perl-in-place',
    re: /\bperl\b[^|&;]*\s-[pnlasw0]*i(\.|\b)/i,
    msg: 'in-place editing via `perl -i` is blocked — use the Edit tool to modify files.',
  },
  {
    id: 'awk-in-place',
    re: /\bg?awk\b[^|&;]*\s-i\s+inplace\b/i,
    msg: 'in-place editing via `awk -i inplace` is blocked — use the Edit tool to modify files.',
  },
]

// Escape hatch: a command matching any ALLOW regex is permitted even if a RULE matches.
// Empty by default; add a narrow regex to opt a legitimate case back in without disabling
// the whole guard.
const ALLOW: ReadonlyArray<RegExp> = []

export const register: Register = on => {
  on('tool.call', ($, e, next) => {
    if (!SHELLS.has(e.tool)) return next(e)

    const cmd = ((e as { command?: string }).command ?? '').trim()
    if (!cmd) return next(e)

    if (ALLOW.some(re => re.test(cmd))) return next(e)

    const hit = RULES.find(r => r.re.test(cmd))
    return hit ? { deny: `${$.plugin.name}: ${hit.msg}` } : next(e)
  }).catch(($, e, next) =>
    // Fail CLOSED: if the guard threw before deciding, deny the call rather than let it
    // through. If next was already reached, the decision was made — pass it on.
    next.called ? next(e) : { deny: `${$.plugin.name}: guard failed — command blocked for safety.` },
  )
}
