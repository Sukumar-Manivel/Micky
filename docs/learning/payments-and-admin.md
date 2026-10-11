# Payments, earnings and admin

How Micky takes money from news channels, keeps each uploader's share, pays uploaders out, and how admins moderate the platform. Code lives in `apps/api/src/orders`, `src/earnings`, `src/admin` and `src/reports`.

## What was built and why

| Module | Routes | Job |
|---|---|---|
| **OrdersModule** | `POST /orders`, `/orders/:id/verify`, `/orders/:id/mock-pay`, `GET /orders`, `/orders/:id`, `/orders/:id/download`, `POST /payments/razorpay/webhook`, plus the `commerce` BullMQ queue (refund jobs, housekeeping) | A channel buys a licence. The payment is confirmed and the uploader is credited. The buyer downloads the original. Money that cannot be kept is refunded; refunds and chargebacks made later revoke the sale. |
| **EarningsModule** | `PUT /me/payout-details`, `GET /me/earnings`, `/me/ledger`, `/me/sales`, `POST`/`GET /me/payouts` | The uploader sees their money and asks to be paid by UPI. |
| **AdminModule** | `/admin/*` | Stats, the review queue, approving news channels, paying out, the refund queue (with retry), disputed orders, ledger adjustments, and handling takedown reports. |
| **ReportsModule** | `POST /reports` | A public form for complaints and takedown requests (required by the IT Rules). |

### The big design decision: collect, keep a ledger, pay out in batches

The first plan used **Razorpay Route**, which splits every payment automatically between the platform and the uploader. Since the RBI Payment Aggregator Directions (September 2025), Razorpay only turns on Route for businesses with more than ₹40 lakh turnover. A new startup cannot use it.

What we do instead:

1. Collect the **full** payment into the platform's Razorpay account.
2. Record the uploader's share (70% by default) as a `SALE_CREDIT` row in an **append-only ledger**. The credit is **held** for 7 days (`EARNINGS_HOLD_DAYS`) before it can be withdrawn, because card payments can be refunded or charged back after the sale.
3. The uploader asks for a payout from the **available** part of the balance. We write a `PAYOUT_DEBIT` row straight away, so the same money can't be asked for twice.
4. An admin pays a **batch** of requests by UPI, then marks each one paid with the bank reference (UTR). If a payout can't be made, rejecting it writes a `PAYOUT_REVERSAL` that gives the money back.

The ledger is the source of truth. You can rebuild any balance, at any moment in time, from its rows. A refund or chargeback adds a negative `SALE_REVERSAL`; a won chargeback adds a `SALE_REINSTATEMENT`; an admin correction is an `ADJUSTMENT` with a mandatory note.

## How a purchase flows through the code

```
 Channel's browser            Micky API                          Razorpay
 ─────────────────            ──────────────                          ────────
 1. Click "Buy"     ──POST /orders──▶ OrdersController.create
                                      OrdersService.create
                                       ├─ media APPROVED? licence rules OK? (409 if not)
                                       ├─ reuse a CREATED order < 30 min old, or:
                                       ├─ amount = priceFor(); split = splitSale()
                                       ├─ provider.createOrder() ────────────────▶ orders.create
                                       │                         ◀──── order_XXXX ──┘
                                       └─ INSERT orders (CREATED)
                    ◀── CheckoutView {orderId, amount, razorpay:{keyId, orderId}}
 2. Razorpay Checkout opens, the buyer pays ───────────────────────────────▶ (card/UPI)
                    ◀── {razorpay_payment_id, razorpay_signature} ─────────────────┘
 3. POST /orders/:id/verify ─▶ OrdersService.verify
                                ├─ HMAC(stored order id | payment id, key_secret) == signature?
                                ├─ provider.fetchPayment() ─────────────────▶ payments.fetch
                                │   captured? same order? same amount, INR?
                                │   (only "authorized" → return CREATED; the webhook grants it)
                                └─ markPaid(orderId, payment)  ◀────┐
                    ◀── OrderView (PAID) or 409 "refund requested"  │  same method
                                                                    │
 4. (seconds later, server to server)                               │
                     POST /payments/razorpay/webhook ◀──────────────┼──── order.paid /
                       RazorpayWebhookController.handle             │     payment.captured
                        ├─ HMAC(raw body, webhook_secret) == X-Razorpay-Signature? else 400
                        ├─ INSERT webhook_events(event id, sha256(body)) ON CONFLICT DO NOTHING
                        │    └─ already there → 200 "already processed"
                        └─ find order by providerOrderId → markPaid ─┘
                           (also: payment.failed, refund.processed/failed, payment.dispute.*)
                     ──▶ 200 {received: true}

 5. GET /orders/:id/download ─▶ signed URL to /files/download/:token (15 min), downloadCount + 1
```

Steps 3 and 4 both happen for every payment, in either order, sometimes at the same moment. The browser may also never reach step 3, because the tab was closed. That is why everything funnels into **one idempotent method, `OrdersService.markPaid`**.

### Inside `markPaid` (one database transaction)

1. `SELECT ... FROM media WHERE id = ? FOR UPDATE`. This locks the media row, so any other payment for the same media waits here.
2. Re-read the order. If it is already `PAID` by this payment, return it unchanged. If it was paid by a *different* payment, the buyer was charged twice: record a refund for the second payment.
3. Was the payment made before `expires_at`? Do the licence rules (`licenceBlocker`) still hold? If not, the money cannot be kept: set the order to `REFUND_PENDING` with a `status_reason`, and insert a `refunds` row **in the same transaction**.
4. `UPDATE orders SET status='PAID' ... WHERE id = ? AND status <> 'PAID'`.
5. `INSERT INTO ledger_entries (SALE_CREDIT, available_at = paid_at + 7 days) ... ON CONFLICT DO NOTHING`. The partial unique index `ledger_one_credit_per_order_idx` allows at most one sale credit per order.
6. For an exclusive licence, set `media.exclusive_sold = true`.

After the commit, a refund job is queued if step 2 or 3 recorded one. If anything throws, the whole transaction rolls back: you can never end up with a paid order and no credit, or a refund decision without a refund row.

### Refunds (`orders/refunds.service.ts`, `orders/commerce.processor.ts`)

"Record, then act":

```
markPaid tx:  orders → REFUND_PENDING, INSERT refunds(payment id UNIQUE, PENDING)   COMMIT
after commit: queue.add('refund', { paymentId }, { jobId: 'refund-<paymentId>', attempts: 6, backoff 30 s… })
job:          refunds row still PENDING? → attempts + 1
              provider.refund({ paymentId, amount, receipt: refunds.id })
                ├─ processed → refunds PROCESSED + order REFUNDED
                ├─ pending   → store the gateway refund id; the refund.processed webhook finishes it
                └─ throws    → BullMQ retries; after the 6th try: refunds FAILED, order REFUND_FAILED
admin:        POST /admin/refunds/:id/retry → back to PENDING, queued again
housekeeping: every 5 min: expire unpaid checkouts, re-queue refunds stuck in PENDING
```

Three layers make "refund this payment exactly once" hold even if the job runs twice: the unique `provider_payment_id` on `refunds`, the job id derived from the payment id, and the gateway call itself, which first looks for an existing refund carrying our receipt. The mock provider implements refunds too (instantly `processed`), so the whole flow runs in tests and demos.

### After the sale: refunds made elsewhere and chargebacks

A refund made in the Razorpay dashboard arrives as `refund.processed` for a payment we never asked to refund. A chargeback arrives as `payment.dispute.created`. Both run `OrdersService.revoke` in one transaction: lock the order, set `REFUNDED` or `DISPUTED`, and write a negative `SALE_REVERSAL` equal to the credit. Downloads check `status = 'PAID'` on every request, so the licence is revoked at once, including links already handed out. `payment.dispute.won` sets the order back to PAID and writes a `SALE_REINSTATEMENT`. The unique index on `(order_id, type)` means each of these rows can exist at most once per order, however many times the webhook arrives.

### Checkout expiry

A checkout can be paid for 30 minutes (`orders.expires_at`); the quoted price is honoured until then. Housekeeping marks unpaid ones `EXPIRED`. A payment is judged by **when the buyer paid** (the gateway's `created_at`), not by when we hear about it, so a delayed webhook for a payment made in time still grants the licence, and a payment made after expiry is refunded.

### Licence rules (`orders/licence-rules.ts`)

- The media must be `APPROVED`.
- A channel can buy each media only once.
- After an exclusive sale, nobody else can buy anything.
- Exclusive can only be bought if there are **no** paid orders yet.

The same pure function runs when the order is created (to give a clear 409 early) and again under the lock when it is paid (to be correct).

### Payouts (`EarningsService.requestPayout`)

```
BEGIN
  SELECT pg_advisory_xact_lock(hashtext(:uploaderId))   -- one payout at a time per uploader
  UPI ID set?            else 400
  UPI ID changed less than PAYOUT_COOLDOWN_HOURS ago?   else 400
  available = SUM(amount) of rows WHERE available_at <= now()     (earnings/ledger.ts)
  amount ≤ available and ≥ MIN_PAYOUT_PAISE?   else 400
  INSERT payouts (REQUESTED)
  INSERT ledger_entries (PAYOUT_DEBIT, -amount)
COMMIT                                                    -- lock released here
```

### Changing the payout destination (`PUT /me/payout-details`)

Where money goes is the most valuable thing to an attacker holding a stolen session. So changing the UPI ID:
- needs the **current password** (403 if wrong, 10 attempts a minute), so a stolen access token is not enough;
- starts a **cooling-off** (`PAYOUT_COOLDOWN_HOURS`, 24): no payout can be requested until it ends, which gives the real owner time to notice. The earnings page shows the change and the pause;
- is **audited** in `payout_detail_changes` (old and new ID, IP, user agent), and admins see "UPI ID changed recently" on payouts requested within 7 days of a change.

Setting the first UPI ID needs the password but has no pause: there is no earlier destination to divert money from. It takes the same advisory lock as payouts, so a change and a payout request never interleave.

### Database guarantees (migration `0001`)

The application already gets these right; the constraints make them hold when a future change gets them wrong:
- `CHECK (amount > 0 AND platform_fee + uploader_share = amount AND currency = 'INR')` on orders, and `amount > 0` on payouts and refunds.
- Ledger: amount never 0; the sign must match the type (credits and reinstatements +, reversals and debits −, adjustments either); sale rows need an `order_id`, payout rows a `payout_id`; an `ADJUSTMENT` needs a note.
- Partial unique indexes: one PAID exclusive order per media, one PAID order per (buyer, media), one ledger row of each type per order and per payout. Double-crediting or double-reversing is impossible.
- A trigger makes `ledger_entries` append-only: UPDATE and DELETE raise an error (an operator can open a maintenance window with `SET LOCAL micky.ledger_maintenance = 'on'`).
- Every status that means "money was captured" (`PAID`, `REFUND_*`, `DISPUTED`) requires a `provider_payment_id`.

### Admin

Every admin decision is a **conditional update**, for example `UPDATE media SET status='APPROVED' WHERE id=? AND status='IN_REVIEW' RETURNING *`. If no row comes back, the item doesn't exist (404) or was already handled (409). Two admins clicking at once can't approve twice, and a payout can't be rejected and reversed twice.

After an approval commits, the admin service calls `IncidentsService.recompute()` and `RealtimeService.emitToChannels({type:'media.approved'})`. They run **after** the commit, so dashboards never hear about a change that was rolled back.

## Key concepts, simply

**Paise integers.** `0.1 + 0.2 !== 0.3` in floating point. Money is stored and computed as whole paise (`₹1,500 = 150000`). `splitSale` rounds the platform fee *down*, so the uploader gets any odd paisa, and `fee + share === amount` always holds (there is a unit test for this).

**HMAC signatures.** HMAC-SHA256(message, secret) is a fingerprint only someone with the secret can produce. Razorpay signs `order_id|payment_id` with our key secret. If the signature matches, Razorpay really confirmed *that* payment for *that* order. We always use the order id **stored on our server**, never one sent by the browser. Otherwise a buyer could pay for a cheap order and replay its signature on an expensive one.

**Constant-time comparison.** `a === b` stops at the first different character, so response timing leaks how much of a guess was right. `crypto.timingSafeEqual` always compares every byte.

**Raw body.** The webhook HMAC is computed over the exact bytes Razorpay sent. Parsing the JSON and calling `JSON.stringify` again can change spacing or key order, and the check fails, or worse, you end up checking something different from what was signed. `main.ts` enables `rawBody: true`, and the controller verifies `req.rawBody` **before** trusting the parsed body.

**Webhooks and retries.** A webhook is the gateway calling *your* server. Razorpay keeps retrying until it gets a 2xx, so the same event can arrive many times, and events can arrive out of order. Handlers must therefore be idempotent and fast. On an internal error, we delete the event-id claim and answer 500 so that the retry can succeed.

**Idempotency keys.** An idempotency key is a unique id that lets you recognise a request you have already handled. We have three layers:
- the `webhook_events` primary key (the Razorpay event id);
- the conditional `WHERE status <> 'PAID'` update;
- the unique index on sale credits.

Each layer alone would stop a double credit. Together they are defence in depth.

**Database transactions.** A group of statements that either all happen or none do (atomicity), with a consistent view of the data.

**Row locks / `SELECT ... FOR UPDATE`.** A row lock makes other transactions that want to lock the same row *wait* until you commit. Without it, two channels paying for the same exclusive licence at the same moment would both read "no paid orders yet", and both would win. The e2e test "two channels racing for the same exclusive licence" fails if `.for('update')` is removed (we checked).

**Advisory locks.** These are locks on an arbitrary number that you choose, not on a row. A balance is a `SUM` over many rows, with no single row to lock, and new rows can appear. So we lock on `hashtext(uploaderId)`. The `_xact_` variant is released automatically at commit or rollback. The e2e test fires 10 parallel ₹800 payout requests at a ₹2,450 balance: exactly 3 succeed. Without the lock, 8 succeeded.

**Race conditions.** A race condition is a bug where the result depends on the timing of concurrent operations. The classic form is "check, then act": read the balance, decide it is enough, write the debit, while another request does the same in between. The fix is always to make the check and the act atomic: a lock, a conditional update, or a unique constraint.

**Append-only ledger; balances are computed, not stored.** Ledger rows are never updated or deleted, and corrections are new `ADJUSTMENT` rows. A stored `balance` column can drift from history (a bug, a crash between two writes, a manual SQL fix). A computed `SUM` cannot, and every rupee is explained by a row. That makes it auditable, which matters when you hold other people's money. If it ever gets slow, add periodic snapshots and keep the ledger as the truth.

**RBAC (role-based access control).** `@Roles('ADMIN')` on the admin controller, `@Roles('UPLOADER')` on earnings, and `@Roles('CHANNEL') @ApprovedChannel()` on order creation are enforced by the global `RolesGuard`. *Ownership* ("is this your order?") is checked in the service by querying with `buyerId = currentUser`. Other people's resources return **404, not 403**, so we don't reveal that they exist.

**Mock provider.** `PaymentProvider` is an interface with two implementations, chosen by `PAYMENTS_PROVIDER`. The mock lets the whole flow be demoed with no keys (`/orders/:id/mock-pay`). It is refused in production by `AppConfig`, and it returns `false` for all signatures, so Razorpay routes can't pay mock orders.

## Trade-offs and known limits

- **The early licence check isn't a reservation.** Two channels can both reach checkout for an exclusive licence. Only one payment wins; the others are refunded automatically. The alternative, holding a reservation for N minutes, blocks other buyers.
- **Abandoned checkouts are reused** while they have at least 10 of their 30 minutes left and the price hasn't changed. After 30 minutes they expire.
- **Refunds can still fail for good** (for example the payment is too old for the gateway). They then wait in the admin's refund queue; the buyer sees "Refund delayed", never a promise that it happens by itself.
- **A partial refund** made in the dashboard is treated as a full revocation of the licence (logged as a warning). Partial credit reversals are not modelled.
- **After an exclusive sale is refunded or charged back**, `exclusive_sold` stays true: the buyer already had the original, so the media is not resold automatically. An admin decides.
- **Balances can go negative** when a sale is reversed after its share was paid out. Future sales net it off; there is no clawback from the uploader's bank.
- **Credits written before migration 0001** were made available immediately (no retroactive hold).
- **The UPI-change alert is in-app only.** There is no email yet, so the owner only notices on the earnings page; the admin flag is the second line of defence.
- **Refund jobs run in the API process**, not the worker: they are small HTTP calls, and this keeps the payment secrets out of the worker container.
- **Payouts are manual** (admin pays by UPI, then enters the UTR). RazorpayX Payouts could automate this later. TDS (Section 194-O) is not yet deducted; consult a CA.
- **Advisory-lock hash collisions:** two uploaders whose ids share a 32-bit hash briefly wait for each other. This is correct, just slightly slower.
- The webhook never grants a licence when `amount` is missing, the currency is not INR, or the order belongs to another provider. A captured payment of the wrong amount is refunded (defence in depth: the amount is fixed when the Razorpay order is created).
- A REMOVED (taken-down) media can no longer be downloaded, even by past buyers.

## Interview questions with model answers

**1. Why not trust the payment success callback from the browser?**
The browser is controlled by the user. Anyone can call `/verify` with made-up ids. We only accept it if the HMAC of *our stored* `order_id` plus the payment id, signed with our secret key, matches. Only Razorpay could have produced that. We also don't rely on the browser at all: the webhook confirms the payment server-to-server.

**2. Why do you need both `/verify` and a webhook?**
`/verify` is the fast path: the user sees "Paid" immediately. The webhook is the reliable path: it arrives even if the user closed the tab or lost connection after paying. Both call the same idempotent `markPaid`, so receiving both is harmless.

**3. How do you make the webhook idempotent?**
We insert the `x-razorpay-event-id` into `webhook_events` (primary key) with `ON CONFLICT DO NOTHING`; zero rows inserted means we have already processed it, so we return 200. `markPaid` is also idempotent on its own: a conditional update, plus a unique index on one sale credit per order. A test sends the same webhook twice and checks there is one ledger entry.

**4. Why verify the signature over the raw body?**
The HMAC covers exact bytes. Re-serialising parsed JSON can change whitespace, key order or number formatting, and then the check fails or checks the wrong thing. We enabled `rawBody` in Nest and verify `req.rawBody` before using `req.body`.

**5. Two channels pay for the same exclusive licence at the same second. What happens?**
Each `markPaid` starts a transaction and runs `SELECT ... FOR UPDATE` on the media row. The second one waits until the first commits. It then re-checks the rules, sees the media is `exclusiveSold`, sets its own order `REFUND_PENDING` and records a refund in the same transaction. After commit a BullMQ job refunds the payment through the gateway, and the order becomes `REFUNDED`. Exactly one PAID order and one ledger credit result; a concurrency test with three buyers proves it, including the two refunds.

**6. Why `SELECT FOR UPDATE` on the media row and not on the order row?**
The conflict is between *different* orders for the same media. Locking each order would not stop two different orders from both succeeding. The media row is the shared resource they compete for.

**7. How do you stop an uploader withdrawing more than their balance with parallel requests?**
In one transaction: take `pg_advisory_xact_lock(hashtext(userId))`, compute `SUM(ledger)`, validate, then insert the payout and a negative `PAYOUT_DEBIT`. The lock serialises requests per uploader, so the second one sees the first debit. Ten parallel ₹800 requests against ₹2,450 give exactly three payouts.

**8. Why an advisory lock rather than a row lock there?**
There is no single row that holds the balance: it's a `SUM` over many rows, and new rows can be inserted (phantoms). `FOR UPDATE` on existing ledger rows wouldn't block a concurrent insert. An advisory lock on a key derived from the user id is a simple, explicit mutex. The alternative is a `SERIALIZABLE` transaction with retry on serialization failure.

**9. Why not store a `balance` column on the user?**
It can drift from the history (bugs, partial failures, manual fixes) and can't explain itself. With an append-only ledger, the balance is `SUM(amount)`: always consistent, auditable, and you can reconstruct it at any past date. Corrections are new rows, never edits.

**10. Why store money as integer paise?**
Binary floating point can't represent 0.1 exactly, so sums drift (`0.1 + 0.2 = 0.30000000000000004`). Integers are exact. We round the platform fee *down* so the uploader never loses a paisa, and we test that `fee + share === amount` for many amounts and percentages.

**11. Why didn't you use Razorpay Route for split payments?**
Under the RBI Payment Aggregator Directions (September 2025), Razorpay enables Route only for businesses above ₹40 lakh turnover. So we collect the full amount, keep each uploader's share in the ledger, and pay out in batches by UPI. It also gives us a natural place for a minimum payout, fraud holds and TDS later.

**12. What is a timing attack and how do you prevent it?**
Comparing a secret with `===` returns early at the first mismatch, so an attacker can measure response times to learn how many leading characters were right and guess a valid signature byte by byte. `crypto.timingSafeEqual` takes the same time regardless. We also check lengths first, because it throws on different lengths.

**13. What happens if processing a webhook fails half-way?**
`markPaid` runs in a transaction, so a failure rolls back all of its writes. The controller then deletes the `webhook_events` claim and returns 500, Razorpay retries later, and the retry processes cleanly. If we had kept the claim, the retry would be skipped and the payment lost.

**14. How do you prevent two admins processing the same payout or approving the same media twice?**
Conditional updates: `UPDATE payouts SET status='REJECTED' WHERE id=? AND status='REQUESTED' RETURNING *`. Only one transaction can match. The other updates zero rows and gets a 409. For a payout rejection, the reversal ledger entry is written in the same transaction, so a payout is reversed at most once (tested with four parallel rejects).

**15. Why are realtime events and incident recomputes sent after the database commit?**
If we emitted inside the transaction and it then rolled back, channels would be told about media that isn't actually approved. Side effects that can't be rolled back (network messages, emails) go after the commit. The stronger version is a transactional outbox table, processed by a worker.

**16. Why return 404 instead of 403 for another channel's order?**
A 403 confirms the order exists, which leaks information (for example, that a competitor bought this footage). Querying by `(id, buyerId)` and returning 404 reveals nothing.

**17. How would you test payment code without hitting Razorpay?**
- **Mock provider** behind the `PaymentProvider` interface for the main flow.
- For Razorpay mode, start a dedicated app with test secrets, insert orders directly or stub `createOrder` with `vi.spyOn`, and sign webhook bodies ourselves with the test secret.
- Unit-test the HMAC against signatures computed independently with `openssl`.

**18. A buyer paid, but the licence was sold a second earlier. How do they get their money back?**
The decision and the refund record are written in one transaction (`REFUND_PENDING` + a `refunds` row, unique per payment id). After commit, a BullMQ job keyed on the payment id calls the gateway's refund API, retrying with backoff. The gateway call looks for an existing refund with our receipt first, so a crash between "gateway refunded" and "we saved it" cannot refund twice. If all retries fail, the refund shows up in the admin's queue with a Retry button, and housekeeping re-queues anything stuck.

**19. Why hold an uploader's earnings for 7 days?**
Card payments can be refunded or charged back after the sale. Without a hold, a fraudster could buy their own footage with a stolen card and withdraw 70% before the chargeback arrives; the platform would lose 100% plus the fee. With the hold, most reversals arrive while the credit is still on hold, and the reversal simply cancels it.

**20. What happens to the ledger when a sale is refunded after the uploader was paid?**
We write a negative `SALE_REVERSAL` row, never edit the credit. The balance goes negative, and new sales net it off before anything else can be withdrawn. The row has the same `available_at` as the credit, so inside the hold the two cancel out in "on hold" without touching the available balance.

**21. Why do you need a password to change the UPI ID if the user is already logged in?**
A stolen session (an XSS, a leaked refresh cookie) is enough to read pages, but it should not be enough to redirect money. Re-authentication proves the person knows the password. The cooling-off period then gives the real owner time to notice, and the audit table records who changed it and from where.

**22. The application already enforces the money rules. Why add database constraints?**
Code changes; constraints don't forget. A future refactor, a manual SQL fix or a new endpoint can bypass the service logic, but not a `CHECK`, a unique index or a trigger. They turn a silent money bug into a loud error. For example `UNIQUE (order_id, type)` on the ledger makes a double credit or double reversal impossible whatever the code does.

**23. Why is the webhook's body hash stored as well as the event id?**
Razorpay signs the body but not the `x-razorpay-event-id` header. Someone who captured a signed body could resend it under a new event id and pass the id check. A unique SHA-256 of the raw body catches that; the handlers are idempotent anyway, as a third layer.

**24. Why fetch the payment in `/verify` if the signature is already valid?**
The checkout signature is issued when the payment is *authorised*. If it is never captured (manual capture, an expired capture window), Razorpay returns the money to the buyer, and we would have granted a licence and an uploader credit for money that never arrived. So we create orders with `payment_capture: true`, and `/verify` grants only when `payments.fetch` says `captured` for the right amount; otherwise the `payment.captured` webhook grants it later.
