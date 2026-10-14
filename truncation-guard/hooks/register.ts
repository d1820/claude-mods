import type { Register } from 'claude-code'

const SHELLS = new Set(['Bash', 'PowerShell'])

// Truncating readers of command output. CLAUDE.md hard rule: capture the FULL
// output to a file, then Read it — never pipe through head/tail/Select -First.
const TRUNC =
  /(^|[|;&])\s*(head|tail)\b|(^|[|;&])\s*sed\s+-n\b|\bGet-Content\b[^|]*-(TotalCount|Head|Tail|First|Last)\b|\|\s*Select-Object\b[^|]*-(First|Last|Skip|Index)\b/i

export const register: Register = on => {
  on('tool.call', ($, e, next) => {
    if (!SHELLS.has(e.tool)) return next(e)

    const cmd = (e as { command?: string }).command ?? ''
    if (TRUNC.test(cmd)) {
      return {
        deny:
          'Truncating command output is blocked (CLAUDE.md). Redirect the FULL output to a file ("<cmd> > out.txt 2>&1") and Read the file — do not use head/tail/sed -n/Get-Content -TotalCount/Select-Object -First.',
      }
    }

    return next(e)
  }).catch((_$, e, next) => next(e))
}
