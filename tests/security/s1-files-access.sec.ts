// S1 – the /files route must not hand out private files to anonymous callers.
// Tests marked `todo` assert the SECURE behaviour and currently FAIL = vulnerability reproduced.
import { OUTSIDE_FILE, STORAGE_DIR, writeOutsideFile, writeStorageFile } from './_harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'

const CUSTOMER_FILE = 'models/user_a/private-part.stl'
const BACKUP_FILE = 'backups/20260101T000000Z/db.sql'
const RECEIPT_FILE = 'orders/order_1/receipts/receipt.pdf'

async function getFile(segments: string[]) {
  const { GET } = await import('../../app/files/[...path]/route')
  const req = new NextRequest(`http://localhost/files/${segments.join('/')}`)
  const res = await GET(req, { params: Promise.resolve({ path: segments }) })
  const body = res.status === 200 ? await res.text() : ''
  return { res, body }
}

test.before(() => {
  writeStorageFile(CUSTOMER_FILE, 'FAKE-CUSTOMER-MODEL-CONTENT')
  writeStorageFile(BACKUP_FILE, 'FAKE-DATABASE-DUMP-CONTENT')
  writeStorageFile(RECEIPT_FILE, 'FAKE-RECEIPT-CONTENT')
  writeOutsideFile('FAKE-FILE-OUTSIDE-STORAGE')
})

test('control: harness uses an isolated storage directory', () => {
  assert.ok(STORAGE_DIR.includes('mkw-sectest-'))
})

test('S1a: anonymous caller must not read a customer model file', { todo: 'S1 confirmed if this fails' }, async (t) => {
  const { res, body } = await getFile(CUSTOMER_FILE.split('/'))
  t.diagnostic(`status=${res.status} cache-control=${res.headers.get('cache-control')} body="${body}"`)
  assert.ok([401, 403, 404].includes(res.status), `anonymous request got HTTP ${res.status} and the file content`)
})

test('S1b: anonymous caller must not read database backups', { todo: 'S1 confirmed if this fails' }, async (t) => {
  const { res, body } = await getFile(BACKUP_FILE.split('/'))
  t.diagnostic(`status=${res.status} body="${body}"`)
  assert.ok([401, 403, 404].includes(res.status), `anonymous request got HTTP ${res.status} and the backup content`)
})

test('S1c: anonymous caller must not read order receipts', { todo: 'S1 confirmed if this fails' }, async (t) => {
  const { res, body } = await getFile(RECEIPT_FILE.split('/'))
  t.diagnostic(`status=${res.status} body="${body}"`)
  assert.ok([401, 403, 404].includes(res.status), `anonymous request got HTTP ${res.status} and the receipt content`)
})

test('S1d: private files must never be served with a public, year-long cache header', { todo: 'S1 confirmed if this fails' }, async (t) => {
  const { res } = await getFile(CUSTOMER_FILE.split('/'))
  const cc = res.headers.get('cache-control') || ''
  t.diagnostic(`cache-control=${cc}`)
  assert.ok(!/public/i.test(cc), `cache-control is "${cc}"`)
})

test('S1e: path traversal outside the storage directory must be refused (handler level)', { todo: 'S1 confirmed if this fails' }, async (t) => {
  const { res, body } = await getFile(['..', path_basename(OUTSIDE_FILE)])
  t.diagnostic(`status=${res.status} body="${body}"`)
  assert.notEqual(res.status, 200, 'a file outside STORAGE_DIR was served')
})

// Verified over real HTTP against `next start`: GET /files/models/..%2f..%2foutside-secret.txt -> 200 with the outside file.
// (Plain `../`, `%2e%2e`, double-encoded and backslash variants are already normalised/blocked by Next.js.)
test('S1f: encoded-slash traversal segment (the shape that reaches the handler over HTTP) must be refused', { todo: 'S1 confirmed if this fails' }, async (t) => {
  const { res, body } = await getFile(['models', `../../${path_basename(OUTSIDE_FILE)}`])
  t.diagnostic(`status=${res.status} body="${body}"`)
  assert.notEqual(res.status, 200, 'a file outside STORAGE_DIR was served')
})

function path_basename(p: string) {
  return p.split('/').pop() as string
}
