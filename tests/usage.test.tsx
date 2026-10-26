import { expect, test } from 'claude-code/testing'

import { addTurn, family, label, resetOffer, scopedMeters, shares, tone, toUsage } from '../hooks/register'

const turn = (model: string, n: number) => ({
  model,
  input_tokens: n,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

test('colors, labels and model share', async () => {
  expect([tone(10), tone(65), tone(92)]).toEqual(['success', 'warning', 'error'])
  expect(label('five_hour')).toBe('Session · 5h')
  expect(label('seven_day_opus')).toBe('Weekly · Opus')
  expect(label('seven_day_fable')).toBe('Weekly · Fable')
  expect(family('claude-fable-5-1')).toBe('Fable')

  let t = addTurn({}, turn('claude-fable-5-1', 300))
  t = addTurn(t, turn('claude-opus-5-5', 100))
  expect(shares(t).map(s => [s.name, s.percent])).toEqual([['Fable', 75], ['Opus', 25]])

  const u = toUsage({
    context: { window: 200000, tokens: 84000, percent: 42 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 81.5 }],
    cost: { usd: 1.25 },
  })
  expect(u.meters.map(m => m.label)).toEqual(['Context window', 'Session · 5h'])
})

test('model-scoped weekly limits come from the usage endpoint body', async () => {
  const body = {
    limits: [
      { kind: 'session', percent: 21, resets_at: 'a', scope: null },
      { kind: 'weekly_all', percent: 48, resets_at: 'b', scope: null },
      { kind: 'weekly_scoped', percent: 81, resets_at: 'c', scope: { model: { id: null, display_name: 'Fable' } } },
    ],
  }
  expect(scopedMeters(body)).toEqual([{ label: 'Weekly · Fable', percent: 81, resetsAt: 'c' }])
  expect(scopedMeters({})).toEqual([])
  expect(scopedMeters(null)).toEqual([])
})

test('a reset offer is read from cedar_ember, juniper_tide or the command list', async () => {
  // The body this account answered with no offer active.
  const none = { cedar_ember: { eligible: false, ineligible_reason: 'surface', grants: [] }, juniper_tide: null }
  expect(resetOffer(none, false)).toBe(null)
  expect(resetOffer({ cedar_ember: { eligible: true, grants: [{ resets_left: 1 }, { resets_left: 1 }] } }, false)).toEqual({ left: 2 })
  expect(resetOffer({ cedar_ember: { eligible: true, grants: [{ resets_left: 0 }] } }, false)).toBe(null)
  expect(resetOffer({ juniper_tide: { eligible: true } }, false)).toEqual({})
  expect(resetOffer({ juniper_tide: { eligible: false } }, false)).toBe(null)
  expect(resetOffer(none, true)).toEqual({})
})

test('the reset button runs /limit-reset', async ($, on) => {
  const ran: string[] = []
  on('clock.now', () => ({ value: 0 }))
  on('command.run', (_, e) => (ran.push(e.command), { text: '' }))
  on('state.get', (_, e) => {
    const values: Record<string, unknown> = {
      offer: { left: 2 },
      usage: { meters: [{ label: 'Session · 5h', percent: 100 }] },
      scoped: [],
      models: {},
      isExpanded: true,
    }
    return { value: { value: values[(e as { key: string }).key] as never, version: 1 } }
  })
  const ui = await $.ui.mount({ plugin: 'usage-bars', component: 'AbovePrompt', surface: 'vscode', props: { hasSurvey: false } } as never)
  expect(await ui.find({ type: 'Button', key: 'reset' })).toBeTruthy()
  await ui.press({ key: 'reset' })
  expect(ran).toEqual(['limit-reset'])
  await ui.unmount()
})

for (const surface of ['terminal', 'vscode'] as const) {
  test(`the band draws meters and the model split on ${surface}`, async ($, on) => {
    on('clock.now', () => ({ value: 0 }))
    on('state.get', (_, e) => {
      const key = (e as { key?: string }).key
      if (key === 'models') return { value: { value: { Fable: 300, Opus: 100 }, version: 1 } }
      if (key === 'isExpanded') return { value: { value: true, version: 1 } }
      if (key === 'scoped') return { value: { value: [{ label: 'Weekly · Fable', percent: 81 }], version: 1 } }
      return { value: { value: { meters: [{ label: 'Context window', percent: 42 }], usd: 1.25 }, version: 1 } }
    })
    const ui = await $.ui.mount({
      plugin: 'usage-bars',
      component: 'AbovePrompt',
      surface,
      props: { hasSurvey: false },
    } as never)
    expect((await ui.find({ type: 'Text', text: /42%/ }))?.text).toContain('42%')
    expect((await ui.find({ type: 'Text', text: /Fable 75%/ }))?.text).toContain('75%')
    expect((await ui.find({ type: 'Text', text: /\$1\.25/ })) !== undefined).toBe(true)
    expect(await ui.find({ type: 'Text', text: /Weekly · Fable/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /81%/ })).toBeTruthy()
    await ui.unmount()
  })
}
