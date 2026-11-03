// "Empty the cart, but only if it still is the cart I was told about" (R1-2, S-07 / S-10): the rules behind CartProvider.clearIf. A plain module - it imports nothing, touches no
// storage, no network and no React, and takes its clock and its tasks from the caller - so every rule here is tried without a browser (tests/cart-clear-if.test.ts); what the real
// provider and the real React do with it is tried in a real browser (tests/e2e/cart-clear-if.responsive.spec.ts).
//
// Why this exists. When the server says a payment is verified, the page must empty the cart that was paid for - and ONLY that cart. `clear()` (setItems([])) is not enough:
//   * it empties whatever the cart holds when React gets round to it, also a cart the customer has changed or rebuilt for a NEW purchase in the meantime;
//   * it does not write the saved cart: that is an effect that runs later (one render, then one effect, with no upper bound if the tab is slowed or frozen), so "I called clear()" says
//     nothing about what a reload, or another tab, will find - and the page used to forget the checkout key right after, which could leave a FULL cart with no key (a second order);
//   * nothing says whether it happened.
// So the cart is emptied by a question, not by a command: the caller gives a predicate ("is this the cart that was paid?"), the provider asks it on the LATEST state React has queued
// (not on the last render), empties the cart only if it says yes, and the answer is "cleared" only when the new state has been COMMITTED and the cart saved in this browser reads back
// empty. Every other answer means: the cart may or may not be empty, nobody should act as if it were, and - the rule of S-10 - nothing queued may empty it LATER.
//
// How "nothing queued may empty it later" is kept:
//   * the update queued is an ordinary updater that only READS the state of its question. Once the question is answered or given up it returns its input unchanged, whenever and however
//     many times React runs it (React may run an updater twice, in another order, or long after - a frozen tab runs it when it wakes up);
//   * React may also run an updater at the moment it is queued and keep that answer (the "eager" path, taken when the component has nothing else queued) - and an answer kept that way
//     can not be withdrawn. So the provider queues a tick first (a second, unrelated piece of state), which makes the component busy and sends the updater down the ordinary path;
//   * the provider asks from a fresh task, outside any event and any transition, so the update has the ordinary priority: it is rendered in order with the updates queued before it,
//     in one piece with its commit, not sliced between tasks - there is no render that is half done when the wait runs out.
// None of this is a transaction across tabs: another tab can still save a cart between the read-back and the caller's next step. It narrows that window to a few milliseconds; it
// does not close it (docs/CHECKLIST-PRELANCIO.md, CART-SYNC).

/** What the browser holds at the key of the cart, as the provider reads it (never throws). */
export type PersistedCart = { available: true; raw: string | null } | { available: false }

export type ClearIfResult =
  | { kind: 'cleared' }                                                              // the new state was committed AND the saved cart reads back as the empty list
  | { kind: 'kept'; reason: 'changed' | 'other_tab' }                                // nothing was emptied: the cart is no longer the one asked about / another tab saved a cart this tab has not taken yet
  | { kind: 'unconfirmed'; reason: 'not_ready' | 'not_flushed' | 'not_persisted' }   // nobody knows: no cart read yet / the update did not run in time / it ran but the saved cart is not empty

/** How long a question waits for React to commit before it is given up (and its update made harmless). */
export const CLEAR_IF_WAIT_MS = 2_000
export const CLEAR_IF_WAIT_BOUNDS = { min: 50, max: 30_000 } as const
export function clearIfWaitMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return CLEAR_IF_WAIT_MS
  return Math.min(CLEAR_IF_WAIT_BOUNDS.max, Math.max(CLEAR_IF_WAIT_BOUNDS.min, Math.round(value)))
}

const EMPTY_CART_TEXT = '[]'

export type ClearIfGate = 'go' | 'other_tab' | 'not_ready' | 'unavailable'

/**
 * Is it safe to ask at all? The cart saved in this browser must be the very text THIS tab wrote last: if it is anything else, another tab saved a cart this tab has not taken yet
 * (emptying now would throw that cart away), and if this tab has not saved yet (`lastWritten` is null) there is no cart to speak about.
 */
export function precheckClearIf(input: { persisted: PersistedCart; lastWritten: string | null }): ClearIfGate {
  if (input.lastWritten === null) return 'not_ready'
  if (!input.persisted.available) return 'unavailable'
  return input.persisted.raw === input.lastWritten ? 'go' : 'other_tab'
}

export type ClearIfDeps<T> = {
  /** The text saved at the key of the cart right now. */
  readPersisted: () => PersistedCart
  /** The text this tab saved last (null until it has read the saved cart and written once). */
  lastWritten: () => string | null
  /** Queue the two updates: the tick (first, so that the component is busy) and the updater. */
  dispatch: (update: { tick: number; apply: (prev: readonly T[]) => readonly T[] }) => void
  /** Resolves in a FRESH task: outside any event handler and any transition. */
  nextTask: () => Promise<void>
  setTimer: (run: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

export type ClearIfEngine<T> = {
  /** Ask. `matches` must be pure: it may be called any number of times, on any state React has queued, and must not change it. Never rejects. */
  run: (matches: (items: readonly T[]) => boolean, options?: { waitMs?: number }) => Promise<ClearIfResult>
  /** Called after every commit (an effect of the provider, declared after the one that saves the cart), with the state that was committed and the tick it carries. */
  observe: (commit: { items: readonly T[]; tick: number }) => void
  /** The component goes away: every question is given up and every update still queued becomes harmless. */
  cancelAll: () => void
  /** How many questions are not answered yet. */
  pending: () => number
}

type Question<T> = {
  id: number
  state: 'hopping' | 'armed' | 'spent'
  matches: (items: readonly T[]) => boolean
  // the empty list this question's update returns: ONE list, so that two runs of the updater give React the same answer
  empty: T[]
  timer: unknown
  resolve: (result: ClearIfResult) => void
}

const notFlushed = (): ClearIfResult => ({ kind: 'unconfirmed', reason: 'not_flushed' })
const notPersisted = (): ClearIfResult => ({ kind: 'unconfirmed', reason: 'not_persisted' })

// The caller's predicate, which may throw: true / false, or null when it did not answer.
function ask<T>(matches: (items: readonly T[]) => boolean, items: readonly T[]): boolean | null {
  try { return matches(items) === true } catch { return null }
}

export function createClearIfEngine<T>(deps: ClearIfDeps<T>): ClearIfEngine<T> {
  const live = new Set<Question<T>>()
  let lastId = 0

  function finish(question: Question<T>, result: ClearIfResult) {
    if (question.state === 'spent') return
    question.state = 'spent'
    if (question.timer !== null) {
      try { deps.clearTimer(question.timer) } catch { /* the timer is gone either way */ }
      question.timer = null
    }
    live.delete(question)
    question.resolve(result)
  }

  function run(matches: (items: readonly T[]) => boolean, options?: { waitMs?: number }): Promise<ClearIfResult> {
    const waitMs = clearIfWaitMs(options?.waitMs)
    return new Promise<ClearIfResult>((resolve) => {
      const op: Question<T> = { id: ++lastId, state: 'hopping', matches, empty: [], timer: null, resolve }
      live.add(op)
      const arm = () => {
        try {
          // looked at only now, in the fresh task: what the world is NOW is what counts
          if (op.state !== 'hopping') return
          const gate = precheckClearIf({ persisted: deps.readPersisted(), lastWritten: deps.lastWritten() })
          if (gate === 'other_tab') return finish(op, { kind: 'kept', reason: 'other_tab' })
          if (gate === 'not_ready') return finish(op, { kind: 'unconfirmed', reason: 'not_ready' })
          if (gate === 'unavailable') return finish(op, notPersisted())
          op.state = 'armed'
          // The update. It only reads: the state of its question and the list it is given. Whatever the question's fate, it can not empty a cart after that (see the top of the file).
          const apply = (prev: readonly T[]): readonly T[] => {
            if (op.state !== 'armed') return prev
            if (prev.length === 0) return prev
            return ask(op.matches, prev) === true ? op.empty : prev
          }
          op.timer = deps.setTimer(() => finish(op, notFlushed()), waitMs)
          deps.dispatch({ tick: op.id, apply })
        } catch {
          finish(op, notFlushed())
        }
      }
      try { deps.nextTask().then(arm, () => finish(op, notFlushed())) } catch { finish(op, notFlushed()) }
    })
  }

  // What a commit that carries the update proves. Judged on the state that was COMMITTED and on the cart saved in this browser - never on what the updater did while it ran, which
  // a render that was thrown away can have done too.
  function judge(op: Question<T>, items: readonly T[]): ClearIfResult {
    if (items.length === 0) {
      const saved = deps.readPersisted()
      return saved.available && saved.raw === EMPTY_CART_TEXT ? { kind: 'cleared' } : notPersisted()
    }
    // not empty: either the cart is no longer the one asked about (nothing to clear), or it still is and the update did not take effect
    return ask(op.matches, items) === false ? { kind: 'kept', reason: 'changed' } : notFlushed()
  }

  function observe(commit: { items: readonly T[]; tick: number }) {
    if (live.size === 0) return
    for (const op of [...live]) {
      if (op.state !== 'armed' || commit.tick < op.id) continue
      try { finish(op, judge(op, commit.items)) } catch { finish(op, notFlushed()) }
    }
  }

  function cancelAll() {
    for (const op of [...live]) finish(op, notFlushed())
  }

  return { run, observe, cancelAll, pending: () => live.size }
}
