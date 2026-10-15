import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { resolveRateLimitIp } from '@/lib/client-ip'

export type RateLimitConfig = {
  windowMs: number
  max: number
  blockDurationMs: number
}

export type RateLimitResult = {
  allowed: boolean
  remaining: number
  resetAt: Date
  retryAfterSeconds: number | null
}

function readPositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value || '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

function msFromSecondsEnv(name: string, fallbackSeconds: number) {
  return readPositiveInt(process.env[name], fallbackSeconds) * 1000
}

export function getAuthRateLimitConfig(kind: 'login' | 'register' | 'resend'): RateLimitConfig {
  if (kind === 'login') {
    return {
      windowMs: msFromSecondsEnv('AUTH_LOGIN_RATE_WINDOW_SECONDS', 15 * 60),
      max: readPositiveInt(process.env.AUTH_LOGIN_RATE_MAX, 5),
      blockDurationMs: msFromSecondsEnv('AUTH_LOGIN_LOCK_SECONDS', 15 * 60),
    }
  }
  if (kind === 'register') {
    return {
      windowMs: msFromSecondsEnv('AUTH_REGISTER_RATE_WINDOW_SECONDS', 60 * 60),
      max: readPositiveInt(process.env.AUTH_REGISTER_RATE_MAX, 5),
      blockDurationMs: msFromSecondsEnv('AUTH_REGISTER_LOCK_SECONDS', 60 * 60),
    }
  }
  return {
    windowMs: msFromSecondsEnv('AUTH_RESEND_RATE_WINDOW_SECONDS', 60 * 60),
    max: readPositiveInt(process.env.AUTH_RESEND_RATE_MAX, 3),
    blockDurationMs: msFromSecondsEnv('AUTH_RESEND_LOCK_SECONDS', 60 * 60),
  }
}

// The address used to count requests: what a proxy of ours wrote (see lib/client-ip.ts), or "unknown". A header the client can
// set by itself is never believed, so it cannot be used to pick a fresh counter for every request.
export function getRequestIp(req: NextRequest): string {
  return resolveRateLimitIp(req.headers)
}

function retryAfterSeconds(when: Date, now: Date) {
  const diffMs = when.getTime() - now.getTime()
  return diffMs > 0 ? Math.ceil(diffMs / 1000) : 0
}

export async function checkRateLimit(key: string, cfg: RateLimitConfig): Promise<RateLimitResult> {
  const now = new Date()
  const entry = await prisma.rateLimit.findUnique({ where: { key } })
  if (!entry) {
    return {
      allowed: true,
      remaining: cfg.max,
      resetAt: new Date(now.getTime() + cfg.windowMs),
      retryAfterSeconds: null,
    }
  }

  let { count, resetAt, blockedUntil } = entry
  if (resetAt <= now) {
    count = 0
    resetAt = new Date(now.getTime() + cfg.windowMs)
    blockedUntil = null
    await prisma.rateLimit.update({
      where: { key },
      data: { count, resetAt, blockedUntil },
    })
  }

  if (blockedUntil && blockedUntil > now) {
    return {
      allowed: false,
      remaining: 0,
      resetAt,
      retryAfterSeconds: retryAfterSeconds(blockedUntil, now),
    }
  }

  return {
    allowed: true,
    remaining: Math.max(0, cfg.max - count),
    resetAt,
    retryAfterSeconds: null,
  }
}

export async function consumeRateLimit(key: string, cfg: RateLimitConfig): Promise<RateLimitResult> {
  const now = new Date()
  const entry = await prisma.rateLimit.findUnique({ where: { key } })

  if (!entry) {
    const resetAt = new Date(now.getTime() + cfg.windowMs)
    await prisma.rateLimit.create({
      data: {
        key,
        count: 1,
        resetAt,
      },
    })
    return {
      allowed: true,
      remaining: Math.max(0, cfg.max - 1),
      resetAt,
      retryAfterSeconds: null,
    }
  }

  let { count, resetAt, blockedUntil } = entry
  if (resetAt <= now) {
    count = 0
    resetAt = new Date(now.getTime() + cfg.windowMs)
    blockedUntil = null
  }

  if (blockedUntil && blockedUntil > now) {
    return {
      allowed: false,
      remaining: 0,
      resetAt,
      retryAfterSeconds: retryAfterSeconds(blockedUntil, now),
    }
  }

  const nextCount = count + 1
  if (nextCount > cfg.max) {
    blockedUntil = new Date(now.getTime() + cfg.blockDurationMs)
    await prisma.rateLimit.update({
      where: { key },
      data: { count: nextCount, resetAt, blockedUntil },
    })
    return {
      allowed: false,
      remaining: 0,
      resetAt,
      retryAfterSeconds: retryAfterSeconds(blockedUntil, now),
    }
  }

  await prisma.rateLimit.update({
    where: { key },
    data: { count: nextCount, resetAt, blockedUntil },
  })

  return {
    allowed: true,
    remaining: Math.max(0, cfg.max - nextCount),
    resetAt,
    retryAfterSeconds: null,
  }
}

export async function clearRateLimit(key: string) {
  await prisma.rateLimit.deleteMany({ where: { key } })
}

// ---- Fixed-window counter for checkout --------------------------------------------------------------------------------
// ONE atomic statement (insert-or-increment), so simultaneous requests are counted exactly and the first-ever request for a key
// cannot fail on a unique-key race (consumeRateLimit above reads then writes and is meant for sequential logins).
export type FixedWindowConfig = { windowMs: number; max: number }

export function getCheckoutRateLimitConfig(kind: 'quote' | 'session' | 'manual' | 'global' | 'status' | 'status_global'): FixedWindowConfig {
  const windowMs = msFromSecondsEnv('CHECKOUT_RATE_WINDOW_SECONDS', 10 * 60)
  if (kind === 'quote') return { windowMs, max: readPositiveInt(process.env.CHECKOUT_QUOTE_RATE_MAX, 120) }
  // The order status page asks again every few seconds while a payment is being confirmed: its own, larger budgets, so that
  // waiting for a payment never uses up the budget of quotes and checkouts (and the other way round).
  if (kind === 'status') return { windowMs, max: readPositiveInt(process.env.CHECKOUT_STATUS_RATE_MAX, 240) }
  if (kind === 'status_global') return { windowMs, max: readPositiveInt(process.env.CHECKOUT_STATUS_GLOBAL_RATE_MAX, 3000) }
  if (kind === 'session') return { windowMs, max: readPositiveInt(process.env.CHECKOUT_SESSION_RATE_MAX, 20) }
  // A request for a manual quote creates a record a person has to read: few per address and per customer.
  if (kind === 'manual') return { windowMs, max: readPositiveInt(process.env.CHECKOUT_MANUAL_RATE_MAX, 5) }
  // Backstop for the whole shop: a forged X-Forwarded-For header must not let one client create unlimited orders.
  return { windowMs, max: readPositiveInt(process.env.CHECKOUT_GLOBAL_RATE_MAX, 300) }
}

export async function consumeFixedWindow(key: string, cfg: FixedWindowConfig): Promise<RateLimitResult> {
  const resetAt = new Date(Date.now() + cfg.windowMs)
  const rows = await prisma.$queryRaw<Array<{ count: number; resetAt: Date }>>`
    INSERT INTO "RateLimit" ("key", "count", "resetAt", "updatedAt")
    VALUES (${key}, 1, ${resetAt}, now())
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimit"."resetAt" <= (now() AT TIME ZONE 'UTC') THEN 1 ELSE "RateLimit"."count" + 1 END,
      "resetAt" = CASE WHEN "RateLimit"."resetAt" <= (now() AT TIME ZONE 'UTC') THEN ${resetAt} ELSE "RateLimit"."resetAt" END,
      "updatedAt" = now()
    RETURNING "count", "resetAt"`
  const row = rows[0]
  const count = Number(row?.count ?? 1)
  const windowEnd = row?.resetAt ? new Date(row.resetAt) : resetAt
  const allowed = count <= cfg.max
  return {
    allowed,
    remaining: Math.max(0, cfg.max - count),
    resetAt: windowEnd,
    retryAfterSeconds: allowed ? null : Math.max(1, Math.ceil((windowEnd.getTime() - Date.now()) / 1000)),
  }
}
