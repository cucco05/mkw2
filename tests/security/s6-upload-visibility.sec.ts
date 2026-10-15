// S6 – files uploaded by ordinary customers must be private to them (and admins), not public.
// The upload route stores `visibility = resolveUploadVisibility(field, canChoose)`; for non-admins this is forced to "public".
import { db, resetDb, seedCustomerAndModel } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { canChooseUploadVisibility, resolveUploadVisibility } from '../../lib/upload-visibility'

test.before(async () => {
  await resetDb()
})

test('control: admins/staff can choose visibility, customers cannot choose', () => {
  assert.equal(canChooseUploadVisibility({ role: 'admin' }), true)
  assert.equal(canChooseUploadVisibility({ role: 'customer' }), false)
})

test('S6a: the visibility assigned to a customer upload must not be "public"', { todo: 'S6 confirmed if this fails' }, (t) => {
  const assigned = resolveUploadVisibility('private', canChooseUploadVisibility({ role: 'customer' }))
  t.diagnostic(`customer asks for "private" -> assigned "${assigned}"; with no choice -> "${resolveUploadVisibility(undefined, false)}"`)
  assert.notEqual(assigned, 'public')
})

test('S6b: a customer upload (as stored by the upload route) must not appear in the anonymous public catalogue', { todo: 'S6 confirmed if this fails' }, async (t) => {
  await resetDb()
  const assigned = resolveUploadVisibility(undefined, false) // exactly what /api/upload computes for a customer
  const { model } = await seedCustomerAndModel({ visibility: assigned })
  const { GET } = await import('../../app/api/models/route')
  const res = await GET(new NextRequest('http://localhost/api/models?pageSize=50'))
  const text = await res.text()
  const visibleToAnonymous = text.includes(model.id)
  const prisma = await db()
  const stored = await prisma.model.findUnique({ where: { id: model.id }, select: { visibility: true } })
  t.diagnostic(`stored visibility="${stored?.visibility}"; anonymous GET /api/models HTTP ${res.status}; contains model: ${visibleToAnonymous}`)
  assert.equal(visibleToAnonymous, false, 'a customer-uploaded model is listed to anonymous visitors')
})
