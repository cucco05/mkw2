// Shared harness for the security verification tests (Phase 1, activity 1.4).
//
// SAFETY: these tests only run against a LOCAL throw-away database whose name ends in `_sectest`,
// with fake users/models/files and a fake Stripe client. No real payment or customer data is involved.
// Import this module FIRST in every *.sec.ts file: it must set the environment before the app code loads.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dbUrl = process.env.SEC_TEST_DATABASE_URL || ''
if (!/^postgres(ql)?:\/\/[^@/]*@(127\.0\.0\.1|localhost)(:\d+)?\/[A-Za-z0-9_]*_sectest(\?.*)?$/.test(dbUrl)) {
  throw new Error(
    'Refusing to run: SEC_TEST_DATABASE_URL must point to a local database whose name ends with "_sectest" '
    + '(e.g. postgresql://postgres@127.0.0.1:55432/mkw_sectest).',
  )
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'mkw-sectest-'))
export const STORAGE_DIR = path.join(tmpRoot, 'storage')
export const OUTSIDE_FILE = path.join(tmpRoot, 'outside-secret.txt')
mkdirSync(STORAGE_DIR, { recursive: true })

process.env.DATABASE_URL = dbUrl
process.env.STORAGE_DIR = STORAGE_DIR
process.env.JWT_SECRET = 'sectest-jwt-secret-0123456789abcdefghijklmnop'
process.env.STRIPE_SECRET_KEY = 'sk_test_FAKE_not_a_real_key_000000000000'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_FAKE_sectest_secret'
// Nothing listens on this port: any accidental self-HTTP call fails fast instead of reaching a real service.
process.env.BASE_URL = 'http://127.0.0.1:9'
// The tests play the role of the one reverse proxy in front of the app: the last X-Forwarded-For entry is the client (lib/client-ip.ts).
process.env.TRUSTED_PROXY_HOPS = '1'
delete process.env.CLIENT_IP_HEADER
delete process.env.FILES_BASE_URL
delete process.env.FILES_CDN_BASE_URL

export function writeStorageFile(rel: string, content: string) {
  const full = path.join(STORAGE_DIR, rel)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content)
  return full
}

export function writeOutsideFile(content: string) {
  writeFileSync(OUTSIDE_FILE, content)
}

// ---- Fake Stripe -----------------------------------------------------------------------------------
// The app uses a singleton Stripe client; replacing the methods on that instance means no network calls.
type AnyFn = (...args: any[]) => any
export const stripeCalls: string[] = []

export async function installFakeStripe(overrides: Record<string, AnyFn> = {}) {
  const { getStripe } = await import('../../lib/stripe')
  const stripe: any = getStripe()
  const impl: Record<string, AnyFn> = {
    'customers.create': async () => ({ id: 'cus_FAKE' }),
    'invoiceItems.create': async () => ({ id: 'ii_FAKE' }),
    'invoices.create': async () => ({ id: 'in_FAKE' }),
    'invoices.sendInvoice': async () => ({ id: 'in_FAKE', status: 'open', hosted_invoice_url: null, invoice_pdf: null }),
    'paymentIntents.create': async () => ({ id: 'pi_created_FAKE', client_secret: 'secret_FAKE' }),
    'paymentIntents.retrieve': async () => {
      throw new Error('paymentIntents.retrieve not stubbed for this test')
    },
    ...overrides,
  }
  for (const [pathStr, fn] of Object.entries(impl)) {
    // 'customers.create' or a nested resource such as 'checkout.sessions.create'
    const parts = pathStr.split('.')
    const method = parts.pop() as string
    const target = parts.reduce((object: any, key) => object[key], stripe)
    target[method] = async (...args: any[]) => {
      stripeCalls.push(pathStr)
      return fn(...args)
    }
  }
  return stripe
}

// ---- Database helpers --------------------------------------------------------------------------------
export async function db() {
  return (await import('../../lib/db')).prisma
}

// The machines the tests run against: the shop's first machine as the migration creates it (Bambu Lab A1 mini, 180 x 180 x 180 mm, 0.4 mm nozzle),
// EXCEPT that ABS is also allowed here, because several existing scenarios sell it (the migration's default does not: PLA, PETG, TPU only).
// Tests about machines call configureTestMachine() with what they need.
export const TEST_MACHINE_DEFAULTS = {
  key: 'bambu-a1-mini', label: 'Bambu Lab A1 mini', isActive: true, buildXmm: 180, buildYmm: 180, buildZmm: 180,
  marginXYmm: 3, marginZmm: 2, supportMarginXYmm: 3, nozzleDiameterMm: 0.4, minFeatureMm: null as number | null, maxSupportRatio: null as number | null,
  allowedMaterials: ['PLA', 'PETG', 'TPU', 'ABS'], allowedFinishes: ['standard', 'matte', 'gloss', 'polished', 'textured'], notes: 'test machine',
}
export async function configureTestMachine(over: Partial<typeof TEST_MACHINE_DEFAULTS> = {}, others: Array<Partial<typeof TEST_MACHINE_DEFAULTS> & { key: string }> = []) {
  const prisma = await db()
  const data = { ...TEST_MACHINE_DEFAULTS, ...over }
  await prisma.printerMachine.upsert({ where: { key: data.key }, update: data, create: data })
  const keep = [data.key, ...others.map((machine) => machine.key)]
  await prisma.printerMachine.deleteMany({ where: { key: { notIn: keep } } })
  for (const machine of others) {
    const extra = { ...TEST_MACHINE_DEFAULTS, ...machine }
    await prisma.printerMachine.upsert({ where: { key: extra.key }, update: extra, create: extra })
  }
}

export async function resetDb() {
  const prisma = await db()
  await configureTestMachine()
  await prisma.rateLimit.deleteMany()
  await prisma.stripeEvent.deleteMany()
  await prisma.jobForm.deleteMany()
  await prisma.printOrder.deleteMany() // items/messages cascade
  await prisma.featuredModel.deleteMany()
  await prisma.productTemplate.deleteMany()
  await prisma.model.deleteMany()
  await prisma.profile.deleteMany({ where: { user: { email: { endsWith: '@sectest.invalid' } } } })
  await prisma.user.deleteMany({ where: { email: { endsWith: '@sectest.invalid' } } })
}

// An orderable, published model. Published models belong to the SHOP (an admin account): since the privacy policy
// (lib/model-access.ts) a customer's model can never be ordered by other people, even if stored as "public".
export async function seedShopModel(opts: { visibility?: string; volumeMm3?: number; priceUsd?: number } = {}) {
  const prisma = await db()
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`
  const user = await prisma.user.create({
    data: { email: `shop${stamp}@sectest.invalid`, passwordHash: 'not-a-real-hash', name: 'Fake Shop', role: 'admin' },
  })
  const model = await prisma.model.create({
    data: {
      title: 'FAKE expensive part',
      filePath: `models/${user.id}/fake.stl`,
      fileType: 'stl',
      userId: user.id,
      visibility: opts.visibility ?? 'public',
      volumeMm3: opts.volumeMm3 ?? 400000,
      priceUsd: opts.priceUsd ?? 200,
      effectivePriceUsd: opts.priceUsd ?? 200,
      sizeXmm: 80,
      sizeYmm: 80,
      sizeZmm: 60,
    },
  })
  return { user, model }
}

export function cartBody(modelId: string, extra: Record<string, unknown> = {}) {
  return {
    items: [{ modelId, qty: 1, colors: ['#ffffff'], material: 'PLA' }],
    shipping: { method: 'pickup' },
    ...extra,
  }
}

export async function postJson(handler: AnyFn, url: string, body: unknown) {
  const { NextRequest } = await import('next/server')
  const req = new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    return await handler(req, {} as any)
  } catch (err: any) {
    // A thrown error would be a 500 for the caller (Stripe, a browser, ...).
    return new Response(JSON.stringify({ error: String(err?.message || err), thrown: true }), { status: 500 })
  }
}
