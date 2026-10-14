import { test, expect, mock } from 'claude-code/testing'

test('band shows session totals after a turn completes', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  // Bottom implementation the kit needs beneath the plugin for the event.
  on('turn.complete', () => ({ text: '' }))

  await clock.advance(5000)
  await $.turn.complete({
    reason: 'answer',
    turnId: 't1',
    isAborted: false,
    answer: '',
    durationMs: 5000,
  } as never)

  const ui = await $.ui.mount({
    plugin: 'activity',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false } as never,
  })

  const el = await ui.find({ text: /session/ })
  expect(el).toBeDefined()
})
