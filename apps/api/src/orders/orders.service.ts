import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../common/auth.decorators.js';
import { priceFor, splitSale } from '../common/money.js';
import { offsetOf, type Paginated, paginated } from '../common/pagination.js';
import { UrlService } from '../common/urls.service.js';
import { AppConfig } from '../config/app-config.js';
import { type Database, InjectDb } from '../db/db.module.js';
import { media, orders } from '../db/schema.js';
import {
  writeSaleCredit,
  writeSaleReinstatement,
  writeSaleReversal,
} from '../earnings/ledger.js';
import { checkoutTtlMs, saleCreditHoldMs } from '../earnings/money-policy.js';
import { deliveryFileName } from '../common/views.js';
import { licenceBlocker, licenceLabel } from './licence-rules.js';
import {
  type CheckoutView,
  type OrderMediaRow,
  type OrderRow,
  type OrderView,
  toOrderView,
} from './order-view.js';
import type {
  CreateOrderDto,
  ListOrdersQuery,
  VerifyPaymentDto,
} from './orders.dto.js';
import { MockProvider } from './payments/mock.provider.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from './payments/payment-provider.js';
import { RazorpayProvider } from './payments/razorpay.provider.js';
import { EXPIRY_SWEEP_GRACE_MS } from './refunds.constants.js';
import { RefundsService } from './refunds.service.js';

/**
 * An unpaid checkout is reused (instead of creating a new one) only while at least this
 * much of its payment window is left, so the buyer always has time to finish paying.
 */
const REUSE_MIN_REMAINING_MS = 10 * 60 * 1000;

/** The payment as markPaid needs it. */
export interface CapturedPayment {
  id: string;
  /** When the buyer paid, according to the gateway; decides whether the checkout had expired. */
  paidAt: Date;
}

/**
 * Result of markPaid. It never throws for business outcomes, so the webhook can always answer 200.
 * `refund_pending`: the money was captured but cannot be kept; a refund has been queued.
 */
export type MarkPaidResult =
  | { outcome: 'paid' | 'already_paid'; order: OrderRow }
  | { outcome: 'refund_pending'; order: OrderRow; reason: string };

/** Order states in which the order's own payment was captured and is being (or was) given back or disputed. */
const REVOKED_STATES = [
  'REFUND_PENDING',
  'REFUNDED',
  'REFUND_FAILED',
  'DISPUTED',
] as const;

/** Media columns used by the order views. */
const ORDER_MEDIA_COLUMNS = {
  id: media.id,
  title: media.title,
  type: media.type,
  thumbKey: media.thumbKey,
} as const;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly config: AppConfig,
    private readonly urls: UrlService,
    private readonly refunds: RefundsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Checkout
  // ---------------------------------------------------------------------------

  /** POST /orders: starts a checkout for one licence of one media item. */
  async create(buyer: AuthUser, dto: CreateOrderDto): Promise<CheckoutView> {
    const item = await this.db.query.media.findFirst({
      where: eq(media.id, dto.mediaId),
    });
    // Channels only ever see APPROVED media, so anything else is "not found" to them.
    if (!item || item.status !== 'APPROVED')
      throw new NotFoundException('Media not found');

    // Early check so the buyer gets a clear message before paying.
    // It is checked again, under a row lock, when the payment arrives (markPaid).
    const state = await this.licenceState(this.db, item.id, buyer.id);
    const blocker = licenceBlocker(
      { mediaStatus: item.status, exclusiveSold: item.exclusiveSold, ...state },
      dto.licenseType,
    );
    if (blocker) throw new ConflictException(blocker);

    const amount = priceFor(item, dto.licenseType);
    const description = `${licenceLabel(dto.licenseType)}: ${item.title}`;

    // A buyer who closes the checkout and clicks "Buy" again should get the same
    // order back, not a pile of abandoned orders. Only reuse it if the price is unchanged
    // and enough of its payment window is left.
    const reusable = await this.db.query.orders.findFirst({
      where: and(
        eq(orders.buyerId, buyer.id),
        eq(orders.mediaId, item.id),
        eq(orders.licenseType, dto.licenseType),
        eq(orders.status, 'CREATED'),
        eq(orders.amount, amount),
        eq(orders.provider, this.provider.name),
        gt(orders.expiresAt, new Date(Date.now() + REUSE_MIN_REMAINING_MS)),
      ),
      orderBy: desc(orders.createdAt),
    });
    if (reusable) return this.toCheckout(reusable, description);

    const { platformFee, uploaderShare } = splitSale(
      amount,
      this.config.platformFeePercent,
    );

    // Our id is generated first so it can be sent to the gateway as the receipt,
    // which makes the two systems easy to reconcile later.
    const orderId = randomUUID();
    const { providerOrderId } = await this.provider.createOrder({
      amountPaise: amount,
      receipt: orderId,
      notes: { orderId, mediaId: item.id, licenseType: dto.licenseType },
    });

    const [order] = await this.db
      .insert(orders)
      .values({
        id: orderId,
        buyerId: buyer.id,
        mediaId: item.id,
        licenseType: dto.licenseType,
        amount,
        platformFee,
        uploaderShare,
        currency: 'INR',
        status: 'CREATED',
        provider: this.provider.name,
        providerOrderId,
        // The quoted price is honoured until then. A payment made later is refunded.
        expiresAt: new Date(Date.now() + checkoutTtlMs(this.config)),
      })
      .returning();

    this.logger.log(
      `Order ${order.id} created: ${dto.licenseType} of media ${item.id} for ${amount} paise`,
    );
    return this.toCheckout(order, description);
  }

  private toCheckout(order: OrderRow, description: string): CheckoutView {
    return {
      orderId: order.id,
      amount: order.amount,
      currency: 'INR',
      provider: this.provider.name,
      expiresAt: order.expiresAt.toISOString(),
      ...(this.provider instanceof RazorpayProvider
        ? {
            razorpay: {
              keyId: this.provider.keyId,
              orderId: order.providerOrderId,
            },
          }
        : {}),
      description,
    };
  }

  // ---------------------------------------------------------------------------
  // Payment confirmation (three entry points, one implementation)
  // ---------------------------------------------------------------------------

  /** POST /orders/:id/verify: the browser reports a successful Razorpay Checkout payment. */
  async verify(
    buyer: AuthUser,
    orderId: string,
    dto: VerifyPaymentDto,
  ): Promise<OrderView> {
    const order = await this.findOwnOrder(buyer, orderId);
    if (order.status === 'PAID') return this.view(order.id);

    // The signature is checked against the provider order id stored in OUR database.
    // If we trusted an id sent by the browser, a buyer could reuse the signature of
    // a cheap order to unlock an expensive one.
    const valid =
      order.provider === this.provider.name &&
      this.provider.verifyPaymentSignature(
        order.providerOrderId,
        dto.razorpayPaymentId,
        dto.razorpaySignature,
      );
    if (!valid) {
      this.logger.warn(`Invalid payment signature for order ${order.id}`);
      throw new BadRequestException(
        'Payment verification failed: invalid signature',
      );
    }

    // The signature proves the payment was *authorised*. Only the gateway can say the
    // money was *captured*, and for how much (review M5).
    let payment;
    try {
      payment = await this.provider.fetchPayment(dto.razorpayPaymentId);
    } catch {
      throw new BadGatewayException(
        'We could not confirm your payment with the payment gateway yet. If you were charged, ' +
          'the licence appears under Purchases within a few minutes; otherwise please try again.',
      );
    }
    if (payment.orderId !== order.providerOrderId) {
      this.logger.warn(
        `Payment ${payment.id} belongs to ${payment.orderId}, not order ${order.id}`,
      );
      throw new BadRequestException(
        'Payment verification failed: the payment belongs to another order',
      );
    }
    if (payment.status !== 'captured') {
      // Usually "authorized" for a moment before auto-capture: the payment.captured
      // webhook grants the licence. The browser polls GET /orders/:id meanwhile.
      this.logger.log(
        `Order ${order.id}: payment ${payment.id} is ${payment.status}, not captured yet`,
      );
      return this.view(order.id);
    }
    if (payment.amount !== order.amount || payment.currency !== 'INR') {
      await this.refundStrayPayment(
        order,
        { id: payment.id, amount: payment.amount },
        `The payment of ${payment.amount} ${payment.currency} does not match the order amount`,
      );
      throw new ConflictException(
        'The amount paid does not match the price of this licence. A full refund of your payment has been requested.',
      );
    }

    return this.viewOrThrow(
      await this.markPaid(order.id, {
        id: payment.id,
        paidAt: payment.createdAt,
      }),
    );
  }

  /** POST /orders/:id/mock-pay: instant "payment" for development and demos. */
  async mockPay(buyer: AuthUser, orderId: string): Promise<OrderView> {
    // Pretend the route does not exist when a real gateway is configured.
    if (!(this.provider instanceof MockProvider)) throw new NotFoundException();
    const order = await this.findOwnOrder(buyer, orderId);
    if (order.provider !== 'mock')
      throw new NotFoundException('Order not found');
    return this.viewOrThrow(
      await this.markPaid(order.id, {
        id: `mock_pay_${randomUUID()}`,
        paidAt: new Date(),
      }),
    );
  }

  /**
   * THE single place where an order becomes PAID. Called by verify, mock-pay and the
   * webhook, possibly at the same moment for the same order, and possibly for two
   * different buyers racing for the same exclusive licence. Everything happens in one
   * transaction, so either all of it is saved or none of it is:
   *
   *  1. Lock the media row (SELECT ... FOR UPDATE). Every other markPaid for the same
   *     media now waits here until we commit, so the licence check below cannot race.
   *  2. Re-read the order. If it is already PAID by this payment, return it unchanged
   *     (idempotent). A *different* payment for a PAID order is a double charge: refund it.
   *  3. Check the payment was made before the checkout expired, and re-check the licence
   *     rules. If either fails, the money cannot be kept: the order becomes REFUND_PENDING
   *     and a refund is recorded in the same transaction (the job runs after commit).
   *  4. Mark the order PAID (conditional on it not being PAID yet).
   *  5. Credit the uploader's share, held until the hold period ends. The partial unique
   *     index "one SALE_CREDIT per order" makes a double credit impossible.
   *  6. For an exclusive licence, set media.exclusiveSold.
   *
   * A FAILED order can still become PAID: Razorpay sends `payment.failed` for a declined
   * card, and the buyer may then retry and succeed in the same checkout. An EXPIRED order
   * can too, if the gateway says the buyer paid before it expired (a delayed webhook).
   */
  async markPaid(
    orderId: string,
    payment: CapturedPayment,
  ): Promise<MarkPaidResult> {
    const existing = await this.db.query.orders.findFirst({
      where: eq(orders.id, orderId),
      columns: { mediaId: true },
    });
    if (!existing) throw new NotFoundException('Order not found');

    const result = await this.db.transaction(
      async (tx): Promise<MarkPaidResult & { refundPaymentId?: string }> => {
        // 1. Serialise all payments for this media.
        const [item] = await tx
          .select({
            id: media.id,
            uploaderId: media.uploaderId,
            status: media.status,
            exclusiveSold: media.exclusiveSold,
          })
          .from(media)
          .where(eq(media.id, existing.mediaId))
          .for('update');

        // 2. Read the order again now that we hold the lock: another request may have paid it.
        const [order] = await tx
          .select()
          .from(orders)
          .where(eq(orders.id, orderId));

        if (order.status === 'PAID' || isRevoked(order.status)) {
          if (order.providerPaymentId === payment.id) {
            return order.status === 'PAID'
              ? { outcome: 'already_paid', order }
              : {
                  outcome: 'refund_pending',
                  order,
                  reason: order.statusReason ?? 'This order is being refunded',
                };
          }
          // Same order, a second captured payment: the buyer was charged twice.
          const reason =
            'This order had already been paid with another payment';
          await this.refunds.record(tx, {
            orderId: order.id,
            provider: order.provider,
            paymentId: payment.id,
            amount: order.amount,
            reason,
          });
          this.logger.warn(
            `Order ${order.id} is ${order.status} with ${order.providerPaymentId}; refunding the extra payment ${payment.id}`,
          );
          return order.status === 'PAID'
            ? { outcome: 'already_paid', order, refundPaymentId: payment.id }
            : {
                outcome: 'refund_pending',
                order,
                reason,
                refundPaymentId: payment.id,
              };
        }

        // 3. Was the checkout still open when the buyer paid? Are the licence rules still met?
        const expired = payment.paidAt.getTime() > order.expiresAt.getTime();
        const state = await this.licenceState(tx, item.id, order.buyerId);
        const reason = expired
          ? 'This checkout expired before the payment was made'
          : licenceBlocker(
              {
                mediaStatus: item.status,
                exclusiveSold: item.exclusiveSold,
                ...state,
              },
              order.licenseType,
            );
        if (reason) {
          const [refunding] = await tx
            .update(orders)
            .set({
              status: 'REFUND_PENDING',
              providerPaymentId: payment.id,
              statusReason: reason,
            })
            .where(
              and(
                eq(orders.id, order.id),
                inArray(orders.status, ['CREATED', 'FAILED', 'EXPIRED']),
              ),
            )
            .returning();
          await this.refunds.record(tx, {
            orderId: order.id,
            provider: order.provider,
            paymentId: payment.id,
            amount: order.amount,
            reason,
          });
          return {
            outcome: 'refund_pending',
            order: refunding,
            reason,
            refundPaymentId: payment.id,
          };
        }

        // 4. CREATED/FAILED/EXPIRED -> PAID. The WHERE makes this a no-op if it is already PAID.
        const paidAt = new Date();
        const [paid] = await tx
          .update(orders)
          .set({
            status: 'PAID',
            paidAt,
            providerPaymentId: payment.id,
            statusReason: null,
          })
          .where(and(eq(orders.id, order.id), ne(orders.status, 'PAID')))
          .returning();

        // 5. Credit the uploader, spendable only after the hold period (review H2).
        await writeSaleCredit(tx, {
          uploaderId: item.uploaderId,
          orderId: paid.id,
          amount: paid.uploaderShare,
          note: `${licenceLabel(paid.licenseType)} sale`,
          availableAt: new Date(
            paidAt.getTime() + saleCreditHoldMs(this.config),
          ),
        });

        // 6. An exclusive sale takes the media off the market for everyone else.
        if (paid.licenseType === 'EXCLUSIVE') {
          await tx
            .update(media)
            .set({ exclusiveSold: true })
            .where(eq(media.id, item.id));
        }
        return { outcome: 'paid', order: paid };
      },
    );

    if (result.refundPaymentId)
      await this.refunds.enqueue(result.refundPaymentId);
    if (result.outcome === 'paid') {
      this.logger.log(`Order ${orderId} PAID (payment ${payment.id})`);
    } else if (result.outcome === 'refund_pending' && result.refundPaymentId) {
      this.logger.warn(
        `Order ${orderId}: payment ${payment.id} (${result.order.amount} paise) cannot be kept: ` +
          `${result.reason}. Refund queued.`,
      );
    }
    const { refundPaymentId: _ignored, ...outcome } = result;
    return outcome;
  }

  /**
   * A captured payment we will not use at all (wrong amount or currency). Refunds it
   * without changing the order, which stays payable.
   */
  async refundStrayPayment(
    order: OrderRow,
    payment: { id: string; amount: number },
    reason: string,
  ): Promise<void> {
    if (!(payment.amount > 0)) {
      this.logger.error(
        `Stray payment ${payment.id} for order ${order.id} has no amount; refund it by hand`,
      );
      return;
    }
    await this.db.transaction((tx) =>
      this.refunds.record(tx, {
        orderId: order.id,
        provider: order.provider,
        paymentId: payment.id,
        amount: payment.amount,
        reason,
      }),
    );
    await this.refunds.enqueue(payment.id);
    this.logger.error(
      `Payment ${payment.id} for order ${order.id} will be refunded: ${reason}`,
    );
  }

  /** Marks an unpaid order FAILED (Razorpay `payment.failed` webhook). Returns false if nothing changed. */
  async markFailed(orderId: string): Promise<boolean> {
    const updated = await this.db
      .update(orders)
      .set({ status: 'FAILED' })
      .where(and(eq(orders.id, orderId), eq(orders.status, 'CREATED')))
      .returning({ id: orders.id });
    return updated.length > 0;
  }

  // ---------------------------------------------------------------------------
  // After the sale: refunds made outside Micky, and chargebacks (review H2)
  // ---------------------------------------------------------------------------

  /**
   * The payment of a PAID (or DISPUTED) order was refunded, e.g. by an admin in the
   * Razorpay dashboard. The licence is revoked (downloads require PAID) and the uploader's
   * credit is reversed. Idempotent.
   */
  async reverseSaleForRefund(
    paymentId: string,
    note: string,
  ): Promise<'reversed' | 'unchanged' | 'unknown'> {
    return this.revoke(paymentId, ['PAID', 'DISPUTED'], 'REFUNDED', note);
  }

  /** A chargeback was opened (or lost) for this payment. Idempotent. */
  async openDispute(
    paymentId: string,
    note: string,
  ): Promise<'reversed' | 'unchanged' | 'unknown'> {
    return this.revoke(paymentId, ['PAID'], 'DISPUTED', note);
  }

  /**
   * The platform won the chargeback: the buyer's licence and the uploader's share come
   * back. Idempotent.
   */
  async disputeWon(
    paymentId: string,
  ): Promise<'reinstated' | 'unchanged' | 'unknown'> {
    const result = await this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.providerPaymentId, paymentId))
        .for('update');
      if (!order) return 'unknown' as const;
      if (order.status !== 'DISPUTED') return 'unchanged' as const;
      // The money stays with us, so the uploader's share always comes back. The licence
      // only comes back if that does not break the licence rules: while the order was
      // DISPUTED the buyer may have bought the media again (or, after a non-exclusive
      // dispute, someone bought it exclusively). The unique indexes would refuse PAID then.
      const [conflict] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.mediaId, order.mediaId),
            eq(orders.status, 'PAID'),
            ne(orders.id, order.id),
            order.licenseType === 'EXCLUSIVE'
              ? undefined
              : sql`(${orders.buyerId} = ${order.buyerId} or ${orders.licenseType} = 'EXCLUSIVE')`,
          ),
        )
        .limit(1);
      await tx
        .update(orders)
        .set(
          conflict
            ? {
                statusReason:
                  'Chargeback won; the licence is held by a later order',
              }
            : { status: 'PAID', statusReason: null },
        )
        .where(eq(orders.id, order.id));
      await writeSaleReinstatement(
        tx,
        order.id,
        'Chargeback won: sale reinstated',
      );
      return 'reinstated' as const;
    });
    if (result === 'reinstated')
      this.logger.log(`Dispute on payment ${paymentId} won: sale reinstated`);
    return result;
  }

  private async revoke(
    paymentId: string,
    from: OrderRow['status'][],
    to: 'REFUNDED' | 'DISPUTED',
    note: string,
  ): Promise<'reversed' | 'unchanged' | 'unknown'> {
    const result = await this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.providerPaymentId, paymentId))
        .for('update');
      if (!order) return 'unknown' as const;
      if (!from.includes(order.status)) return 'unchanged' as const;
      const now = new Date();
      await tx
        .update(orders)
        .set({
          status: to,
          statusReason: note,
          ...(to === 'REFUNDED' ? { refundedAt: now } : { disputedAt: now }),
        })
        .where(eq(orders.id, order.id));
      // The balance may go negative if the share was already paid out; future sales net it off.
      await writeSaleReversal(tx, order.id, note);
      return 'reversed' as const;
    });
    if (result === 'reversed')
      this.logger.warn(
        `Payment ${paymentId}: order ${to}, licence revoked and uploader credit reversed (${note})`,
      );
    return result;
  }

  /**
   * Housekeeping: unpaid checkouts past their payment window become EXPIRED. A payment
   * that still arrives for one is judged by when the buyer paid (see markPaid).
   */
  async expireStaleCheckouts(): Promise<number> {
    const expired = await this.db
      .update(orders)
      .set({ status: 'EXPIRED', statusReason: 'Not paid in time' })
      .where(
        and(
          eq(orders.status, 'CREATED'),
          lt(orders.expiresAt, new Date(Date.now() - EXPIRY_SWEEP_GRACE_MS)),
        ),
      )
      .returning({ id: orders.id });
    if (expired.length)
      this.logger.log(`Expired ${expired.length} unpaid checkout(s)`);
    return expired.length;
  }

  /** Looks up an order by the gateway's order id (webhooks only know that id). */
  async findByProviderOrderId(
    providerOrderId: string,
  ): Promise<OrderRow | undefined> {
    return this.db.query.orders.findFirst({
      where: eq(orders.providerOrderId, providerOrderId),
    });
  }

  /** Looks up an order by the payment that paid it (refund and dispute webhooks). */
  async findByProviderPaymentId(
    paymentId: string,
  ): Promise<OrderRow | undefined> {
    return this.db.query.orders.findFirst({
      where: eq(orders.providerPaymentId, paymentId),
    });
  }

  private async viewOrThrow(result: MarkPaidResult): Promise<OrderView> {
    if (result.outcome === 'refund_pending') {
      throw new ConflictException(
        `${result.reason}. You will not be charged for it: a full refund of your payment has been requested. ` +
          'Banks usually take 5–7 working days to show it; contact support if it has not arrived by then.',
      );
    }
    return this.view(result.order.id);
  }

  // ---------------------------------------------------------------------------
  // Reading orders and downloading
  // ---------------------------------------------------------------------------

  /** GET /orders: the caller's own orders, newest first. */
  async list(
    buyer: AuthUser,
    query: ListOrdersQuery,
  ): Promise<Paginated<OrderView>> {
    const where = and(
      eq(orders.buyerId, buyer.id),
      query.status ? eq(orders.status, query.status) : undefined,
    );
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({ order: orders, media: ORDER_MEDIA_COLUMNS })
        .from(orders)
        .innerJoin(media, eq(media.id, orders.mediaId))
        .where(where)
        .orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db.select({ total: count() }).from(orders).where(where),
    ]);
    return paginated(
      rows.map((r) => toOrderView(r.order, r.media, this.urls)),
      total,
      query,
    );
  }

  /** GET /orders/:id: the buyer, or any admin. */
  async get(user: AuthUser, orderId: string): Promise<OrderView> {
    const row = await this.loadWithMedia(orderId);
    if (!row || (user.role !== 'ADMIN' && row.order.buyerId !== user.id)) {
      throw new NotFoundException('Order not found');
    }
    return toOrderView(row.order, row.media, this.urls);
  }

  /** GET /orders/:id/download: a short-lived signed link to the original file. */
  async download(
    buyer: AuthUser,
    orderId: string,
  ): Promise<{ url: string; expiresAt: string; fileName: string }> {
    const order = await this.findOwnOrder(buyer, orderId);
    if (order.status !== 'PAID')
      throw new ConflictException('This order has not been paid');

    const item = await this.db.query.media.findFirst({
      where: eq(media.id, order.mediaId),
      columns: { title: true, originalKey: true, mimeType: true, status: true },
    });
    if (!item) throw new NotFoundException('Media not found');
    // Content taken down after a valid legal complaint must not be distributed further.
    if (item.status === 'REMOVED')
      throw new ConflictException(
        'This media has been taken down and cannot be downloaded',
      );

    // downloadCount is incremented by the file route only when the whole file was sent,
    // so issuing a link is not counted as a download.
    const { url, expiresAt } = this.urls.downloadUrl(order.id, order.buyerId);
    return {
      url,
      expiresAt: expiresAt.toISOString(),
      fileName: deliveryFileName(item),
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Loads an order of this buyer, or 404 (never 403, so we do not reveal other buyers' orders). */
  private async findOwnOrder(
    buyer: AuthUser,
    orderId: string,
  ): Promise<OrderRow> {
    const order = await this.db.query.orders.findFirst({
      where: and(eq(orders.id, orderId), eq(orders.buyerId, buyer.id)),
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  private async loadWithMedia(
    orderId: string,
  ): Promise<{ order: OrderRow; media: OrderMediaRow } | undefined> {
    const [row] = await this.db
      .select({ order: orders, media: ORDER_MEDIA_COLUMNS })
      .from(orders)
      .innerJoin(media, eq(media.id, orders.mediaId))
      .where(eq(orders.id, orderId));
    return row;
  }

  private async view(orderId: string): Promise<OrderView> {
    const row = await this.loadWithMedia(orderId);
    if (!row) throw new NotFoundException('Order not found');
    return toOrderView(row.order, row.media, this.urls);
  }

  /** Paid-order facts the licence rules need. Works inside or outside a transaction. */
  // A DISPUTED order no longer holds a licence; a REFUNDED one neither. Only PAID counts.
  private async licenceState(
    db: Pick<Database, 'select'>,
    mediaId: string,
    buyerId: string,
  ): Promise<{ paidOrderCount: number; buyerHasPaid: boolean }> {
    const [row] = await db
      .select({
        paidOrderCount: count(),
        buyerPaidCount:
          sql<number>`count(*) filter (where ${orders.buyerId} = ${buyerId})`.mapWith(
            Number,
          ),
      })
      .from(orders)
      .where(and(eq(orders.mediaId, mediaId), eq(orders.status, 'PAID')));
    return {
      paidOrderCount: row.paidOrderCount,
      buyerHasPaid: row.buyerPaidCount > 0,
    };
  }
}

function isRevoked(status: OrderRow['status']): boolean {
  return (REVOKED_STATES as readonly string[]).includes(status);
}
