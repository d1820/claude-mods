import { test, expect, mock } from 'claude-code/testing'

// Reproduces the live report: a session running inside a git WORKTREE whose
// branch encodes a work item (feature/danturco-13239-integrations) shows no
// "WI 13239" in the band. Mirrors the real .git layout on disk:
//   <wt>/.git                      -> "gitdir: <main>/.git/worktrees/<wt-name>"
//   <main>/.git/worktrees/<name>/HEAD -> "ref: refs/heads/feature/danturco-13239-integrations"
const WT = 'C:/Dev/MediRoutes/MediRoutes.Platform-danturco-13239-integrations'
const GITDIR = 'C:/Dev/MediRoutes/MediRoutes.Platform/.git/worktrees/MediRoutes.Platform-danturco-13239-integrations'

test('worktree branch yields WI in the band', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, { USERPROFILE: 'C:/Users/Dan' })
  mock.store(on, {})

  // Bottom of the git filesystem the plugin walks. Missing / wrong-type paths
  // reject, exactly as the real $.fs.read does.
  on('session.cwd', () => ({ value: WT }))
  on('fs.read', (_$, e) => {
    const p = e.path.replace(/\\/g, '/') // kit may hand paths back with backslashes
    if (p === `${WT}/.git`) return { value: `gitdir: ${GITDIR}\n` }
    if (p === `${GITDIR}/HEAD`)
      return { value: 'ref: refs/heads/feature/danturco-13239-integrations\n' }
    throw new Error(`ENOENT ${p}`) // e.g. <wt>/.git/HEAD (.git is a file)
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))

  // Drive the two hooks that detect context, then complete a turn so the band
  // renders unconditionally (turn !== null defeats the quiet short-circuit).
  await $.prompt.submit({ text: 'hello' } as never)
  await clock.advance(1000)
  await $.turn.complete({
    reason: 'answer',
    turnId: 't1',
    isAborted: false,
    answer: '',
    durationMs: 1000,
  } as never)

  const ui = await $.ui.mount({
    plugin: 'activity',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false } as never,
  })

  const el = await ui.find({ text: /WI 13239/ })
  expect(el).toBeDefined()
})
