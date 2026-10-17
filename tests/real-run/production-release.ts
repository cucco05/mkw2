// REAL-SERVER CHECK (not part of `npm test`), step 4.6, S4: the release of orders to production through a REAL `next start` (production mode) over real HTTP, with
//   * cookies, `Origin` headers and bearer secrets exactly as a browser / PrintLab would send them,
//   * the throw-away test database,
//   * PrintLab and StockWorks replaced by LOCAL fake HTTP servers started by this script (nothing real is contacted: no printer, no PrintLab, no StockWorks, no Stripe).
//
//   npm run build   (with CURRENCY=EUR NEXT_PUBLIC_CURRENCY=EUR)
//   SEC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mkw_sectest node --import tsx tests/real-run/production-release.ts
//
// What it shows: an order that is not released (awaiting payment, being confirmed, payment page open, payment under review, outside order, "paid" with no proof) can
// not be moved, assigned, sent to PrintLab or picked by the automatic queue, whatever the request says, and PrintLab hears nothing; what PrintLab itself says is recorded
// without moving the order; a released order goes through exactly once; a request from another site is refused before anything happens; the callbacks keep working
// with their secret and without a session; a call whose outcome is unknown is never repeated and is only settled by the record itself; the administrator pages
// explain it; a customer never reads why. Exit code 1 when anything is not as expected.
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { db } from '../security/_harness' // (sets the environment of the throw-away database: it must be the first import that touches the app)
import { makeOrder, releasedSpec, setup, state, teardown, world } from '../security/_release-fixtures'
import { readJournal } from '../../lib/external-effects'

const jwt = createRequire(`${process.cwd()}/package.json`)('jsonwebtoken')
const PORT = Number(process.env.PORT || 3097)
const BASE = `http://127.0.0.1:${PORT}`
const SECRET = 'printlab-real-run-secret'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const sign = (id: string) => jwt.sign({ sub: id }, process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '1d' })

let server: ChildProcess | null = null
async function start() {
  server = spawn('node_modules/.bin/next', ['start', '-p', String(PORT)], {
    env: {
      ...process.env, NODE_ENV: 'production', PORT: String(PORT), BASE_URL: 'https://shop.example.test', HOSTED_CHECKOUT_ENABLED: 'true', TRUSTED_PROXY_HOPS: '1',
      STRIPE_SECRET_KEY: 'sk_test_FAKE_not_a_real_key_000000000000', STRIPE_WEBHOOK_SECRET: 'whsec_FAKE_release', TAX_MODE: 'none', CURRENCY: 'EUR', NEXT_PUBLIC_CURRENCY: 'EUR',
      PRINTLAB_BASE_URL: state.printLab.url, PRINTLAB_WEBHOOK_SECRET: SECRET, PRINTLAB_SUBMIT_TIMEOUT_MS: '1500',
      STOCKWORKS_BASE_URL: state.stockWorks.url, STOCKWORKS_USERNAME: 'sectest', STOCKWORKS_PASSWORD: 'sectest', STOCKWORKS_TIMEOUT_MS: '1500',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/robots.txt`)).ok) return } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error('the server did not start')
}
async function stop() { if (server) { server.kill('SIGTERM'); await sleep(800); server = null } }

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`PASS  ${name}`) } else { failed++; console.log(`FAIL  ${name}${detail === undefined ? '' : ` - ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`) }
}

type Who = 'admin' | 'staff' | 'customer' | null
async function call(method: string, path: string, opts: { who?: Who; origin?: string | null; body?: unknown; headers?: Record<string, string> } = {}) {
  const tokens: Record<string, string> = { admin: sign(state.adminId), staff: sign(state.staffId), customer: sign(state.customerId) }
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9', ...(opts.headers ?? {}) }
  if (opts.who) headers.Cookie = `mwv2_token=${tokens[opts.who]}`
  if (opts.origin !== null) headers.Origin = opts.origin ?? BASE
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: 'manual' })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* a page */ }
  return { status: res.status, json, text }
}
const admin = (method: string, path: string, body?: unknown, extra: { origin?: string | null; who?: Who } = {}) => call(method, path, { who: extra.who ?? 'admin', body, origin: extra.origin })
const callback = (orderId: string, status: string, secret: string | null = SECRET) => call('POST', '/api/printlab/jobs/job_real_1', {
  origin: null, body: { status, source_order_id: orderId }, headers: secret ? { Authorization: `Bearer ${secret}` } : {},
})

async function row(id: string) { const prisma = await db(); return prisma.printOrder.findUniqueOrThrow({ where: { id } }) }
async function ownedByCustomer(orderId: string) { const prisma = await db(); await prisma.printOrder.update({ where: { id: orderId }, data: { userId: state.customerId } }) }

;(async () => {
  await setup() // users, the shop model, fake Stripe for this process, and the two fake outside services
  await world()
  const prisma = await db()
  const printer = await prisma.printer.create({ data: { name: 'FAKE A1 mini' } })
  await start()

  // ---- 1. orders that are not released ----------------------------------------------------------------------------------------------------
  const held: Array<{ name: string; code: string; spec: Parameters<typeof makeOrder>[0] }> = [
    { name: 'awaiting payment', code: 'PAYMENT_NOT_VERIFIED', spec: { status: 'awaiting_payment', paymentStatus: 'pending' } },
    { name: 'payment being confirmed', code: 'PAYMENT_PROCESSING', spec: { status: 'awaiting_payment', paymentStatus: 'processing', attempts: ['processing'] } },
    { name: 'payment page still open', code: 'PAYMENT_ACTIVE', spec: { status: 'awaiting_payment', paymentStatus: 'pending', attempts: ['open'] } },
    { name: 'payment under review (dispute)', code: 'PAYMENT_ON_HOLD', spec: releasedSpec({ reason: 'dispute' }) },
    { name: 'outside order nobody checked', code: 'EXTERNAL_ORDER_NOT_AUTHORIZED', spec: { status: 'awaiting_review', paymentStatus: 'pending', reason: 'external_order' } },
    { name: '"paid" with no proof', code: 'PAYMENT_UNPROVEN', spec: { status: 'queued', paymentStatus: 'paid' } },
  ]
  for (const entry of held) {
    const order = await makeOrder(entry.spec, { status: entry.spec.status === 'awaiting_payment' || entry.spec.status === 'awaiting_review' ? 'queued' : undefined })
    const id = order.id
    const before = await row(id)
    const submissions = state.printLab.submissions().length
    const moved = await admin('PATCH', `/api/admin/orders/${id}/status`, { status: 'printing' })
    check(`[${entry.name}] moving it into production is refused (${entry.code})`, moved.status === 409 && moved.json?.code === entry.code, { status: moved.status, body: moved.json })
    const authorized = await admin('PATCH', `/api/admin/orders/${id}/status`, { status: 'printing', authorizeUnpaid: true, authorizationReason: 'agreed on the phone with the customer' })
    const mayAuthorize = ['PAYMENT_NOT_VERIFIED', 'PAYMENT_UNPROVEN', 'EXTERNAL_ORDER_NOT_AUTHORIZED'].includes(entry.code)
    if (mayAuthorize) {
      // an administrator MAY authorize these (and it is recorded); reset the order so that the rest of the checks look at an unreleased order again
      check(`[${entry.name}] an administrator may authorize it, with a written reason`, authorized.status === 200, { status: authorized.status, body: authorized.json })
      await prisma.printOrder.update({ where: { id }, data: { status: 'queued', metadata: before.metadata as any } })
    } else {
      check(`[${entry.name}] no authorization overrides it`, authorized.status === 409 && authorized.json?.code === entry.code, { status: authorized.status, body: authorized.json })
    }
    const assigned = await admin('PATCH', `/api/admin/orders/${id}/assign-printer`, { printerId: printer.id })
    check(`[${entry.name}] a printer can not be assigned`, assigned.status === 409, { status: assigned.status })
    const sent = await admin('POST', `/api/admin/orders/${id}/printlab-submit`, {})
    check(`[${entry.name}] it is not sent to PrintLab`, sent.status === 409 && state.printLab.submissions().length === submissions, { status: sent.status, submissions: state.printLab.submissions().length })
    await ownedByCustomer(id)
    const afterRefusals = await row(id)
    check(`[${entry.name}] nothing about the order changed`, afterRefusals.status === 'queued' && afterRefusals.printerId === null, { status: afterRefusals.status, printerId: afterRefusals.printerId })
    // what PrintLab itself says is recorded and does not move the order
    const link = await admin('POST', `/api/admin/orders/${id}/printlab-link`, { mode: 'manual', manual: { printLabJobId: `pl_${id}`, status: 'completed' } })
    const signal = await callback(id, 'started')
    const afterSignals = await row(id)
    check(`[${entry.name}] PrintLab's word is recorded (link and callback answer 200) but does not move the order`, link.status === 200 && signal.status === 200 && afterSignals.status === 'queued' && JSON.stringify(afterSignals.metadata).includes(`pl_${id}`), { link: link.status, signal: signal.status, status: afterSignals.status })
  }
  const queued = await admin('POST', '/api/admin/printers/auto-queue', {})
  const picked = await prisma.printOrder.count({ where: { printerId: printer.id } })
  check('the automatic queue picked nobody (every order was unreleased)', queued.status === 200 && picked === 0, { status: queued.status, picked })
  check('PrintLab was told nothing during all of that (no submission, no command)', state.printLab.submissions().length === 0 && state.printLab.otherCalls().length === 0, { submissions: state.printLab.submissions().length, other: state.printLab.otherCalls().length })
  check('StockWorks was told nothing', state.stockWorks.posts().length === 0)

  // ---- 2. requests from another site, and the callbacks ----------------------------------------------------------------------------------
  const sample = await makeOrder(releasedSpec())
  const crossSite = await admin('PATCH', `/api/admin/orders/${sample.id}/status`, { status: 'printing' }, { origin: 'https://evil.example' })
  check('a request from another site is refused before anything is read (403 INVALID_ORIGIN)', crossSite.status === 403 && crossSite.json?.code === 'INVALID_ORIGIN', { status: crossSite.status, body: crossSite.json })
  const noOrigin = await admin('PATCH', `/api/admin/orders/${sample.id}/status`, { status: 'printing' }, { origin: null })
  check('a request that says nothing about where it comes from is refused too', noOrigin.status === 403, { status: noOrigin.status })
  check('...and the order did not move', (await row(sample.id)).status === 'queued')
  const noSession = await call('PATCH', `/api/admin/orders/${sample.id}/status`, { body: { status: 'printing' } })
  check('no session: 401', noSession.status === 401, { status: noSession.status })
  const asStaffAuthorize = await admin('PATCH', `/api/admin/orders/${(await makeOrder({ status: 'queued', paymentStatus: 'pending' })).id}/status`, { status: 'printing', authorizeUnpaid: true }, { who: 'staff' })
  check('staff can not authorize production without a payment (403)', asStaffAuthorize.status === 403, { status: asStaffAuthorize.status })
  const noSecret = await callback(sample.id, 'started', null)
  const wrongSecret = await callback(sample.id, 'started', 'not-the-secret')
  check('a PrintLab callback without the secret, or with a wrong one, is refused (401)', noSecret.status === 401 && wrongSecret.status === 401, { noSecret: noSecret.status, wrongSecret: wrongSecret.status })
  check('...and it was not applied', (await row(sample.id)).status === 'queued')

  // ---- 3. a released order goes through exactly once ---------------------------------------------------------------------------------------
  const released = await makeOrder(releasedSpec({ items: 2, metadata: { slicerStats: { materials: [{ material: 'PLA', grams: 20, colors: ['black'] }] } } }))
  const first = await admin('POST', `/api/admin/orders/${released.id}/printlab-submit`, {})
  check('a released order is sent to PrintLab: one job per line', first.status === 200 && state.printLab.submissions().length === 2, { status: first.status, submissions: state.printLab.submissions().length, body: first.json })
  const second = await admin('POST', `/api/admin/orders/${released.id}/printlab-submit`, {})
  check('sent again: PrintLab hears nothing new', state.printLab.submissions().length === 2, { status: second.status, submissions: state.printLab.submissions().length })
  const assignedOk = await admin('PATCH', `/api/admin/orders/${released.id}/assign-printer`, { printerId: printer.id })
  check('a printer can be assigned to it', assignedOk.status === 200 && (await row(released.id)).printerId === printer.id, { status: assignedOk.status })
  const started = await callback(released.id, 'started')
  check('PrintLab\'s "started" moves a released order to printing', started.status === 200 && (await row(released.id)).status === 'printing', { status: started.status })
  const done = await callback(released.id, 'completed')
  check('"completed" completes it', done.status === 200 && (await row(released.id)).status === 'completed', { status: done.status })
  await admin('PATCH', `/api/admin/orders/${released.id}/status`, { status: 'completed' })
  await admin('PATCH', `/api/admin/orders/${released.id}/status`, { status: 'completed' })
  check('the material of a released order is taken out of stock at most once, however many times the status is set', state.stockWorks.posts().length <= 1, { posts: state.stockWorks.posts().length })
  const heldAfter = await admin('DELETE', `/api/admin/orders/${released.id}`, { reason: 'removing a duplicate order by mistake' })
  check('an order that went to production can not be deleted (409), its job would be left without an order', heldAfter.status === 409 && (await prisma.printOrder.count({ where: { id: released.id } })) === 1, { status: heldAfter.status, body: heldAfter.json })

  // ---- 4. a call whose outcome is unknown is never repeated -------------------------------------------------------------------------------
  // (a) PrintLab records the job and the answer is lost; PrintLab can NOT be searched (it does not list its jobs): the outcome stays unknown
  state.printLab.options.listJobs = false
  const doubtful = await makeOrder(releasedSpec({ items: 1 }))
  state.printLab.mode.submit = { kind: 'drop', record: true }
  const lost = await admin('POST', `/api/admin/orders/${doubtful.id}/printlab-submit`, {})
  state.printLab.mode.submit = { kind: 'ok' }
  const recorded = state.printLab.jobs.length
  const entries = Object.entries(readJournal((await row(doubtful.id)).metadata))
  check('a lost answer is recorded as UNCERTAIN, not as a failure that can be repeated', lost.status !== 200 && entries.length === 1 && entries[0][1].state === 'uncertain', { status: lost.status, journal: entries })
  const submissionsBefore = state.printLab.submissions().length
  const retry = await admin('POST', `/api/admin/orders/${doubtful.id}/printlab-submit`, {})
  check('pressing "Submit" again does not send it again', state.printLab.submissions().length === submissionsBefore, { status: retry.status, before: submissionsBefore, after: state.printLab.submissions().length })
  check('...and, PrintLab being unable to say whether the job exists, the outcome is still unknown', readJournal((await row(doubtful.id)).metadata)[entries[0][0]]?.state === 'uncertain')
  const wrongProof = await admin('POST', `/api/admin/orders/${doubtful.id}/external-effects`, { effectKey: entries[0][0], externalId: 'pl_job_that_does_not_exist', reason: 'I looked in PrintLab and found it' })
  check('naming a record that does not exist settles nothing (409 NO_RELIABLE_PROOF)', wrongProof.status === 409 && wrongProof.json?.code === 'NO_RELIABLE_PROOF', { status: wrongProof.status, body: wrongProof.json })
  const noDeclaration = await admin('POST', `/api/admin/orders/${doubtful.id}/external-effects`, { effectKey: entries[0][0], action: 'retry', reason: 'it did not happen, send it again' })
  check('there is no way to say "it did not happen, send it again" (400)', noDeclaration.status === 400, { status: noDeclaration.status })
  check('...and the outcome is still unknown', readJournal((await row(doubtful.id)).metadata)[entries[0][0]]?.state === 'uncertain')
  const realId = state.printLab.jobs[recorded - 1]?.id
  const staffProof = await admin('POST', `/api/admin/orders/${doubtful.id}/external-effects`, { effectKey: entries[0][0], externalId: realId ?? 'x', reason: 'staff tries to settle it' }, { who: 'staff' })
  check('staff can not settle it (403)', staffProof.status === 403, { status: staffProof.status })
  const proof = await admin('POST', `/api/admin/orders/${doubtful.id}/external-effects`, { effectKey: entries[0][0], externalId: realId, reason: 'found the job in PrintLab with this order id' })
  check('naming the record that PrintLab really holds settles it (the server looked it up there)', proof.status === 200 && readJournal((await row(doubtful.id)).metadata)[entries[0][0]]?.state === 'confirmed', { status: proof.status, body: proof.json })
  const afterProof = state.printLab.submissions().length
  await admin('POST', `/api/admin/orders/${doubtful.id}/printlab-submit`, {})
  check('and then it is not sent again either', state.printLab.submissions().length === afterProof)

  // (b) the same lost answer, but PrintLab CAN be searched: the job is FOUND (presence), the outcome is settled by that, and still nothing is sent twice
  state.printLab.options.listJobs = true
  const findable = await makeOrder(releasedSpec({ items: 1 }))
  state.printLab.mode.submit = { kind: 'drop', record: true }
  await admin('POST', `/api/admin/orders/${findable.id}/printlab-submit`, {})
  state.printLab.mode.submit = { kind: 'ok' }
  const beforeSearch = state.printLab.submissions().length
  await admin('POST', `/api/admin/orders/${findable.id}/printlab-submit`, {})
  const settled = Object.values(readJournal((await row(findable.id)).metadata))[0]
  check('a job that PrintLab can show is found, not sent again: the outcome is settled by its presence', state.printLab.submissions().length === beforeSearch && settled?.state === 'confirmed' && settled?.confirmedBy === 'reconciliation', { before: beforeSearch, after: state.printLab.submissions().length, settled })

  // ---- 5. the pages -----------------------------------------------------------------------------------------------------------------------
  const unpaid = await makeOrder({ status: 'awaiting_payment', paymentStatus: 'pending' })
  await ownedByCustomer(unpaid.id)
  const page = await call('GET', `/admin/users/${state.customerId}/orders/${unpaid.id}`, { who: 'admin', origin: null })
  check('the administrator\'s order page has the "Production release" card and says the order awaits payment', page.status === 200 && page.text.includes('Production release') && /Not released - awaiting payment/.test(page.text), { status: page.status })
  const prod = await call('GET', '/admin/production', { who: 'admin', origin: null })
  check('the production page has "Not in production" and the unpaid order is listed there', prod.status === 200 && prod.text.includes('Not in production'), { status: prod.status })
  const api = await call('GET', '/api/admin/production', { who: 'admin', origin: null })
  check('the production API lists it as held back, not in the queue', api.status === 200 && api.json?.notReleased?.some((o: any) => o.id === unpaid.id) && !api.json?.orders?.some((o: any) => o.id === unpaid.id), { status: api.status })
  const customerApi = await call('GET', `/api/customer/orders/${unpaid.id}`, { who: 'customer', origin: null })
  const leaked = /paymentReviewReason|notReleased|externalEffects|productionAuthorization|"release"/.test(customerApi.text)
  check('a customer reading the order sees no reason, no release state, no journal', customerApi.status === 200 && !leaked, { status: customerApi.status })
  const customerAdmin = await call('GET', '/api/admin/production', { who: 'customer', origin: null })
  check('a customer can not read the administrator\'s production API', customerAdmin.status === 401 || customerAdmin.status === 403, { status: customerAdmin.status })

  await stop()
  await teardown()
  console.log(`\n${passed}/${passed + failed} checks passed${failed ? ` - ${failed} FAILED` : ''}`)
  process.exit(failed ? 1 : 0)
})().catch(async (err) => { console.error(err); await stop(); process.exit(1) })
