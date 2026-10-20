import { randomUUID } from 'crypto'
import path from 'path'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { formatCurrency, type Currency } from '@/lib/currency'
import { getStripe } from '@/lib/stripe'
import { createAndSendStripeInvoice, createMakerWorksPaymentIntent, normalizeStripePaymentStatus, resolveStripeInvoiceDaysUntilDue } from '@/lib/stripe-payments'
import { capturePayPalOrder, createPayPalOrder } from '@/lib/paypal'
import { z } from 'zod'
import type { ShippingSelection } from '@/types/checkout'
import { normalizeColors } from '@/lib/cartPricing'
import { resolvePublicBaseUrl } from '@/lib/public-url'
import { recordCustomerOrder } from '@/lib/orders'
import { consumeProductTemplateInventoryOnCheckout } from '@/lib/stockworks-product-consumption'
import { sendAdminDiscordNotification } from '@/lib/discord'
import { sendAdminPushNotification } from '@/lib/push'
import { normalizePaymentStatus } from '@/lib/orderworks-status'
import { incrementMetric } from '@/lib/observability-metrics'
import { withRequestObservability } from '@/lib/request-observability'
import { saveBuffer } from '@/lib/storage'
import { buildManufacturabilitySnapshot, renderManufacturabilityReportPdf, type ManufacturabilityModelInput } from '@/lib/manufacturability-report'
import { getOrganizationMembership, isPrivilegedOrgRole } from '@/lib/organizations'
import { adminPaymentNotificationTitle, allowedPaymentMethods, checkoutRoleOf, isPaymentMethodAllowed, isPaymentVerified, productStockMayBeTakenAtCheckout } from '@/lib/order-payment-policy'
import { metadataRecord, updateOrderMetadata } from '@/lib/order-metadata'
import { autoSubmitOrderToPrintLab } from '@/lib/printlab-order-submit'
import { isLegacyCardCheckoutEnabled } from '@/lib/checkout-guards'
import { verifyPaymentIntent } from '@/lib/payment-verification'
import {
  CheckoutQuoteError,
  checkoutItemSchema,
  checkoutShippingSchema,
  computeCheckoutTotals,
  loadCheckoutContext,
  priceLineItems,
} from '@/lib/checkout-quote'

export const dynamic = 'force-dynamic'

const payloadSchema = z.object({
  items: z.array(checkoutItemSchema).min(1),
  shipping: checkoutShippingSchema,
  paymentMethod: z.enum(['card', 'paypal', 'cash', 'invoice', 'po', 'quote', 'comped']).default('card'),
  rush: z.boolean().optional(),
  commit: z.boolean().optional(),
  paymentIntentId: z.string().max(200).optional(),
  paymentDetails: z.object({
    purchaseOrderNumber: z.string().max(120).optional(),
    billingEmail: z.string().email().max(160).optional(),
    billingContact: z.string().max(120).optional(),
    notes: z.string().max(300).optional(),
  }).partial().optional(),
  organizationId: z.string().cuid().optional(),
  projectCode: z.string().max(64).optional(),
  departmentCode: z.string().max(32).optional(),
})

function normalizePaymentStatusForQueue(paymentMethod: string, status: string | null) {
  if (!status) return status
  const normalized = normalizePaymentStatus(status)
  if (!normalized) return null
  if ((paymentMethod === 'card' || paymentMethod === 'paypal') && normalized === 'paid') return 'paid'
  return normalized
}

async function handlePost(req: NextRequest) {
  try {
    const json = await req.json()
    const parsed = payloadSchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid cart payload' }, { status: 400 })
    }

    let paymentMethod = parsed.data.paymentMethod || 'card'
    const commit = Boolean(parsed.data.commit)
    if (commit) {
      incrementMetric('checkout_committed_total')
    } else {
      incrementMetric('checkout_started_total')
    }
    const isCash = paymentMethod === 'cash'
    const providedPaymentIntentId = (parsed.data.paymentIntentId || '').trim()
    const rush = Boolean(parsed.data.rush)
    const paymentDetails = parsed.data.paymentDetails || undefined
    const organizationId = parsed.data.organizationId || undefined
    const projectCode = typeof parsed.data.projectCode === 'string' ? parsed.data.projectCode.trim() : ''
    const departmentCode = typeof parsed.data.departmentCode === 'string' ? parsed.data.departmentCode.trim().toUpperCase() : ''

    const items = parsed.data.items
    const shipping = parsed.data.shipping as ShippingSelection | undefined
    if (isCash && shipping && shipping.method !== 'pickup') {
      return NextResponse.json({ error: 'Cash payments are only available for local pickup' }, { status: 400 })
    }
    for (const entry of items) {
      if (normalizeColors(entry.colors).length === 0) {
        return NextResponse.json({ error: 'Select at least one filament color for each item.' }, { status: 400 })
      }
    }
    if (shipping?.method === 'ship') {
      const addr = shipping.address as ShippingSelection['address']
      if (!addr || !addr.name || !addr.line1 || !addr.city || !addr.postalCode || !addr.country) {
        return NextResponse.json({ error: 'Shipping address is incomplete' }, { status: 400 })
      }
    }
    const ctx = await loadCheckoutContext(items)
    const { userId, user: userForCheckout, isAdmin, models, cfg } = ctx
    const organizationMembership = organizationId && userId
      ? await getOrganizationMembership(userId, organizationId)
      : null
    if (organizationId && !organizationMembership) {
      return NextResponse.json({ error: 'Organization membership is required to use this billing account.' }, { status: 403 })
    }
    if (organizationMembership && organizationMembership.status !== 'active') {
      return NextResponse.json({ error: 'Organization membership is not active.' }, { status: 403 })
    }
    const orgDepartments = Array.isArray((organizationMembership?.organization.procurementConfig as any)?.departments)
      ? (organizationMembership?.organization.procurementConfig as any).departments
      : []
    if (organizationMembership && departmentCode) {
      const allowedDepartment = orgDepartments.some((entry: any) => String(entry?.code || '').trim().toUpperCase() === departmentCode)
      if (!allowedDepartment) {
        return NextResponse.json({ error: 'Selected department is not configured for this organization.' }, { status: 400 })
      }
    }
    const orgRole = organizationMembership?.role || null
    const orgRequiresApproval = Boolean(organizationMembership?.organization.quoteApprovalRequired)

    const publicBaseUrl = resolvePublicBaseUrl(req)
    const checkoutId = randomUUID()
    const { lineItems, itemsTotal, discountSummary, pricingAdjustments } = await priceLineItems(ctx, { items, rush, publicBaseUrl })

    const isAdminFreeCheckout = isAdmin
    // Which payment methods may be used is decided here, from the session, never from the request:
    // guests and customers can pay by card or ask for a quote; cash / invoice / PO / no-charge are administrator-only.
    const checkoutRole = checkoutRoleOf(userForCheckout)
    if (!isPaymentMethodAllowed(paymentMethod, checkoutRole)) {
      return NextResponse.json(
        { error: 'This payment method is not available.', allowedPaymentMethods: allowedPaymentMethods(checkoutRole) },
        { status: 403 },
      )
    }
    if (isAdminFreeCheckout && paymentMethod === 'card') {
      paymentMethod = 'comped'
    }
    const shippingPayload: ShippingSelection = shipping || { method: 'pickup' }
    const {
      currencyCode,
      currency,
      shippingAmountCents,
      shippingRate,
      taxCents,
      estimatedTotalCents,
      amount,
      total,
      isFreeOrder,
    } = await computeCheckoutTotals({ cfg, itemsTotal, isAdminFreeCheckout, shippingPayload })

    if (organizationMembership && orgRole === 'requester' && orgRequiresApproval && paymentMethod !== 'quote') {
      return NextResponse.json({ error: 'Requester role must submit as quote for approver review.' }, { status: 400 })
    }
    const requirePoAboveCents = organizationMembership?.organization.requirePoAboveCents
    if (
      organizationMembership
      && paymentMethod === 'po'
      && typeof requirePoAboveCents === 'number'
      && Number.isFinite(requirePoAboveCents)
      && amount >= requirePoAboveCents
      && !paymentDetails?.purchaseOrderNumber
    ) {
      return NextResponse.json({ error: 'PO number is required for this order amount.' }, { status: 400 })
    }

    // The old card path must not take real money in production (see lib/checkout-guards.ts). Nothing is created or charged.
    if (!isFreeOrder && paymentMethod === 'card' && !isLegacyCardCheckoutEnabled()) {
      incrementMetric('legacy_checkout_blocked_total')
      return NextResponse.json(
        { error: 'Card payment through this checkout is no longer available. Please use the new checkout.', code: 'LEGACY_CARD_CHECKOUT_DISABLED' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      )
    }
    if (!isFreeOrder && paymentMethod === 'card' && !process.env.STRIPE_SECRET_KEY) {
      return NextResponse.json({ error: 'Stripe is not configured' }, { status: 500 })
    }
    if (!isFreeOrder && paymentMethod === 'paypal' && (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET)) {
      return NextResponse.json({ error: 'PayPal is not configured' }, { status: 500 })
    }

    const metadataItems = lineItems.slice(0, 20).map((item) => `${item.qty}x ${item.title}${item.partName ? ` (${item.partName})` : ''}`).join(', ')
    const customerEmail = userForCheckout?.email || undefined
    const customerName = userForCheckout?.name || shippingPayload.address?.name || undefined

    let paymentIntentId: string | null = providedPaymentIntentId || null
    let clientSecret: string | null = null
    let finalizedPaymentStatus: string | null = null
    let stripeChargeId: string | null = null
    let stripeCustomerId: string | null = null
    let stripeReceiptUrl: string | null = null
    let stripeInvoice: {
      invoiceId: string
      customerId: string
      hostedInvoiceUrl: string | null
      invoicePdfUrl: string | null
      invoiceStatus: string | null
    } | null = null
    let stripeInvoiceError: string | null = null
    let paypalCaptureId: string | null = null
    let alreadyRecordedOrderId: string | null = null

    // (step 4.6, S6, F21) the identifier that the browser sends is used ONLY to finalize a card or PayPal payment, where it is verified with Stripe / PayPal. For every other
    // order (no charge, quote, cash, invoice, purchase order) it is ignored: the identifier is made here, so that a `pi_...` chosen by the browser never reaches the order
    // (a column that is looked up, and read from Stripe, by the payment sync).
    if (isFreeOrder) {
      if (!commit) {
        paymentIntentId = `free_preview_${randomUUID()}`
      } else {
        paymentIntentId = `free_${randomUUID()}`
        finalizedPaymentStatus = 'free'
      }
    } else if (paymentMethod === 'card') {
      if (!commit) {
        const intent = await createMakerWorksPaymentIntent({
          amount,
          currency,
          checkoutId,
          userId,
          customerEmail,
          customerName,
          metadata: {
            makerworksCurrency: currencyCode,
            makerworksShippingMethod: shippingPayload.method,
          },
        })
        paymentIntentId = intent.id
        clientSecret = intent.client_secret
      } else {
        if (!paymentIntentId) {
          incrementMetric('payment_failures_total', 1, { source: 'checkout_finalize', reason: 'missing_payment_intent_id' })
          return NextResponse.json({ error: 'paymentIntentId is required to finalize checkout.' }, { status: 400 })
        }
        const stripe = getStripe()
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId)
        if (!intent) {
          incrementMetric('payment_failures_total', 1, { source: 'checkout_finalize', reason: 'payment_intent_not_found' })
          return NextResponse.json({ error: 'Payment intent not found.' }, { status: 404 })
        }
        const allowedStatuses = new Set(['succeeded', 'processing', 'requires_capture'])
        if (!allowedStatuses.has(intent.status)) {
          incrementMetric('payment_failures_total', 1, { source: 'checkout_finalize', reason: intent.status || 'invalid_status' })
          return NextResponse.json({ error: `Payment not completed (${intent.status}).` }, { status: 400 })
        }
        // The payment must be for THIS order's total, in its currency (the same check the webhook applies). A cheaper or foreign
        // PaymentIntent is refused before any order exists.
        const verdict = verifyPaymentIntent({ id: 'checkout', totalCents: amount, currency: currencyCode }, intent as any, { requireOrderReference: false })
        if (verdict.outcome === 'mismatch') {
          incrementMetric('payment_failures_total', 1, { source: 'checkout_finalize', reason: `mismatch_${verdict.reason}` })
          return NextResponse.json({ error: 'This payment does not match the order total.', code: 'PAYMENT_MISMATCH' }, { status: 400 })
        }
        // ...and it can pay for ONE order only. Asking again for the same order (a double click) answers the same way again.
        const usedBy = await prisma.printOrder.findFirst({
          where: { OR: [{ stripePaymentIntentId: intent.id }, { metadata: { path: ['paymentIntentId'], equals: intent.id } }] },
          select: { id: true, userId: true, totalCents: true },
        })
        if (usedBy) {
          if ((usedBy.userId ?? null) !== (userId ?? null) || usedBy.totalCents !== amount) {
            return NextResponse.json({ error: 'This payment was already used for another order.', code: 'PAYMENT_ALREADY_USED' }, { status: 409 })
          }
          alreadyRecordedOrderId = usedBy.id
        }
        clientSecret = intent.client_secret || null
        finalizedPaymentStatus = normalizePaymentStatusForQueue(paymentMethod, normalizeStripePaymentStatus(intent.status) || intent.status || null)
        stripeCustomerId = typeof intent.customer === 'string' ? intent.customer : intent.customer?.id || null
        if (intent.latest_charge && typeof intent.latest_charge !== 'string') {
          stripeChargeId = intent.latest_charge.id
          stripeReceiptUrl = intent.latest_charge.receipt_url || null
        } else if (typeof intent.latest_charge === 'string') {
          stripeChargeId = intent.latest_charge
        }
      }
    } else if (paymentMethod === 'paypal') {
      if (!commit) {
        const order = await createPayPalOrder({
          amountCents: amount,
          currency: currencyCode,
          checkoutId,
        })
        paymentIntentId = order.id
      } else {
        if (!paymentIntentId) {
          incrementMetric('payment_failures_total', 1, { source: 'checkout_finalize', reason: 'missing_paypal_order_id' })
          return NextResponse.json({ error: 'paymentIntentId is required to finalize PayPal checkout.' }, { status: 400 })
        }
        const capture = await capturePayPalOrder({
          orderId: paymentIntentId,
          expectedAmountCents: amount,
          expectedCurrency: currencyCode,
        })
        paymentIntentId = capture.orderId
        paypalCaptureId = capture.captureId
        finalizedPaymentStatus = normalizePaymentStatusForQueue(paymentMethod, capture.paymentStatus)
      }
    } else if (!commit) {
      paymentIntentId = `${paymentMethod}_preview_${randomUUID()}`
    } else {
      paymentIntentId = `${paymentMethod}_${randomUUID()}`
      finalizedPaymentStatus = paymentMethod === 'quote' ? 'quote' : paymentMethod === 'comped' ? 'free' : 'pending'
    }

    if (commit && alreadyRecordedOrderId) {
      // Same payment, same order total, same customer: the order already exists. Nothing is created or announced a second time.
      return NextResponse.json({
        paymentIntentId: paymentIntentId!, clientSecret, currency: currencyCode, amount, total: Number(total.toFixed(2)), lineItems,
        shipping: shippingPayload, shippingRate, paymentMethod, committed: true, discount: discountSummary, adminFreeCheckout: isAdminFreeCheckout,
        estimatedTotal: Number((estimatedTotalCents / 100).toFixed(2)), stripeInvoice: null, stripeInvoiceError: null,
      })
    }
    if (commit) {
      // (lib/order-payment-policy.ts, productStockMayBeTakenAtCheckout: never for a quote request, not yet for a payment still being confirmed)
      const takeProductStockNow = productStockMayBeTakenAtCheckout({ paymentMethod, paymentStatus: finalizedPaymentStatus })
      try {
        if (takeProductStockNow) await consumeProductTemplateInventoryOnCheckout(paymentIntentId!, items)
      } catch (stockErr: any) {
        console.error('Failed to consume StockWorks product inventory', stockErr)
        return NextResponse.json(
          { error: 'Failed to update product inventory in StockWorks. Please retry checkout.' },
          { status: 502 },
        )
      }
      let order: Awaited<ReturnType<typeof recordCustomerOrder>> | null = null
      try {
        order = await recordCustomerOrder({
          paymentIntentId: paymentIntentId!,
          amountCents: amount,
          shippingCents: shippingAmountCents,
          taxCents,
          currency: currencyCode,
          lineItems,
          shipping: shippingPayload,
          paymentMethod,
          userId,
          customerEmail,
          customerName,
          discountPercent: discountSummary.totalPercent ?? null,
          organizationId: organizationMembership?.organization.id || null,
          // (step 4.6, S6, F15) a payment that is not confirmed is not "paid": nothing here invents a status
          paymentStatus: finalizedPaymentStatus || 'pending',
          stripeChargeId,
          stripeCustomerId,
          receiptUrl: stripeReceiptUrl,
          metadata: {
            cartItems: items,
            shipping,
            paymentMethod,
            rush,
            organizationId: organizationMembership?.organization.id || null,
            organizationName: organizationMembership?.organization.name || null,
            organizationRole: orgRole,
            projectCode: projectCode || null,
            departmentCode: departmentCode || null,
            quoteApprovalRequired: orgRequiresApproval,
            demandSurgeMultiplier: pricingAdjustments.demandSurgeMultiplier,
            rushMultiplier: pricingAdjustments.rushMultiplier,
            paymentDetails,
            adminFreeCheckout: isAdminFreeCheckout,
            estimatedTotalCents,
            stripe: {
              paymentIntentId,
              customerId: stripeCustomerId,
              chargeId: stripeChargeId,
              receiptUrl: stripeReceiptUrl,
              paymentStatus: finalizedPaymentStatus,
            },
            paypal: paymentMethod === 'paypal'
              ? {
                orderId: paymentIntentId,
                captureId: paypalCaptureId,
                paymentStatus: finalizedPaymentStatus,
              }
              : undefined,
          },
        })
        if (order && paymentMethod === 'invoice' && amount > 0 && process.env.STRIPE_SECRET_KEY) {
          const invoiceCustomerEmail = paymentDetails?.billingEmail || customerEmail || null
          const invoiceCustomerName = paymentDetails?.billingContact || customerName || null
          const invoiceLineItems = [
            ...lineItems,
            ...(shippingAmountCents > 0
              ? [{
                title: shippingRate?.label || 'Shipping',
                qty: 1,
                lineTotal: Number((shippingAmountCents / 100).toFixed(2)),
              }]
              : []),
          ]
          try {
            stripeInvoice = await createAndSendStripeInvoice({
              orderId: order.id,
              orderNumber: order.orderNumber,
              amountCents: amount,
              currency,
              lineItems: invoiceLineItems,
              userId,
              customerEmail: invoiceCustomerEmail,
              customerName: invoiceCustomerName,
              daysUntilDue: resolveStripeInvoiceDaysUntilDue(),
            })
            // the order's metadata is read again under the lock: payment verification wrote to it a moment ago (receipt, effects, Stripe record)
            const invoiceFacts = stripeInvoice
            await updateOrderMetadata(order.id, (current) => ({
              metadata: {
                ...current,
                stripeInvoice: {
                  invoiceId: invoiceFacts.invoiceId,
                  hostedInvoiceUrl: invoiceFacts.hostedInvoiceUrl,
                  invoicePdfUrl: invoiceFacts.invoicePdfUrl,
                  status: invoiceFacts.invoiceStatus,
                  sentAt: new Date().toISOString(),
                },
                stripe: { ...metadataRecord(current.stripe), customerId: invoiceFacts.customerId },
              },
              columns: {
                stripeCustomerId: invoiceFacts.customerId,
                stripeInvoiceId: invoiceFacts.invoiceId,
                hostedInvoiceUrl: invoiceFacts.hostedInvoiceUrl || undefined,
                invoicePdfUrl: invoiceFacts.invoicePdfUrl || undefined,
              },
              result: undefined,
            }))
            order = await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })
          } catch (invoiceErr: any) {
            stripeInvoiceError = invoiceErr?.message || 'Stripe invoice send failed'
            console.error('Failed to create or send Stripe invoice', invoiceErr)
            await updateOrderMetadata(order.id, (current) => ({
              metadata: { ...current, stripeInvoice: { error: stripeInvoiceError, failedAt: new Date().toISOString() } },
              result: undefined,
            }))
            order = await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })
          }
        }
        if (order) {
          const modelsById = new Map<string, ManufacturabilityModelInput>(
            models.map((model) => [
              model.id,
              {
                id: model.id,
                title: model.title,
                material: model.material,
                sizeXmm: model.sizeXmm,
                sizeYmm: model.sizeYmm,
                sizeZmm: model.sizeZmm,
                printabilityScore: model.printabilityScore ?? null,
                failureRiskScore: model.failureRiskScore ?? null,
                orientationSuggestion: model.orientationSuggestion ?? null,
                supportLikelihood: model.supportLikelihood ?? null,
              },
            ]),
          )
          const reportSnapshot = buildManufacturabilitySnapshot({
            lineItems,
            modelsById,
          })
          const reportPdf = renderManufacturabilityReportPdf(reportSnapshot, `Order ${order.orderNumber ?? order.id}`)
          const reportRelativePath = path.posix.join(
            'orders',
            order.id,
            'reports',
            `manufacturability-${Date.now()}.pdf`,
          )
          await saveBuffer(reportRelativePath, reportPdf)
          await updateOrderMetadata(order.id, (current) => ({
            metadata: {
              ...current,
              artifacts: {
                ...metadataRecord(current.artifacts),
                manufacturabilityReport: {
                  version: 1,
                  filePath: `/${reportRelativePath}`,
                  generatedAt: reportSnapshot.generatedAt,
                  summary: reportSnapshot.summary,
                },
              },
            },
            result: undefined,
          }))
          order = await prisma.printOrder.findUniqueOrThrow({ where: { id: order.id } })
        }
        if (order?.status === 'queued') {
          await autoSubmitOrderToPrintLab(order.id, 'makerworks_checkout')
        }
      } catch (err) {
        console.error('Failed to persist customer order or submit it to PrintLab', err)
      }
      try {
        const itemLines = lineItems.slice(0, 4).map((item) => `${item.qty}x ${item.title}${item.partName ? ` (${item.partName})` : ''}`)
        if (lineItems.length > itemLines.length) {
          itemLines.push(`+${lineItems.length - itemLines.length} more`)
        }
        const totalLabel = formatCurrency(amount / 100, currencyCode as Currency)
        const orderUrl = order && publicBaseUrl ? `${publicBaseUrl}/customer/orders/${order.id}` : undefined
        const adminOrderUrl = order && userId && publicBaseUrl ? `${publicBaseUrl}/admin/users/${userId}/orders/${order.id}` : undefined
        await sendAdminDiscordNotification({
          title: paymentMethod === 'comped' ? 'New no-charge order' : paymentMethod === 'quote' ? 'New quote request' : isPaymentVerified(finalizedPaymentStatus) ? 'New paid order' : 'New order awaiting payment',
          body: [
            `Total: ${totalLabel}`,
            `Fulfillment: ${shippingPayload.method === 'pickup' ? 'pickup' : 'ship'}`,
            `Payment: ${paymentMethod}${finalizedPaymentStatus ? ` (${finalizedPaymentStatus})` : ''}`,
            customerName ? `Customer: ${customerName}` : null,
            customerEmail ? `Email: ${customerEmail}` : null,
            itemLines.length ? `Items: ${itemLines.join(', ')}` : null,
            adminOrderUrl || orderUrl || null,
          ],
          meta: {
            orderId: order?.id,
            orderNumber: order?.orderNumber ?? undefined,
            paymentIntentId,
          },
        })
      } catch (notifyErr) {
        console.error('Admin Discord notification failed for checkout:', notifyErr)
      }
      try {
        const totalLabel = formatCurrency(amount / 100, currencyCode as Currency)
        const baseUrl = publicBaseUrl || (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '')
        const notificationUrl = order && userId
          ? `${baseUrl}/admin/users/${userId}/orders/${order.id}`
          : `${baseUrl}/admin`
        await sendAdminPushNotification({
          title: adminPaymentNotificationTitle(paymentMethod, finalizedPaymentStatus, { created: true }),
          body: `${totalLabel} - ${shippingPayload.method === 'pickup' ? 'pickup' : 'ship'}`,
          url: notificationUrl,
          tag: `payment:${paymentIntentId}`,
          data: { paymentIntentId, paymentMethod, paymentStatus: finalizedPaymentStatus || undefined },
        })
      } catch (notifyErr) {
        console.error('Admin push notification failed for checkout:', notifyErr)
      }
    }

    return NextResponse.json({
      paymentIntentId: paymentIntentId!,
      clientSecret,
      currency: currencyCode,
      amount,
      total: Number(total.toFixed(2)),
      lineItems,
      shipping: shippingPayload,
      shippingRate,
      paymentMethod,
      committed: commit,
      discount: discountSummary,
      adminFreeCheckout: isAdminFreeCheckout,
      estimatedTotal: Number((estimatedTotalCents / 100).toFixed(2)),
      stripeInvoice,
      stripeInvoiceError,
    })
  } catch (err: any) {
    if (err instanceof CheckoutQuoteError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('Stripe checkout error:', err)
    incrementMetric('payment_failures_total', 1, { source: 'checkout_exception', reason: 'exception' })
    return NextResponse.json({ error: err.message || 'Checkout failed' }, { status: 500 })
  }
}

export const POST = withRequestObservability(handlePost, { routeName: '/api/checkout' })