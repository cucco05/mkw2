// Step 4.6 (S3) - the pure rules of minimum-price waivers (lib/minimum-waivers.ts): which floor a unit gets, and who may manage waivers. No database.
import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanReason, effectiveMinimum, isWaiverActive, isWaiverAdmin, waiverForLine, WaiverError, type ActiveWaiver } from '../lib/minimum-waivers'

const waiver = (over: Partial<ActiveWaiver> = {}): ActiveWaiver => ({ id: 'w1', modelId: 'M', productTemplateId: null, minimumPriceCents: 200, expiresAt: null, createdAt: new Date(0), ...over })

test('a waiver can only LOWER the floor: min(waiver, the shop minimum); at or above the minimum it is not used and not recorded', () => {
  assert.deepEqual(effectiveMinimum(500, undefined), { cents: 500, waiverId: null })
  assert.deepEqual(effectiveMinimum(500, null), { cents: 500, waiverId: null })
  assert.deepEqual(effectiveMinimum(500, waiver()), { cents: 200, waiverId: 'w1' })
  assert.deepEqual(effectiveMinimum(500, waiver({ minimumPriceCents: 0 })), { cents: 0, waiverId: 'w1' }, 'a waiver to zero is allowed: the unit is sold at its own price')
  assert.deepEqual(effectiveMinimum(500, waiver({ minimumPriceCents: 500 })), { cents: 500, waiverId: null }, 'equal: nothing to waive')
  assert.deepEqual(effectiveMinimum(500, waiver({ minimumPriceCents: 900 })), { cents: 500, waiverId: null }, 'the shop lowered its minimum below the waiver: the waiver has no effect')
  assert.deepEqual(effectiveMinimum(500, waiver({ minimumPriceCents: -5 })), { cents: 500, waiverId: null }, 'a damaged value is never trusted')
  assert.deepEqual(effectiveMinimum(500, waiver({ minimumPriceCents: 2.5 })), { cents: 500, waiverId: null })
  assert.deepEqual(effectiveMinimum(0, waiver()), { cents: 0, waiverId: null }, 'a shop with no minimum has nothing to waive')
})

test('a line with a ready-made product counts ONLY the product\'s waiver; any other line ONLY its model\'s', () => {
  const byModel = new Map([['M', waiver({ id: 'wm' })]])
  const byProduct = new Map([['P', waiver({ id: 'wp', modelId: null, productTemplateId: 'P' })]])
  const waivers = { byModel, byProduct }
  assert.equal(waiverForLine(waivers, 'M', null)?.id, 'wm')
  assert.equal(waiverForLine(waivers, 'M', undefined)?.id, 'wm')
  assert.equal(waiverForLine(waivers, 'M', 'P')?.id, 'wp', 'the product line takes the product waiver')
  assert.equal(waiverForLine(waivers, 'M', 'OTHER'), undefined, 'a product with no waiver does not borrow its model\'s')
  assert.equal(waiverForLine(waivers, 'N', null), undefined)
})

test('a waiver is in force until it is revoked or expires', () => {
  const now = new Date('2026-10-20T12:00:00Z')
  assert.equal(isWaiverActive({}, now), true)
  assert.equal(isWaiverActive({ expiresAt: new Date('2026-10-21T00:00:00Z') }, now), true)
  assert.equal(isWaiverActive({ expiresAt: new Date('2026-10-20T12:00:00Z') }, now), false, 'at the very instant it expires it is over')
  assert.equal(isWaiverActive({ expiresAt: new Date('2026-10-19T00:00:00Z') }, now), false)
  assert.equal(isWaiverActive({ revokedAt: new Date('2026-10-01T00:00:00Z') }, now), false)
})

test('PRICE_WAIVER_ADMIN_IDS: unset = every administrator, set = only the ones named', () => {
  assert.equal(isWaiverAdmin('a1', {} as any), true)
  assert.equal(isWaiverAdmin('a1', { PRICE_WAIVER_ADMIN_IDS: '' } as any), true)
  assert.equal(isWaiverAdmin('a1', { PRICE_WAIVER_ADMIN_IDS: ' , ' } as any), true)
  assert.equal(isWaiverAdmin('a1', { PRICE_WAIVER_ADMIN_IDS: 'a1, a2' } as any), true)
  assert.equal(isWaiverAdmin('a3', { PRICE_WAIVER_ADMIN_IDS: 'a1, a2' } as any), false)
})

test('the written reason: 10 to 300 characters, trimmed', () => {
  assert.equal(cleanReason('  fine for the demo shelf  '), 'fine for the demo shelf')
  for (const bad of [undefined, null, 42, '', '         ', 'too short']) assert.throws(() => cleanReason(bad), (err: any) => err instanceof WaiverError && err.code === 'REASON_REQUIRED')
  assert.throws(() => cleanReason('x'.repeat(301)), (err: any) => err instanceof WaiverError && err.code === 'REASON_TOO_LONG')
  assert.equal(cleanReason('x'.repeat(300)).length, 300)
})
