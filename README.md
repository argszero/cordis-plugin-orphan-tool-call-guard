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
        user        tool_result: [error] "The tool call was interrupted after it was
                    recorded, but no result was durably recorded. Its outcome is
                    unknown. Decide whether to retry from the tool semantics..."
```

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
request it looks for tool calls no `tool-result` block answers, and for each one
inserts a synthetic result — the exact message shape and wording
`@deepseek-ai/dsh-session`'s `repair.ts` uses for a crash-interrupted turn —
directly after the assistant message that declared it. If there is nothing to
answer, the request is passed through untouched and nothing is logged.

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

| dsh line | `@deepseek-ai/dsh-llm` |
| --- | --- |
| 0.1.2 prereleases | `0.1.2-rc.1` |
| 0.1.3 prereleases | `0.1.3-alpha.2` |
| 0.1.5 prereleases | `0.1.5-rc.2` |
| 0.1.6 prereleases | `0.1.6-alpha.2` |

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
runs the repaired stream through the shipped `@deepseek-ai/dsh-llm/invariant`.

## License

MIT

## Source discussion

[deepseek-ai/deepseek-harness discussion #7129](https://github.com/deepseek-ai/deepseek-harness/discussions/7129)
