// TEST SUPPORT, never loaded by the application: a fake of api.stripe.com at the HTTP level, used to run the REAL server (`next start`) with the
// REAL Stripe SDK in front of it and no network. Load it with  NODE_OPTIONS="--require tests/real-run/fake-stripe-http-preload.js".
//   FAKE_STRIPE_STATE  JSON file with the fake's state (sessions, intents, injected faults)
//   FAKE_STRIPE_LOG    one line per request the SDK made (method, path, idempotency key)
//   FAKE_STRIPE_FORMS  one line per checkout-session creation with the decoded form the SDK sent (amounts, currency, metadata...)
// Payment page addresses are https://checkout.stripe.com/c/pay/<id> (the only host the checkout page follows).
// (the REAL Stripe SDK serialises the requests and parses the answers)
// State lives in a JSON file (FAKE_STRIPE_STATE) so the test driver can "pay", "expire" or "break" things from outside the server.
// Every request is appended to FAKE_STRIPE_LOG. Supported: checkout.sessions create/retrieve/expire, paymentIntents retrieve,
// charges are embedded in the PaymentIntent (latest_charge) as the SDK would receive them with expand.
const https = require('https'); const fs = require('fs'); const { EventEmitter } = require('events'); const { Readable } = require('stream')
const orig = https.request; const LOG = process.env.FAKE_STRIPE_LOG; const STATE = process.env.FAKE_STRIPE_STATE

function load() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return { seq: 0, sessions: {}, intents: {}, keys: {}, faults: [] } } }
function save(s) { fs.writeFileSync(STATE, JSON.stringify(s)) }
function decode(body) { const out = {}; for (const [k, v] of new URLSearchParams(body)) out[k] = v; return out }
function sub(form, prefix) { const out = {}; for (const [k, v] of Object.entries(form)) { if (k.startsWith(prefix)) out[k.slice(prefix.length).replace(/^\[|\]$/g, '')] = v } return out }
// A session as the SDK would return it, with payment_intent expanded when it exists and the caller asked for it.
function render(state, session, expand) {
  const out = { ...session }
  if (session.payment_intent) {
    const pi = state.intents[session.payment_intent]
    out.payment_intent = expand && pi ? pi : session.payment_intent
  }
  return out
}

https.request = function (options, cb) {
  const host = (options && (options.host || options.hostname)) || ''
  if (host !== 'api.stripe.com') return orig.apply(this, arguments)
  const req = new EventEmitter(); const chunks = []; let ended = false
  req.setTimeout = () => req; req.destroy = () => {}; req.abort = () => {}; req.setHeader = () => {}
  req.write = (c) => { chunks.push(Buffer.from(c)); return true }
  req.end = (c) => {
    if (ended) return; ended = true; if (c) chunks.push(Buffer.from(c))
    const full = String(options.path || ''); const [path, query = ''] = full.split('?'); const method = String(options.method || 'GET')
    const form = decode(Buffer.concat(chunks).toString('utf8')); const q = new URLSearchParams(query)
    if (method === 'POST' && path === '/v1/checkout/sessions' && process.env.FAKE_STRIPE_FORMS) fs.appendFileSync(process.env.FAKE_STRIPE_FORMS, JSON.stringify({ at: Date.now(), form }) + '\n')
    const expand = [...[...q.entries()].filter(([k]) => k.startsWith('expand[')).map(([, v]) => v), ...Object.entries(form).filter(([k]) => k.startsWith('expand[')).map(([, v]) => v)]
    const headers = options.headers || {}
    const idem = headers['Idempotency-Key'] || headers['idempotency-key'] || null
    const state = load()
    fs.appendFileSync(LOG, JSON.stringify({ method, path, query, idempotencyKey: idem, expand }) + '\n')

    // injected faults: {match:'sessions', status:503, remaining:n, delayMs}
    let fault = null
    for (const f of state.faults) { if (f.remaining > 0 && full.includes(f.match) && (!f.method || f.method === method)) { fault = f; f.remaining -= 1; break } }
    let status = 200, body, m, delay = 5
    if (fault) {
      delay = fault.delayMs || 5
      if (fault.status) { status = fault.status; body = { error: { type: 'api_error', message: 'fake temporary Stripe failure' } } }
    }
    if (!body) {
      if (method === 'POST' && path === '/v1/checkout/sessions') {
        const sig = JSON.stringify(form); const known = idem && state.keys[idem]
        if (known && known.sig !== sig) { status = 400; body = { error: { type: 'idempotency_error', message: 'keys can only be reused with the same parameters' } } }
        else if (known) body = state.sessions[known.id]
        else {
          let total = 0
          for (let i = 0; form[`line_items[${i}][price_data][unit_amount]`] !== undefined; i++) total += Number(form[`line_items[${i}][price_data][unit_amount]`]) * Number(form[`line_items[${i}][quantity]`] || 1)
          const id = `cs_test_REAL_${++state.seq}`
          body = {
            id, object: 'checkout.session', mode: form.mode, status: 'open', payment_status: 'unpaid', url: `https://checkout.stripe.com/c/pay/${id}`,
            amount_total: total, currency: form['line_items[0][price_data][currency]'], client_reference_id: form.client_reference_id,
            metadata: sub(form, 'metadata'), expires_at: Number(form.expires_at), payment_intent: null,
            // what a payment on this session will carry (copied to the PaymentIntent when "paid")
            _piMetadata: sub(form, 'payment_intent_data[metadata]'),
          }
          state.sessions[id] = body; if (idem) state.keys[idem] = { id, sig }
        }
      } else if (method === 'GET' && (m = path.match(/^\/v1\/checkout\/sessions\/([^/?]+)$/)) && state.sessions[m[1]]) {
        body = render(state, state.sessions[m[1]], expand.some((e) => e.startsWith('payment_intent')))
      } else if (method === 'POST' && (m = path.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/)) && state.sessions[m[1]]) {
        const s = state.sessions[m[1]]; if (s.status === 'open') s.status = 'expired'; body = s
      } else if (method === 'GET' && (m = path.match(/^\/v1\/payment_intents\/([^/?]+)$/)) && state.intents[m[1]]) {
        body = state.intents[m[1]]
      } else { status = 404; body = { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'not found in fake: ' + path } } }
    }
    save(state)
    const res = Readable.from([JSON.stringify(body)]); res.statusCode = status; res.headers = { 'request-id': 'req_fake', 'content-type': 'application/json' }
    setTimeout(() => req.emit('response', res), delay)
  }
  process.nextTick(() => req.emit('socket', { connecting: false }))
  return req
}
