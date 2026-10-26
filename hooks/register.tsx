import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput, TurnUsage } from 'claude-code'

import type { Meter, ModelTokens, ResetOffer, Usage } from '../types'

const usage = atom({ plugin: 'usage-bars', key: 'usage' } as const, null)
const scoped = atom({ plugin: 'usage-bars', key: 'scoped' } as const, [])
const offer = atom({ plugin: 'usage-bars', key: 'offer' } as const, null)
const models = atom({ plugin: 'usage-bars', key: 'models' } as const, {})
const isExpanded = atom({ plugin: 'usage-bars', key: 'isExpanded' } as const, true)

const FAMILIES = ['Fable', 'Opus', 'Sonnet', 'Haiku']
const LABELS: Record<string, string> = {
  five_hour: 'Session · 5h',
  seven_day: 'Weekly · all models',
  spend_limit: 'Spend limit',
}
// Hex for the SVG bars (no theme there); theme keys for text.
const HEX = { success: '#3FB950', warning: '#D29922', error: '#F85149' } as const
const MODEL_HEX: Record<string, string> = { Fable: '#A78BFA', Opus: '#D97757', Sonnet: '#58A6FF', Haiku: '#3FB950' }
const OTHER_HEX = '#8B949E'
const WIDTH = 20
// Per-model weekly limits (e.g. Fable) are only in the account's usage endpoint, not in $.session.usage().
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1'
const POLL_MS = 60_000

export const tone = (percent: number) => (percent >= 80 ? 'error' : percent >= 50 ? 'warning' : 'success')

export const family = (model: string) =>
  FAMILIES.find(f => model.toLowerCase().includes(f.toLowerCase())) ?? model

// A model-scoped window (e.g. seven_day_opus, or a Fable one) reads "Weekly · Fable".
export const label = (kind: string) => {
  if (LABELS[kind]) return LABELS[kind]
  const f = FAMILIES.find(f => kind.toLowerCase().includes(f.toLowerCase()))
  return f ? `Weekly · ${f}` : kind.replaceAll('_', ' ')
}

export const resetsIn = (resetsAt: string | undefined, now: number) => {
  if (!resetsAt) return ''
  const minutes = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  return days ? `resets in ${days}d ${hours}h` : `resets in ${hours}h ${minutes % 60}m`
}

export const toUsage = (e: Pick<SessionMeasureInput, 'context' | 'rateLimits' | 'cost'>): Usage => {
  const meters: Meter[] = []
  if (e.context.percent !== undefined) meters.push({ label: 'Context window', percent: e.context.percent })
  for (const r of e.rateLimits) meters.push({ label: label(r.kind), percent: r.percentUsed, resetsAt: r.resetsAt })
  return { meters, usd: e.cost?.usd }
}

type Limit = { percent?: number; resets_at?: string; scope?: { model?: { display_name?: string } } | null }

export const scopedMeters = (body: unknown): Meter[] => {
  const limits = (body as { limits?: Limit[] } | null)?.limits ?? []
  return limits.flatMap(l => {
    const name = l.scope?.model?.display_name
    return name && typeof l.percent === 'number'
      ? [{ label: `Weekly · ${name}`, percent: l.percent, resetsAt: l.resets_at }]
      : []
  })
}

type Grants = { eligible?: boolean; grants?: { resets_left?: number }[] }
type Tide = { eligible?: boolean; available?: boolean }

// cedar_ember: resets granted to the account; juniper_tide: the weekly session-limit reset.
// shortcut: juniper_tide's shape was never seen non-null, so any object not marked ineligible counts; tighten once one shows up.
export const resetOffer = (body: unknown, isCommandListed: boolean): ResetOffer | null => {
  const b = (body ?? {}) as { cedar_ember?: Grants | null; juniper_tide?: Tide | null }
  const left = (b.cedar_ember?.grants ?? []).reduce((n, g) => n + (g.resets_left ?? 0), 0)
  if (b.cedar_ember?.eligible && left > 0) return { left }
  const tide = b.juniper_tide
  if (tide && tide.eligible !== false && tide.available !== false) return {}
  return isCommandListed ? {} : null
}

let fetchedAt = -Infinity

// Asks the usage endpoint at most once a minute; the engine adds the login, the token never reaches the mod.
const refreshScoped = async ($: EngineInterface) => {
  const now = await $.clock.now()
  if (now - fetchedAt < POLL_MS) return
  fetchedAt = now
  try {
    const auth = await $.session.authorize()
    if (auth?.kind !== 'bearer') return
    const res = await $.http.fetch(USAGE_URL, { auth: auth.handle, headers: { 'anthropic-beta': 'oauth-2025-04-20' } })
    if (!res.ok) return
    const body: unknown = JSON.parse(res.text)
    const isListed = (await $.command.list()).some(c => c.name === 'limit-reset')
    await update($, scoped, () => scopedMeters(body))
    await update($, offer, () => resetOffer(body, isListed))
  } catch {
    // Keep the last reading; the next measure retries.
  }
}

export const addTurn = (tokens: ModelTokens, u: TurnUsage): ModelTokens => {
  const f = family(u.model)
  const n = u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  return { ...tokens, [f]: (tokens[f] ?? 0) + n }
}

export const shares = (tokens: ModelTokens) => {
  const total = Object.values(tokens).reduce((a, b) => a + b, 0)
  return Object.entries(tokens)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => ({ name, percent: (n / total) * 100, hex: MODEL_HEX[name] ?? OTHER_HEX }))
}

const clamp = (p: number) => Math.min(Math.max(p, 0), 100)

const meterSvg = (percent: number, hex: string) => {
  const w = percent > 0 ? Math.max(4, (clamp(percent) / 100) * 400) : 0
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="4" viewBox="0 0 400 4"><defs><linearGradient id="g"><stop offset="0" stop-color="${hex}" stop-opacity=".65"/><stop offset="1" stop-color="${hex}"/></linearGradient></defs><rect width="400" height="4" rx="2" fill="rgba(128,128,128,.22)"/><rect width="${w}" height="4" rx="2" fill="url(#g)"/></svg>`
}

const stackSvg = (parts: { percent: number; hex: string }[]) => {
  let x = 0
  const rects = parts.map(p => {
    const w = (p.percent / 100) * 400
    const r = `<rect x="${x}" width="${Math.max(w - 2, 1)}" height="4" fill="${p.hex}"/>`
    x += w
    return r
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="4" viewBox="0 0 400 4"><defs><clipPath id="c"><rect width="400" height="4" rx="2"/></clipPath></defs><rect width="400" height="4" rx="2" fill="rgba(128,128,128,.22)"/><g clip-path="url(#c)">${rects.join('')}</g></svg>`
}

const blocks = (percent: number) => {
  const filled = Math.round((clamp(percent) / 100) * WIDTH)
  return ['━'.repeat(filled), '─'.repeat(WIDTH - filled)] as const
}

const pct = (p: number) => `${p.toFixed(0)}%`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // Seed the band at once instead of waiting for the next turn.
    const now = await $.session.usage()
    await update($, usage, () => toUsage(now))
    await refreshScoped($)
    return r
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => toUsage(e))
    await refreshScoped($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    if (u) await update($, models, t => addTurn(t ?? {}, u))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const engine = await read($, usage)
    const extra = (await read($, scoped)) ?? []
    // The model-scoped windows sit right below the all-models weekly one.
    const u = engine && {
      ...engine,
      meters: [...engine.meters, ...extra.filter(x => !engine.meters.some(m => m.label === x.label))],
    }
    const split = shares((await read($, models)) ?? {})
    if (e.props.hasSurvey || !u || (u.meters.length === 0 && split.length === 0)) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Svg = 'Svg' in ui ? ui.Svg : undefined
    const now = await $.clock.now()
    const expanded = await read($, isExpanded)
    const reset = await read($, offer)
    const resetButton = reset && (
      <Button
        key="reset"
        label={reset.left ? `Use reset (${reset.left} left)` : 'Use reset'}
        onPress={async () => {
          try {
            // Claude Code's own /limit-reset asks to confirm; the mod never claims a reset itself.
            await $.command.run({ command: 'limit-reset' })
          } catch {
            $.ui.toast('Type /limit-reset to use your reset')
          }
          fetchedAt = -Infinity
        }}
      />
    )
        const toggle = (
      <Button
        key="toggle"
        label={expanded ? 'Collapse' : 'Details'}
        onPress={() => update($, isExpanded, v => !v)}
      />
    )

    if (!expanded) {
      return (
        <Box flexDirection="row" alignItems="center" gap="sm" flexWrap="wrap">
          {u.meters.map(m => (
            <Text key={m.label}>
              <Text dimColor>{m.label} </Text>
              <Text color={tone(m.percent)} weight="semibold" tabular>{pct(m.percent)}</Text>
            </Text>
          ))}
          {split.map(s => (
            <Text key={s.name}>
              <Text color={s.hex}>● </Text>
              <Text dimColor>{s.name} </Text>
              <Text weight="semibold" tabular>{pct(s.percent)}</Text>
            </Text>
          ))}
          {u.usd !== undefined && <Text color="claude" weight="semibold">${u.usd.toFixed(2)}</Text>}
          {resetButton}
          {toggle}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap="sm" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text weight="semibold">Usage</Text>
          <Box flexDirection="row" alignItems="center" gap="sm">
            {u.usd !== undefined && (
              <Text>
                <Text color="claude" weight="semibold">${u.usd.toFixed(2)}</Text>
                <Text dimColor> this session</Text>
              </Text>
            )}
            {resetButton}
            {toggle}
          </Box>
        </Box>

        {u.meters.map(m => {
          const reset = resetsIn(m.resetsAt, now)
          if (!Svg) {
            const [filled, empty] = blocks(m.percent)
            return (
              <Text key={m.label}>
                <Text weight="semibold">{m.label.padEnd(20)}</Text>
                <Text color={tone(m.percent)}>{filled}</Text>
                <Text dimColor>{empty}</Text>
                <Text color={tone(m.percent)} weight="semibold">{` ${pct(m.percent).padStart(4)}`}</Text>
                <Text dimColor>{reset && `  ${reset}`}</Text>
              </Text>
            )
          }
          return (
            <Box key={m.label} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text weight="medium">{m.label}</Text>
                <Text>
                  <Text dimColor size="footnote">{reset && `${reset}  `}</Text>
                  <Text color={tone(m.percent)} weight="semibold" tabular>{pct(m.percent)}</Text>
                </Text>
              </Box>
              <Svg source={meterSvg(m.percent, HEX[tone(m.percent)])} alt={`${m.label} ${pct(m.percent)} used`} />
            </Box>
          )
        })}

        {split.length > 0 && (
          <Box key="models" flexDirection="column">
            <Text weight="medium">Models this session</Text>
            {!Svg ? (
              <Text>
                {split.map(s => (
                  <Text key={s.name} color={s.hex}>{'━'.repeat(Math.max(1, Math.round((s.percent / 100) * 40)))}</Text>
                ))}
              </Text>
            ) : (
              <Svg source={stackSvg(split)} alt={split.map(s => `${s.name} ${pct(s.percent)}`).join(', ')} />
            )}
            <Box flexDirection="row" gap="md" flexWrap="wrap">
              {split.map(s => (
                <Text key={s.name}>
                  <Text color={s.hex}>● </Text>
                  <Text>{s.name} </Text>
                  <Text weight="semibold" tabular>{pct(s.percent)}</Text>
                </Text>
              ))}
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
