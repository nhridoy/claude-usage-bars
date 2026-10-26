export type Meter = { label: string; percent: number; resetsAt?: string }
export type Usage = { meters: Meter[]; usd?: number }
/** Tokens each model family processed, e.g. { Fable: 120000 }; new input, output and cache writes only. */
export type ModelTokens = Record<string, number>
/** The same, for one weekly limit window; `id` names the window (its reset hour) so a new week starts over. */
export type WeekTokens = { id: string; tokens: ModelTokens }
/** A limit reset Claude is offering now; `left` when the server says how many. */
export type ResetOffer = { left?: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-bars': {
      usage: Usage | null
      scoped: Meter[]
      models: ModelTokens
      week: WeekTokens | null
      offer: ResetOffer | null
      isExpanded: boolean
    }
  }
}
