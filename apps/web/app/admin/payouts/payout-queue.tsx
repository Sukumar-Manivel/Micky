'use client';

// Payouts are sent by hand: the admin pays the uploader's UPI ID from the company account,
// then records the UPI transaction reference (UTR) here. Rejecting a payout returns the money
// to the uploader's balance with a PAYOUT_REVERSAL ledger entry (done by the API).

import { useState } from 'react';
import { LoadError, ReasonForm, StatusFilter } from '@/components/admin-ui';
import { PayoutStatusBadge } from '@/components/badges';
import { useToast } from '@/components/toast';
import { Button, EmptyState, PageHeader, Pager, Skeleton } from '@/components/ui';
import { adminApi } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { formatINR } from '@/lib/money';
import type { AdminPayout, PayoutStatus } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const PAGE_SIZE = 20;
const STATUS_OPTIONS: { value: PayoutStatus | undefined; label: string }[] = [
  { value: 'REQUESTED', label: 'To send' },
  { value: 'PAID', label: 'Paid' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: undefined, label: 'All' },
];

export function PayoutQueue() {
  const [status, setStatus] = useState<PayoutStatus | undefined>('REQUESTED');
  const [page, setPage] = useState(1);
  const list = useApi(`admin/payouts?status=${status ?? ''}&page=${page}`, () =>
    adminApi.payouts({ status, page, pageSize: PAGE_SIZE }),
  );
  const pageTotal = list.data?.items.reduce((sum, p) => sum + p.amount, 0) ?? 0;

  return (
    <>
      <PageHeader title="Payouts">
        Send each amount to the UPI ID shown, then record the transaction reference so the uploader can trace it.
      </PageHeader>
      <StatusFilter
        label="Filter by status"
        value={status}
        options={STATUS_OPTIONS}
        onChange={(s) => {
          setStatus(s);
          setPage(1);
        }}
      />
      {list.error && !list.data ? <LoadError message={list.error} onRetry={list.reload} /> : null}
      {list.loading ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : list.data && list.data.items.length === 0 ? (
        <EmptyState title={status === 'REQUESTED' ? 'No payouts to send' : 'No payouts here'}>
          {status === 'REQUESTED' ? 'Uploaders’ withdrawal requests appear here.' : 'Try another filter.'}
        </EmptyState>
      ) : list.data ? (
        <>
          {status === 'REQUESTED' ? (
            <p className="mb-3 text-sm text-muted">
              <span className="tabular font-bold text-ink">{list.data.total}</span> waiting ·{' '}
              <span className="tabular font-bold text-ink">{formatINR(pageTotal)}</span> on this page
            </p>
          ) : null}
          <ul className="flex flex-col gap-3">
            {list.data.items.map((p) => (
              <li key={p.id}>
                <PayoutCard payout={p} onChanged={list.reload} />
              </li>
            ))}
          </ul>
          <Pager page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </>
      ) : null}
    </>
  );
}

function PayoutCard({ payout: p, onChanged }: { payout: AdminPayout; onChanged: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'idle' | 'paid' | 'reject'>('idle');
  const [copied, setCopied] = useState(false);

  async function copyUpi() {
    try {
      await navigator.clipboard.writeText(p.upiId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked (e.g. insecure origin); the ID is selectable text anyway.
    }
  }

  return (
    <article className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <PayoutStatusBadge status={p.status} />
            <span className="text-sm text-muted">Requested {formatDateTime(p.createdAt)}</span>
          </div>
          <p className="font-display tabular text-4xl font-bold">{formatINR(p.amount)}</p>
          <p className="text-sm [overflow-wrap:anywhere]">
            {p.uploader.name} · <a href={`mailto:${p.uploader.email}`} className="underline">{p.uploader.email}</a>
          </p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">UPI ID</span>
            <code className="rounded bg-sunken px-2 py-0.5 font-mono font-semibold [overflow-wrap:anywhere]">{p.upiId}</code>
            <Button variant="ghost" size="sm" onClick={copyUpi} aria-label={`Copy UPI ID ${p.upiId}`}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          {p.reference ? <p className="text-sm text-muted">Reference: <span className="font-mono">{p.reference}</span></p> : null}
          {p.note ? <p className="text-sm text-muted">Note: {p.note}</p> : null}
          {p.processedAt ? <p className="text-sm text-muted">Processed {formatDateTime(p.processedAt)}</p> : null}
        </div>
        {p.status === 'REQUESTED' && mode === 'idle' ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button onClick={() => setMode('paid')}>Mark as paid…</Button>
            <Button variant="secondary" onClick={() => setMode('reject')}>
              Reject…
            </Button>
          </div>
        ) : null}
      </div>
      {mode === 'paid' ? (
        <ReasonForm
          label="UPI transaction reference (UTR)"
          hint="The 12-digit reference from your banking app after sending the money."
          submitLabel={`Confirm ${formatINR(p.amount)} paid`}
          multiline={false}
          maxLength={100}
          onCancel={() => setMode('idle')}
          onSubmit={async (reference) => {
            await adminApi.markPaid(p.id, reference);
            toast(`Payout of ${formatINR(p.amount)} marked as paid`, 'success');
            onChanged();
          }}
        />
      ) : mode === 'reject' ? (
        <ReasonForm
          label="Why is it rejected?"
          hint={`The uploader sees this, and ${formatINR(p.amount)} goes back to their balance.`}
          submitLabel="Reject payout"
          variant="danger"
          onCancel={() => setMode('idle')}
          onSubmit={async (note) => {
            await adminApi.rejectPayout(p.id, note);
            toast('Payout rejected and the money returned to the balance', 'info');
            onChanged();
          }}
        />
      ) : null}
    </article>
  );
}
