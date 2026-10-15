#!/usr/bin/env node
/*
 * Makes customer models private (privacy policy: lib/model-access.ts).
 *
 * The application already treats every customer-owned model as private, whatever is stored in `visibility`,
 * so running this script is NOT required for protection. It only cleans up old records (saved as "public" or
 * "unlisted" before the policy existed) so the database says what the policy enforces.
 *
 *   node scripts/privatize-customer-models.js            DRY RUN (default): only reports, changes nothing
 *   node scripts/privatize-customer-models.js --apply    writes a record of what it changes, then sets visibility = 'private'
 *
 * Options:  --out <dir>   where to write the change record (default: $BACKUP_DIR, else $STORAGE_DIR/backups)
 *
 * Nothing is deleted. Only the `visibility` column of customer-owned models can change, and only to 'private'.
 * Models owned by admin/staff accounts (the shop's own) are never touched.
 */
const { PrismaClient } = require('@prisma/client')
const fs = require('fs')
const path = require('path')

const prisma = new PrismaClient()

// Customer = not an admin/staff account (the same definition as lib/model-access.ts isShopAccount).
const exposedCustomerModels = {
  visibility: { not: 'private' },
  user: { isAdmin: false, role: 'customer' },
}

function maskEmail(email) {
  if (!email) return '(none)'
  const [name, domain] = String(email).split('@')
  return `${name.slice(0, 2)}***@${domain || '?'}`
}

function dbTarget() {
  try {
    const u = new URL(process.env.DATABASE_URL || '')
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`
  } catch {
    return '(DATABASE_URL not set or invalid)'
  }
}

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const outIdx = args.indexOf('--out')
  const outDir = outIdx >= 0 ? args[outIdx + 1] : (process.env.BACKUP_DIR || path.join(process.env.STORAGE_DIR || 'storage', 'backups'))

  console.log(`Database: ${dbTarget()}`)
  console.log(apply ? 'Mode: APPLY (will set visibility to private)' : 'Mode: DRY RUN (no changes will be made)')

  const [total, shopPublished, exposed] = await Promise.all([
    prisma.model.count(),
    prisma.model.count({ where: { visibility: { not: 'private' }, user: { OR: [{ isAdmin: true }, { role: { in: ['admin', 'staff'] } }] } } }),
    prisma.model.findMany({
      where: exposedCustomerModels,
      select: { id: true, title: true, visibility: true, userId: true, user: { select: { email: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  const byVisibility = {}
  const byOwner = new Map()
  for (const m of exposed) {
    byVisibility[m.visibility] = (byVisibility[m.visibility] || 0) + 1
    const key = m.userId
    const entry = byOwner.get(key) || { email: m.user?.email, count: 0 }
    entry.count += 1
    byOwner.set(key, entry)
  }

  console.log(`\nModels in database:                       ${total}`)
  console.log(`Shop models published (left untouched):   ${shopPublished}`)
  console.log(`Customer models not marked private:      ${exposed.length}`)
  for (const [v, n] of Object.entries(byVisibility)) console.log(`   stored as "${v}": ${n}`)
  if (exposed.length > 0) {
    console.log('\nOwners (e-mail masked):')
    for (const [id, o] of [...byOwner.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 20)) {
      console.log(`   ${id}  ${maskEmail(o.email)}  ${o.count} model(s)`)
    }
  }

  if (exposed.length === 0) {
    console.log('\nNothing to do: every customer model is already private.')
    return
  }
  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to set these models to private (a change record is written first).')
    return
  }

  fs.mkdirSync(outDir, { recursive: true })
  const recordPath = path.join(outDir, `privatize-customer-models-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(recordPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    note: 'Records models whose visibility was set to private by scripts/privatize-customer-models.js',
    changes: exposed.map((m) => ({ id: m.id, userId: m.userId, previousVisibility: m.visibility })),
  }, null, 2), { mode: 0o600 })
  console.log(`\nChange record written: ${recordPath}`)

  const result = await prisma.model.updateMany({ where: exposedCustomerModels, data: { visibility: 'private' } })
  console.log(`Updated ${result.count} model(s) to private. No data was deleted.`)
}

main()
  .catch((err) => {
    console.error('privatize-customer-models failed:', err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
