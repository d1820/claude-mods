import { test, expect, mock } from 'claude-code/testing'

// The plan "second check flow": besides the profile ~/.claude/plans, the mod now
// also finds plan files under the repo at <repoRoot>/<child>/plans/*.md (which
// covers <repoRoot>/.claude/plans and any <repoRoot>/<dir>/plans).
const HOME = 'C:/Users/Dan'
const ROOT = 'C:/Dev/MediRoutes/Repo'

const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
const file = (name: string, mtimeMs = 0) => ({ name, kind: 'file' as const, size: 1, mtimeMs, isLink: false })
const PROFILE_PLANS = `${HOME}/.claude/plans`

// A normal (non-worktree) checkout on branch `main`, with a plan at docs/plans.
function fakeRepo(on: Parameters<typeof mock.clock>[0]) {
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.read', (_$: unknown, e: { path: string }) => {
    const p = e.path.replace(/\\/g, '/')
    if (p === `${ROOT}/.git/HEAD`) return { value: 'ref: refs/heads/main\n' }
    if (p === `${ROOT}/docs/plans/plan.md`) return { value: '# plan\n' }
    throw new Error(`ENOENT ${p}`)
  })
  on('fs.list', (_$: unknown, e: { path: string }) => {
    const p = e.path.replace(/\\/g, '/')
    if (p === ROOT) return { value: [dir('.git'), dir('docs'), dir('src')] }
    if (p === `${ROOT}/docs/plans`) return { value: [file('plan.md')] }

    return { value: [] }
  })
  on('fs.exists', (_$: unknown, e: { path: string }) => ({
    value: e.path.replace(/\\/g, '/') === `${ROOT}/docs/plans/plan.md`,
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_$: unknown, e: { text: string }) => ({ text: e.text }))
}

test('/plan finds a file in <repoRoot>/<child>/plans', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.env(on, { USERPROFILE: HOME })
  mock.store(on, {})
  fakeRepo(on as never)

  // Resolve repoRoot (ensureContext runs on prompt.submit).
  await $.prompt.submit({ text: 'hi' } as never)

  const res = await $.command.run({ command: 'plan', args: 'plan' } as never)
  expect(res.text).toBe(`Active plan set: ${ROOT}/docs/plans/plan.md`)
})

test('writing a plan under <repoRoot>/<child>/plans shows it in the band', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.env(on, { USERPROFILE: HOME })
  mock.store(on, {})
  fakeRepo(on as never)
  on('tool.call', () => ({ result: 'ok' }))

  await $.prompt.submit({ text: 'hi' } as never)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/docs/plans/plan.md` } as never)

  const ui = await $.ui.mount({
    plugin: 'activity',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false } as never,
  })

  const el = await ui.find({ text: /plan\.md/ })
  expect(el).toBeDefined()
})

test('/plan picks the newest-mtime copy when the name hits multiple layers', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.env(on, { USERPROFILE: HOME })
  mock.store(on, {})
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.read', (_$: unknown, e: { path: string }) => {
    if (e.path.replace(/\\/g, '/') === `${ROOT}/.git/HEAD`) return { value: 'ref: refs/heads/main\n' }
    throw new Error('ENOENT')
  })
  on('fs.list', (_$: unknown, e: { path: string }) => {
    const p = e.path.replace(/\\/g, '/')
    if (p === ROOT) return { value: [dir('.git'), dir('docs')] }
    if (p === PROFILE_PLANS) return { value: [file('shared.md', 100)] } // older
    if (p === `${ROOT}/docs/plans`) return { value: [file('shared.md', 200)] } // newer
    return { value: [] }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_$: unknown, e: { text: string }) => ({ text: e.text }))

  await $.prompt.submit({ text: 'hi' } as never)

  const res = await $.command.run({ command: 'plan', args: 'shared' } as never)
  expect(res.text).toBe(`Active plan set: ${ROOT}/docs/plans/shared.md`)
})

test('the /planPathRefresh token sets the newest plan and is stripped from the prompt', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.env(on, { USERPROFILE: HOME })
  mock.store(on, {})
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.read', (_$: unknown, e: { path: string }) => {
    if (e.path.replace(/\\/g, '/') === `${ROOT}/.git/HEAD`) return { value: 'ref: refs/heads/main\n' }
    throw new Error('ENOENT')
  })
  on('fs.list', (_$: unknown, e: { path: string }) => {
    const p = e.path.replace(/\\/g, '/')
    if (p === ROOT) return { value: [dir('.git'), dir('docs')] }
    if (p === PROFILE_PLANS) return { value: [file('old.md', 100)] } // older
    if (p === `${ROOT}/docs/plans`) return { value: [file('new.md', 200)] } // newest
    return { value: [] }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_$: unknown, e: { text: string }) => ({ text: e.text }))

  // The token is stripped from what the model receives.
  const res = await $.prompt.submit({ text: 'fix the drawer bug /planPathRefresh' } as never)
  expect(res.text).toBe('fix the drawer bug')

  // ...and the active plan is now the newest one across all layers.
  const cur = await $.command.run({ command: 'plan', args: '' } as never)
  expect(cur.text).toBe(`Active plan: ${ROOT}/docs/plans/new.md`)
})
