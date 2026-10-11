import { formatDate } from '@/lib/format';
import { formatINR } from '@/lib/money';
import type { EarningsSummary } from '@/lib/types';
import { Skeleton } from './ui';

/**
 * The uploader's money at a glance. "Available" is what can be withdrawn now; sale credits
 * are on hold for a few days first (refunds and chargebacks can still reverse them), and
 * the available amount can be negative after a refund of a sale that was already paid out.
 */
export function EarningsCards({ summary }: { summary: EarningsSummary | undefined }) {
  const availableNote = !summary
    ? undefined
    : summary.available < 0
      ? 'Negative after a refund: future sales make up for it'
      : 'Ready to withdraw';
  const holdNote = !summary
    ? undefined
    : summary.onHold > 0 && summary.nextReleaseAt
      ? `Next release ${formatDate(summary.nextReleaseAt)}`
      : `Each sale is held ${summary.holdDays} days`;
  const items: { label: string; value: number | undefined; note?: string; lead?: boolean }[] = [
    { label: 'Available', value: summary?.available, note: availableNote, lead: true },
    { label: 'On hold', value: summary?.onHold, note: holdNote },
    { label: 'Total earned', value: summary?.totalEarned, note: summary ? `${summary.salesCount} sales` : undefined },
    {
      label: 'Paid out',
      value: summary?.totalPaidOut,
      note: summary && summary.pendingPayouts > 0 ? `${formatINR(summary.pendingPayouts)} being sent to your UPI` : undefined,
    },
  ];
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line lg:grid-cols-4">
      {items.map((i) => (
        <div key={i.label} className={`flex flex-col gap-1 p-4 ${i.lead ? 'bg-ink text-page' : 'bg-surface'}`}>
          <dt className={`text-sm font-semibold ${i.lead ? 'opacity-80' : 'text-muted'}`}>{i.label}</dt>
          <dd className="font-display tabular text-3xl font-bold sm:text-4xl">
            {i.value === undefined ? <Skeleton className="h-9 w-24" /> : formatINR(i.value)}
          </dd>
          {i.note ? <dd className={`text-xs ${i.lead ? 'opacity-70' : 'text-muted'}`}>{i.note}</dd> : null}
        </div>
      ))}
    </dl>
  );
}
