'use client';

import Link from 'next/link';
import { LoadError } from '@/components/admin-ui';
import { PageHeader, Skeleton } from '@/components/ui';
import { adminApi } from '@/lib/api';
import { formatINR } from '@/lib/money';
import type { AdminStats } from '@/lib/types';
import { useApi } from '@/lib/use-api';

/** The admin's to-do list first (things waiting on a person), then the business numbers. */
export function AdminOverview() {
  const { data, error, loading, reload, refreshing } = useApi('admin/stats', () => adminApi.stats());

  return (
    <>
      <PageHeader title="Overview">What needs a decision today, and how the marketplace is doing.</PageHeader>
      {error && !data ? <LoadError message={error} onRetry={reload} /> : null}
      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true" aria-label="Loading">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : data ? (
        <div className="flex flex-col gap-10" aria-busy={refreshing || undefined}>
          <Waiting stats={data} />
          <Numbers stats={data} />
        </div>
      ) : null}
    </>
  );
}

function Waiting({ stats }: { stats: AdminStats }) {
  const tasks = [
    { href: '/admin/review', count: stats.media.inReview, label: 'Uploads to review', note: 'Approve or reject footage' },
    { href: '/admin/channels', count: stats.users.pendingChannels, label: 'Newsrooms to approve', note: 'Check the organisation' },
    {
      href: '/admin/payouts',
      count: stats.payouts.requested,
      label: 'Payouts to send',
      note: stats.payouts.requested > 0 ? `${formatINR(stats.payouts.requestedAmount)} in total` : 'Nothing waiting',
    },
    { href: '/admin/reports', count: stats.reports.open, label: 'Open reports', note: 'Grievances have legal deadlines' },
  ];
  return (
    <section aria-labelledby="waiting-h">
      <h2 id="waiting-h" className="mb-3 text-xl font-bold">
        Waiting for you
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tasks.map((t) => (
          <li key={t.href}>
            <Link
              href={t.href}
              className={`flex h-full flex-col gap-1 rounded-xl border p-4 hover:border-ink ${
                t.count > 0 ? 'border-signal/40 bg-surface' : 'border-line bg-surface'
              }`}
            >
              <span className={`font-display tabular text-5xl font-bold ${t.count > 0 ? 'text-signal' : 'text-muted'}`}>{t.count}</span>
              <span className="font-bold">{t.label}</span>
              <span className="text-sm text-muted">{t.note}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Numbers({ stats }: { stats: AdminStats }) {
  const groups: { title: string; rows: [string, string][] }[] = [
    {
      title: 'People',
      rows: [
        ['Uploaders', String(stats.users.uploaders)],
        ['Newsrooms', String(stats.users.channels)],
        ['Newsrooms waiting', String(stats.users.pendingChannels)],
      ],
    },
    {
      title: 'Footage',
      rows: [
        ['Processing', String(stats.media.processing)],
        ['In review', String(stats.media.inReview)],
        ['On sale', String(stats.media.approved)],
        ['Rejected', String(stats.media.rejected)],
      ],
    },
    {
      title: 'Money',
      rows: [
        ['Licences sold', String(stats.orders.paid)],
        ['Revenue', formatINR(stats.orders.revenue)],
        ['Platform fees', formatINR(stats.orders.platformFees)],
      ],
    },
  ];
  return (
    <section aria-labelledby="numbers-h">
      <h2 id="numbers-h" className="mb-3 text-xl font-bold">
        Marketplace
      </h2>
      <div className="grid gap-3 md:grid-cols-3">
        {groups.map((g) => (
          <div key={g.title} className="rounded-xl border border-line bg-surface p-4">
            <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">{g.title}</h3>
            <dl className="flex flex-col">
              {g.rows.map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-3 border-t border-line py-2 first:border-0">
                  <dt className="text-muted">{k}</dt>
                  <dd className="tabular font-bold">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}
