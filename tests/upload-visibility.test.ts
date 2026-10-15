import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canChooseUploadVisibility,
  resolveUploadVisibility,
  UPLOAD_VISIBILITIES,
} from '../lib/upload-visibility'

test('only admins and staff can choose upload visibility', () => {
  assert.equal(canChooseUploadVisibility({ isAdmin: true, role: 'customer' }), true)
  assert.equal(canChooseUploadVisibility({ isAdmin: false, role: 'admin' }), true)
  assert.equal(canChooseUploadVisibility({ isAdmin: false, role: 'staff' }), true)
  assert.equal(canChooseUploadVisibility({ isAdmin: false, role: 'customer' }), false)
  assert.equal(canChooseUploadVisibility(null), false)
})

test('admin upload visibility accepts public unlisted and private', () => {
  assert.deepEqual(UPLOAD_VISIBILITIES, ['public', 'unlisted', 'private'])
  assert.equal(resolveUploadVisibility('public', true), 'public')
  assert.equal(resolveUploadVisibility('unlisted', true), 'unlisted')
  assert.equal(resolveUploadVisibility('private', true), 'private')
})

test('privacy by default: every upload is private unless staff explicitly choose otherwise', () => {
  // customers: always private, whatever they ask for
  assert.equal(resolveUploadVisibility('public', false), 'private')
  assert.equal(resolveUploadVisibility('private', false), 'private')
  assert.equal(resolveUploadVisibility('unlisted', false), 'private')
  assert.equal(resolveUploadVisibility(undefined, false), 'private')
  // staff/admin: invalid or missing values also fall back to private
  assert.equal(resolveUploadVisibility('hidden', true), 'private')
  assert.equal(resolveUploadVisibility('', true), 'private')
  assert.equal(resolveUploadVisibility(undefined, true), 'private')
})
