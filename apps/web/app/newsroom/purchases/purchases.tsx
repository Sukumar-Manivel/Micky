'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useSignedInUser } from '@/components/auth-provider';
import { OrderStatusBadge } from '@/components/badges';
import { MediaThumb } from '@/components/media-thumb';
import { Alert, Button, ButtonLink, EmptyState, PageHeader, Pager, Skeleton } from '@/components/ui';
import { describeError, ordersApi } from '@/lib/api';
import { downloadOriginal } from '@/lib/download';
import { LICENSE_LABEL, formatDateTime } from '@/lib/format';
import { formatINR } from '@/lib/money';
import type { OrderView } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const PAGE_SIZE = 20;

export function Purchases() {
  const user = useSignedInUser();
  const [page, setPage] = useState(1);
  // GET /orders is for CHANNEL users only; admins see a short note instead.
  const isChannel = user.role === 'CHANNEL';
  const { data, error, loading } = useApi(isChannel ? `orders?page=${page}` : null, () =>
    ordersApi.list({ page, pageSize: PAGE_SIZE, status: 'PAID' }),
  );

  return (
    <>
      <PageHeader title="Purchases">Every licence your newsroom has bought. Download links are created fresh each time.</PageHeader>
      {!isChannel ? <Alert tone="info">Purchases are listed for newsroom accounts only.</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      {loading ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : data && data.items.length === 0 ? (
        <EmptyState title="No licences yet" action={<ButtonLink href="/newsroom">Browse the live feed</ButtonLink>}>
          When you buy a licence, the original file is available here to download.
        </EmptyState>
      ) : data ? (
        <>
          <ul className="flex flex-col gap-3">
            {data.items.map((o) => (
              <li key={o.id}>
                <OrderRow order={o} />
              </li>
            ))}
          </ul>
          <Pager page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} />
        </>
      ) : null}
    </>
  );
}

function OrderRow({ order: o }: { order: OrderView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <article className="grid grid-cols-[6.5rem_1fr] gap-3 rounded-xl border border-line bg-surface p-3 sm:grid-cols-[9rem_1fr_auto] sm:items-center sm:gap-5">
      <MediaThumb url={o.media.thumbnailUrl} type={o.media.type} alt="" />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <OrderStatusBadge status={o.status} />
          <span className="text-sm font-semibold">{LICENSE_LABEL[o.licenseType]}</span>
        </div>
        <Link href={`/newsroom/media/${o.media.id}`} className="truncate font-bold hover:underline">
          {o.media.title}
        </Link>
        <p className="text-sm text-muted">
          <span className="tabular">{formatINR(o.amount)}</span> · {o.paidAt ? `paid ${formatDateTime(o.paidAt)}` : formatDateTime(o.createdAt)} ·{' '}
          downloaded {o.downloadCount} {o.downloadCount === 1 ? 'time' : 'times'}
        </p>
        {error ? <p className="text-sm font-semibold text-danger">{error}</p> : null}
      </div>
      {o.status === 'PAID' ? (
        <Button
          className="col-span-2 sm:col-span-1"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await downloadOriginal(o.id);
            } catch (err) {
              setError(describeError(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Download original
        </Button>
      ) : null}
    </article>
  );
}
