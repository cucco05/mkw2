import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('global layout includes r3Dr parent-company branding', async () => {
  const layout = await readFile('app/layout.tsx', 'utf8')
  const brand = await readFile('lib/brand.ts', 'utf8')
  const globals = await readFile('app/globals.css', 'utf8')

  assert.match(brand, /PARENT_COMPANY_NAME = 'r3Dr'/)
  assert.match(brand, /PARENT_COMPANY_URL = 'https:\/\/r3dr\.ca'/)
  assert.match(layout, /An r3Dr company/)
  assert.match(layout, /href=\{PARENT_COMPANY_URL\}/)
  assert.match(layout, />r3dr\.ca<\/a>/)
  assert.match(layout, /mailto:contact@r3dr\.ca/)
  assert.doesNotMatch(layout, /r3dr\.com/)
  assert.doesNotMatch(layout, /parent-company-strip/)
  assert.match(layout, /<footer className="footer-shell app-footer/)
  assert.match(layout, /className="footer-business-grid"/)
  // The footer classes the layout uses are still styled. The exact look (the rounded corners that an older design gave `.footer-shell`) is a design choice, not branding, and is not pinned here.
  assert.match(globals, /\.footer-shell\s*\{[^}]*border-top:/s)
  assert.match(globals, /\.footer-business-grid\s*\{[^}]*display:\s*grid/s)
  assert.match(layout, /MakerWorks 3D Print Lab/)
})
