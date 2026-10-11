import { formatINR } from '@/lib/money';
import type { EarningsSummary } from '@/lib/types';
import { Skeleton } from './ui';

export function EarningsCards({ summary }: { summary: EarningsSummary | undefined }) {
  const items: { label: string; value: number | undefined; note?: string; lead?: boolean }[] = [
    { label: 'Balance', value: summary?.balance, note: 'Ready to withdraw', lead: true },
    { label: 'Total earned', value: summary?.totalEarned, note: summary ? `${summary.salesCount} sales` : undefined },
    { label: 'Paid out', value: summary?.totalPaidOut },
    { label: 'Pending payouts', value: summary?.pendingPayouts, note: 'Being sent to your UPI' },
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
