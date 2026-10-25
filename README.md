# @argszero/cordis-plugin-orphan-tool-call-guard

A cordis plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)
that makes a session usable again after a recorded tool call lost its result.

```
input:  user        "delete the stale branch"
        assistant   tool_calls: [git_branch(delete) id=call-1]
                    ← the tool scheduler's `prepare` threw; no tool/result was ever recorded
        turn/end    { kind: 'error' }
```

From that point the durable transcript declares a tool call nothing answers. The
tool-call block travels into **every later request**, and providers refuse an
assistant `tool_calls` block with no matching result — permanently, for every
subsequent message, with no way out from inside the product. The session is dead,
and the failure belongs to the *request*, not to the turn that produced it.

Mounted, this plugin supplies the missing result to the outgoing request:

```
input:  user        "delete the stale branch"
        assistant   tool_calls: [git_branch(delete) id=call-1]
        tool        toolCallId: call-1  [error] "The tool call was interrupted after
                    it was recorded, but no result was durably recorded. Its outcome
                    is unknown. Decide whether to retry from the tool semantics..."
```

The fourth line is the shape from `0.2.1-rc.1` on, where a tool result is a
message of its own. On the 0.1.x lines the same text travels as a `tool-result`
content block inside a user-role message, because that is the only container a
result has there. The guard builds whichever shape the installed line admits.

The replacement is re-derived on every later request, so the session stays usable
from then on. Nothing is written to the session log.

## Install

```sh
npm install @argszero/cordis-plugin-orphan-tool-call-guard
```

In a `cordis.yml` / profile bundle, add the row (or merge this package's
`cordis.patch.yml`, which contains the same one):

```yaml
- insert:
    - id: orphan-tool-call-guard
      name: '@argszero/cordis-plugin-orphan-tool-call-guard'
```

No configuration is required. `mode: observe` reports the poison and leaves the
request failing, and `maxRepairs` (default 64) is an all-or-nothing circuit
breaker for a transcript that is not worth a partial repair.

## What it does, precisely

The plugin listens on the documented `llm/stream` waterfall. For each outgoing
request it collects every call id the transcript answers — a message-level
`toolCallId` on a first-class `role: 'tool'` message, or a nested one on a
`tool-result` content block — and treats every assistant `tool-call` block whose
id is in neither set as an orphan. Detection reads the vocabulary structurally
rather than assuming one spelling: from `0.2.1-rc.1` on a `tool-result` block is
no longer how a result is spelled, so a set collected from blocks alone stays
empty there and every already-answered call would look like a poison.

Each orphan gets one synthetic result, inserted directly after the assistant
message that declared it, in the wording `@deepseek-ai/dsh-session`'s `repair.ts`
uses for a crash-interrupted turn. The *container* follows the installed line:
the line's own `createToolResultMessage`, which builds a `role: 'tool'` message
where that is the admitted shape and the user-role container before it. Which
shape applies is decided by building one and reading its role — not by a version
string, and not by whether the constructor exists, because it exists on every
line this package declares. The synthetic message's id is re-derived from the
call id, so the same orphan keeps the same identity on every request instead of
minting a new one each time. If there is nothing to answer, the request is
passed through untouched and nothing is logged.

## What it does not do, and why

**It does not write the result into the session log.** The package-owned session
invariant (`@deepseek-ai/dsh-session/invariant`) requires an appended `tool/result`
to name the **currently open** turn and step *and* to correlate with a `tool/call`
recorded **in that step**; the only escape from the second requirement is the
`TOOL_NOT_STARTED` code, which asserts the opposite of what this log shows. A
poisoned session's turn closed long ago, so there is no open step to name and the
pending-call set was cleared at `step/end`. No post-step writer can append that
event — which is also why the shipped crash-repair path only closes a log whose
last turn is still open, and why it reads a closed turn as "balanced log, nothing
to close".

**It does not repair the failing step.** The durable fix belongs to the writer
that still holds the step open: the tool call is appended before the scheduler is
asked to prepare it, so a `prepare` that throws leaves the call recorded and the
step still open. That fix is upstream's.

**It does not keep the log-reconstruction invariant's guarantee for the repaired
request.** A request assembled by `dsh-agent-loop` is marked by object identity,
and the agent-loop invariant validates only marked requests. The replacement this
plugin dispatches is a different object, so it is honestly not passed off as the
loop's log-derived request — and its transcript is, by construction, not equal to
`session.deriveMessages()`. That is the trade this plugin makes: a session that
cannot talk to any provider, or a request that carries one synthetic message the
log does not have. The synthetic message says what it is; the log keeps telling
the truth.

Listeners earlier in the `llm/stream` waterfall see two dispatches for a repaired
request: the original (which never reaches a provider) and the replacement. That
is inherent to replacing a request at a waterfall whose `next()` takes no
arguments.

## Configuration

| option | default | meaning |
| --- | --- | --- |
| `mode` | `repair` | `repair` supplies the missing results; `observe` reports them and lets the request go through unchanged |
| `maxRepairs` | `64` | the most orphans one request may repair; above it the request is reported and passed through untouched |

## Compatibility

| dsh line | `@deepseek-ai/dsh-llm` measured | suite |
| --- | --- | --- |
| 0.1.2 prereleases | `0.1.2-rc.1` | 36 / 36 |
| 0.1.3 prereleases | `0.1.3-alpha.2` | 36 / 36 |
| 0.1.5 prereleases | `0.1.5-alpha.1` | 36 / 36 |
| 0.1.6 prereleases | `0.1.6-alpha.1` | 36 / 36 |
| 0.2.1 prereleases | `0.2.1-rc.1`, `rc.2`, `rc.3` | 35 pass, 1 self-skipped |

Each row is a separate install of that line's published packages with this
repository's `test/` copied in; the counts are what `node --test` printed against
that install, not an intention. The peer range admits those lines and nothing
outside them.

**The 0.2.1 skip is a stated capability gap, not a failure.** One test drives a
repaired stream through the shipped session invariant, whose home on the older
lines is `@deepseek-ai/dsh-session/invariant`. `@deepseek-ai/dsh-llm` does not
export `./invariant` on the 0.2.1 line, and `@deepseek-ai/dsh-invariants` is
published only up to `0.2.0-rc.2` — no artifact of that line can state the rule,
so the test reports `SKIP` with that reason rather than passing quietly.

**From `0.2.1-rc.1` on, a tool result is a message, not a block.** There a result
is a first-class `role: 'tool'` message carrying a message-level `toolCallId`, and
a `tool-result` *content block* in an interpreted slot is refused at admission.
The guard detects answers in both vocabularies and builds its synthetic result in
the one the installed line admits, so this single package repairs both — and on
the newer line it never puts a `tool-result` block on the wire, which is asserted.

The plugin needs the `llm/stream` waterfall, `GenerateOptions.sessionId`, and the
`llm` service — all present across those lines. `@deepseek-ai/cordis` is a peer
dependency.

## Tests

```sh
npm test
```

The suite mounts the real `@deepseek-ai/cordis` context, the real
`@deepseek-ai/dsh-llm` service and its real `llm/stream` waterfall. The only
stand-in is the provider backend, because a test cannot call a provider — and it
enforces the one rule the repair exists for. The control test (plugin unmounted)
proves the fixture really is refused, the synthetic message is checked against
`interruptedTurnClosers()` rather than a copy of its wording, and the last test
runs the repaired stream through the shipped session invariant.

The suite carries shape-neutral arms, because the vocabulary moves under it:
detection is asserted against both spellings wherever the line can produce them,
the built container is pinned per line, and on a line whose results are messages a
repaired request is asserted to carry **no** `tool-result` block — exactly the
block the previous synthesis would have produced, and the one the newer line
refuses. On the older lines that block *is* the container, so the assertion does
not apply and does not run.

`test/packaging.spec.mjs` guards the artifact rather than the behaviour, since
every one of its failures is silent: the built `lib/` must not be hidden by any
ignore file (`.gitignore` and `.npmignore` are each checked when present, because
a copy of the tree may carry neither), the file list must carry the entry point,
the declarations and the mount patch, that patch must register
`id: orphan-tool-call-guard` and name this package, and every bare import in the
shipped code must be declared for a consumer rather than only for this checkout.

### Against the provider's own serializer

```sh
npm run build && npm run probe:serializer
```

That suite stands in for the provider backend, so it never reaches the component
that actually refuses a poisoned session: the provider package's Messages
serializer, which throws `INVALID_REQUEST` while building the request body,
before a socket is opened. `scripts/probe-real-serializer.mjs` closes that gap
by driving the published `@deepseek-ai/dsh-llm-deepseek` adapter over both
unpaired shapes — an orphan followed by a later turn, and an orphan the history
ends on, which the serializer refuses from two different lines — with
`globalThis.fetch` stubbed to record the call and then throw. Each shape is
asserted twice: unguarded it is refused with zero calls made, guarded the same
transcript is built and dispatched, and the captured body is checked to answer
the call in the very next wire message.

It also covers the other shipped protocol, where the evidence has to be different.
The chat-completions serializer performs **no** pairing check, so nothing local
refuses the request: the probe confirms the poisoned transcript is built and
dispatched (one fetch call, against zero on the messages protocol), and that the
captured body carries an assistant `tool_calls` followed by a `role: 'user'`
message — the shape a chat-completions provider rejects with 400. Guarded, the
same body answers each `tool_call_id` with a `role: 'tool'` message immediately
after the assistant turn, which is that provider's stated requirement.

The dangling call in that arm sits **inside an already-closed turn with later
turns after it**, the shape a crash-tail repair cannot reach: the probe derives
the transcript from a log whose `tool/call`, `step/end` and `turn/end` events all
project to no surface message, so `interruptedTurnClosers` would see a balanced
log and emit nothing. Because the guard correlates over assistant blocks rather
than over log events, a closed turn is not a special case for it.

## License

MIT

## Source discussion

[deepseek-ai/deepseek-harness discussion #7129](https://github.com/deepseek-ai/deepseek-harness/discussions/7129)
