/**
 * Orphan tool-call guard.
 *
 * A `tool/call` is appended *before* the tool scheduler is asked to prepare the
 * call (`@deepseek-ai/dsh-agent-loop`, `tool-calls.ts`: `appendToolCall(...)`,
 * then `await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(...)`). When that
 * `prepare` throws — a duplicate harness copy leaves the scheduler undefined
 * (discussions #7126/#7128), a dispatch is rejected, the turn is cancelled —
 * the call stays recorded with no `tool/result`, and because it never reaches
 * `inFlight` the ordered commit cannot supply one either. The step then closes
 * in its `finally` and the turn closes normally, its failure written as
 * `turn/end { kind: 'error' }`.
 *
 * `repair.ts` does not close that call. It synthesizes a result only for a log
 * whose last turn is still **open**; a closed turn is read as "Balanced log (no
 * crash mid-turn): nothing to close". The transcript therefore keeps an
 * assistant `tool_calls` block with no `tool` reply — which every provider
 * rejects — and the rejection belongs to the *request*, not to the turn: from
 * the first refusal on, every request of that session fails and the session is
 * unusable, with no recovery path in the product (discussion #7129).
 *
 * **Why this repairs the request and not the log.** The durable repair belongs
 * to the writer that still holds the step open. `@deepseek-ai/dsh-session` owns
 * a runtime invariant for exactly this shape (`src/invariant.ts`, `case
 * 'tool/result'`): an appended synthetic result must name the **currently open**
 * turn and step *and* must correlate with a `tool/call` recorded **in that
 * step**; the one escape from the second requirement is `error.code ===
 * TOOL_NOT_STARTED`, which asserts the opposite of what this log shows. The
 * invariant's `pendingCalls` is cleared by `step/end`, `step/end` is appended in
 * the turn's `finally` **before** the later seams run (`agent/error` included),
 * and nothing in a plugin can run in between. So no post-step writer can append
 * the `TOOL_OUTCOME_UNKNOWN` result `repair.ts` would use without failing that
 * invariant — the honest repair is in-step, in `tool-calls.ts`, and the guard
 * below covers the sessions that are already poisoned.
 *
 * The seam is the last point at which the model-visible request still belongs to
 * the caller: `options.messages` is the transcript the adapter serializes. A
 * request assembled by the agent loop is marked by **object identity**
 * (`markAgentLoopRequest`), so the loop's own frozen object is still checked by
 * that package's request-reconstruction invariant exactly as before, while the
 * replacement this plugin re-dispatches is a different object and therefore
 * never claims to be a loop-built request.
 *
 * The repair is `repair.ts`'s synthetic result in `repair.ts`'s own words: one
 * user-role tool-result message per orphan, inserted directly after the
 * assistant message that declared it, marked `isError`. That the outcome is
 * unknown is a fact about the log — it cannot distinguish a call that never
 * reached a tool from one that ran and lost its result — so the text tells the
 * model to decide from the tool's semantics and never to retry blindly. Nothing
 * is written to the session: the durable log keeps telling the truth, and the
 * repair is re-derived on each later request.
 *
 * @module @argszero/cordis-plugin-orphan-tool-call-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'

/** This plugin's id: its bundle row and the prefix of its log lines. */
export const name = 'orphan-tool-call-guard'

/** The LLM runtime the `llm/stream` waterfall and its replacement dispatch need. */
export const inject = ['llm']

/** Plugin configuration. */
export interface Config {
  /**
   * What to do with an outgoing request that still carries an unpaired tool
   * call. `repair` (the default) supplies the missing result and dispatches the
   * replacement; `observe` reports it and lets the request through unchanged,
   * for an operator who wants the failure visible rather than masked.
   */
  mode?: 'repair' | 'observe'
  /**
   * Circuit breaker: the most orphans one request may repair (default 64). The
   * bound is all-or-nothing — a transcript whose remaining calls would stay
   * unpaired is not worth half a repair — so a request above it is reported and
   * passed through untouched.
   */
  maxRepairs?: number
}

export const Config: z<Config> = z.object({
  mode: z.union([z.const('repair'), z.const('observe')]).default('repair'),
  maxRepairs: z.natural().min(1).default(64),
})

/**
 * What the model is told about a call whose outcome was never durably recorded.
 *
 * Copied verbatim from `@deepseek-ai/dsh-session`'s `repair.ts`, so a transcript
 * repaired here reads exactly like one repaired by the crash path: the model
 * already knows this wording, and the two paths cannot drift into disagreeing
 * advice.
 */
export const OUTCOME_UNKNOWN_TEXT = 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.'

/** One recorded tool call the transcript never answered. */
export interface OrphanCall {
  /** The call id the assistant message declared and no result answers. */
  readonly callId: ToolCallId
  /** Tool name from the declaring block, for reporting. */
  readonly toolName: string
  /** Position, in the inspected list, of the assistant message that declared it. */
  readonly messageIndex: number
}

/** Whether one message is the tool result for `callId`. */
function answers(message: Message, callId: ToolCallId): boolean {
  return message.content.some(block => block.type === 'tool-result' && block.toolCallId === callId)
}

/**
 * Find every call the transcript declares but never answers.
 *
 * The correlation is global rather than positional on purpose: a call id is
 * unique per call, so a result anywhere in the list settles it, while an
 * unpaired declaration is exactly what a provider rejects. This is deliberately
 * not `repair.ts`'s trace — that one clears its pending set at `step/end`, and
 * clearing at a step boundary is precisely what hides this shape.
 * @param messages - the model-visible message list, in order.
 * @returns the orphans in transcript order, empty when every call is answered.
 */
export function findOrphanCalls(messages: readonly Message[]): readonly OrphanCall[] {
  const answered = new Set<ToolCallId>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool-result') answered.add(block.toolCallId)
    }
  }
  const orphans: OrphanCall[] = []
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type !== 'tool-call' || answered.has(block.id)) continue
      orphans.push({ callId: block.id, toolName: block.name, messageIndex })
    }
  }
  return orphans
}

/**
 * Build the synthetic result for one orphan, in `repair.ts`'s shape: a
 * user-role message whose single block is the error result for `callId`. The id
 * is derived from the call rather than random, so re-deriving the same repair
 * produces the same message identity on every request.
 * @param callId - the call the result answers.
 * @returns the frozen synthetic tool-result message.
 */
export function syntheticToolResult(callId: ToolCallId): Message {
  return freezeMessage({
    id: MessageId(`orphan-tool-result-${callId}`),
    role: 'user',
    source: { kind: 'tool', callId },
    content: [{
      type: 'tool-result',
      toolCallId: callId,
      isError: true,
      content: [{ type: 'text', text: OUTCOME_UNKNOWN_TEXT }],
    }],
  })
}

/**
 * Answer every orphan in one message list.
 *
 * Each result is inserted immediately after the assistant message that declared
 * it, which is where the loop itself puts a real one and the only position every
 * adapter reads as "the reply to this call" — appending at the tail would leave
 * the declaration separated from its answer by whatever follows it.
 * @param messages - the model-visible message list, in order.
 * @param orphans - the orphans to answer, as {@link findOrphanCalls} returned them.
 * @returns a new list with one synthetic result per orphan.
 */
export function answerOrphans(
  messages: readonly Message[],
  orphans: readonly OrphanCall[],
): readonly Message[] {
  const byMessage = new Map<number, OrphanCall[]>()
  for (const orphan of orphans) {
    const group = byMessage.get(orphan.messageIndex)
    if (group === undefined) byMessage.set(orphan.messageIndex, [orphan])
    else group.push(orphan)
  }
  const repaired: Message[] = []
  for (const [index, message] of messages.entries()) {
    repaired.push(message)
    for (const orphan of byMessage.get(index) ?? []) repaired.push(syntheticToolResult(orphan.callId))
  }
  return repaired
}

/** One request's finding, for the log line and for tests. */
export interface GuardOutcome {
  /** Session the request belongs to, when the request carries one. */
  readonly sessionId: string | undefined
  /** The orphans found, in transcript order. */
  readonly orphans: readonly OrphanCall[]
  /** Policy that ran. */
  readonly mode: 'repair' | 'observe'
  /** Whether the request was replaced. */
  readonly repaired: boolean
}

/** A bounded, human-readable list of `toolName(callId)` pairs. */
function describe(orphans: readonly OrphanCall[], limit = 4): string {
  const shown = orphans.slice(0, limit).map(orphan => `${orphan.toolName}(${orphan.callId})`)
  const rest = orphans.length - shown.length
  return rest <= 0 ? shown.join(', ') : `${shown.join(', ')} and ${rest} more`
}

/** Plural-correct count of unpaired calls. */
function count(orphans: readonly OrphanCall[]): string {
  return `${orphans.length} unpaired tool call${orphans.length === 1 ? '' : 's'}`
}

/**
 * Decide what one outgoing request needs.
 *
 * The request is left alone when every declared call is answered, when the
 * transcript exceeds the breaker, or in `observe` mode. A replacement is built
 * only for the case the guard exists for.
 * @param options - the request entering the `llm/stream` waterfall.
 * @param config - resolved plugin configuration.
 * @param report - sink for the one log line each finding produces.
 * @returns the outcome, and the replacement request when one was built.
 */
export function guard(
  options: GenerateOptions,
  config: Required<Config>,
  report: (message: string) => void,
): { outcome: GuardOutcome; replacement?: GenerateOptions } {
  const orphans = findOrphanCalls(options.messages)
  const sessionId = options.sessionId
  const where = sessionId === undefined ? 'a request' : `session "${sessionId}"`
  if (orphans.length === 0) {
    return { outcome: { sessionId, orphans, mode: config.mode, repaired: false } }
  }
  if (orphans.length > config.maxRepairs) {
    report(`${count(orphans)} in ${where} exceeds maxRepairs ${config.maxRepairs}; the guarded request is passed through unrepaired: ${describe(orphans)}`)
    return { outcome: { sessionId, orphans, mode: config.mode, repaired: false } }
  }
  if (config.mode === 'observe') {
    report(`${count(orphans)} in ${where}; mode "observe" left the request unchanged, so the provider will reject it: ${describe(orphans)}`)
    return { outcome: { sessionId, orphans, mode: config.mode, repaired: false } }
  }
  const replacement: GenerateOptions = {
    ...options,
    messages: [...answerOrphans(options.messages, orphans)],
  }
  report(`${count(orphans)} in ${where}; supplied ${repairNoun(orphans)} before dispatch: ${describe(orphans)}`)
  return { outcome: { sessionId, orphans, mode: config.mode, repaired: true }, replacement }
}

/** Plural-correct count of supplied results. */
function repairNoun(orphans: readonly OrphanCall[]): string {
  return `a synthetic result for ${orphans.length === 1 ? 'it' : 'each'}`
}

/**
 * Mount the guard on the `llm/stream` waterfall.
 * @param ctx - host context.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: Required<Config> = {
    mode: config.mode ?? 'repair',
    maxRepairs: config.maxRepairs ?? 64,
  }
  /**
   * Requests this plugin already handled, so the replacement it dispatches
   * passes straight through. The identity guard is what keeps the re-dispatch
   * from recursing: the replacement is orphan-free by construction, but a
   * later listener that rewrites requests must still not send this plugin back
   * through its own scan.
   */
  const seen = new WeakSet<GenerateOptions>()

  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> => {
    if (seen.has(options)) return next()
    const { outcome, replacement } = guard(options, resolved, message => ctx.logger.warn(`orphan tool-call guard: ${message}`))
    if (!outcome.repaired || replacement === undefined) return next()
    seen.add(options)
    seen.add(replacement)
    return ctx.llm.stream(replacement)
  }, { prepend: true })
}
