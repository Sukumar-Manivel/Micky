'use client';

// Money that goes back, or might (review H1, H2):
// - Refunds the platform owes buyers: a payment that lost the race for an exclusive licence,
//   arrived after its checkout expired, was a double payment or had the wrong amount. The API
//   refunds them through the payment gateway in a background job with retries; a refund that
//   still fails lands here as FAILED with the gateway's error and a "Retry" button.
// - Disputed orders: a buyer's bank opened a chargeback. The licence is already revoked and the
//   uploader's share reversed; the admin answers the dispute in the Razorpay dashboard.
// - Ledger adjustments: the only way to correct an uploader's balance (the ledger is append-only).

import { useState } from 'react';
import { LoadError, StatusFilter } from '@/components/admin-ui';
import { Badge, OrderStatusBadge } from '@/components/badges';
import { useToast } from '@/components/toast';
import { Alert, Button, EmptyState, Field, PageHeader, Pager, Panel, Skeleton, inputClass } from '@/components/ui';
import { adminApi, describeError } from '@/lib/api';
import { LICENSE_LABEL, formatDateTime } from '@/lib/format';
import { formatINR, rupeesToPaise } from '@/lib/money';
import type { AdminRefund, RefundStatus } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const PAGE_SIZE = 20;
const STATUS_OPTIONS: { value: RefundStatus | undefined; label: string }[] = [
  { value: 'FAILED', label: 'Failed' },
  { value: 'PENDING', label: 'In progress' },
  { value: 'PROCESSED', label: 'Refunded' },
  { value: undefined, label: 'All' },
];
const refundTone = { PENDING: 'progress', PROCESSED: 'good', FAILED: 'bad' } as const;
const refundLabel: Record<RefundStatus, string> = { PENDING: 'In progress', PROCESSED: 'Refunded', FAILED: 'Failed' };

export function RefundQueue() {
  return (
    <>
      <PageHeader title="Refunds and disputes">
        Refunds run automatically through the payment gateway and are retried for a while. The ones that still fail wait
        here for you.
      </PageHeader>
      <div className="flex flex-col gap-10">
        <Refunds />
        <DisputedOrders />
        <AdjustmentForm />
      </div>
    </>
  );
}

function Refunds() {
  const [status, setStatus] = useState<RefundStatus | undefined>('FAILED');
  const [page, setPage] = useState(1);
  const list = useApi(`admin/refunds?status=${status ?? ''}&page=${page}`, () =>
    adminApi.refunds({ status, page, pageSize: PAGE_SIZE }),
  );
  return (
    <section aria-labelledby="refunds-h">
      <h2 id="refunds-h" className="mb-3 text-xl font-bold">
        Refunds to buyers
      </h2>
      <StatusFilter
        label="Filter refunds by status"
        value={status}
        options={STATUS_OPTIONS}
        onChange={(s) => {
          setStatus(s);
          setPage(1);
        }}
      />
      {list.error && !list.data ? <LoadError message={list.error} onRetry={list.reload} /> : null}
      {list.loading ? (
        <Skeleton className="h-28" />
      ) : list.data && list.data.items.length === 0 ? (
        <EmptyState title={status === 'FAILED' ? 'No failed refunds' : 'No refunds here'}>
          {status === 'FAILED' ? 'Every refund went through or is still being retried.' : 'Try another filter.'}
        </EmptyState>
      ) : list.data ? (
        <>
          <ul className="flex flex-col gap-3">
            {list.data.items.map((r) => (
              <li key={r.id}>
                <RefundCard refund={r} onChanged={list.reload} />
              </li>
            ))}
          </ul>
          <Pager page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </>
      ) : null}
    </section>
  );
}

function RefundCard({ refund: r, onChanged }: { refund: AdminRefund; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      await adminApi.retryRefund(r.id);
      toast('Refund queued again', 'info');
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={refundTone[r.status]}>{refundLabel[r.status]}</Badge>
            <OrderStatusBadge status={r.order.status} />
            <span className="text-sm text-muted">Since {formatDateTime(r.createdAt)}</span>
          </div>
          <p className="font-display tabular text-3xl font-bold">{formatINR(r.amount)}</p>
          <p className="text-sm">
            {r.media.title} · {LICENSE_LABEL[r.order.licenseType]}
          </p>
          <p className="text-sm [overflow-wrap:anywhere]">
            {r.buyer.organization ?? 'Newsroom'} ·{' '}
            <a href={`mailto:${r.buyer.email}`} className="underline">
              {r.buyer.email}
            </a>
          </p>
          <p className="text-sm text-muted">Why: {r.reason}</p>
          <p className="text-sm text-muted [overflow-wrap:anywhere]">
            Payment <span className="font-mono">{r.providerPaymentId}</span>
            {r.providerRefundId ? (
              <>
                {' '}
                · refund <span className="font-mono">{r.providerRefundId}</span>
              </>
            ) : null}{' '}
            · {r.attempts} attempt{r.attempts === 1 ? '' : 's'}
          </p>
          {r.lastError ? <p className="text-sm font-semibold text-danger">Last error: {r.lastError}</p> : null}
          {r.processedAt ? <p className="text-sm text-muted">Refunded {formatDateTime(r.processedAt)}</p> : null}
        </div>
        {r.status !== 'PROCESSED' ? (
          <div className="flex shrink-0 flex-col gap-1">
            <Button onClick={retry} busy={busy} variant={r.status === 'FAILED' ? 'primary' : 'secondary'}>
              Retry refund
            </Button>
            <p className="max-w-56 text-xs text-muted">Safe to press twice: the gateway never refunds a payment twice.</p>
          </div>
        ) : null}
      </div>
      {error ? <Alert>{error}</Alert> : null}
    </article>
  );
}

function DisputedOrders() {
  const [page, setPage] = useState(1);
  const list = useApi(`admin/orders?status=DISPUTED&page=${page}`, () =>
    adminApi.orders({ status: 'DISPUTED', page, pageSize: PAGE_SIZE }),
  );
  return (
    <section aria-labelledby="disputes-h">
      <h2 id="disputes-h" className="mb-1 text-xl font-bold">
        Disputed orders
      </h2>
      <p className="mb-3 text-sm text-muted">
        A chargeback was opened. The licence is revoked and the uploader’s share reversed until the dispute is won. Answer
        it in the Razorpay dashboard.
      </p>
      {list.error && !list.data ? <LoadError message={list.error} onRetry={list.reload} /> : null}
      {list.loading ? (
        <Skeleton className="h-24" />
      ) : list.data && list.data.items.length === 0 ? (
        <p className="text-muted">No open disputes.</p>
      ) : list.data ? (
        <>
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="text-muted">
                <tr className="border-b border-line">
                  <th scope="col" className="py-2 pr-3 font-semibold">Paid</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Footage</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Buyer</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Payment</th>
                  <th scope="col" className="py-2 text-right font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((o) => (
                  <tr key={o.id} className="border-b border-line last:border-0 align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">{o.paidAt ? formatDateTime(o.paidAt) : '—'}</td>
                    <td className="py-2 pr-3">
                      {o.media.title}
                      {o.statusReason ? <span className="block text-xs text-muted">{o.statusReason}</span> : null}
                    </td>
                    <td className="py-2 pr-3 [overflow-wrap:anywhere]">{o.buyer.organization ?? o.buyer.email}</td>
                    <td className="py-2 pr-3 font-mono text-xs [overflow-wrap:anywhere]">{o.providerPaymentId ?? '—'}</td>
                    <td className="tabular py-2 text-right font-bold">{formatINR(o.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </>
      ) : null}
    </section>
  );
}

function AdjustmentForm() {
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const uploaderEmail = String(form.get('uploaderEmail') ?? '').trim();
    const direction = form.get('direction') === 'debit' ? -1 : 1;
    const paise = rupeesToPaise(String(form.get('amount') ?? ''));
    const note = String(form.get('note') ?? '').trim();
    if (!uploaderEmail.includes('@')) return setError('Enter the uploader’s email address.');
    if (paise === null || paise === 0) return setError('Enter an amount in rupees, for example 250.');
    if (note.length < 3) return setError('Explain the adjustment: the note is kept with the ledger row for good.');
    setBusy(true);
    setError(null);
    try {
      const entry = await adminApi.createAdjustment({ uploaderEmail, amount: direction * paise, note });
      toast(`${entry.amount > 0 ? 'Credited' : 'Debited'} ${formatINR(Math.abs(entry.amount))}`, 'success');
      formEl.reset();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel aria-labelledby="adjust-h">
      <h2 id="adjust-h" className="mb-1 text-xl font-bold">
        Correct an uploader’s balance
      </h2>
      <p className="mb-4 text-sm text-muted">
        Writes an adjustment to the ledger with your name and the note. It cannot be edited or deleted later; a mistake is
        corrected with another adjustment.
      </p>
      <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
        <Field label="Uploader’s email" htmlFor="uploaderEmail">
          <input id="uploaderEmail" name="uploaderEmail" type="email" autoComplete="off" required className={inputClass} />
        </Field>
        <fieldset className="flex flex-wrap gap-4">
          <legend className="mb-1 font-semibold">Direction</legend>
          <label className="flex min-h-11 items-center gap-2">
            <input type="radio" name="direction" value="credit" defaultChecked /> Credit (add money)
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input type="radio" name="direction" value="debit" /> Debit (take money)
          </label>
        </fieldset>
        <Field label="Amount (₹)" htmlFor="adjust-amount" hint="Up to ₹1,00,000 per adjustment.">
          <input
            id="adjust-amount"
            name="amount"
            inputMode="decimal"
            required
            aria-describedby="adjust-amount-hint"
            className={inputClass}
          />
        </Field>
        <Field label="Note (required)" htmlFor="adjust-note" hint="Why, and any reference (ticket, payment id).">
          <textarea
            id="adjust-note"
            name="note"
            rows={2}
            minLength={3}
            maxLength={500}
            required
            aria-describedby="adjust-note-hint"
            className={inputClass}
          />
        </Field>
        {error ? <Alert>{error}</Alert> : null}
        <div>
          <Button type="submit" busy={busy}>
            Write adjustment
          </Button>
        </div>
      </form>
    </Panel>
  );
}
