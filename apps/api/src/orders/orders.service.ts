import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, gt, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../common/auth.decorators.js';
import { priceFor, splitSale } from '../common/money.js';
import { offsetOf, type Paginated, paginated } from '../common/pagination.js';
import { UrlService } from '../common/urls.service.js';
import { AppConfig } from '../config/app-config.js';
import { type Database, InjectDb } from '../db/db.module.js';
import { ledgerEntries, media, orders } from '../db/schema.js';
import { licenceBlocker, licenceLabel } from './licence-rules.js';
import {
  type CheckoutView,
  downloadFileName,
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

/** A checkout that was started but not paid is reused for this long instead of creating a new one. */
const REUSE_CHECKOUT_MS = 30 * 60 * 1000;

/** Result of markPaid. It never throws for business outcomes, so the webhook can always answer 200. */
export type MarkPaidResult =
  | { outcome: 'paid' | 'already_paid'; order: OrderRow }
  | { outcome: 'licence_unavailable'; order: OrderRow; reason: string };

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
    // order back, not a pile of abandoned orders. Only reuse it if the price is unchanged.
    const reusable = await this.db.query.orders.findFirst({
      where: and(
        eq(orders.buyerId, buyer.id),
        eq(orders.mediaId, item.id),
        eq(orders.licenseType, dto.licenseType),
        eq(orders.status, 'CREATED'),
        eq(orders.amount, amount),
        eq(orders.provider, this.provider.name),
        gt(orders.createdAt, new Date(Date.now() - REUSE_CHECKOUT_MS)),
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

    return this.viewOrThrow(
      await this.markPaid(order.id, dto.razorpayPaymentId),
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
      await this.markPaid(order.id, `mock_pay_${randomUUID()}`),
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
   *  2. Re-read the order. If it is already PAID, return it unchanged (idempotent).
   *  3. Re-check the licence rules. If the licence was sold in the meantime, mark the
   *     order FAILED: the buyer was charged, so it is logged loudly for a refund.
   *  4. Mark the order PAID (conditional on it not being PAID yet).
   *  5. Credit the uploader's share in the ledger. The partial unique index
   *     "one SALE_CREDIT per order" makes a double credit impossible even if step 4
   *     were somehow bypassed.
   *  6. For an exclusive licence, set media.exclusiveSold.
   *
   * A FAILED order can still become PAID: Razorpay sends `payment.failed` for a
   * declined card, and the buyer may then retry and succeed in the same checkout.
   * Money actually captured always wins, as long as the licence is still available.
   */
  async markPaid(
    orderId: string,
    providerPaymentId: string,
  ): Promise<MarkPaidResult> {
    const existing = await this.db.query.orders.findFirst({
      where: eq(orders.id, orderId),
      columns: { mediaId: true },
    });
    if (!existing) throw new NotFoundException('Order not found');

    const result = await this.db.transaction(
      async (tx): Promise<MarkPaidResult> => {
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
        if (order.status === 'PAID') {
          if (order.providerPaymentId !== providerPaymentId) {
            // Same order, a second successful payment: the buyer was charged twice.
            this.logger.error(
              `NEEDS REFUND: order ${order.id} is already paid by ${order.providerPaymentId}, ` +
                `but payment ${providerPaymentId} also arrived for it`,
            );
          }
          return { outcome: 'already_paid', order };
        }

        // 3. Re-check the licence rules, excluding this order itself.
        const state = await this.licenceState(tx, item.id, order.buyerId);
        const reason = licenceBlocker(
          {
            mediaStatus: item.status,
            exclusiveSold: item.exclusiveSold,
            ...state,
          },
          order.licenseType,
        );
        if (reason) {
          const [failed] = await tx
            .update(orders)
            .set({ status: 'FAILED', providerPaymentId })
            .where(and(eq(orders.id, order.id), ne(orders.status, 'PAID')))
            .returning();
          return { outcome: 'licence_unavailable', order: failed, reason };
        }

        // 4. CREATED/FAILED -> PAID. The WHERE makes this a no-op if it is already PAID.
        const [paid] = await tx
          .update(orders)
          .set({ status: 'PAID', paidAt: new Date(), providerPaymentId })
          .where(and(eq(orders.id, order.id), ne(orders.status, 'PAID')))
          .returning();

        // 5. Credit the uploader. ON CONFLICT targets the partial unique index.
        await tx
          .insert(ledgerEntries)
          .values({
            uploaderId: item.uploaderId,
            type: 'SALE_CREDIT',
            amount: paid.uploaderShare,
            orderId: paid.id,
            note: `${licenceLabel(paid.licenseType)} sale`,
          })
          .onConflictDoNothing({
            target: ledgerEntries.orderId,
            where: sql`${ledgerEntries.type} = 'SALE_CREDIT'`,
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

    if (result.outcome === 'paid') {
      this.logger.log(`Order ${orderId} PAID (payment ${providerPaymentId})`);
    } else if (result.outcome === 'licence_unavailable') {
      // The customer has been charged but gets nothing: a human must refund them.
      this.logger.error(
        `NEEDS REFUND: order ${orderId} was paid (payment ${providerPaymentId}, ` +
          `${result.order.amount} paise) but the licence is no longer available: ${result.reason}`,
      );
    }
    return result;
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

  /** Looks up an order by the gateway's order id (webhooks only know that id). */
  async findByProviderOrderId(
    providerOrderId: string,
  ): Promise<OrderRow | undefined> {
    return this.db.query.orders.findFirst({
      where: eq(orders.providerOrderId, providerOrderId),
    });
  }

  private async viewOrThrow(result: MarkPaidResult): Promise<OrderView> {
    if (result.outcome === 'licence_unavailable') {
      throw new ConflictException(
        `${result.reason}. Your payment will be refunded in full; please contact support if it is not.`,
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
      columns: { title: true, originalName: true, status: true },
    });
    if (!item) throw new NotFoundException('Media not found');
    // Content taken down after a valid legal complaint must not be distributed further.
    if (item.status === 'REMOVED')
      throw new ConflictException(
        'This media has been taken down and cannot be downloaded',
      );

    // Atomic increment in SQL (download_count = download_count + 1), so two parallel
    // downloads cannot both read 3 and both write 4.
    await this.db
      .update(orders)
      .set({ downloadCount: sql`${orders.downloadCount} + 1` })
      .where(eq(orders.id, order.id));

    const { url, expiresAt } = this.urls.downloadUrl(order.id);
    return {
      url,
      expiresAt: expiresAt.toISOString(),
      fileName: downloadFileName(item.title, item.originalName),
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
