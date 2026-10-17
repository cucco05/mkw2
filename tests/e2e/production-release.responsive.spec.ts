// Step 4.6, S4 - the production-release screens of the administrator, on a desktop and on phone-sized screens (projects "chromium", "mobile" 393x851 and
// "mobile-small" 360x640 of playwright.config.ts; EMULATED phones, not a real iPhone or Android - those checks stay open in docs/CHECKLIST-PRELANCIO.md):
//   * /admin/production: the queue holds only released orders; "Not in production" lists every other order with the reason (and nothing about it reaches a customer);
//   * the order page: the "Production release" card says why the order is, or is not, released; what the server would refuse is switched off and explained
//     (printer, PrintLab); the server stays the authority (the refusals below come from the real server);
//   * an outside call whose outcome is unknown is shown as such, can only be confirmed by naming its record, and nothing on the page offers to send it again;
//   * nothing sticks out of the screen, the controls are thumb-sized, no text is cut, no request leaves the site, no error appears in the console.
// Nothing here changes an order: the buttons that would (send to PrintLab, assign, authorize) are only looked at, or answered by the real server with a refusal.
// Needs a running app on the throw-away test database seeded with tests/e2e/seed-production-release.ts (E2E_RELEASE_FIXTURE is the file that script wrote);
// otherwise skipped.
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'

type Fixture = {
  adminToken: string
  staffToken: string
  customerToken: string
  adminId: string
  customerId: string
  printerId: string
  orders: Record<string, { id: string; orderNumber: number; userId: string }>
}
const FIXTURE = (process.env.E2E_RELEASE_FIXTURE || '').trim()
const data = FIXTURE && fs.existsSync(FIXTURE) ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Fixture : null
const MIN_TOUCH = 44

const orderLabel = (key: string) => `MW-${String(data!.orders[key].orderNumber).padStart(5, '0')}`
const orderUrl = (key: string) => `/admin/users/${data!.customerId}/orders/${data!.orders[key].id}`
const HELD = ['pending', 'processing', 'openPage', 'dispute', 'external', 'waiting', 'printlabReported']
const IN_QUEUE = ['released', 'authorized', 'manual', 'sent', 'uncertain']

// Records everything that should never happen on these pages.
function watch(page: Page, baseURL: string) {
  const origin = new URL(baseURL).origin
  const external: string[] = []
  const pageErrors: string[] = []
  const serverErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    // The browser logs every refused request (4xx) as a console error. The refusals this file provokes on purpose are answers of the server (409) and are checked
    // one by one below; anything else in the console is a real problem.
    if (/Failed to load resource: the server responded with a status of 409/.test(message.text())) return
    consoleErrors.push(`${message.text()} (${message.location().url})`)
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => {
    const url = request.url()
    if (/^(data|blob|about):/.test(url)) return
    if (new URL(url).origin !== origin) external.push(url)
  })
  page.on('response', (response) => { if (new URL(response.url()).origin === origin && response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`) })
  return () => {
    expect(external, 'requests to another site').toEqual([])
    expect(pageErrors, 'uncaught errors in the page').toEqual([])
    expect(serverErrors, 'answers of the site with a 5xx status').toEqual([])
    expect(consoleErrors, 'errors in the browser console').toEqual([])
  }
}

async function fits(page: Page, label: string) {
  const { overflow, offenders } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const wide: string[] = []
    for (const el of Array.from(document.querySelectorAll('main *, h1, h2, button, a, section, input, select, label'))) {
      const box = (el as HTMLElement).getBoundingClientRect()
      if (box.width > 0 && box.right > width + 1) wide.push(`${el.tagName.toLowerCase()}:${(el.textContent || '').trim().slice(0, 30)}`)
    }
    return { overflow: document.documentElement.scrollWidth - width, offenders: wide.slice(0, 5) }
  })
  expect(overflow, `${label}: horizontal scroll of ${overflow}px`).toBeLessThanOrEqual(0)
  expect(offenders, `${label}: elements wider than the screen`).toEqual([])
}
async function thumbSized(locator: Locator, what: string) {
  await expect(locator.first(), `${what} is on the page`).toBeVisible()
  for (const [index, box] of (await locator.all()).entries()) {
    const size = await box.boundingBox()
    expect(size, `${what} #${index} is on screen`).not.toBeNull()
    expect(size!.height, `${what} #${index} height`).toBeGreaterThanOrEqual(MIN_TOUCH - 0.5)
  }
}
// no block of text is wider than its box (a cut line would show as scrollWidth > clientWidth)
async function noClippedText(scope: Locator, label: string) {
  const clipped = await scope.evaluate((root) => {
    const out: string[] = []
    for (const el of Array.from(root.querySelectorAll('p, li, label, h2, button, select'))) {
      const node = el as HTMLElement
      if (node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1) out.push(`${node.tagName.toLowerCase()}:${(node.textContent || '').trim().slice(0, 40)}`)
    }
    return out
  })
  expect(clipped, `${label}: text wider than its box`).toEqual([])
}

const card = (page: Page) => page.getByTestId('production-release-card')
const submitButton = (page: Page) => page.getByRole('button', { name: 'Submit to PrintLab', exact: true })
const saveAssignment = (page: Page) => page.getByRole('button', { name: 'Save printer assignment', exact: true })
const statusSelect = (page: Page) => page.getByLabel('New status')
async function openOrder(page: Page, key: string) {
  await page.goto(orderUrl(key))
  await expect(card(page)).toBeVisible()
  // the printers load after the page: wait for the list the assignment is made from
  await expect(page.getByLabel('Printer', { exact: true }).locator('option', { hasText: 'E2E release printer' })).toHaveCount(1)
}
async function patchStatus(page: Page, act: () => Promise<void>) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => /\/api\/admin\/orders\/[^/]+\/status$/.test(r.url()) && r.request().method() === 'PATCH'),
    act(),
  ])
  return { status: response.status(), body: await response.json().catch(() => ({})) as { code?: string; error?: string } }
}

test.describe('production release (administrator), every screen size', () => {
  test.skip(!data, 'E2E_RELEASE_FIXTURE is not set (see tests/e2e/seed-production-release.ts)')

  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([{ name: 'mwv2_token', value: data!.adminToken, url: baseURL! }])
  })

  test('the production page: the queue holds only released orders, every other order is listed with its reason', async ({ page, baseURL }) => {
    const assertClean = watch(page, baseURL!)
    await page.goto('/admin/production')
    const held = page.getByTestId('not-released')
    await expect(held).toBeVisible()
    await expect(page.getByText('Released orders only')).toBeVisible()
    const queue = page.getByTestId('queue-order')
    await expect(queue.first()).toBeVisible()

    for (const key of HELD) {
      await expect(held.getByTestId('not-released-item').filter({ hasText: orderLabel(key) }), `${key} is listed as held back`).toHaveCount(1)
      await expect(queue.filter({ hasText: orderLabel(key) }), `${key} must not be in the queue`).toHaveCount(0)
    }
    for (const key of IN_QUEUE) {
      await expect(queue.filter({ hasText: orderLabel(key) }), `${key} is in the queue`).toHaveCount(1)
      await expect(held.getByTestId('not-released-item').filter({ hasText: orderLabel(key) }), `${key} is not held back`).toHaveCount(0)
    }
    const reason = (key: string) => held.getByTestId('not-released-item').filter({ hasText: orderLabel(key) }).getByTestId('not-released-reason')
    await expect(reason('pending')).toContainText(/awaiting payment/i)
    await expect(reason('processing')).toContainText(/being confirmed/i)
    await expect(reason('openPage')).toContainText(/payment page open/i)
    await expect(reason('dispute')).toContainText(/payment under review/i)
    await expect(reason('external')).toContainText(/outside order/i)
    await expect(reason('waiting')).toContainText(/waiting for an administrator/i)
    // an order held after it went to production says so
    const disputeLine = held.getByTestId('not-released-item').filter({ hasText: orderLabel('dispute') })
    await expect(disputeLine).toContainText('PrintLab reported "started"')
    await expect(disputeLine).toContainText('Already went to production')

    await fits(page, 'production page')
    await thumbSized(held.getByRole('link', { name: 'Open order' }), 'Open order link')
    await noClippedText(held, 'not in production')
    assertClean()
  })

  test('the jobs page shows the same held-back orders, and they are not jobs of the queue', async ({ page, baseURL }) => {
    const assertClean = watch(page, baseURL!)
    await page.goto('/admin/jobs')
    const held = page.getByTestId('jobs-not-released')
    await expect(held).toBeVisible()
    for (const key of HELD) await expect(held.getByTestId('jobs-not-released-item').filter({ hasText: orderLabel(key) }), key).toHaveCount(1)
    for (const key of HELD) await expect(page.getByTestId('queue-job').filter({ hasText: orderLabel(key) }), `${key} must not be a job`).toHaveCount(0)
    await fits(page, 'jobs page')
    assertClean()
  })

  test('the production API gives the reasons to an administrator and to nobody else', async ({ request }) => {
    const get = (token: string) => request.get('/api/admin/production', { headers: { cookie: `mwv2_token=${token}` } })
    const res = await get(data!.adminToken)
    expect(res.status()).toBe(200)
    const body = await res.json()
    const queueIds = new Set((body.orders as Array<{ id: string }>).map((order) => order.id))
    const heldIds = new Set((body.notReleased as Array<{ id: string }>).map((order) => order.id))
    for (const key of HELD) {
      expect(heldIds.has(data!.orders[key].id), `${key} is held back`).toBe(true)
      expect(queueIds.has(data!.orders[key].id), `${key} is not in the queue`).toBe(false)
    }
    for (const key of IN_QUEUE) expect(queueIds.has(data!.orders[key].id), `${key} is in the queue`).toBe(true)
    expect((await get(data!.customerToken)).status(), 'a customer').toBeGreaterThanOrEqual(401)
    expect((await get(data!.customerToken)).status(), 'a customer').toBeLessThanOrEqual(403)
    expect((await request.get('/api/admin/production')).status(), 'nobody signed in').toBeGreaterThanOrEqual(401)
  })

  for (const entry of [
    { key: 'pending', state: /awaiting payment/i, authorizable: true, code: 'PAYMENT_NOT_VERIFIED', viaQueueButton: true },
    { key: 'processing', state: /being confirmed/i, authorizable: false, code: 'PAYMENT_PROCESSING', viaQueueButton: true },
    { key: 'openPage', state: /payment page open/i, authorizable: false, code: 'PAYMENT_ACTIVE', viaQueueButton: true },
    { key: 'external', state: /outside order to check/i, authorizable: true, code: 'EXTERNAL_ORDER_NOT_AUTHORIZED', viaQueueButton: true },
    { key: 'dispute', state: /payment under review/i, authorizable: false, code: 'PAYMENT_ON_HOLD', viaQueueButton: false },
  ]) {
    test(`an order that is not released (${entry.key}): the page says why, switches off what the server would refuse, and the server refuses it`, async ({ page, baseURL }) => {
      const assertClean = watch(page, baseURL!)
      await openOrder(page, entry.key)
      await expect(page.getByTestId('release-state')).toContainText(entry.state)

      // PrintLab: switched off, with the reason next to it
      await expect(submitButton(page)).toBeDisabled()
      await expect(page.getByTestId('printlab-submit-reason')).toContainText(/released/i)
      // printer: a printer can not be assigned; taking one away would still be possible
      await expect(page.getByTestId('assign-blocked-note')).toContainText(/released/i)
      await page.getByLabel('Printer', { exact: true }).selectOption(data!.printerId)
      await expect(saveAssignment(page)).toBeDisabled()
      await page.getByLabel('Printer', { exact: true }).selectOption('')
      await expect(saveAssignment(page)).toBeEnabled()
      // status control: says it, and a PrintLab record can still be attached but will not move the order
      await expect(page.getByTestId('status-release-note')).toContainText(entry.authorizable ? /written authorization/i : /No authorization can release it/i)
      await expect(page.getByTestId('printlab-link-note')).toContainText(/not released/i)

      // the server decides, whatever the page shows
      const answer = await patchStatus(page, async () => {
        if (entry.viaQueueButton) await page.getByTestId('status-move-to-queue').click()
        else {
          await statusSelect(page).selectOption('printing')
          await page.getByRole('button', { name: 'Update', exact: true }).click()
        }
      })
      expect(answer.status, 'the server refuses').toBe(409)
      expect(answer.body.code).toBe(entry.code)
      const ask = page.getByTestId('status-ask')
      if (entry.authorizable) {
        // an administrator is asked for a written authorization - on the page, with a reason of at least 10 characters
        await expect(ask).toBeVisible()
        const confirm = ask.getByRole('button', { name: 'Authorize and update' })
        await expect(confirm).toBeDisabled()
        await ask.getByRole('textbox').fill('too short')
        await expect(confirm).toBeDisabled()
        await ask.getByRole('textbox').fill('Agreed with the customer by phone')
        await expect(confirm).toBeEnabled()
        await thumbSized(ask.getByRole('button'), 'authorization buttons')
        await thumbSized(ask.getByRole('textbox'), 'authorization reason')
        await noClippedText(ask, 'authorization form')
        await ask.getByRole('button', { name: 'Not now' }).click()
        await expect(ask).toHaveCount(0)
      } else {
        // a payment that is held, being confirmed or open is NOT something an authorization can override: no form is offered
        await expect(ask).toHaveCount(0)
      }

      await fits(page, `order ${entry.key}`)
      await thumbSized(statusSelect(page), 'status select')
      await thumbSized(page.getByRole('button', { name: 'Update', exact: true }), 'Update button')
      await thumbSized(submitButton(page), 'Submit to PrintLab')
      await thumbSized(saveAssignment(page), 'Save printer assignment')
      await thumbSized(page.getByLabel('Printer', { exact: true }), 'Printer select')
      if (entry.viaQueueButton) await thumbSized(page.getByTestId('status-move-to-queue'), 'Move to queue')
      await noClippedText(card(page), `release card ${entry.key}`)
      assertClean()
    })
  }

  test('staff can see the reason but are not offered the authorization', async ({ page, context, baseURL }) => {
    const assertClean = watch(page, baseURL!)
    await context.clearCookies()
    await context.addCookies([{ name: 'mwv2_token', value: data!.staffToken, url: baseURL! }])
    await openOrder(page, 'pending')
    await expect(page.getByTestId('release-state')).toContainText(/awaiting payment/i)
    await expect(page.getByTestId('status-release-note')).toContainText(/Only an administrator can authorize/i)
    const answer = await patchStatus(page, () => page.getByTestId('status-move-to-queue').click())
    expect(answer.status).toBe(409)
    await expect(page.getByTestId('status-ask'), 'no authorization form for staff').toHaveCount(0)
    await fits(page, 'order page as staff')
    assertClean()
  })

  test('a released order says on what basis, and what was decided by whom', async ({ page, baseURL }) => {
    const assertClean = watch(page, baseURL!)
    await openOrder(page, 'released')
    await expect(page.getByTestId('release-state')).toContainText('Released - Stripe payment verified')
    await expect(submitButton(page)).toBeEnabled()
    await expect(page.getByTestId('printlab-submit-reason')).toHaveCount(0)
    await expect(page.getByTestId('assign-blocked-note')).toHaveCount(0)
    await expect(page.getByTestId('status-release-note')).toHaveCount(0)
    await fits(page, 'released order')

    await openOrder(page, 'authorized')
    await expect(page.getByTestId('release-state')).toContainText('Released - administrator authorization')
    await expect(page.getByTestId('release-authorization')).toContainText('Authorized by E2E Release Admin')
    await expect(page.getByTestId('release-authorization')).toContainText('Agreed with the customer on the phone')
    await expect(page.getByTestId('release-authorization')).toContainText('not a payment')

    await openOrder(page, 'manual')
    await expect(page.getByTestId('release-state')).toContainText('Released - manual payment registered')
    await expect(page.getByTestId('release-manual-payment')).toContainText('taken outside Stripe')
    await expect(page.getByTestId('release-manual-payment')).toContainText('Cash received at the counter')
    await fits(page, 'manual payment order')
    await noClippedText(card(page), 'release card (manual)')
    assertClean()
  })

  test('a paid order that was not moved says it waits for an administrator; an order already in production says so and can not be sent twice', async ({ page, baseURL }) => {
    const assertClean = watch(page, baseURL!)
    await openOrder(page, 'waiting')
    await expect(page.getByTestId('release-state')).toContainText('waiting for an administrator')
    await expect(page.getByTestId('status-current')).toContainText('Awaiting review')
    await expect(page.getByTestId('status-move-to-queue')).toBeVisible()

    await openOrder(page, 'sent')
    await expect(page.getByTestId('release-evidence')).toContainText('already went to production')
    await expect(page.getByTestId('release-evidence')).toContainText('can not be deleted')
    await expect(page.getByTestId('release-evidence')).toContainText('nothing here stops a printer')
    // a printing order is not sent to PrintLab again from here
    await expect(submitButton(page)).toBeDisabled()
    await expect(page.getByTestId('printlab-submit-reason')).toContainText(/only be sent to PrintLab while it is queued/i)
    await fits(page, 'order in production')
    assertClean()
  })

  test('PrintLab said something about an order that is not released: it is shown, and the order was not moved', async ({ page, baseURL }) => {
    const assertClean = watch(page, baseURL!)
    await openOrder(page, 'printlabReported')
    await expect(page.getByTestId('release-printlab')).toContainText('PrintLab reported "started"')
    await expect(page.getByTestId('release-printlab')).toContainText('the order was not moved')
    await expect(page.getByTestId('status-current')).toContainText('Awaiting payment')
    await fits(page, 'order with a PrintLab signal')
    assertClean()
  })

  test('an outside call whose outcome is unknown: shown as unknown, confirmed only by naming its record, never offered again', async ({ page, baseURL }) => {
    const assertClean = watch(page, baseURL!)
    const sent: string[] = []
    await page.route('**/api/admin/orders/*/external-effects', async (route) => {
      sent.push(route.request().postData() || '')
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'The record could not be verified on the outside service, so the outcome stays unknown: no such job.', code: 'NO_RELIABLE_PROOF' }),
      })
    })
    await openOrder(page, 'uncertain')
    const unknown = page.getByTestId('release-effect-uncertain')
    await expect(unknown).toHaveCount(1)
    await expect(unknown).toContainText('OUTCOME UNKNOWN')
    await expect(unknown).toContainText('will not be sent again by itself')
    await expect(page.getByTestId('release-effect')).toHaveCount(1) // the StockWorks movement that was confirmed
    // the one thing that can be done: name the record that exists on the outside service
    const form = page.getByTestId('release-confirm-form')
    await expect(form).toBeVisible()
    const submit = form.getByRole('button', { name: /Confirm with the PrintLab record/ })
    await expect(submit).toBeDisabled()
    await form.getByLabel('PrintLab job id').fill('pl_e2e_does_not_exist')
    await form.getByLabel(/Why you are sure/).fill('x')
    await expect(submit).toBeDisabled()
    await form.getByLabel(/Why you are sure/).fill('Looked for it in PrintLab and found nothing')
    await expect(submit).toBeEnabled()
    await submit.click()
    await expect(page.getByTestId('release-confirm-problem')).toContainText('stays unknown')
    expect(sent.length, 'exactly one request, and it only names a record').toBe(1)
    expect(JSON.parse(sent[0])).toEqual({ effectKey: 'printlab:item:e2e-item-1', externalId: 'pl_e2e_does_not_exist', reason: 'Looked for it in PrintLab and found nothing' })
    // nowhere on the page is there a way to say "it did not happen" or to send it again
    await expect(page.getByRole('button', { name: /send again|send it again|try again|retry|did not happen|not done|allow/i })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /send again|retry/i })).toHaveCount(0)

    await fits(page, 'order with an unknown outcome')
    await thumbSized(form.getByRole('button'), 'confirm button')
    await thumbSized(form.getByRole('textbox'), 'confirm fields')
    await noClippedText(card(page), 'release card (unknown outcome)')
    assertClean()
  })

  test('staff see an unknown outcome but can not settle it', async ({ page, context, baseURL }) => {
    const assertClean = watch(page, baseURL!)
    await context.clearCookies()
    await context.addCookies([{ name: 'mwv2_token', value: data!.staffToken, url: baseURL! }])
    await openOrder(page, 'uncertain')
    await expect(page.getByTestId('release-effect-uncertain')).toContainText('OUTCOME UNKNOWN')
    await expect(page.getByTestId('release-confirm-form')).toHaveCount(0)
    await expect(page.getByTestId('release-effect-uncertain')).toContainText('Only an administrator can settle this')
    assertClean()
  })

  test('a customer never reads why an order is held back', async ({ page, context, baseURL }) => {
    await context.clearCookies()
    await context.addCookies([{ name: 'mwv2_token', value: data!.customerToken, url: baseURL! }])
    for (const key of ['dispute', 'external', 'processing', 'pending']) {
      const response = await page.goto(`/customer/orders/${data!.orders[key].id}`)
      expect(response!.status(), key).toBe(200)
      const text = await page.locator('body').innerText()
      expect(text, `${key}: a review code reached the customer`).not.toMatch(/dispute|external_order|payment_hold|paymentReviewReason|Not released|Production release/)
      expect(await page.content(), `${key}: a hold reached the customer's page source`).not.toMatch(/paymentReviewReason|externalEffects|productionAuthorization|notReleased/)
    }
  })
})
