/**
 * Real-serializer probe: drive the guard's repair through the provider's own
 * Messages serializer, on the published provider package.
 *
 * `npm test` mounts the real `llm/stream` waterfall but stands in for the
 * provider backend, so it never reaches the component that actually refuses a
 * poisoned session: `@deepseek-ai/dsh-llm-deepseek`'s
 * `protocols/messages/serialize.ts`, which throws `LlmError('…', 'INVALID_REQUEST')`
 * while building the request body, before any socket is opened. The repair is
 * only worth anything if it satisfies that serializer, so this probe asserts
 * exactly that.
 *
 * The whole instrument is one stub: `globalThis.fetch` records the call and then
 * throws. That makes the two outcomes disjoint and both observable —
 * a rejected request records zero calls, an accepted one records one call whose
 * captured body is the real wire JSON.
 *
 * Prints the full evidence as JSON and exits non-zero if any assertion fails.
 *
 * It is deliberately NOT part of `npm test`: it needs the provider package
 * installed (`npm install` does that via devDependencies) and a build first.
 * Reproduce with:
 *
 *   npm install && npm run build && npm run probe:serializer
 */
import { guard, findOrphanCalls, OUTCOME_UNKNOWN_TEXT } from '../lib/index.js'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'

const failures = []
let checks = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) return
  failures.push(detail === undefined ? label : `${label} — ${detail}`)
}

/* ---------------------------------------------------------------- instrument */

const realFetch = globalThis.fetch
let calls = []

globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: init?.body })
  throw new Error(`PROBE_SENTINEL_FETCH_REACHED ${String(url)}`)
}

/* ------------------------------------------------------------------- adapter */

const connection = resolveAdapterOptions({
  protocol: 'messages',
  baseURL: 'https://probe.invalid/v1',
  thinking: 'disabled',
})

/**
 * The same adapter over the other shipped protocol. #7386 reports the failure
 * from the chat-completions hop, where the serializer performs NO pairing check
 * — so the request is built and dispatched, and only the provider refuses it.
 * That makes this arm's evidence the captured wire body rather than a throw.
 */
const chatConnection = resolveAdapterOptions({
  protocol: 'chat-completions',
  baseURL: 'https://probe.invalid/v1',
  thinking: 'disabled',
})

const MODEL = connection.models[0].id
const CHAT_MODEL = chatConnection.models[0].id

function makeAdapter(chat = false) {
  return new DeepSeekAdapter({
    options: () => chat ? chatConnection : connection,
    resolveApiKey: async () => 'probe-key-not-a-secret',
    resolveUserId: () => 'probe-user',
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  })
}

/** Drive one request through the real adapter; report the outcome and whether the wire was reached. */
async function send(options, chat = false) {
  calls = []
  try {
    for await (const _chunk of makeAdapter(chat).stream(options)) void _chunk
    return { outcome: 'stream-completed', code: undefined, message: undefined, calls: [...calls] }
  } catch (error) {
    return { outcome: 'threw', code: error?.code, message: error?.message, calls: [...calls] }
  }
}

/* ------------------------------------------------------------------ fixtures */

const user = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const assistantCall = (id, callId, name = 'read_file') => ({
  id,
  role: 'assistant',
  source: { kind: 'model' },
  content: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify({ path: 'notes.md' }) }],
})
const toolResult = (id, callId) => ({
  id,
  role: 'user',
  source: { kind: 'tool', callId },
  content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'file contents' }] }],
})
const request = messages => ({ provider: 'deepseek-official', model: MODEL, messages })

/**
 * The poisoned assistant message as the surface really derives it: the report's
 * seq 17 `assistant/message`, reconstructed as a log event and run through the
 * shipped `deriveEventMessage`. Its sibling `tool/call` at seq 18 is trace data.
 *
 * Deriving it rather than hand-writing it is the point — the claim under test is
 * about the transcript the loop really sends, so the fixture has to be the one
 * the harness produces, not a lookalike. Note this also covers the report's
 * second shape for free: calls that never reached the scheduler have no
 * `tool/call` event at all, but they are still blocks in this same message.
 */
function derivedPoison() {
  return deriveEventMessage({
    type: 'assistant/message',
    seq: 17,
    time: 0,
    data: { turn: 1, step: 1, message: assistantCall('a1', 'call_1') },
  })
}

const traceOnlyCall = deriveEventMessage({ type: 'tool/call', seq: 18, time: 0, data: { turn: 1, step: 1 } })

/**
 * The two shapes the serializer partitions separately: an orphan followed by a
 * later turn, and an orphan the history ends on. They throw from different
 * lines, and one repair shape has to satisfy both.
 */
const SHAPES = {
  'mid-history-unpaired': [
    user('u1', 'read the file'),
    derivedPoison(),
    user('u2', 'what happened?'),
  ],
  'history-ends-unpaired': [
    user('u1', 'read the file'),
    derivedPoison(),
  ],
}

/** Find the message carrying `tool_use` and the message immediately after it. */
function pairing(body) {
  const messages = JSON.parse(body).messages
  const at = messages.findIndex(entry => entry.content.some(block => block.type === 'tool_use'))
  return { messages, at, next: at === -1 ? undefined : messages[at + 1] }
}

/* -------------------------------------------------------------------- arms */

const report = { model: MODEL, shapes: {}, control: {}, observe: {} }

/* The fixture must be the harness's own derivation, and the report's claim that
 * `tool/call` is trace rather than surface must hold — both are load-bearing for
 * reading the arms below. */

const sample = derivedPoison()
report.fixture = {
  derivedIsMessage: sample !== null,
  carriesToolCall: sample?.content?.some(block => block.type === 'tool-call' && block.id === 'call_1') === true,
  traceOnlyCallIsNotSurface: traceOnlyCall === null,
}
check('[fixture] the poisoned assistant message is the surface\'s own derivation', report.fixture.derivedIsMessage && report.fixture.carriesToolCall)
check('[fixture] a tool/call event derives no surface message', report.fixture.traceOnlyCallIsNotSurface)

// The synthetic text must be repair.ts's own wording, not a paraphrase of it.
report.wording = { length: OUTCOME_UNKNOWN_TEXT.length, beginsWith: OUTCOME_UNKNOWN_TEXT.slice(0, 40) }
check('[fixture] the synthetic text is non-empty canonical wording', OUTCOME_UNKNOWN_TEXT.length === 313, `${OUTCOME_UNKNOWN_TEXT.length} chars`)

for (const [name, messages] of Object.entries(SHAPES)) {
  const record = {}
  report.shapes[name] = record

  // Arm 1 — the transcript as the loop would really send it.
  const poisoned = await send(request(messages))
  record.poisoned = { outcome: poisoned.outcome, code: poisoned.code, message: poisoned.message, fetchCalls: poisoned.calls.length }
  check(`[${name}] poisoned request is refused by the real serializer`, poisoned.outcome === 'threw' && poisoned.code === 'INVALID_REQUEST', `got ${poisoned.outcome}/${poisoned.code}`)
  check(`[${name}] refusal happens before the wire`, poisoned.calls.length === 0, `${poisoned.calls.length} fetch call(s)`)

  // Arm 2 — the same transcript through the guard.
  const notes = []
  const { outcome, replacement } = guard(request(messages), { mode: 'repair', maxRepairs: 64 }, note => notes.push(note))
  record.guard = { orphans: outcome.orphans.map(orphan => ({ callId: orphan.callId, toolName: orphan.toolName })), repaired: outcome.repaired, note: notes[0] }
  check(`[${name}] guard finds exactly the unpaired call`, outcome.orphans.length === 1, `${outcome.orphans.length} orphan(s)`)
  check(`[${name}] guard builds a replacement`, outcome.repaired === true && replacement !== undefined)

  const repaired = await send(replacement)
  record.repaired = { outcome: repaired.outcome, code: repaired.code, message: repaired.message, fetchCalls: repaired.calls.length }
  check(`[${name}] repaired request is no longer an INVALID_REQUEST`, repaired.code !== 'INVALID_REQUEST', `code ${repaired.code}`)
  check(`[${name}] repaired request reaches the wire`, repaired.calls.length === 1, `${repaired.calls.length} fetch call(s)`)

  if (repaired.calls.length === 1) {
    const { messages: wire, at, next } = pairing(repaired.calls[0].body)
    record.wire = {
      url: repaired.calls[0].url,
      messageCount: wire.length,
      assistantAt: at,
      answersImmediately: next?.content?.some(block => block.type === 'tool_result' && block.tool_use_id === 'call_1') === true,
      carriesUnknownText: JSON.stringify(next ?? {}).includes(OUTCOME_UNKNOWN_TEXT.slice(0, 60)),
    }
    check(`[${name}] the synthetic result answers the call in the very next wire message`, record.wire.answersImmediately)
    check(`[${name}] the synthetic result carries the outcome-unknown text`, record.wire.carriesUnknownText)
    check(`[${name}] no tool_use is left unanswered`, wire.every((entry, index) => entry.content.every(block => block.type !== 'tool_use' || wire[index + 1]?.content.some(other => other.type === 'tool_result' && other.tool_use_id === block.id))))
  }
}

/* Closed-turn arm — #7386's shape: the dangler sits in an already-closed turn
 * with later turns after it, which is where a crash-tail repair stops looking.
 * The report's excerpt is exactly this: seq 3816 `tool/call`, seq 3818
 * `turn/end` error, then turns 4-5, and only much later the failing request. */

const closedTurnLog = [
  { type: 'user/message', seq: 16, time: 0, data: user('u1', 'read the file') },
  { type: 'assistant/message', seq: 17, time: 0, data: { turn: 1, step: 1, message: assistantCall('a1', 'call_1') } },
  { type: 'tool/call', seq: 18, time: 0, data: { turn: 1, step: 1 } },
  { type: 'step/end', seq: 19, time: 0, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: 20, time: 0, data: { turn: 1, reason: { kind: 'error' } } },
  { type: 'user/message', seq: 21, time: 0, data: user('u2', 'what happened?') },
]

const closedSurface = closedTurnLog.map(event => deriveEventMessage(event)).filter(message => message !== null)

report.closedTurn = {
  logEvents: closedTurnLog.length,
  surfacedMessages: closedSurface.length,
  surfacedTypes: closedSurface.map(message => message.role),
  boundariesAreTrace: closedTurnLog.filter(event => ['tool/call', 'step/end', 'turn/end'].includes(event.type)).every(event => deriveEventMessage(event) === null),
}
check('[closed turn] the log is balanced — every boundary event derives no surface message', report.closedTurn.boundariesAreTrace)
const poisonedAt = closedSurface.findIndex(message => message.role === 'assistant' && message.content.some(block => block.type === 'tool-call'))
check('[closed turn] a closed turn still surfaces its poisoned assistant message', poisonedAt !== -1)
check('[closed turn] a later turn follows the dangler — it is mid-history, not the tail', poisonedAt !== -1 && closedSurface.length > poisonedAt + 1)

const closedGuard = guard(request(closedSurface), { mode: 'repair', maxRepairs: 64 }, () => {})
report.closedTurn.repaired = closedGuard.outcome.repaired
check('[closed turn] the guard repairs a dangler inside a closed turn', closedGuard.outcome.repaired === true)

/* chat-completions arm — #7386's hop. This serializer performs no pairing
 * check, so nothing local refuses the request and the evidence has to be the
 * captured wire body. The provider's own criterion, quoted from the report:
 * "An assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'." */

function ccPairing(body) {
  const messages = JSON.parse(body).messages
  const at = messages.findIndex(entry => Array.isArray(entry.tool_calls) && entry.tool_calls.some(call => call.id === 'call_1'))
  const next = at === -1 ? undefined : messages[at + 1]
  return {
    messages,
    at,
    declaredCalls: at === -1 ? [] : messages[at].tool_calls.map(call => call.id),
    nextRole: next?.role,
    answersImmediately: next?.role === 'tool' && next?.tool_call_id === 'call_1',
  }
}

const ccRequest = messages => ({ provider: 'deepseek-official', model: CHAT_MODEL, messages })
const ccPoisoned = await send(ccRequest(closedSurface), true)
report.chatCompletions = {
  poisoned: { outcome: ccPoisoned.outcome, code: ccPoisoned.code, fetchCalls: ccPoisoned.calls.length },
}
check('[chat] the local serializer does NOT catch the dangler (unlike the messages protocol)', ccPoisoned.calls.length === 1, `${ccPoisoned.calls.length} fetch call(s)`)

if (ccPoisoned.calls.length === 1) {
  const body = ccPairing(ccPoisoned.calls[0].body)
  report.chatCompletions.poisonedWire = { url: ccPoisoned.calls[0].url, declaredCalls: body.declaredCalls, nextRole: body.nextRole, answersImmediately: body.answersImmediately, messageCount: body.messages.length }
  check('[chat] the unguarded wire body violates the provider contract the report quotes', body.answersImmediately === false, `next role ${body.nextRole}`)
}

const ccRepaired = await send(ccRequest(closedGuard.replacement.messages), true)
report.chatCompletions.repaired = { outcome: ccRepaired.outcome, code: ccRepaired.code, fetchCalls: ccRepaired.calls.length }
if (ccRepaired.calls.length === 1) {
  const body = ccPairing(ccRepaired.calls[0].body)
  report.chatCompletions.repairedWire = { url: ccRepaired.calls[0].url, declaredCalls: body.declaredCalls, nextRole: body.nextRole, answersImmediately: body.answersImmediately, messageCount: body.messages.length }
  check('[chat] the guarded wire body answers the call immediately', body.answersImmediately === true, `next role ${body.nextRole}`)
  check('[chat] the guarded body still carries the declared call — answered, not dropped', body.declaredCalls.includes('call_1'))
}

/* Control arm — a healthy transcript must not be touched, and must still ship. */

const healthy = request([user('u1', 'read the file'), assistantCall('a1', 'call_1'), toolResult('t1', 'call_1'), user('u2', 'thanks')])
const healthyOutcome = guard(healthy, { mode: 'repair', maxRepairs: 64 }, () => {})
const healthySent = await send(healthy)
report.control = { orphans: findOrphanCalls(healthy.messages).length, repaired: healthyOutcome.outcome.repaired, outcome: healthySent.outcome, code: healthySent.code, fetchCalls: healthySent.calls.length }
check('[control] a paired transcript yields no orphans', report.control.orphans === 0)
check('[control] a paired transcript is passed through unchanged', healthyOutcome.outcome.repaired === false && healthyOutcome.replacement === undefined)
check('[control] a paired transcript reaches the wire', healthySent.calls.length === 1)

/* Observe arm — reporting without repairing must leave the request refused. */

const observe = guard(request(SHAPES['history-ends-unpaired']), { mode: 'observe', maxRepairs: 64 }, note => { report.observe.note = note })
const observeSent = await send(observe.replacement ?? request(SHAPES['history-ends-unpaired']))
report.observe = { ...report.observe, repaired: observe.outcome.repaired, code: observeSent.code, fetchCalls: observeSent.calls.length }
check('[observe] observe mode does not repair', observe.outcome.repaired === false)
check('[observe] observe mode leaves the real refusal intact', observeSent.code === 'INVALID_REQUEST' && observeSent.calls.length === 0)

globalThis.fetch = realFetch

console.log(JSON.stringify(report, null, 2))
console.log(`\nchecks: ${checks}, failures: ${failures.length}`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)
