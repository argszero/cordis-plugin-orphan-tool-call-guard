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
 * The repair is `repair.ts`'s synthetic result in `repair.ts`'s own words,
 * inserted directly after the assistant message that declared it and marked
 * `isError`. Its *shape* follows the line: a `tool-result` content block inside a
 * user-role message on the 0.1.x lines, where that is the container a result
 * lives in, and a first-class `role: 'tool'` message from `0.2.1-rc.1` on, where
 * the older container is a hard admission refusal and so could not carry a
 * repair at all. That the outcome is
 * unknown is a fact about the log — it cannot distinguish a call that never
 * reached a tool from one that ran and lost its result — so the text tells the
 * model to decide from the tool's semantics and never to retry blindly. Nothing
 * is written to the session: the durable log keeps telling the truth, and the
 * repair is re-derived on each later request.
 *
 * @module @argszero/cordis-plugin-orphan-tool-call-guard
 */
import z from '@deepseek-ai/schemastery';
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm';
import * as llmRuntime from '@deepseek-ai/dsh-llm';
/** This plugin's id: its bundle row and the prefix of its log lines. */
export const name = 'orphan-tool-call-guard';
/** The LLM runtime the `llm/stream` waterfall and its replacement dispatch need. */
export const inject = ['llm'];
export const Config = z.object({
    mode: z.union([z.const('repair'), z.const('observe')]).default('repair'),
    maxRepairs: z.natural().min(1).default(64),
});
/**
 * What the model is told about a call whose outcome was never durably recorded.
 *
 * Copied verbatim from `@deepseek-ai/dsh-session`'s `repair.ts`, so a transcript
 * repaired here reads exactly like one repaired by the crash path: the model
 * already knows this wording, and the two paths cannot drift into disagreeing
 * advice.
 */
export const OUTCOME_UNKNOWN_TEXT = 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.';
/**
 * Every call id one message answers, whatever shape this line spells them in.
 *
 * Two shapes exist and both must be read, because the guard runs on a line whose
 * vocabulary it does not control:
 *
 * - a `tool-result` **content block** carrying `toolCallId`, inside a user-role
 *   message — the 0.1.x shape;
 * - a **message-level** `toolCallId`, on a first-class `role: 'tool'` message —
 *   the shape from `0.2.1-rc.1` on.
 *
 * Read structurally for the same reason `tool-result` is not named here: the
 * block vocabulary is merge-extensible, so a block carrying a `toolCallId` is an
 * answer whatever its tag says.
 * @param message - one message of the request.
 * @returns the call ids it answers, possibly none.
 */
function answeredBy(message) {
    const ids = [];
    const top = message.toolCallId;
    if (typeof top === 'string')
        ids.push(top);
    for (const block of message.content) {
        const nested = block.toolCallId;
        if (typeof nested === 'string')
            ids.push(nested);
    }
    return ids;
}
/**
 * Whether this line's tool results are first-class `role: 'tool'` messages.
 *
 * Probed from the constructor rather than from a version string, and from what
 * the constructor *produces* rather than from whether it exists: it exists on
 * every line this package declares, but it builds the older user-role container
 * on the 0.1.x lines and a `role: 'tool'` message from `0.2.1-rc.1` on. The
 * shape is what matters, because a request can only carry the vocabulary its own
 * line admits.
 */
const RESULTS_ARE_MESSAGES = (() => {
    const build = llmRuntime.createToolResultMessage;
    if (typeof build !== 'function')
        return false;
    try {
        const probe = build({ callId: 'shape-probe', content: [], isError: false });
        return probe.role === 'tool';
    }
    catch {
        return false;
    }
})();
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
export function findOrphanCalls(messages) {
    const answered = new Set();
    for (const message of messages) {
        for (const callId of answeredBy(message))
            answered.add(callId);
    }
    const orphans = [];
    for (const [messageIndex, message] of messages.entries()) {
        if (message.role !== 'assistant')
            continue;
        for (const block of message.content) {
            if (block.type !== 'tool-call' || answered.has(block.id))
                continue;
            orphans.push({ callId: block.id, toolName: block.name, messageIndex });
        }
    }
    return orphans;
}
/**
 * Build the synthetic result for one orphan in the shape this line admits.
 *
 * The wording is `repair.ts`'s, so a transcript repaired here reads exactly like
 * one repaired by the crash path. The *container* is the line's, and that
 * distinction is the whole point: a `tool-result` content block in interpreted
 * content is a hard admission refusal from `0.2.1-rc.1` on (the durable
 * vocabulary there spells a result as a `role: 'tool'` message), so building the
 * older container on that line would answer the orphan by making the request
 * unsendable — a repair that fails in the same breath.
 *
 * @param callId - the call the result answers.
 * @param shape - which container to build; defaults to the installed line's, and
 *   is spelled out by tests so both arms are pinned wherever they can run.
 * @returns the frozen synthetic tool-result message.
 */
export function syntheticToolResult(callId, shape = RESULTS_ARE_MESSAGES ? 'message' : 'container') {
    const content = [{ type: 'text', text: OUTCOME_UNKNOWN_TEXT }];
    if (shape === 'message') {
        // Built by the line's own constructor so identity, freezing, `source` and
        // the message-level `toolCallId` are the runtime's decisions, not a copy of
        // them that could drift.
        const build = llmRuntime.createToolResultMessage;
        if (build !== undefined) {
            // The constructor mints a fresh identity per call, and this repair is
            // re-derived on *every* request, so a random id would make each request's
            // repaired transcript differ from the last. The id is therefore re-derived
            // from the call, which is the property this plugin documents: the same
            // orphan produces the same message identity every time.
            const built = build({ callId, content, isError: true });
            return freezeMessage({ ...built, id: MessageId(`orphan-tool-result-${callId}`) });
        }
    }
    // Reachable only on a line that still spells a result this way: the block type
    // is gone from the union from `0.2.1-rc.1` on, so the cast documents which
    // lines this branch can run on rather than pretending the type exists.
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
    });
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
export function answerOrphans(messages, orphans) {
    const byMessage = new Map();
    for (const orphan of orphans) {
        const group = byMessage.get(orphan.messageIndex);
        if (group === undefined)
            byMessage.set(orphan.messageIndex, [orphan]);
        else
            group.push(orphan);
    }
    const repaired = [];
    for (const [index, message] of messages.entries()) {
        repaired.push(message);
        for (const orphan of byMessage.get(index) ?? [])
            repaired.push(syntheticToolResult(orphan.callId));
    }
    return repaired;
}
/** A bounded, human-readable list of `toolName(callId)` pairs. */
function describe(orphans, limit = 4) {
    const shown = orphans.slice(0, limit).map(orphan => `${orphan.toolName}(${orphan.callId})`);
    const rest = orphans.length - shown.length;
    return rest <= 0 ? shown.join(', ') : `${shown.join(', ')} and ${rest} more`;
}
/** Plural-correct count of unpaired calls. */
function count(orphans) {
    return `${orphans.length} unpaired tool call${orphans.length === 1 ? '' : 's'}`;
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
export function guard(options, config, report) {
    const orphans = findOrphanCalls(options.messages);
    const sessionId = options.sessionId;
    const where = sessionId === undefined ? 'a request' : `session "${sessionId}"`;
    if (orphans.length === 0) {
        return { outcome: { sessionId, orphans, mode: config.mode, repaired: false } };
    }
    if (orphans.length > config.maxRepairs) {
        report(`${count(orphans)} in ${where} exceeds maxRepairs ${config.maxRepairs}; the guarded request is passed through unrepaired: ${describe(orphans)}`);
        return { outcome: { sessionId, orphans, mode: config.mode, repaired: false } };
    }
    if (config.mode === 'observe') {
        report(`${count(orphans)} in ${where}; mode "observe" left the request unchanged, so the provider will reject it: ${describe(orphans)}`);
        return { outcome: { sessionId, orphans, mode: config.mode, repaired: false } };
    }
    const replacement = {
        ...options,
        messages: [...answerOrphans(options.messages, orphans)],
    };
    report(`${count(orphans)} in ${where}; supplied ${repairNoun(orphans)} before dispatch: ${describe(orphans)}`);
    return { outcome: { sessionId, orphans, mode: config.mode, repaired: true }, replacement };
}
/** Plural-correct count of supplied results. */
function repairNoun(orphans) {
    return `a synthetic result for ${orphans.length === 1 ? 'it' : 'each'}`;
}
/**
 * Mount the guard on the `llm/stream` waterfall.
 * @param ctx - host context.
 * @param config - plugin configuration.
 */
export function apply(ctx, config = {}) {
    const resolved = {
        mode: config.mode ?? 'repair',
        maxRepairs: config.maxRepairs ?? 64,
    };
    /**
     * Requests this plugin already handled, so the replacement it dispatches
     * passes straight through. The identity guard is what keeps the re-dispatch
     * from recursing: the replacement is orphan-free by construction, but a
     * later listener that rewrites requests must still not send this plugin back
     * through its own scan.
     */
    const seen = new WeakSet();
    ctx.on('llm/stream', (options, next) => {
        if (seen.has(options))
            return next();
        const { outcome, replacement } = guard(options, resolved, message => ctx.logger.warn(`orphan tool-call guard: ${message}`));
        if (!outcome.repaired || replacement === undefined)
            return next();
        seen.add(options);
        seen.add(replacement);
        return ctx.llm.stream(replacement);
    }, { prepend: true });
}
