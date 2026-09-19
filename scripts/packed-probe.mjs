/**
 * Packed-artifact probe: install this package's tarball into a clean project and
 * drive it through the real `llm/stream` waterfall on one dsh line.
 *
 * This is the only check that witnesses undeclared dependencies (the package is
 * consumed exactly as npm resolves it), and repeating it per dsh line is what
 * makes the compatibility claim in the README evidence rather than a promise.
 *
 * Prints one line per assertion and exits non-zero on the first failure.
 *
 * It is deliberately NOT part of `npm test`: it imports the PUBLISHED package by
 * name, so it only means anything in a project where the packed tarball is
 * installed. Reproduce a line with:
 *
 *   mkdir probe && cd probe && npm init -y
 *   npm install <path-to-tarball> @deepseek-ai/cordis@^4.0.2 @deepseek-ai/dsh-llm@<version>
 *   cp ../scripts/packed-probe.mjs . && node packed-probe.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter, ToolCallId, createAssistantMessage, createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { name, inject, apply, Config } from '@argszero/cordis-plugin-orphan-tool-call-guard'

const CALL = ToolCallId('call-1')
const messages = [
  createUserMessage({ content: [{ type: 'text', text: 'run it' }], source: { kind: 'user' } }),
  createAssistantMessage({
    content: [{ type: 'tool-call', id: CALL, name: 'read', arguments: '{"path":"a"}' }],
    source: { provider: 'fake', model: 'm' },
  }),
]

class PairingAdapter extends LlmAdapter {
  calls = []
  rejections = 0
  async *stream(options) {
    this.calls.push(options)
    const answered = new Set()
    for (const m of options.messages) for (const b of m.content) if (b.type === 'tool-result') answered.add(b.toolCallId)
    const dangling = []
    for (const m of options.messages) if (m.role === 'assistant') for (const b of m.content) if (b.type === 'tool-call' && !answered.has(b.id)) dangling.push(b.id)
    if (dangling.length > 0) {
      this.rejections += 1
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', message: 'dangling tool call' } } }
      return
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const checks = []
function check(label, ok, detail) {
  checks.push([label, ok])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  (${detail})`}`)
}

async function drive(mount) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new PairingAdapter()
  ctx.llm.registerAdapter(['fake'], adapter)
  if (mount) await ctx.plugin({ name, inject, apply, Config }, {})
  const chunks = []
  for await (const chunk of ctx.llm.stream({ provider: 'fake', model: 'm', messages })) chunks.push(chunk)
  return { chunks, adapter }
}

const version = (await import('@deepseek-ai/dsh-llm/package.json', { with: { type: 'json' } })).default.version
console.log(`--- @deepseek-ai/dsh-llm ${version} ---`)

const bare = await drive(false)
check('plugin unmounted: the fixture is refused', bare.chunks.at(-1).reason.kind === 'error'
  && bare.chunks.at(-1).reason.failure.code === 'INVALID_REQUEST', `rejections=${bare.adapter.rejections}`)

const guarded = await drive(true)
check('plugin mounted: the provider answers normally', guarded.chunks.at(-1).reason.kind === 'stop',
  JSON.stringify(guarded.chunks.at(-1)))
check('exactly one call reached the backend', guarded.adapter.calls.length === 1, `calls=${guarded.adapter.calls.length}`)
if (guarded.adapter.calls.length === 1) {
  const handed = guarded.adapter.calls[0].messages
  check('the backend was handed a paired transcript', handed.length === 3
    && handed[2].content[0].toolCallId === CALL && handed[2].content[0].isError === true,
    handed.map(m => m.content[0].type).join('|'))
}

const failed = checks.filter(([, ok]) => !ok)
console.log(`${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
