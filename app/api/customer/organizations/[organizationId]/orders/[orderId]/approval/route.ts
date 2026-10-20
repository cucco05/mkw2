import { NextRequest, NextResponse } from 'next/server'
import { viewerGuards } from '@/lib/viewer'
import { rejectCrossOrigin } from '@/lib/csrf'
import { getOrganizationMembership, isPrivilegedOrgRole } from '@/lib/organizations'
import { ORG_APPROVAL_STATUSES, isPaymentVerified } from '@/lib/order-payment-policy'
import { ProductionReleaseError, releaseErrorResponse, withReleaseLock } from '@/lib/production-release'
import { withFinancialRevision } from '@/lib/financial-revision'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ organizationId: string; orderId: string }> }

export async function POST(req: NextRequest, { params }: Context) {
  const { organizationId, orderId } = await params
  // the shared resolver of the person making the request (the same one the administrator routes use; tests replace it)
  const viewer = await viewerGuards.getViewer()
  const userId = viewer?.id
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const crossOrigin = rejectCrossOrigin(req)
  if (crossOrigin) return crossOrigin

  const membership = await getOrganizationMembership(userId, organizationId)
  if (!membership) return NextResponse.json({ error: 'Organization not found.' }, { status: 404 })
  if (!isPrivilegedOrgRole(membership.role)) {
    return NextResponse.json({ error: 'Only approvers/owners can action org quotes.' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : ''
  if (!['approve', 'reject'].includes(action)) {
    return NextResponse.json({ error: 'Invalid action.' }, { status: 400 })
  }
  const note = typeof body.note === 'string' ? body.note.trim() : ''

  try {
    // Decided and written under the lock on the order, on the facts read after it (the payment may have changed a moment ago).
    const updated = await withReleaseLock(orderId, 'org-approval', async ({ tx, order, decision }) => {
      if (order.organizationId !== organizationId) throw new ProductionReleaseError(404, 'NOT_FOUND', 'Order not found.')
      // An approver answers a quote that is waiting for the answer. Anything else (already printing, finished, cancelled...) is not theirs to turn around.
      if (!ORG_APPROVAL_STATUSES.includes(order.status)) {
        throw new ProductionReleaseError(409, 'ORDER_NOT_AWAITING_APPROVAL', `This order is "${order.status}": it is not waiting for an approval.`, { releaseState: decision.state })
      }
      // Rejecting cancels the order: not one that has money on it or on its way, or a payment under review.
      if (action === 'reject') {
        const hasMoney = isPaymentVerified(order.paymentStatus) || Boolean(order.paidAt) || Boolean(order.paymentReviewReason)
          || order.paymentAttempts.some((attempt) => attempt.status === 'paid' || attempt.status === 'processing')
          || ['payment_processing', 'payment_hold', 'payment_active'].includes(decision.state)
        if (hasMoney) {
          throw new ProductionReleaseError(409, 'ORDER_HAS_PAYMENT', 'A payment exists for this order (or is being confirmed or reviewed): it can not be cancelled by rejecting the quote. Ask an administrator.', { releaseState: decision.state })
        }
      }
      const metadata = {
        ...(order.metadata && typeof order.metadata === 'object' && !Array.isArray(order.metadata) ? order.metadata as Record<string, unknown> : {}),
        orgApproval: {
          action,
          note: note || null,
          approvedByUserId: userId,
          approvedAt: new Date().toISOString(),
        },
      }
      // (step 4.6, S6, P2b) rejecting a quote cancels the order: the financial revision goes up in this same UPDATE (an authorization given before no longer holds)
      const row = await tx.printOrder.update({
        where: { id: order.id },
        data: withFinancialRevision(order, {
          // Approving a quote does not start production: the order still needs a released payment (or an administrator's
          // explicit authorization) before it can enter the production queue.
          status: action === 'approve' ? (decision.released ? 'queued' : 'awaiting_payment') : 'cancelled',
          metadata,
        }),
        select: { id: true, status: true },
      })
      if (action === 'approve') {
        await tx.printOrderApprovalRequest.updateMany({
          where: { orderId: order.id, status: 'pending' },
          data: { status: 'approved', responseNote: note || 'Approved by organization approver.', respondedAt: new Date() },
        })
      }
      return row
    }, { require: 'none' })

    return NextResponse.json({ order: updated })
  } catch (error) {
    const refusal = releaseErrorResponse(error)
    if (refusal) return refusal
    throw error
  }
}
