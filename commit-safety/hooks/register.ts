import type { Register } from 'claude-code'

const SHELLS = new Set(['Bash', 'PowerShell'])

export const register: Register = on => {
  on('tool.call', ($, e, next) => {
    if (!SHELLS.has(e.tool)) return next(e)

    const raw = (e as { command?: string }).command ?? ''
    const cmd = raw.trim()

    const add = cmd.match(/\bgit\s+add\s+(.+)/i)
    if (add && /(^|\s)(-A|--all|-u|\.)(\s|$)/.test(add[1] ?? '')) {
      return {
        deny:
          'Blanket staging is blocked (CLAUDE.md): never git add -A / . / -u. Stage explicit paths — one per file discussed.',
      }
    }

    if (/\bgit\s+mv\b/i.test(cmd)) {
      return { deny: 'git mv is blocked (CLAUDE.md). Move files explicitly instead.' }
    }

    if (/\bgit\s+push\b[^|&;]*\bmain\b/i.test(cmd)) {
      return { deny: 'main is protected: do not push to main. Open a PR from a branch.' }
    }

    if (/\bgit\s+commit\b/i.test(cmd) && /-m\b/i.test(cmd) && /\n/.test(raw)) {
      return {
        deny:
          'Inline multiline -m is blocked (CLAUDE.md). Write the message to a file and use git commit -F <file>.',
      }
    }

    if (/\bgit\s+commit\b[^|&;]*--amend\b/i.test(cmd)) {
      $.ui.toast('Reminder: avoid git commit --amend (CLAUDE.md).')
    }

    return next(e)
  }).catch((_$, e, next) => next(e))
}
