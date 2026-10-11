'use client';

import { useState } from 'react';
import { useAuth, useSignedInUser } from '@/components/auth-provider';
import { PayoutStatusBadge } from '@/components/badges';
import { EarningsCards } from '@/components/earnings-cards';
import { useToast } from '@/components/toast';
import { Alert, Button, EmptyState, Field, PageHeader, Pager, Panel, Skeleton, inputClass } from '@/components/ui';
import { describeError, earningsApi } from '@/lib/api';
import { LICENSE_LABEL, formatDate, formatDateTime } from '@/lib/format';
import { formatINR, paiseToRupeeInput, rupeesToPaise } from '@/lib/money';
import type { LedgerEntryType } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const PAGE_SIZE = 10;
/** Must match the API's MIN_PAYOUT_PAISE default (₹100). The server is the final judge. */
const MIN_PAYOUT_PAISE = 100_00;
const UPI_PATTERN = /^[a-zA-Z0-9._-]{2,}@[a-zA-Z][a-zA-Z0-9.]{1,}$/;

const ledgerLabel: Record<LedgerEntryType, string> = {
  SALE_CREDIT: 'Sale',
  PAYOUT_DEBIT: 'Payout',
  PAYOUT_REVERSAL: 'Payout returned',
  ADJUSTMENT: 'Adjustment',
};

export function EarningsView() {
  const summary = useApi('me/earnings', () => earningsApi.summary());
  const [payoutsVersion, setPayoutsVersion] = useState(0);

  const refreshAll = () => {
    summary.reload();
    setPayoutsVersion((v) => v + 1);
  };

  return (
    <>
      <PageHeader title="Earnings">
        You earn a share of every licence sold. Withdraw your balance to any UPI ID.
      </PageHeader>
      <div className="flex flex-col gap-8">
        {summary.error ? <Alert>{summary.error}</Alert> : <EarningsCards summary={summary.data} />}
        <div className="grid gap-6 lg:grid-cols-2">
          <UpiPanel />
          <PayoutRequestPanel balance={summary.data?.balance} onRequested={refreshAll} />
        </div>
        <PayoutHistory key={payoutsVersion} />
        <SalesTable />
        <LedgerTable key={`ledger-${payoutsVersion}`} />
      </div>
    </>
  );
}

function UpiPanel() {
  const user = useSignedInUser();
  const { setUser } = useAuth();
  const toast = useToast();
  const current = user.uploader?.upiId ?? null;
  const [editing, setEditing] = useState(current === null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const upiId = String(new FormData(e.currentTarget).get('upiId')).trim();
    if (!UPI_PATTERN.test(upiId)) return setError('Enter a UPI ID like yourname@okaxis.');
    setBusy(true);
    setError(null);
    try {
      const { user: updated } = await earningsApi.setPayoutDetails(upiId);
      setUser(updated);
      setEditing(false);
      toast('UPI ID saved', 'success');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel aria-labelledby="upi-h">
      <h2 id="upi-h" className="mb-3 text-xl font-bold">
        Where we send your money
      </h2>
      {!editing && current ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p>
            <span className="text-muted">UPI ID: </span>
            <strong className="[overflow-wrap:anywhere]">{current}</strong>
          </p>
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            Change
          </Button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Field label="UPI ID" htmlFor="upiId" hint="Find it in your UPI app (GPay, PhonePe, Paytm, BHIM). It looks like name@bank.">
            <input
              id="upiId"
              name="upiId"
              defaultValue={current ?? ''}
              required
              minLength={3}
              maxLength={100}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="yourname@okaxis"
              aria-describedby="upiId-hint"
              className={inputClass}
            />
          </Field>
          {error ? <Alert>{error}</Alert> : null}
          <div className="flex gap-2">
            <Button type="submit" busy={busy}>
              Save UPI ID
            </Button>
            {current ? (
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      )}
    </Panel>
  );
}

function PayoutRequestPanel({ balance, onRequested }: { balance: number | undefined; onRequested: () => void }) {
  const user = useSignedInUser();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasUpi = Boolean(user.uploader?.upiId);
  const canWithdraw = balance !== undefined && balance >= MIN_PAYOUT_PAISE;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (balance === undefined) return;
    const amount = rupeesToPaise(String(new FormData(e.currentTarget).get('amount')));
    if (amount === null) return setError('Enter an amount in rupees, for example 500.');
    if (amount < MIN_PAYOUT_PAISE) return setError(`The smallest payout is ${formatINR(MIN_PAYOUT_PAISE)}.`);
    if (amount > balance) return setError(`You can withdraw up to ${formatINR(balance)}.`);
    setBusy(true);
    setError(null);
    try {
      await earningsApi.requestPayout(amount);
      toast(`Payout of ${formatINR(amount)} requested`, 'success');
      e.currentTarget?.reset();
      onRequested();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel aria-labelledby="withdraw-h">
      <h2 id="withdraw-h" className="mb-3 text-xl font-bold">
        Withdraw
      </h2>
      {balance === undefined ? (
        <Skeleton className="h-24" />
      ) : !hasUpi ? (
        <p className="text-muted">Add your UPI ID first, then you can withdraw.</p>
      ) : !canWithdraw ? (
        <p className="text-muted">
          You can withdraw once your balance reaches {formatINR(MIN_PAYOUT_PAISE)}. Your balance is {formatINR(balance)}.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Field label="Amount (₹)" htmlFor="amount" hint={`Up to ${formatINR(balance)}. Payouts are usually sent within 3 working days.`}>
            <input
              id="amount"
              name="amount"
              inputMode="decimal"
              required
              defaultValue={paiseToRupeeInput(balance)}
              aria-describedby="amount-hint"
              className={inputClass}
            />
          </Field>
          {error ? <Alert>{error}</Alert> : null}
          <Button type="submit" busy={busy}>
            Request payout
          </Button>
        </form>
      )}
    </Panel>
  );
}

function PayoutHistory() {
  const [page, setPage] = useState(1);
  const { data, error, loading } = useApi(`me/payouts?page=${page}`, () => earningsApi.payouts({ page, pageSize: PAGE_SIZE }));
  return (
    <Panel aria-labelledby="payouts-h">
      <h2 id="payouts-h" className="mb-3 text-xl font-bold">
        Payouts
      </h2>
      {error ? <Alert>{error}</Alert> : null}
      {loading ? (
        <Skeleton className="h-24" />
      ) : data && data.items.length === 0 ? (
        <p className="text-muted">No payouts yet.</p>
      ) : data ? (
        <>
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead className="text-muted">
                <tr className="border-b border-line">
                  <th scope="col" className="py-2 pr-3 font-semibold">Requested</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Amount</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">UPI ID</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Status</th>
                  <th scope="col" className="py-2 font-semibold">Reference / note</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id} className="border-b border-line last:border-0">
                    <td className="py-2 pr-3">{formatDate(p.createdAt)}</td>
                    <td className="tabular py-2 pr-3 font-bold">{formatINR(p.amount)}</td>
                    <td className="py-2 pr-3 [overflow-wrap:anywhere]">{p.upiId}</td>
                    <td className="py-2 pr-3">
                      <PayoutStatusBadge status={p.status} />
                    </td>
                    <td className="py-2 text-muted">{p.reference ?? p.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} />
        </>
      ) : null}
    </Panel>
  );
}

function SalesTable() {
  const [page, setPage] = useState(1);
  const { data, error, loading } = useApi(`me/sales?page=${page}`, () => earningsApi.sales({ page, pageSize: PAGE_SIZE }));
  return (
    <Panel aria-labelledby="sales-h">
      <h2 id="sales-h" className="mb-3 text-xl font-bold">
        Sales
      </h2>
      {error ? <Alert>{error}</Alert> : null}
      {loading ? (
        <Skeleton className="h-24" />
      ) : data && data.items.length === 0 ? (
        <EmptyState title="No sales yet">Once a newsroom buys a licence for your footage, it shows up here.</EmptyState>
      ) : data ? (
        <>
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="text-muted">
                <tr className="border-b border-line">
                  <th scope="col" className="py-2 pr-3 font-semibold">Date</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Footage</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Buyer</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Licence</th>
                  <th scope="col" className="py-2 text-right font-semibold">Your share</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((s) => (
                  <tr key={s.orderId} className="border-b border-line last:border-0">
                    <td className="py-2 pr-3">{formatDate(s.paidAt)}</td>
                    <td className="py-2 pr-3">{s.mediaTitle}</td>
                    <td className="py-2 pr-3">{s.buyerOrganization}</td>
                    <td className="py-2 pr-3">{LICENSE_LABEL[s.licenseType]}</td>
                    <td className="tabular py-2 text-right font-bold">
                      {formatINR(s.uploaderShare)}
                      <span className="block text-xs font-normal text-muted">of {formatINR(s.amount)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} />
        </>
      ) : null}
    </Panel>
  );
}

function LedgerTable() {
  const [page, setPage] = useState(1);
  const { data, error, loading } = useApi(`me/ledger?page=${page}`, () => earningsApi.ledger({ page, pageSize: PAGE_SIZE }));
  return (
    <Panel aria-labelledby="ledger-h">
      <h2 id="ledger-h" className="mb-1 text-xl font-bold">
        All money in and out
      </h2>
      <p className="mb-3 text-sm text-muted">Every change to your balance, newest first.</p>
      {error ? <Alert>{error}</Alert> : null}
      {loading ? (
        <Skeleton className="h-24" />
      ) : data && data.items.length === 0 ? (
        <p className="text-muted">Nothing yet.</p>
      ) : data ? (
        <>
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[30rem] text-left text-sm">
              <thead className="text-muted">
                <tr className="border-b border-line">
                  <th scope="col" className="py-2 pr-3 font-semibold">When</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Type</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Details</th>
                  <th scope="col" className="py-2 text-right font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((l) => (
                  <tr key={l.id} className="border-b border-line last:border-0">
                    <td className="py-2 pr-3 whitespace-nowrap">{formatDateTime(l.createdAt)}</td>
                    <td className="py-2 pr-3">{ledgerLabel[l.type]}</td>
                    <td className="py-2 pr-3 text-muted">{l.mediaTitle ?? l.note ?? '—'}</td>
                    <td className={`tabular py-2 text-right font-bold ${l.amount < 0 ? '' : 'text-verified'}`}>
                      {l.amount > 0 ? '+' : l.amount < 0 ? '−' : ''}
                      {formatINR(Math.abs(l.amount))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} />
        </>
      ) : null}
    </Panel>
  );
}
