import { test, expect } from 'claude-code/testing'

// --- Blocked: in-place file mutators (deny carries the rule's message). ---
// The plugin denies before reaching anything beneath, so these need no bottom hook.

test('blocks sed -i', async $ => {
  const r = await $.tool.call({ tool: 'Bash', command: "sed -i 's/a/b/' f.txt" })
  expect(r.deny).toMatch(/sed -i/)
})

test('blocks sed -i mid-pipeline', async $ => {
  const r = await $.tool.call({ tool: 'Bash', command: "cat f.txt | sed -i 's/a/b/' f.txt" })
  expect(r.deny).toMatch(/sed -i/)
})

test('blocks sed --in-place', async $ => {
  const r = await $.tool.call({ tool: 'Bash', command: "sed --in-place 's/a/b/' f.txt" })
  expect(r.deny).toMatch(/sed -i/)
})

test('blocks perl -pi -e', async $ => {
  const r = await $.tool.call({ tool: 'Bash', command: "perl -pi -e 's/a/b/' f.txt" })
  expect(r.deny).toMatch(/perl -i/)
})

test('blocks perl -i.bak', async $ => {
  const r = await $.tool.call({ tool: 'Bash', command: "perl -i.bak -pe 's/a/b/' f.txt" })
  expect(r.deny).toMatch(/perl -i/)
})

test('blocks gawk -i inplace', async $ => {
  const r = await $.tool.call({ tool: 'Bash', command: "gawk -i inplace '{ print }' f.txt" })
  expect(r.deny).toMatch(/awk -i inplace/)
})

test('guards PowerShell commands too', async $ => {
  const r = await $.tool.call({ tool: 'PowerShell', command: "sed -i 's/a/b/' f.txt" })
  expect(r.deny).toMatch(/sed -i/)
})

// --- Allowed: reads, redirects, non-in-place uses pass through (no deny). ---
// A pass-through reaches the bottom, so each test supplies one with its own `on`.

test('allows sed read + redirect', async ($, on) => {
  on('tool.call', (_$, _e, _next) => ({ result: 'ok' }))
  const r = await $.tool.call({ tool: 'Bash', command: "sed 's/a/b/' f.txt > out.txt" })
  expect(r.deny).toBeUndefined()
})

test('allows sed -n print range', async ($, on) => {
  on('tool.call', (_$, _e, _next) => ({ result: 'ok' }))
  const r = await $.tool.call({ tool: 'Bash', command: "sed -n '1,5p' f.txt" })
  expect(r.deny).toBeUndefined()
})

test('allows perl -e (no in-place flag)', async ($, on) => {
  on('tool.call', (_$, _e, _next) => ({ result: 'ok' }))
  const r = await $.tool.call({ tool: 'Bash', command: "perl -e 'print 1'" })
  expect(r.deny).toBeUndefined()
})

test('allows perl -ne read', async ($, on) => {
  on('tool.call', (_$, _e, _next) => ({ result: 'ok' }))
  const r = await $.tool.call({ tool: 'Bash', command: "perl -ne 'print' f.txt" })
  expect(r.deny).toBeUndefined()
})

test('allows awk read', async ($, on) => {
  on('tool.call', (_$, _e, _next) => ({ result: 'ok' }))
  const r = await $.tool.call({ tool: 'Bash', command: "awk '{ print }' f.txt" })
  expect(r.deny).toBeUndefined()
})

test('allows an unrelated command', async ($, on) => {
  on('tool.call', (_$, _e, _next) => ({ result: 'ok' }))
  const r = await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(r.deny).toBeUndefined()
})
