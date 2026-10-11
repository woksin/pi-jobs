# Upstream issues (pi runtime) affecting pi-jobs delivery

Draft issue texts for `@earendil-works/pi-coding-agent` (observed on 1.0.3; line numbers below refer to that version). pi-jobs does not
work around these with timers or heuristics. The two races (#1 and #2) have deterministic
reproductions in `test/agent-session.test.ts`; they are skipped and point here. Line references are to
`dist/core/agent-session.js`.

---

## 1. `sendMessage({ triggerTurn: true })` races `AgentSession.prompt()` preparation and loses the user's prompt

**Summary.** `prompt()` awaits input handlers, auth checks, `before_agent_start` handlers
and image normalization before it calls `_runAgentPrompt()` (l. 1481–1595). During that time
`isIdle`/`isStreaming` still report idle (l. 1034–1039). If an extension's
`sendMessage(…, { triggerTurn: true })` arrives in that window, `sendCustomMessage` starts a run
(l. 1767–1772). When the user's prompt reaches `agent.prompt()`, it throws
`Agent is already processing a prompt` and the prompt is lost.

**Minimal repro.**
1. Extension A registers an async `before_agent_start` handler that awaits for 500 ms.
2. Extension B calls `pi.sendMessage({ customType: "x", content: "wake", display: true }, { triggerTurn: true })`
   200 ms after the user submits a prompt.
3. Make the model response to B's message take longer than 300 ms.
4. Result: the user's prompt rejects with "Agent is already processing a prompt".
   Expected: B's message is queued behind the prompt, or vice versa.

**Proposed fix.** Reserve the run atomically when `prompt()` starts preparing, for example with
a `_isPreparingPrompt` flag that counts as "not idle" and makes `sendCustomMessage` take the
follow-up path. Alternatively, provide an atomic extension API such as
`pi.wake(message, { batchKey? })`. It would start a run when idle, join the current run's
follow-ups otherwise, and be serialized with `prompt()`.

---

## 2. Deferred `agent_settled` actions are not revalidated and can run during compaction

**Summary.** A `sendMessage(…, { triggerTurn: true })` issued from an `agent_settled` handler
is pushed to `_deferredSettledActions` (l. 1767–1769). After the emission these actions run
unconditionally (l. 670–693). If another `agent_settled` handler called `ctx.compact()` in the
meantime, compaction is already in progress when the deferred `_runAgentPrompt()` starts an
agent run. `prompt()` itself refuses to start while compacting (l. 1497); the deferred path
does not check.

**Minimal repro (deterministic).**
1. Settings: `compaction: { enabled: false, keepRecentTokens: 1 }`, so the history below can be
   compacted.
2. Extension A (loaded first) has an `agent_settled` handler that calls
   `pi.sendMessage({ customType: "x", content: "wake", display: true }, { triggerTurn: true })`.
   This handler fires once, after the run in step 4.
3. Extension B (loaded after A) has a one-shot `agent_settled` handler that calls
   `ctx.compact()`, and a `session_before_compact` handler that awaits 80 ms so the compaction
   is still in progress for a while.
4. Prompt once, so the transcript has a user message, an assistant tool call, a tool result
   and an assistant reply. Let the run settle (or abort it).
5. Result: A's deferred action calls `_runAgentPrompt()` while `isCompacting === true`, and an
   agent run (model call) happens during the compaction. Expected: the deferred run waits
   until the compaction has finished.

**Proposed fix.** Before running each deferred action, recheck the state: if compacting, defer
it again to the end of compaction (or until idle). Alternatively, route deferred triggers
through the same atomic wake queue as #1.

---

## 3. Custom follow-ups are dropped by `clearQueue()` (Escape) and stranded by `abort()`

**Summary.** `sendCustomMessage` queues a custom follow-up only in the agent
(`agent.followUp`) and not in `_followUpMessages` (l. 1759–1761):
- `clearQueue()` (l. 1846–1853), used by Escape (`interactive-mode.js` l. 2401–2403), clears it
  silently. Only user text is restored to the editor.
- An RPC `abort` leaves it in the agent queue. It is then delivered at the end of whatever run
  happens next, possibly much later.

Extensions cannot observe either case. There is no extension event for queue changes, and
`ctx.hasPendingMessages()` counts only user text.

**Minimal repro.** While a turn streams, call
`pi.sendMessage(m, { triggerTurn: true, deliverAs: "followUp" })`, then
`session.clearQueue(); await session.abort()`. `m` never reaches the transcript and no event
says so.

**Proposed fix.** Any of these would do:
- Return dropped custom messages from `clearQueue()` and emit an extension event (for example
  `queue_cleared { messages }`) so their owners can redeliver.
- Expose `queue_update` to extensions.
- On abort, either flush custom follow-ups as the next run or report them as dropped. Do not
  leave them queued indefinitely.

**pi-jobs' current approach.** It sends completions as a follow-up only from a non-aborted
`agent_end`, where pi consumes them during the subsequent continuation of that run. If a follow-up has no `message_end` confirmation
when the run settles, pi-jobs resends it once through the idle path. A stranded copy that
appears later is replaced in the model context by a one-line stub, keyed on the unique
completion id.

---

## 4. No extension event after compaction state is cleared

**Summary.** `session_compact` is emitted before `_clearManualCompactionState()`
(l. 2205–2223), so `ctx.isIdle()` is still `false` inside the handler. `compaction_end` is
emitted only to session listeners. An extension that must act once compaction is over has to
defer by an event-loop tick (`setImmediate`). That works only if no later `session_compact`
handler is still running, because pi awaits every handler before it clears its state.

**Minimal repro.**
1. Extension A's `session_compact` handler schedules `setImmediate(() => ctx.isIdle() && pi.sendMessage(m, { triggerTurn: true }))`.
   If `ctx.isIdle()` is false at that point, it keeps `m` for later.
2. Extension B (loaded after A) has a `session_compact` handler that awaits 40 ms.
3. Make the history compactable: settings `compaction: { enabled: false, keepRecentTokens: 1 }`
   and at least one completed prompt (user message, assistant tool call, tool result, assistant
   reply), so `/compact` does not stop with "Nothing to compact".
4. Run `/compact`.
5. Result: A's `setImmediate` fires while B is still awaiting, and `isIdle()` is false. pi then
   clears its compaction state, but no further extension event fires. `m` stays undelivered
   while the session sits idle. Expected: an event (or the same event, emitted later) that
   fires once the session is idle again.

**Proposed fix.** Emit `session_compact` after clearing the compaction state. Alternatively,
add an extension event that fires once the session is idle again (see #5).

---

## 5. No reliable post-teardown event for branch summarization (`/tree`)

**Summary.** `navigateTree()` sets `_branchSummaryAbortController` (busy, `isIdle() === false`)
for the whole navigation and clears it in `finally` (l. 3198–3318).
- **Success:** `session_tree` is emitted (l. 3308), but still before the `finally`, so it has
  the same "fires before teardown" problem as #4. pi-jobs handles this case with an
  idle-checked `setImmediate` drain after `session_tree`.
- **Cancelled** (a `session_before_tree` handler returns `{ cancel: true }`), **aborted** or
  **failed** summarization: the function returns or throws through the `finally` without
  emitting any extension event. An extension that deferred work because pi was busy has no
  signal that pi became idle again. More generally, `waitForIdle()` exists only on command
  contexts.

**Minimal repro.**
1. Extension A's `session_before_tree` handler awaits 100 ms and then returns `{ cancel: true }`.
2. Extension B calls `pi.sendMessage(m, { triggerTurn: true })` only when `ctx.isIdle()` is
   true; otherwise it waits for an end event.
3. With at least one completed prompt in the session, start a `/tree` navigation to a
   **different** node than the current leaf (e.g. the first user message), with summarization,
   so `navigateTree()` actually runs. During A's 100 ms, B gets work to send.
4. Result: navigation is cancelled, pi becomes idle, no extension event fires, and `m` waits
   until the user's next prompt. Expected: an event that fires on every path out of the
   navigation.

**Proposed fix.** Add an extension `idle` event, emitted where `_resolveIdleWaitIfIdle()`
resolves, or an `onIdle(cb)` helper on `ExtensionContext`. Alternatively, emit a
`session_tree_end { outcome: "done" | "cancelled" | "aborted" | "error" }` from the `finally`.
