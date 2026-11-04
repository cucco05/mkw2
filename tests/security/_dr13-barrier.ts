// A deterministic BARRIER for the tests of a race: hold a flow at a named point until the test says go. No sleeps, no timing - the order of the steps is the order of the awaits in the test.
//
//   const held = gate('answer in flight')
//   k.sim.hooks.duringCreate = () => held.pass()          // the provider has created the session; our code has not got the answer yet
//   const request = k.payAgain(started)                    // ... runs until it reaches the barrier
//   await held.arrive()                                    // the test goes on exactly when the request is there
//   await k.customerPays(sessionId)                        // the concurrent event
//   held.release()                                         // the request goes on
//   const answer = await request
//
// A barrier that is never reached, or a flow that is never released, FAILS with the name of the barrier after `timeoutMs` (a test that waits for something that can not happen must not hang).
// `times` is how many arrivals are held (the first `times`; later ones pass at once). Not a test file (its name does not match the test patterns).
export type Gate = {
  readonly name: string
  // the number of flows that have arrived so far
  arrivals(): number
  // called BY the code under test (through a hook): signals the arrival and waits for the release
  pass(): Promise<void>
  // called BY the test: resolves when `count` flows have arrived
  arrive(count?: number): Promise<void>
  // lets every held flow go on; later arrivals pass at once
  release(): void
}

export function gate(name: string, options: { times?: number; timeoutMs?: number } = {}): Gate {
  const times = options.times ?? 1
  const timeoutMs = options.timeoutMs ?? 20_000
  let arrived = 0
  let released = false
  const arrivalWaiters: Array<{ count: number; resolve: () => void }> = []
  const releaseWaiters: Array<() => void> = []
  const wake = () => { for (let i = arrivalWaiters.length - 1; i >= 0; i--) if (arrived >= arrivalWaiters[i].count) arrivalWaiters.splice(i, 1)[0].resolve() }
  return {
    name,
    arrivals: () => arrived,
    async pass() {
      arrived++
      wake()
      if (released || arrived > times) return
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`gate "${name}": a flow was held for ${timeoutMs} ms and nobody released it`)), timeoutMs)
        releaseWaiters.push(() => { clearTimeout(timer); resolve() })
      })
    },
    async arrive(count = 1) {
      if (arrived >= count) return
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`gate "${name}": ${count} flow(s) were expected to arrive within ${timeoutMs} ms, ${arrived} did`)), timeoutMs)
        arrivalWaiters.push({ count, resolve: () => { clearTimeout(timer); resolve() } })
      })
    },
    release() {
      released = true
      for (const go of releaseWaiters.splice(0)) go()
    },
  }
}
