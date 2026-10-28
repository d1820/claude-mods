import { test, expect, mock } from 'claude-code/testing'

// The artifacts line in the band: "<count> artifacts in <base-slug>", where the
// base slug is the FIRST artifact folder this session wrote to (pinned — never
// repointed), the count is recursive, and a "(<n> slug folders)" drift hint shows
// when I've written to more than one folder.
const HOME = 'C:/Users/Dan'
const ROOT = 'C:/Dev/MediRoutes/Repo'
const ART = `${ROOT}/.claude/artifacts`

const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
const file = (name: string) => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })

// A normal checkout on `main`; each test adds its own fs.list for the slug folders.
function baseMocks(on: Parameters<typeof mock.clock>[0]) {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, { USERPROFILE: HOME })
  mock.store(on, {})
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.read', (_$: unknown, e: { path: string }) => {
    if (e.path.replace(/\\/g, '/') === `${ROOT}/.git/HEAD`) return { value: 'ref: refs/heads/main\n' }
    throw new Error('ENOENT')
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_$: unknown, e: { text: string }) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.list', () => ({ value: [] })) // the Pane render reads $.agent.list()

  return clock
}

// Complete a turn so the band renders (turn !== null defeats the quiet short-circuit).
async function completeTurn($: { turn: { complete: (e: never) => Promise<unknown> } }) {
  await $.turn.complete({
    reason: 'answer',
    turnId: 't1',
    isAborted: false,
    answer: '',
    durationMs: 1000,
  } as never)
}

// The artifacts line lives in the Pane (opened via $.ui.open({ id: PANE })), not
// the AbovePrompt band — so mount the Pane with its requestId to render it.
const mountPane = ($: { ui: { mount: (e: never) => Promise<{ find: (q: never) => Promise<unknown> }> } }) =>
  $.ui.mount({
    plugin: 'activity',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'activity',
    props: {} as never,
  } as never)

test('counts artifacts recursively under the pinned base slug', async ($, on) => {
  const clock = baseMocks(on as never)
  on('fs.list', (_$: unknown, e: { path: string }) => {
    const p = e.path.replace(/\\/g, '/')
    if (p === `${ART}/alpha`) return { value: [file('a.txt'), file('b.txt'), dir('sub')] }
    if (p === `${ART}/alpha/sub`) return { value: [file('c.txt')] } // nested → must be counted
    return { value: [] }
  })

  await $.prompt.submit({ text: 'hi' } as never)
  await $.tool.call({ tool: 'Write', file_path: `${ART}/alpha/a.txt` } as never)
  await clock.advance(1000)
  await completeTurn($ as never)

  const ui = await mountPane($ as never)
  expect(await ui.find({ text: /3 artifacts in alpha/ } as never)).toBeDefined()
})

test('base slug stays pinned while writing other folders, and drift is flagged', async ($, on) => {
  const clock = baseMocks(on as never)
  on('fs.list', (_$: unknown, e: { path: string }) => {
    const p = e.path.replace(/\\/g, '/')
    if (p === `${ART}/alpha`) return { value: [file('a.txt'), file('a2.txt')] }
    return { value: [] }
  })

  await $.prompt.submit({ text: 'hi' } as never)
  await $.tool.call({ tool: 'Write', file_path: `${ART}/alpha/a.txt` } as never) // pins base = alpha
  await $.tool.call({ tool: 'Write', file_path: `${ART}/beta/b.txt` } as never) // drift, not base
  await clock.advance(1000)
  await completeTurn($ as never)

  const ui = await mountPane($ as never)
  // Base is still alpha (not beta), counted recursively...
  expect(await ui.find({ text: /2 artifacts in alpha/ } as never)).toBeDefined()
  // ...and the second folder is surfaced as drift.
  expect(await ui.find({ text: /2 slug folders/ } as never)).toBeDefined()
})

test('a reference read to another folder neither repoints the base nor inflates drift', async ($, on) => {
  const clock = baseMocks(on as never)
  on('fs.list', (_$: unknown, e: { path: string }) => {
    const p = e.path.replace(/\\/g, '/')
    if (p === `${ART}/alpha`) return { value: [file('a.txt')] }
    return { value: [] }
  })

  await $.prompt.submit({ text: 'hi' } as never)
  await $.tool.call({ tool: 'Write', file_path: `${ART}/alpha/a.txt` } as never) // pins base = alpha
  await $.tool.call({ tool: 'Read', file_path: `${ART}/gamma/ref.txt` } as never) // read only
  await clock.advance(1000)
  await completeTurn($ as never)

  const ui = await mountPane($ as never)
  // Still alpha, and only one slug folder → no drift hint.
  expect(await ui.find({ text: /1 artifacts in alpha/ } as never)).toBeDefined()
  expect(await ui.find({ text: /slug folders/ } as never)).toBeUndefined()
})
