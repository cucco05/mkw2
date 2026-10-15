#!/usr/bin/env node
/*
 * Finds orders that are in the production queue without a verified payment and puts them back "awaiting payment".
 * (Policy: lib/order-payment-policy.ts — production needs a verified payment or an explicit administrator authorization.)
 *
 *   node scripts/hold-unpaid-orders.js            DRY RUN (default): only reports, changes nothing
 *   node scripts/hold-unpaid-orders.js --apply    writes a record of what it changes, then sets status = 'awaiting_payment'
 *
 * Options:  --out <dir>   where to write the change record (default: $BACKUP_DIR, else $STORAGE_DIR/backups)
 *
 * Only orders still in the 'queued' state are moved (nothing is cancelled or deleted, printers are not touched).
 * Orders already printing / post-process / shipped / completed without a verified payment are REPORTED but never
 * changed: they need a human decision.
 * An order is left alone when its payment is verified (paid / free) or when an administrator authorized production
 * (metadata.productionAuthorization.authorized = true).
 */
const { PrismaClient } = require('@prisma/client')
const fs = require('fs')
const path = require('path')

const prisma = new PrismaClient()

const PRODUCTION_STATUSES = ['queued', 'printing', 'post_process', 'shipped', 'completed', 'in_production', 'ready']
// Candidates are selected in SQL on plain columns; the JSON authorization is checked in code
// (a SQL "NOT (json path = true)" is unknown for rows without that path and would silently drop them).
const candidates = {
  status: { in: PRODUCTION_STATUSES },
  paymentMethod: { not: 'quote' },
  paymentStatus: { notIn: ['paid', 'free'] },
}

function isAuthorized(metadata) {
  const meta = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
  const auth = meta.productionAuthorization
  return Boolean(auth && typeof auth === 'object' && auth.authorized === true && typeof auth.by === 'string' && auth.by)
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
  console.log(apply ? 'Mode: APPLY (queued orders without verified payment go back to awaiting payment)' : 'Mode: DRY RUN (no changes will be made)')

  const found = await prisma.printOrder.findMany({
    where: candidates,
    select: { id: true, orderNumber: true, status: true, paymentMethod: true, paymentStatus: true, totalCents: true, currency: true, metadata: true },
    orderBy: { createdAt: 'asc' },
  })
  const orders = found.filter((o) => !isAuthorized(o.metadata))
  const queued = orders.filter((o) => o.status === 'queued')
  const inProgress = orders.filter((o) => o.status !== 'queued')

  console.log(`\nOrders in production states without verified payment or authorization: ${orders.length}`)
  console.log(`   still queued (will be put on hold):         ${queued.length}`)
  console.log(`   already in progress / finished (report only): ${inProgress.length}`)
  for (const o of orders.slice(0, 30)) {
    console.log(`   #${o.orderNumber ?? '?'} ${o.id}  status=${o.status}  method=${o.paymentMethod}  payment=${o.paymentStatus}  total=${(o.totalCents / 100).toFixed(2)} ${o.currency}`)
  }
  if (orders.length > 30) console.log(`   ... and ${orders.length - 30} more`)

  if (queued.length === 0) {
    console.log('\nNothing to change.')
    return
  }
  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to put the queued orders on hold (a change record is written first).')
    return
  }

  fs.mkdirSync(outDir, { recursive: true })
  const recordPath = path.join(outDir, `hold-unpaid-orders-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(recordPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    note: 'Orders moved from queued to awaiting_payment by scripts/hold-unpaid-orders.js',
    changes: queued.map((o) => ({ id: o.id, previousStatus: o.status, paymentStatus: o.paymentStatus, paymentMethod: o.paymentMethod })),
  }, null, 2), { mode: 0o600 })
  console.log(`\nChange record written: ${recordPath}`)

  const result = await prisma.printOrder.updateMany({
    where: { id: { in: queued.map((o) => o.id) }, status: 'queued' },
    data: { status: 'awaiting_payment' },
  })
  console.log(`Moved ${result.count} order(s) to awaiting_payment. Nothing was cancelled or deleted.`)
}

main()
  .catch((err) => {
    console.error('hold-unpaid-orders failed:', err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
