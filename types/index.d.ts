export type Meter = { label: string; percent: number; resetsAt?: string }
export type Usage = { meters: Meter[]; usd?: number }
/** Tokens each model family processed this session, e.g. { Fable: 120000 }. */
export type ModelTokens = Record<string, number>
/** A limit reset Claude is offering now; `left` when the server says how many. */
export type ResetOffer = { left?: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-bars': { usage: Usage | null; scoped: Meter[]; models: ModelTokens; offer: ResetOffer | null; isExpanded: boolean }
  }
}
