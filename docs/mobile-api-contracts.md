# Mobile API Contracts

MakerWorks remains the source of truth for web, Docker/PWA, and native clients. Native clients should call these authenticated JSON routes and reuse existing mutation routes instead of rendering WKWebView pages or scraping server-rendered HTML.

## New Contracts

### Admin Users

`GET /api/admin/users?q={search}`

Auth: admin or staff via the existing admin guard.

Response:

```json
{
  "users": [
    {
      "id": "user_123",
      "email": "customer@example.com",
      "name": "Customer Name",
      "emailVerified": true,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "registrationSource": "invite",
      "registrationIp": "203.0.113.10",
      "registrationUserAgent": "Browser",
      "lastLoginAt": "2026-01-02T00:00:00.000Z",
      "lastLoginIp": "203.0.113.11",
      "lastLoginUserAgent": "Browser",
      "profile": { "slug": "customer", "avatarImagePath": "/avatars/customer.webp" },
      "badges": [{ "achievementId": "ach_1", "achievement": { "key": "comments_1" } }],
      "discountPercent": 10,
      "isFriendsAndFamily": false,
      "friendsAndFamilyPercent": 0,
      "isSuspended": false,
      "isAdmin": false,
      "role": "customer",
      "_count": { "orders": 2 },
      "orderCount": 2,
      "totalSpentCents": 3456
    }
  ],
  "summary": {
    "totalUsers": 1,
    "verifiedUsers": 1,
    "suspendedUsers": 0,
    "adminUsers": 0,
    "newUsers30d": 1,
    "activeUsers30d": 1,
    "customerOrders": 2,
    "orderingUsers": 1,
    "customerRevenueCents": 3456,
    "statCards": []
  },
  "query": { "q": "customer" }
}
```

Search matches the web panel fields: `id`, `name`, `email`, `role`, and `profile.slug`.

`GET /api/admin/users/{id}`

Auth: admin or staff via the existing admin guard.

Response: `{ user, profile, badges, summary }`, where `user` includes account metadata and role flags, `profile` includes editable profile fields, `badges` includes achievement data, and `summary` includes `orderCount` and `totalSpentCents`.

Existing mutation routes remain the source of truth:

- `PATCH /api/admin/users/{id}`
- `DELETE /api/admin/users/{id}`
- `POST /api/admin/users/discount`
- `POST /api/admin/users/invite`

### Customer Orders

`GET /api/customer/orders?limit=30`

Auth: signed-in user. Uses `listOrdersForUser`, including organization-visible orders already available to the web page.

Response: `{ orders, query: { limit } }`. Each order is the **customer view** (`lib/customer-order-view.ts`, an allow list): no Stripe identifiers, checkout key, guest-access hash, payment-sync fields, accounting fields, printer assignment or `metadata`. A reprint request shows `paymentStatus: "quote"`, `totalCents: 0` and must be displayed as "price to be quoted" (never as free).

`GET /api/customer/orders/{orderId}`

Auth: signed-in user with direct or organization access to the order. Uses `getOrderForUser` and `getOrderProductionDetail`.

Response: `{ order, production, derived }`, where `order` is the same customer view (without `metadata`; internal markers are never returned) and `derived` includes `manufacturabilityReport`, `organizationId`, `estimateFeedback`, `failureRecovery`, and `pendingApprovalRequests`.

Existing actions remain:

- `POST /api/customer/orders/{orderId}/messages`
- `POST /api/customer/orders/{orderId}/revision`
- `POST /api/customer/orders/{orderId}/reprint` – creates (or returns the already open) **request for a new quote**: `{ order: { id, orderNumber, status }, created }`; `409 REPRINT_NOT_ALLOWED` unless the order was produced; same-origin requests only; rate limited (`429`).
- `GET /api/customer/orders/{orderId}/receipt`
- `GET /api/customer/orders/{orderId}/manufacturability-report`

### Checkout status

`GET /api/checkout/status?order={orderId}[&return=1]`

Auth: the signed-in owner of the order, or a guest whose browser holds that order's access cookie (`mw_checkout`). Everything else (including a valid order id on its own) gets the same `404`.

Response: `{ orderNumber, state, totalCents, currency, final, pollAfterMs }`, where `state` is `pending | confirming | paid | attention | canceled`. `pollAfterMs` is a number (ask again after that long) only for `confirming`. `return=1` only means "the user is back from the payment page"; it can never produce `paid`. `429` carries `Retry-After`. Never cached (`Cache-Control: no-store, private`). No personal data, payment identifiers or internal reasons are ever returned.

The web return page (`/checkout/success`, step 4.3) is a client of this endpoint and nothing else: it asks once when the user is back, then again only while `state` is `confirming` (waits at least `pollAfterMs`, with growing pauses, stops after about two minutes, nothing while the app is in the background, honours `Retry-After`), and treats any answer that does not have exactly the five fields above as an error, never as a state. A mobile app should do the same: never show "paid" from a deep link or a redirect alone, only from `state: "paid"`. No new endpoint was added in step 4.3.

### Checkout quote and session

`POST /api/checkout/quote` (open to guests; JSON body `{ items, shipping: { method: "pickup" | "ship" }, rush }`; no price, total or status may be sent) and `POST /api/checkout/session` (same cart plus `checkoutKey` and `expectedTotalCents`; same-origin only).

Quote response (whole cents): `{ currency, items[{ title, partName, qty, material, colors, finish, unitPriceCents, lineTotalCents, undiscountedLineTotalCents, discountPercent, leadTimeHours }], itemsTotalCents, discountPercent, shipping: { method, cents, label }, shippingOffer: { shipAvailable, shipCents, shipLabel, shipCountries }, tax: { mode, ratePercent, cents, addedToTotal }, totalCents, canCheckout, unavailableReason }`. `priceMultiplier` in a cart line is ignored: the server works it out.

Errors: `{ error, code, details? }`. Codes: `ITEM_UNAVAILABLE` (`details.itemIndexes` / `itemIndex`: positions in the cart; a customer's private model, a missing model, an unknown/switched-off product look identical), `OPTION_UNAVAILABLE`, `COLOR_REQUIRED`, `COLOR_INVALID`, `COLOR_NOT_ALLOWED`, `COLOR_UNAVAILABLE`, `ITEM_NOT_PRICEABLE` (422), `MINIMUM_ORDER` (`details.minimumCents`, `details.currency`), `TOTAL_INVALID`, `INVALID_REQUEST`, `RATE_LIMITED` (429, `retryAfterSeconds`); session only: `PRICE_CHANGED` (409, `currentTotalCents`), `CHECKOUT_KEY_CONFLICT`, `ORDER_NOT_PAYABLE` (`orderId`, `reason`), `PAYMENT_IN_PROGRESS` (409, `orderId`, `orderNumber`: a payment for exactly this cart is being confirmed or waits for a person - do not pay again, show the status of that order), `TOO_MANY_ATTEMPTS`, `CHECKOUT_DISABLED`, `PAYMENTS_NOT_CONFIGURED`, `TAX_NOT_CONFIGURED`, `SHIPPING_NOT_CONFIGURED`, `CHECKOUT_UNAVAILABLE`, `PAYMENT_PROVIDER_UNAVAILABLE`, `TEMPORARY_ERROR`. A client must empty the cart only after `GET /api/checkout/status` says `paid` for the order it sent to the payment page and the cart is still the one that was sent (never on `confirming` or `attention`, never on a redirect alone). The server refuses a second payment for the same cart while one is being confirmed (`PAYMENT_IN_PROGRESS`); for the same customer (signed in, or a guest with the order's access cookie) an order that is not paid yet is reused with the same payment page. A successful session answer holds Stripe's hosted page `url`: a client must only open `https://checkout.stripe.com/…`.

### Customer Workspaces

`GET /api/customer/workspaces`

Auth: signed-in user. Uses `listProjectWorkspacesForUser`.

Response: `{ workspaces }`.

`GET /api/customer/workspaces/{organizationId}/{projectCode}`

Auth: signed-in organization member. Uses `getProjectWorkspaceDetailForUser`, then returns active members and procurement policy shown on the web detail page.

Response: `{ workspace, members, policy }`.

## Audit Matrix

### Admin

- `/admin/users`: covered by `GET /api/admin/users` and existing per-user mutation routes.
- `/admin/users/{userId}/orders`: still server-rendered. Native contract needed: `GET /api/admin/users/{userId}/orders` returning `{ user, orders, legacyJobs }`.
- `/admin/users/{userId}/orders/{orderId}`: still server-rendered. Native contract needed: `GET /api/admin/users/{userId}/orders/{orderId}` returning `{ user, order, production, derived }`.
- `/admin/users/{userId}/orders/{orderId}/ticket`: still server-rendered print ticket. Native contract can reuse the same order detail payload plus ticket-specific presentation fields.
- `/admin/analytics`: covered by `GET /api/admin/analytics`.
- `/admin/catalog`: covered by `GET/PATCH /api/admin/catalog`.
- `/admin/featured`: covered by `GET/POST /api/admin/featured`.
- `/admin/home-comments`: covered by `GET /api/admin/home-comments` and `PATCH/DELETE /api/admin/home-comments/{id}`.
- `/admin/inventory`: covered by StockWorks inventory routes under `/api/stockworks/*`.
- `/admin/jobs`: covered by `GET /api/admin/production` for production queue data and `/api/admin/orderworks/jobs` for legacy jobs.
- `/admin/production`: covered by `GET /api/admin/production`.
- `/admin/products`: covered by `GET/POST /api/admin/products` and `GET/PATCH/DELETE /api/admin/products/{id}`.
- `/admin/site-config`: covered by `GET/PATCH /api/admin/site-config`.
- `/admin/suite-setup`: covered by `GET/PATCH /api/admin/suite-settings` and related test/token routes.
- `/admin/processing-queues`: covered by `GET /api/admin/processing-queues` and retry/requeue actions.
- `/admin/backup-tools` and `/admin`: partially covered by backup/restore routes; native dashboard contract should be `GET /api/admin/dashboard` returning counts and pending restore state.
- `/admin/failure-photos`: covered by `GET/POST /api/failure-photos`.
- `/admin/demand-forecasting`, `/admin/batch-optimization`, `/admin/material-optimization`, `/admin/fleet-intelligence`: server-rendered intelligence pages. Native contracts should be added per page if these are in the SwiftUI scope.

### Customer

- `/customer/orders`: covered by `GET /api/customer/orders`.
- `/customer/orders/{orderId}`: covered by `GET /api/customer/orders/{orderId}` plus existing action routes.
- `/customer/workspaces`: covered by `GET /api/customer/workspaces`.
- `/customer/workspaces/{organizationId}/{projectCode}`: covered by `GET /api/customer/workspaces/{organizationId}/{projectCode}`.
- `/customer/portal`: mostly upload configuration and existing upload actions. Native contract needed if the iOS app will render this dashboard: `GET /api/customer/portal` returning direct-upload URL, upload byte limits, and visibility permissions.

### Settings

- `/settings/profile`: covered by `GET/PATCH /api/profile`.
- `/settings/organizations`: covered by `/api/customer/organizations`, `/api/customer/organizations/{id}`, `/api/customer/organizations/{id}/members`, and `/api/customer/organizations/{id}/usage`.
- `/settings/account`: covered by `/api/me`, `/api/account/email/request`, `/api/account/password`, `/api/account/sessions/logout-all`, and `/api/logout`. Native clients should use these action routes directly.

### Manual quote request (step 4.2-ter)

`POST /api/checkout/manual-request` (open to guests, same-origin only, rate limited). Body: the same `items` / `shipping` / `rush` as the quote, plus `contact: { email, name? }` (the email is required for a guest; a signed-in customer may omit it) and `note?` (≤ 1000 characters). **No price, total, status or reason may be sent** (the body is strict). The server prices the cart again: a cart that CAN be paid online is refused (`409 REVIEW_NOT_REQUIRED`). Success: `201 { ok: true, orderNumber, created: true }` (`200 … created: false` for the same person, cart and day). The order is `awaiting_review`, payment `quote`, total 0: display it as "price to be quoted", never as free, and never offer payment.

The quote and the session answer `422 { code: "MANUAL_REVIEW_REQUIRED", details: { itemIndexes, reviews: [{ itemIndex, reasons: [{ code, sizeMm?, usableMm?, value? }] }] } }` when a line cannot be made automatically (unknown or unavailable material or finish, model larger than the printer, size not reliable): show the reasons per line, no price, no payment, and offer the manual request. Reason codes: `NO_ACTIVE_MACHINE`, `MATERIAL_UNKNOWN`, `MATERIAL_NOT_AVAILABLE`, `FINISH_UNKNOWN`, `FINISH_NOT_AVAILABLE`, `SIZE_UNKNOWN`, `UNIT_NOT_MM`, `SIZE_IMPLAUSIBLE`, `TOO_LARGE`, `TOO_THIN`, `SUPPORT_HEAVY`. New refusals: `BELOW_PAYMENT_MINIMUM` (400, `details.minimumCents`, `details.totalCents`: the smallest card payment, measured on the total), `MINIMUM_ORDER` also carries `details.itemsTotalCents`; with `canCheckout: false` / session `503`: `MINIMUM_ORDER_NOT_CONFIGURED`, `CURRENCY_NOT_CONFIGURED`, `CURRENCY_INVALID`, `CURRENCY_MISMATCH`. A client must never turn `canCheckout: false` or any of these refusals into a payable cart.

### Printer machines (admin, step 4.2-ter)

`GET|POST /api/admin/printer-machines`, `PATCH /api/admin/printer-machines/{id}`: administrators only (not staff). Machine: `{ key, label, isActive, buildXmm, buildYmm, buildZmm, marginXYmm, marginZmm, supportMarginXYmm, nozzleDiameterMm, minFeatureMm?, maxSupportRatio?, allowedMaterials[], allowedFinishes[], notes? }`. `GET` also returns `options: { materials, finishes }`. Every change is recorded in the admin audit log. Machines are switched off, not deleted.
