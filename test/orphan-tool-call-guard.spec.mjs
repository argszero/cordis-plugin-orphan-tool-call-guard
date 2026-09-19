/**
 * Behaviour tests against a real `@deepseek-ai/cordis` context, the real
 * `@deepseek-ai/dsh-llm` service and its real `llm/stream` waterfall.
 *
 * Nothing here is a stub of the seam: `LlmRuntime` is mounted as the shipped
 * profiles mount it, `ctx.llm.stream()` runs the real waterfall, and the only
 * stand-in is the provider backend, because a test cannot call a provider. That
 * stand-in enforces the one rule the repair exists for — the rule
 * `@deepseek-ai/dsh-session`'s `repair.ts` states in its own comment, that
 * "providers reject dangling assistant calls" — so a green run means the
 * transcript the plugin hands over satisfies a provider, and the control test
 * (plugin unmounted) means the same fixture really is refused.
 *
 * The deeper assertions are about what the plugin does NOT do: it never mutates
 * the request it was handed, it never sends the unrepaired request to the
 * backend, it does not loop when it dispatches its replacement, and the
 * replacement it dispatches is honestly not marked as an agent-loop request.
 *
 * The synthetic message it inserts is checked against
 * `interruptedTurnClosers()` — the shipped crash-recovery implementation — not
 * against a copy of its wording, so the two paths cannot drift apart without
 * this file going red.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  isAgentLoopRequest,
  markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import {
  Config,
  OUTCOME_UNKNOWN_TEXT,
  answerOrphans,
  apply,
  findOrphanCalls,
  guard,
  inject,
  name,
  syntheticToolResult,
} from '../lib/index.js'

// --------------------------------------------------------------- observation

/**
 * The rule a real provider applies to an assistant `tool_calls` block: every
 * declared call needs a result carrying the same id, anywhere in the request.
 * Written here from the outside on purpose — it is the rule being satisfied, so
 * the test states it rather than asking the plugin what it thinks.
 * @param messages - the request's message list.
 * @returns the ids of the calls no result answers.
 */
function danglingCalls(messages) {
  const answered = new Set()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool-result') answered.add(block.toolCallId)
    }
  }
  const dangling = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'tool-call' && !answered.has(block.id)) dangling.push(block.id)
    }
  }
  return dangling
}

/** A protocol-valid terminal script: one text block and a successful finish. */
const HEALTHY_CHUNKS = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'ok' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** A stand-in provider backend that refuses exactly what a provider refuses. */
class PairingAdapter extends LlmAdapter {
  /** One entry per call that reached the backend. */
  calls = []
  /** Count of calls refused for a dangling tool call. */
  rejections = 0

  constructor(chunks) {
    super()
    this.chunks = chunks ?? HEALTHY_CHUNKS
  }

  async *stream(options) {
    this.calls.push(options)
    const dangling = danglingCalls(options.messages)
    if (dangling.length > 0) {
      this.rejections += 1
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'INVALID_REQUEST',
            message: `assistant message has ${dangling.length} tool_call(s) without a response`,
          },
        },
      }
      return
    }
    for (const chunk of this.chunks) yield chunk
  }
}

/**
 * Mount the real LLM service plus a pairing-enforcing backend, then the plugin.
 * @param options - `config` for the plugin, `chunks` for the backend.
 * @returns the context, the backend, and a chunk collector.
 */
async function harness({ config = {}, chunks } = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new PairingAdapter(chunks)
  ctx.llm.registerAdapter(['fake'], adapter)
  // `inject` travels with the plugin object: the cordis loader passes the whole
  // module, so a hand-built mount that omits it silently drops the dependency.
  await ctx.plugin({ name, inject, apply, Config }, config)
  return { ctx, adapter }
}

/** Drive one request through the real waterfall and return its chunks. */
async function stream(ctx, options) {
  const chunks = []
  for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk)
  return chunks
}

// ------------------------------------------------------------------ fixtures

const X = ToolCallId('call-x')
const Y = ToolCallId('call-y')
const Z = ToolCallId('call-z')

/** One ordinary user input. */
function user(text) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** One assistant message declaring the given tool calls. */
function assistant(...ids) {
  return createAssistantMessage({
    content: ids.map(id => ({ type: 'tool-call', id, name: 'read', arguments: '{"path":"a"}' })),
    source: { provider: 'fake', model: 'm' },
  })
}

/** One real (answered) tool result. */
function result(callId, text = 'contents') {
  return createToolResultMessage({ callId, content: [{ type: 'text', text }], isError: false })
}

/** The poisoned transcript of #7129: one call, answered by nothing. */
const POISONED = [user('run it'), assistant(X)]

/** A request envelope, optionally marked and frozen as the agent loop builds it. */
function request(messages, { loopBuilt = false } = {}) {
  const options = { provider: 'fake', model: 'm', messages }
  if (!loopBuilt) return options
  markAgentLoopRequest(options)
  Object.freeze(options.messages)
  return Object.freeze(options)
}

// ------------------------------------------------------- the synthetic result

test('the synthetic result is the one the shipped crash-repair path produces', () => {
  // A log whose last turn is still open, with a call that was recorded as
  // started — the exact input shape `interruptedTurnClosers` answers with the
  // OUTCOME_UNKNOWN text.
  const events = [
    { seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: 1, type: 'step/start', data: { turn: 1, step: 0 } },
    { seq: 2, time: 1, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 0, message: assistant(X) } },
    { seq: 3, time: 1, type: 'tool/call', data: { turn: 1, step: 0, callId: X, name: 'read', arguments: '{}' } },
  ]
  const closers = interruptedTurnClosers(events)
  const closer = closers.find(event => event.type === 'tool/result')
  assert.ok(closer, 'the shipped repair closes the recorded call')
  assert.equal(closer.data.error.code, 'TOOL_OUTCOME_UNKNOWN')

  const shipped = closer.data.message
  const ours = syntheticToolResult(X)
  assert.equal(ours.role, shipped.role)
  assert.equal(ours.source.kind, shipped.source.kind)
  assert.equal(ours.source.callId, shipped.source.callId)
  assert.equal(ours.content[0].content[0].text, shipped.content[0].content[0].text)
  assert.equal(OUTCOME_UNKNOWN_TEXT, shipped.content[0].content[0].text)
  assert.equal(ours.content[0].isError, true)
  assert.equal(ours.content[0].toolCallId, X)
})

test('the synthetic result is immutable and named after the call it answers', () => {
  const message = syntheticToolResult(X)
  assert.ok(Object.isFrozen(message))
  assert.ok(Object.isFrozen(message.content))
  assert.equal(message.id, syntheticToolResult(X).id)
  assert.notEqual(message.id, syntheticToolResult(Y).id)
})

// ------------------------------------------------------------- finding them

test('a fully answered transcript has no orphans', () => {
  assert.deepEqual(findOrphanCalls([user('hi'), assistant(X), result(X)]), [])
  assert.deepEqual(findOrphanCalls([]), [])
})

test('an unanswered call is reported with its tool name and declaring message', () => {
  const messages = [user('run it'), assistant(X)]
  const orphans = findOrphanCalls(messages)
  assert.equal(orphans.length, 1)
  assert.equal(orphans[0].callId, X)
  assert.equal(orphans[0].toolName, 'read')
  assert.equal(orphans[0].messageIndex, 1)
})

test('a result anywhere in the transcript settles a call declared earlier', () => {
  // Correlation is by call id, not by position: the ordering that matters is
  // the provider's, and the provider pairs by id.
  const late = [user('hi'), assistant(X), user('meanwhile'), result(X)]
  assert.deepEqual(findOrphanCalls(late), [])
})

test('only the unanswered calls of a mixed transcript are reported, in order', () => {
  const mixed = [user('hi'), assistant(X, Y), result(X), user('again'), assistant(Z), result(Z)]
  const orphans = findOrphanCalls(mixed)
  assert.deepEqual(orphans.map(o => o.callId), [Y])
  assert.equal(orphans[0].messageIndex, 1)

  const two = [user('hi'), assistant(X, Y)]
  assert.deepEqual(findOrphanCalls(two).map(o => o.callId), [X, Y])
})

// ---------------------------------------------------------- building the fix

test('each result is inserted directly after the message that declared it', () => {
  const messages = [user('a'), assistant(X), result(X), user('b'), assistant(Y), user('c')]
  const repaired = answerOrphans(messages, findOrphanCalls(messages))
  assert.equal(repaired.length, messages.length + 1)
  assert.deepEqual(repaired.map(m => m.content[0].type), [
    'text', 'tool-call', 'tool-result', 'text', 'tool-call', 'tool-result', 'text',
  ])
  assert.equal(repaired[5].content[0].toolCallId, Y)
  // The list is rebuilt, never mutated in place: a loop-built request carries a
  // frozen array.
  assert.equal(messages.length, 6)
  assert.notEqual(repaired, messages)
})

test('sibling calls in one message are answered in declaration order', () => {
  const messages = [assistant(X, Y, Z)]
  const repaired = answerOrphans(messages, findOrphanCalls(messages))
  assert.deepEqual(repaired.slice(1).map(m => m.content[0].toolCallId), [X, Y, Z])
})

test('a transcript with no orphans is returned unchanged by the replacer', () => {
  const messages = [user('hi'), assistant(X), result(X)]
  assert.deepEqual(answerOrphans(messages, []), messages)
})

// ------------------------------------------------------------------- policy

/** Collect the log lines a `guard` call produces. */
function runGuard(options, config) {
  const lines = []
  const { outcome, replacement } = guard(
    options,
    { mode: 'repair', maxRepairs: 64, ...config },
    line => lines.push(line),
  )
  return { outcome, replacement, lines }
}

test('a healthy request is passed through untouched and silently', () => {
  const options = request([user('hi'), assistant(X), result(X)])
  const { outcome, replacement, lines } = runGuard(options, {})
  assert.equal(outcome.repaired, false)
  assert.equal(outcome.orphans.length, 0)
  assert.equal(replacement, undefined)
  assert.deepEqual(lines, [])
})

test('the default policy supplies the missing result before dispatch', () => {
  const options = request(POISONED)
  const { outcome, replacement, lines } = runGuard(options, {})
  assert.equal(outcome.repaired, true)
  assert.equal(outcome.mode, 'repair')
  assert.equal(outcome.sessionId, undefined)
  assert.ok(replacement)
  assert.equal(replacement.messages.length, options.messages.length + 1)
  // The request the caller owns is not the request that will be sent.
  assert.equal(options.messages.length, 2)
  assert.notEqual(replacement.messages, options.messages)
  assert.equal(replacement.provider, 'fake')
  assert.match(lines[0], /1 unpaired tool call/)
  assert.match(lines[0], /read\(call-x\)/)
})

test('the log line names the session and counts correctly for several calls', () => {
  const options = { ...request(POISONED), sessionId: 'sess-1' }
  const { lines } = runGuard(options, {})
  assert.match(lines[0], /session "sess-1"/)

  const many = { provider: 'fake', model: 'm', messages: [user('hi'), assistant(X, Y)] }
  assert.match(runGuard(many, {}).lines[0], /2 unpaired tool calls/)
})

test('observe mode reports the poison and leaves the request to fail', () => {
  const options = request(POISONED)
  const { outcome, replacement, lines } = runGuard(options, { mode: 'observe' })
  assert.equal(outcome.repaired, false)
  assert.equal(outcome.mode, 'observe')
  assert.equal(replacement, undefined)
  assert.match(lines[0], /left the request unchanged/)
})

test('the breaker is all-or-nothing at its bound', () => {
  const atBound = { provider: 'fake', model: 'm', messages: [assistant(X, Y), assistant(Z)] }
  assert.equal(runGuard(atBound, { maxRepairs: 3 }).outcome.repaired, true)

  const overBound = { provider: 'fake', model: 'm', messages: [assistant(X, Y, Z)] }
  const { outcome, replacement, lines } = runGuard(overBound, { maxRepairs: 2 })
  assert.equal(outcome.repaired, false)
  assert.equal(replacement, undefined)
  assert.match(lines[0], /exceeds maxRepairs 2/)
  assert.match(lines[0], /passed through unrepaired/)
})

test('the schema defaults agree with the defaults the plugin applies', () => {
  // Two sources of defaults: the loader resolves config through `Config`, and
  // `apply` re-applies them for a hand-built mount. They must not diverge.
  const resolved = Config({})
  assert.equal(resolved.mode, 'repair')
  assert.equal(resolved.maxRepairs, 64)
  assert.equal(Config({ mode: 'observe' }).mode, 'observe')
})

// ------------------------------------------------------ the real waterfall

test('the fixture is refused when the plugin is not mounted', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new PairingAdapter()
  ctx.llm.registerAdapter(['fake'], adapter)

  const chunks = await stream(ctx, request(POISONED))
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'INVALID_REQUEST')
  assert.equal(adapter.calls.length, 1)
  assert.equal(adapter.rejections, 1)
})

test('the provider is handed a paired transcript and answers normally', async () => {
  const { ctx, adapter } = await harness()
  const chunks = await stream(ctx, request(POISONED))
  assert.deepEqual(chunks, HEALTHY_CHUNKS)
  assert.equal(adapter.rejections, 0)
  // Exactly one call reached the backend: the unrepaired original never did,
  // and the replacement re-entering the waterfall did not repair itself again.
  assert.equal(adapter.calls.length, 1)
  assert.deepEqual(danglingCalls(adapter.calls[0].messages), [])
  assert.deepEqual(
    adapter.calls[0].messages.map(m => m.content[0].type),
    ['text', 'tool-call', 'tool-result'],
  )
  assert.equal(adapter.calls[0].messages[2].content[0].isError, true)
})

test('a request the loop built keeps its marker and its replacement does not claim one', async () => {
  const { ctx, adapter } = await harness()
  const options = request(POISONED, { loopBuilt: true })
  assert.ok(Object.isFrozen(options))
  assert.ok(Object.isFrozen(options.messages))
  assert.equal(isAgentLoopRequest(options), true)

  const chunks = await stream(ctx, options)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  // The loop's own object is untouched and still marked; the replacement the
  // plugin dispatched is a different object, so it is not passed off as the
  // loop's log-derived request.
  assert.equal(options.messages.length, 2)
  assert.equal(isAgentLoopRequest(options), true)
  assert.equal(isAgentLoopRequest(adapter.calls[0]), false)
})

test('observe mode leaves the failure visible end to end', async () => {
  const { ctx, adapter } = await harness({ config: { mode: 'observe' } })
  const chunks = await stream(ctx, request(POISONED))
  assert.equal(chunks.at(-1).reason.failure.code, 'INVALID_REQUEST')
  assert.equal(adapter.rejections, 1)
})

test('the breaker passes an oversized poisoned request through to be refused', async () => {
  const { ctx, adapter } = await harness({ config: { maxRepairs: 1 } })
  const chunks = await stream(ctx, {
    provider: 'fake', model: 'm', messages: [user('hi'), assistant(X, Y)],
  })
  assert.equal(chunks.at(-1).reason.failure.code, 'INVALID_REQUEST')
  assert.equal(adapter.rejections, 1)
})

test('a healthy request reaches the backend unchanged, chunk for chunk', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'he' },
    { type: 'text-delta', index: 0, text: 'llo' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const { ctx, adapter } = await harness({ chunks })
  const healthy = [user('hi'), assistant(X), result(X)]
  assert.deepEqual(await stream(ctx, request(healthy)), chunks)
  assert.equal(adapter.calls.length, 1)
  assert.equal(adapter.calls[0].messages, healthy)
})

test('a repaired request still delivers the backend stream intact', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'ok' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const { ctx } = await harness({ chunks })
  assert.deepEqual(await stream(ctx, request(POISONED)), chunks)
})

test('a live session id is carried through the repair', async () => {
  const { ctx, adapter } = await harness()
  await stream(ctx, { ...request(POISONED), sessionId: 'sess-9' })
  assert.equal(adapter.calls[0].sessionId, 'sess-9')
})

test('the guard survives a second poisoned request on the same context', async () => {
  const { ctx, adapter } = await harness()
  await stream(ctx, request(POISONED))
  const chunks = await stream(ctx, request(POISONED))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(adapter.calls.length, 2)
  assert.equal(adapter.rejections, 0)
})

// ------------------------------------------------------- the llm invariant

test('the repaired stream satisfies the shipped LLM stream invariant', async () => {
  const { InvariantRegistry } = await import('@deepseek-ai/dsh-invariants')
  const llmInvariant = await import('@deepseek-ai/dsh-llm/invariant')

  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(LlmRuntime)
  const adapter = new PairingAdapter()
  ctx.llm.registerAdapter(['fake'], adapter)
  await ctx.plugin({ name, inject, apply, Config }, {})
  const unregister = await llmInvariant.apply(ctx)
  assert.equal(typeof unregister, 'function')

  const chunks = await stream(ctx, request(POISONED))
  assert.equal(chunks.at(-1).reason.kind, 'stop')

  // The invariant is live in this harness, not merely installed: a listener
  // that swallows the terminal chunk makes it report.
  ctx.on('llm/stream', (_options, next) => (async function* () {
    for await (const chunk of next()) {
      if (chunk.type === 'finish') return
      yield chunk
    }
  })())
  const broken = [user('hi'), assistant(X), result(X)]
  await assert.rejects(
    async () => { await stream(ctx, request(broken)) },
    /LLM stream ended without a terminal finish chunk/,
  )
})
