import { NextResponse } from 'next/server'
import { requireAdmin } from '../_utils'
import { withRequestObservability } from '@/lib/request-observability'
import { validateAdminBootstrapPassword, validateJwtSecret } from '@/lib/security-config'
import { prisma } from '@/lib/db'
import { getTaxConfig } from '@/lib/tax'
import { isOrderWorksInboundEnabled } from '@/lib/orderworks-inbound'
import { describeClientIpSource } from '@/lib/client-ip'

export const dynamic = 'force-dynamic'

type Check = {
  key: string
  label: string
  required: boolean
  ok: boolean
  detail?: string | null
  configurableInApp?: boolean
}

const REQUIRED_CHECKS: Array<{ key: string; label: string; required: boolean; alt?: string[] }> = [
  { key: 'DATABASE_URL', label: 'Database connection', required: true },
  { key: 'JWT_SECRET', label: 'JWT secret', required: true },
]

const OPTIONAL_CHECKS: Array<{ key: string; label: string; required: boolean; alt?: string[] }> = [
  { key: 'STRIPE_SECRET_KEY', label: 'Stripe payments', required: false },
  { key: 'STRIPE_WEBHOOK_SECRET', label: 'Stripe webhook signing secret', required: false },
  { key: 'STRIPE_SHIPPING_RATE_ID', label: 'Stripe shipping rate', required: false },
  { key: 'ORDERWORKS_BASE_URL', label: 'OrderWorks inbound base URL', required: false },
  { key: 'ORDERWORKS_USERNAME', label: 'OrderWorks username', required: false },
  { key: 'ORDERWORKS_PASSWORD', label: 'OrderWorks password', required: false },
  { key: 'STOCKWORKS_BASE_URL', label: 'StockWorks base URL', required: false },
  { key: 'STOCKWORKS_ADMIN_USERNAME', label: 'StockWorks admin user', required: false, alt: ['STOCKWORKS_USERNAME'] },
  { key: 'STOCKWORKS_ADMIN_PASSWORD', label: 'StockWorks admin password', required: false, alt: ['STOCKWORKS_PASSWORD'] },
  { key: 'PRINTLAB_BASE_URL', label: 'PrintLab base URL', required: false, alt: ['BAMBU_VIEW_BASE_URL'] },
  { key: 'PRINTLAB_API_KEY', label: 'PrintLab API key', required: false, alt: ['BAMBU_VIEW_API_KEY'] },
  { key: 'PRINTLAB_SESSION_COOKIE', label: 'PrintLab session cookie', required: false, alt: ['BAMBU_VIEW_SESSION_COOKIE'] },
  { key: 'PRINTLAB_AUTH_HEADER', label: 'PrintLab auth header', required: false, alt: ['BAMBU_VIEW_AUTH_HEADER'] },
  { key: 'VAPID_PUBLIC_KEY', label: 'Push notifications key', required: false, alt: ['NEXT_PUBLIC_VAPID_PUBLIC_KEY'] },
  { key: 'VAPID_PRIVATE_KEY', label: 'Push notifications secret', required: false },
  { key: 'ADMIN_PASSWORD', label: 'Admin bootstrap password', required: false },
]

type EnvSource = Record<string, string | undefined>

function resolveValue(keys: string[], env: EnvSource): string | null {
  for (const key of keys) {
    const value = env[key]
    if (value && value.trim()) return value
  }
  return null
}

const IN_APP_SETTING_KEYS: Record<string, string> = {
  STRIPE_SECRET_KEY: 'stripeSecretKey',
  STRIPE_WEBHOOK_SECRET: 'stripeWebhookSecret',
  STRIPE_SHIPPING_RATE_ID: 'stripeShippingRateId',
  ORDERWORKS_BASE_URL: 'orderworksBaseUrl',
  ORDERWORKS_USERNAME: 'orderworksUsername',
  ORDERWORKS_PASSWORD: 'orderworksPassword',
  STOCKWORKS_BASE_URL: 'stockworksBaseUrl',
  STOCKWORKS_ADMIN_USERNAME: 'stockworksUsername',
  STOCKWORKS_ADMIN_PASSWORD: 'stockworksPassword',
  PRINTLAB_BASE_URL: 'printlabBaseUrl',
  PRINTLAB_API_KEY: 'printlabApiKey',
  PRINTLAB_SESSION_COOKIE: 'printlabSessionCookie',
  PRINTLAB_AUTH_HEADER: 'printlabAuthHeader',
  VAPID_PUBLIC_KEY: 'vapidPublicKey',
  VAPID_PRIVATE_KEY: 'vapidPrivateKey',
}

function buildCheck(
  entry: { key: string; label: string; required: boolean; alt?: string[] },
  env: EnvSource,
  configuredSettings: Set<string> = new Set(),
): Check {
  const keys = [entry.key, ...(entry.alt || [])]
  const value = resolveValue(keys, env)
  const configuredInApp = Boolean(IN_APP_SETTING_KEYS[entry.key] && configuredSettings.has(IN_APP_SETTING_KEYS[entry.key]))
  let detail = value ? null : `Missing ${entry.key}${entry.alt?.length ? ` (or ${entry.alt.join(', ')})` : ''}`
  let ok = Boolean(value) || configuredInApp

  if (!value && configuredInApp) {
    detail = 'Configured in Admin -> Suite setup'
  }

  if (value && entry.key === 'JWT_SECRET') {
    const jwt = validateJwtSecret(value)
    ok = jwt.ok
    detail = jwt.ok ? null : jwt.message || 'Invalid JWT secret'
  } else if (value && entry.key === 'ADMIN_PASSWORD') {
    const adminPassword = validateAdminBootstrapPassword(value)
    ok = adminPassword.ok
    detail = adminPassword.ok ? null : adminPassword.message || 'Invalid admin bootstrap password'
  }

  return {
    key: entry.key,
    label: entry.label,
    required: entry.required,
    ok,
    detail,
    configurableInApp: Boolean(IN_APP_SETTING_KEYS[entry.key]),
  }
}

export function buildEnvChecks(env: EnvSource = process.env, configuredSettings: Set<string> = new Set()): Check[] {
  const requiredChecks = REQUIRED_CHECKS.map((entry) => buildCheck(entry, env, configuredSettings))
  const optionalChecks = OPTIONAL_CHECKS
    .filter((entry) => resolveValue([entry.key, ...(entry.alt || [])], env) || configuredSettings.has(IN_APP_SETTING_KEYS[entry.key]))
    .map((entry) => buildCheck(entry, env, configuredSettings))
  // Selling without a tax configuration is not allowed in production (see lib/tax.ts): required there, informative elsewhere.
  const production = env.NODE_ENV === 'production'
  const taxConfig = getTaxConfig(env)
  const taxChecks: Check[] = production || (env.TAX_MODE || '').trim()
    ? [{
      key: 'TAX_MODE',
      label: 'Tax configuration (required before commercial sales)',
      required: production,
      ok: taxConfig.configured,
      detail: taxConfig.problem,
    }]
    : []
  // The old card checkout must be off in production (S2/S3): a required check that is "not ok" while it is switched on.
  const legacyChecks: Check[] = production
    ? [{
      key: 'LEGACY_CARD_CHECKOUT_ENABLED',
      label: 'Old card checkout must be OFF in production',
      required: true,
      ok: (env.LEGACY_CARD_CHECKOUT_ENABLED || '').trim().toLowerCase() !== 'true',
      detail: (env.LEGACY_CARD_CHECKOUT_ENABLED || '').trim().toLowerCase() === 'true' ? 'Unset LEGACY_CARD_CHECKOUT_ENABLED: the old card path creates orders from the browser and can lose paid orders.' : null,
    }]
    : []
  // The OrderWorks inbound webhook is protected only by a shared secret and carries a payment claim nobody verifies here: OFF in production.
  const orderWorksChecks: Check[] = production
    ? [{
      key: 'ORDERWORKS_INBOUND_ENABLED',
      label: 'OrderWorks inbound webhook must be OFF in production',
      required: true,
      ok: !isOrderWorksInboundEnabled(env),
      detail: isOrderWorksInboundEnabled(env) ? 'Unset ORDERWORKS_INBOUND_ENABLED unless an outside OrderWorks service really sends jobs; the orders it creates always wait for an administrator.' : null,
    }]
    : []
  // Per-address limits (login, registration, checkout) need the real client address, which only a proxy of ours can vouch for.
  // Without TRUSTED_PROXY_HOPS or CLIENT_IP_HEADER every request is "unknown": the address limits then stand aside (checkout) or are
  // shared by everybody (login, registration), so this is a required check in production.
  const clientIp = describeClientIpSource(env)
  const clientIpChecks: Check[] = production
    ? [{
      key: 'TRUSTED_PROXY_HOPS',
      label: 'Client address for rate limits (TRUSTED_PROXY_HOPS or CLIENT_IP_HEADER)',
      required: true,
      ok: clientIp.source !== 'none',
      detail: clientIp.source === 'none'
        ? 'Set TRUSTED_PROXY_HOPS to the number of reverse proxies in front of the app (1 = one), or CLIENT_IP_HEADER to the header your platform always overwrites with the client address. Until then no address is believed and login/registration limits are shared by all visitors.'
        : `Client address read from ${clientIp.detail}.`,
    }]
    : []
  return [...requiredChecks, ...taxChecks, ...legacyChecks, ...orderWorksChecks, ...clientIpChecks, ...optionalChecks]
}

async function handleGet() {
  try { await requireAdmin() } catch (e: any) { return NextResponse.json({ error: e.message || 'Unauthorized' }, { status: e.status || 401 }) }
  const configuredSettings = new Set(
    (await prisma.runtimeSetting.findMany({
      where: { value: { not: null } },
      select: { key: true },
    })).map((row: any) => String(row.key)),
  )
  const checks = buildEnvChecks(process.env, configuredSettings)
  const requiredOk = checks.filter((c) => c.required).every((c) => c.ok)
  return NextResponse.json({ ok: requiredOk, checks })
}

export const GET = withRequestObservability(handleGet, { routeName: '/api/admin/env-check' })
