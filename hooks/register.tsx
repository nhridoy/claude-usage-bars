import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput, TurnUsage } from 'claude-code'

import type { Meter, ModelTokens, ResetOffer, Usage, WeekTokens } from '../types'

const usage = atom({ plugin: 'usage-bars', key: 'usage' } as const, null)
const scoped = atom({ plugin: 'usage-bars', key: 'scoped' } as const, [])
const offer = atom({ plugin: 'usage-bars', key: 'offer' } as const, null)
const models = atom({ plugin: 'usage-bars', key: 'models' } as const, {})
const week = atom({ plugin: 'usage-bars', key: 'week' } as const, null)
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
const HOUR = 3_600_000
const WINDOWS: [string, number][] = [['Session', 5 * HOUR], ['Weekly', 168 * HOUR]]
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ALERT_AT = 95

type Snap = Pick<SessionMeasureInput, 'context' | 'rateLimits' | 'cost'>

export const tone = (percent: number, warnAt = 50, dangerAt = 80) =>
  percent >= dangerAt ? 'error' : percent >= warnAt ? 'warning' : 'success'

// The length of the window a meter counts over, from its label; undefined for the context window.
export const windowMs = (label: string) => WINDOWS.find(([k]) => label.startsWith(k))?.[1]

// When the bar would reach 100% if it keeps filling at the rate it has so far; null when that is after the reset.
export const paceHit = (percent: number, resetsAt: string | undefined, span: number | undefined, now: number) => {
  if (!resetsAt || !span || percent <= 0 || percent >= 100) return null
  const resets = Date.parse(resetsAt)
  const elapsed = span - (resets - now)
  if (elapsed < span * 0.05) return null // too early to tell
  const hit = resets - span + (100 / percent) * elapsed
  return hit < resets ? hit : null
}

export const fmtHit = (hit: number, now: number) => {
  if (hit - now < 24 * HOUR) {
    const minutes = Math.max(0, Math.round((hit - now) / 60000))
    return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`
  }
  const d = new Date(hit)
  return `${DAYS[d.getDay()]} ${d.getHours() % 12 || 12}${d.getHours() < 12 ? 'am' : 'pm'}`
}

// The highest threshold the percentage has reached, 0 when none.
export const levelOf = (percent: number, levels: number[]) => Math.max(0, ...levels.filter(l => percent >= l))

// The weekly window's id: its reset hour, so the fraction-of-a-second jitter in resetsAt does not split a week.
export const weekId = (u: Usage | null) => u?.meters.find(m => m.label === 'Weekly · all models')?.resetsAt?.slice(0, 13) ?? 'all'

export const allMeters = (engine: Usage | null, extra: Meter[]): Meter[] =>
  engine ? [...engine.meters, ...extra.filter(x => !engine.meters.some(m => m.label === x.label))] : []

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

export const toUsage = (e: Snap): Usage => {
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

// Asks the usage endpoint at most once per `pollMs`; the engine adds the login, the token never reaches the mod.
const refreshScoped = async ($: EngineInterface, pollMs: number) => {
  const now = await $.clock.now()
  if (now - fetchedAt < pollMs) return
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

// Cache reads are left out: they dominate and say little about how much a model worked.
export const addTurn = (tokens: ModelTokens, u: TurnUsage): ModelTokens => {
  const f = family(u.model)
  const n = u.input_tokens + u.output_tokens + u.cache_creation_input_tokens
  return { ...tokens, [f]: (tokens[f] ?? 0) + n }
}

export const addWeek = (w: WeekTokens | null, id: string, u: TurnUsage): WeekTokens => ({
  id,
  tokens: addTurn(w?.id === id ? w.tokens : {}, u),
})

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


const num = (v: unknown, d: number) => (typeof v === 'number' && v > 0 ? v : d)

const pct = (p: number) => `${p.toFixed(0)}%`

type Config = { warnAt: number; dangerAt: number; pollMs: number; hasAlerts: boolean; hasCost: boolean }

// A pop-up when a limit first reaches the red line and again at 95%; the level is kept in the store so a reload does not repeat it.
const alert = async ($: EngineInterface, cfg: Config) => {
  const prev = ((await $.store.get('alerts')) ?? {}) as Record<string, number>
  const next = { ...prev }
  const now = await $.clock.now()
  for (const m of allMeters(await read($, usage), (await read($, scoped)) ?? [])) {
    if (!windowMs(m.label)) continue
    const level = levelOf(m.percent, [cfg.dangerAt, ALERT_AT])
    const before = prev[m.label] ?? 0
    if (level === before) continue
    next[m.label] = level
    if (level > before) $.ui.toast(`${m.label} is at ${pct(m.percent)}${m.resetsAt ? ` · ${resetsIn(m.resetsAt, now)}` : ''}`)
  }
  if (JSON.stringify(next) !== JSON.stringify(prev)) await $.store.set('alerts', next)
}

// One at a time, so the timer and a measure never toast the same crossing twice.
let queue: Promise<unknown> = Promise.resolve()
const sync = ($: EngineInterface, cfg: Config, snap?: Snap) => {
  queue = queue
    .then(async () => {
      const s = snap ?? (await $.session.usage())
      await update($, usage, () => toUsage(s))
      await refreshScoped($, cfg.pollMs)
      if (cfg.hasAlerts) await alert($, cfg)
      $.ui.invalidate('ui.render') // the "resets in" and pace text move with the clock
    })
    .catch(() => {})
  return queue
}

export const register: Register = (on, options) => {
  const cfg: Config = {
    warnAt: num(options.warnAt, 50),
    dangerAt: num(options.dangerAt, 80),
    pollMs: Math.max(30, num(options.pollSeconds, 60)) * 1000,
    hasAlerts: options.alerts !== false,
    hasCost: options.showCost !== false,
  }
  const { hasCost } = cfg
  const color = (p: number) => tone(p, cfg.warnAt, cfg.dangerAt)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // What survives a restart: the collapsed state and this week's model split.
    const saved = await $.store.get('isExpanded')
    if (typeof saved === 'boolean') await update($, isExpanded, () => saved)
    const w = (await $.store.get('week')) as WeekTokens | undefined
    if (w?.id && w.tokens) await update($, week, () => w)
    await sync($, cfg)
    // Idle refresh; a hot reload drops the timer and this runs again.
    $.clock.every(30_000, () => void sync($, cfg))
    return r
  })

  on('session.measure', async ($, e, next) => {
    await sync($, cfg, e)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    if (u) {
      await update($, models, t => addTurn(t ?? {}, u))
      const id = weekId(await read($, usage))
      let saved: WeekTokens | undefined
      await update($, week, w => (saved = addWeek(w, id, u)))
      if (saved) await $.store.set('week', saved)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const engine = await read($, usage)
    // The model-scoped windows sit right below the all-models weekly one.
    const meters = allMeters(engine, (await read($, scoped)) ?? [])
    const u = engine && { ...engine, meters }
    const split = shares((await read($, models)) ?? {})
    const w = await read($, week)
    const weekSplit = w && w.id === weekId(engine) ? shares(w.tokens) : []
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
        onPress={async () => {
          await update($, isExpanded, v => !v)
          await $.store.set('isExpanded', !expanded)
        }}
      />
    )

    if (!expanded) {
      return (
        <Box flexDirection="row" alignItems="center" gap="sm" flexWrap="wrap">
          {u.meters.map(m => (
            <Text key={m.label}>
              <Text dimColor>{m.label} </Text>
              <Text color={color(m.percent)} weight="semibold" tabular>{pct(m.percent)}</Text>
            </Text>
          ))}
          {split.map(s => (
            <Text key={s.name}>
              <Text color={s.hex}>● </Text>
              <Text dimColor>{s.name} </Text>
              <Text weight="semibold" tabular>{pct(s.percent)}</Text>
            </Text>
          ))}
          {hasCost && u.usd !== undefined && <Text color="claude" weight="semibold">${u.usd.toFixed(2)}</Text>}
          {resetButton}
          {toggle}
        </Box>
      )
    }

    const modelBlock = (title: string, parts: ReturnType<typeof shares>) =>
      parts.length === 0 ? null : (
        <Box key={title} flexDirection="column">
          <Text weight="medium">{title}</Text>
          {!Svg ? (
            <Text>
              {parts.map(p => (
                <Text key={p.name} color={p.hex}>{'━'.repeat(Math.max(1, Math.round((p.percent / 100) * 40)))}</Text>
              ))}
            </Text>
          ) : (
            <Svg source={stackSvg(parts)} alt={parts.map(p => `${p.name} ${pct(p.percent)}`).join(', ')} />
          )}
          <Box flexDirection="row" gap="md" flexWrap="wrap">
            {parts.map(p => (
              <Text key={p.name}>
                <Text color={p.hex}>● </Text>
                <Text>{p.name} </Text>
                <Text weight="semibold" tabular>{pct(p.percent)}</Text>
              </Text>
            ))}
          </Box>
        </Box>
      )

    return (
      <Box flexDirection="column" gap="sm" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text weight="semibold">Usage</Text>
          <Box flexDirection="row" alignItems="center" gap="sm">
            {hasCost && u.usd !== undefined && (
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
          const resetsText = resetsIn(m.resetsAt, now)
          const hit = paceHit(m.percent, m.resetsAt, windowMs(m.label), now)
          const paceText = hit === null ? '' : `at this pace: limit ${fmtHit(hit, now)}`
          if (!Svg) {
            const [filled, empty] = blocks(m.percent)
            return (
              <Text key={m.label}>
                <Text weight="semibold">{m.label.padEnd(20)}</Text>
                <Text color={color(m.percent)}>{filled}</Text>
                <Text dimColor>{empty}</Text>
                <Text color={color(m.percent)} weight="semibold">{` ${pct(m.percent).padStart(4)}`}</Text>
                <Text dimColor>{resetsText && `  ${resetsText}`}</Text>
                <Text color="warning">{paceText && `  · ${paceText}`}</Text>
              </Text>
            )
          }
          return (
            <Box key={m.label} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text weight="medium">{m.label}</Text>
                <Text>
                  <Text dimColor size="footnote">{resetsText && `${resetsText}  `}</Text>
                  <Text color="warning" size="footnote">{paceText && `${paceText}  `}</Text>
                  <Text color={color(m.percent)} weight="semibold" tabular>{pct(m.percent)}</Text>
                </Text>
              </Box>
              <Svg source={meterSvg(m.percent, HEX[color(m.percent)])} alt={`${m.label} ${pct(m.percent)} used`} />
            </Box>
          )
        })}

        {modelBlock('Models this session', split)}
        {modelBlock('Models this week', weekSplit)}
      </Box>
    )
  })
}
