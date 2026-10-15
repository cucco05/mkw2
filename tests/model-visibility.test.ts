import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkoutVisibleModelWhere,
  discoverVisibleModelWhere,
  isDirectOrderableVisibility,
} from '../lib/model-visibility'

const SHOP_OWNER = { user: { OR: [{ isAdmin: true }, { role: { in: ['admin', 'staff'] } }] } }

test('only shop-owned public models are discoverable; unlisted ones are direct-orderable', () => {
  assert.equal(isDirectOrderableVisibility('public'), true)
  assert.equal(isDirectOrderableVisibility('unlisted'), true)
  assert.equal(isDirectOrderableVisibility('private'), false)
  assert.deepEqual(discoverVisibleModelWhere(), {
    AND: [{ visibility: { in: ['public', 'unlisted'] }, ...SHOP_OWNER }, { visibility: 'public' }],
  })
})

test('checkout visibility: guests/customers can order published shop models; customers also their own', () => {
  assert.deepEqual(checkoutVisibleModelWhere(['model_1', 'model_2'], null, false), {
    id: { in: ['model_1', 'model_2'] },
    visibility: { in: ['public', 'unlisted'] },
    ...SHOP_OWNER,
  })

  assert.deepEqual(checkoutVisibleModelWhere(['model_1'], 'user_1', false), {
    id: { in: ['model_1'] },
    OR: [
      { visibility: { in: ['public', 'unlisted'] }, ...SHOP_OWNER },
      { userId: 'user_1' },
    ],
  })

  assert.deepEqual(checkoutVisibleModelWhere(['model_1'], 'admin_1', true), {
    id: { in: ['model_1'] },
  })
})
