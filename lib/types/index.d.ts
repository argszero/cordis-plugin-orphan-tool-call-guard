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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ContentBlock, GenerateOptions, Message, ToolCallId } from '@deepseek-ai/dsh-llm';
/** This plugin's id: its bundle row and the prefix of its log lines. */
export declare const name = "orphan-tool-call-guard";
/** The LLM runtime the `llm/stream` waterfall and its replacement dispatch need. */
export declare const inject: string[];
/** Plugin configuration. */
export interface Config {
    /**
     * What to do with an outgoing request that still carries an unpaired tool
     * call. `repair` (the default) supplies the missing result and dispatches the
     * replacement; `observe` reports it and lets the request through unchanged,
     * for an operator who wants the failure visible rather than masked.
     */
    mode?: 'repair' | 'observe';
    /**
     * Circuit breaker: the most orphans one request may repair (default 64). The
     * bound is all-or-nothing — a transcript whose remaining calls would stay
     * unpaired is not worth half a repair — so a request above it is reported and
     * passed through untouched.
     */
    maxRepairs?: number;
}
export declare const Config: z<Config>;
/**
 * What the model is told about a call whose outcome was never durably recorded.
 *
 * Copied verbatim from `@deepseek-ai/dsh-session`'s `repair.ts`, so a transcript
 * repaired here reads exactly like one repaired by the crash path: the model
 * already knows this wording, and the two paths cannot drift into disagreeing
 * advice.
 */
export declare const OUTCOME_UNKNOWN_TEXT = "The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.";
/**
 * The part of a message this guard reads.
 *
 * Structural on purpose. `GenerateOptions.messages` is `Message[]` on the 0.1.x
 * lines and `RequestMessage[]` (`Message | RequestUserInput`) from
 * `0.2.1-rc.1` on, and this guard must compile and behave on both without naming
 * a type only one of them has.
 */
export interface WalkableMessage {
    readonly role: string;
    readonly content: readonly ContentBlock[];
    /** Present on a first-class tool result (`0.2.1-rc.1`+). */
    readonly toolCallId?: string;
}
/** One recorded tool call the transcript never answered. */
export interface OrphanCall {
    /** The call id the assistant message declared and no result answers. */
    readonly callId: ToolCallId;
    /** Tool name from the declaring block, for reporting. */
    readonly toolName: string;
    /** Position, in the inspected list, of the assistant message that declared it. */
    readonly messageIndex: number;
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
export declare function findOrphanCalls(messages: readonly WalkableMessage[]): readonly OrphanCall[];
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
export declare function syntheticToolResult(callId: ToolCallId, shape?: 'message' | 'container'): Message;
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
export declare function answerOrphans<T extends WalkableMessage>(messages: readonly T[], orphans: readonly OrphanCall[]): readonly T[];
/** One request's finding, for the log line and for tests. */
export interface GuardOutcome {
    /** Session the request belongs to, when the request carries one. */
    readonly sessionId: string | undefined;
    /** The orphans found, in transcript order. */
    readonly orphans: readonly OrphanCall[];
    /** Policy that ran. */
    readonly mode: 'repair' | 'observe';
    /** Whether the request was replaced. */
    readonly repaired: boolean;
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
export declare function guard(options: GenerateOptions, config: Required<Config>, report: (message: string) => void): {
    outcome: GuardOutcome;
    replacement?: GenerateOptions;
};
/**
 * Mount the guard on the `llm/stream` waterfall.
 * @param ctx - host context.
 * @param config - plugin configuration.
 */
export declare function apply(ctx: Context, config?: Config): void;
