'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSignedInUser } from '@/components/auth-provider';
import { CategoryBadge, MediaStatusBadge } from '@/components/badges';
import { EarningsCards } from '@/components/earnings-cards';
import { MediaThumb } from '@/components/media-thumb';
import { Alert, ButtonLink, EmptyState, PageHeader, Pager, Skeleton } from '@/components/ui';
import { earningsApi, myMediaApi } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { formatINR } from '@/lib/money';
import type { MediaOwnerView } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const POLL_MS = 10_000;
const PAGE_SIZE = 12;

export function MyFootage() {
  const user = useSignedInUser();
  const [page, setPage] = useState(1);
  const media = useApi(`me/media?page=${page}`, () => myMediaApi.list({ page, pageSize: PAGE_SIZE }));
  const earnings = useApi('me/earnings', () => earningsApi.summary());

  // While anything is still PROCESSING, check again every 10 s so the status updates by itself.
  const processing = media.data?.items.some((m) => m.status === 'PROCESSING') ?? false;
  const { reload } = media;
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(reload, POLL_MS);
    return () => clearInterval(t);
  }, [processing, reload]);

  return (
    <>
      <PageHeader title="My footage" actions={<ButtonLink href="/upload" variant="signal">Upload footage</ButtonLink>}>
        Hello {user.name.split(' ')[0]}. Here is everything you have shared and what it has earned.
      </PageHeader>

      <section aria-labelledby="earnings-h" className="mb-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 id="earnings-h" className="text-xl font-bold">
            Earnings
          </h2>
          <Link href="/dashboard/earnings" className="font-semibold underline">
            Withdraw and history
          </Link>
        </div>
        {earnings.error ? <Alert>{earnings.error}</Alert> : <EarningsCards summary={earnings.data} />}
      </section>

      <section aria-labelledby="uploads-h">
        <h2 id="uploads-h" className="mb-3 text-xl font-bold">
          Uploads {media.data ? <span className="tabular font-normal text-muted">({media.data.total})</span> : null}
        </h2>
        {processing ? (
          <p className="mb-3 text-sm text-muted" role="status">
            Some uploads are still being prepared. This page updates by itself.
          </p>
        ) : null}
        {media.error && !media.data ? <Alert>{media.error}</Alert> : null}
        {media.loading ? (
          <ul className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <li key={i}>
                <Skeleton className="h-28" />
              </li>
            ))}
          </ul>
        ) : media.data && media.data.items.length === 0 ? (
          <EmptyState title="Nothing uploaded yet" action={<ButtonLink href="/upload">Upload your first video or photo</ButtonLink>}>
            When something newsworthy happens near you, and only if it is safe, record it and share it here.
          </EmptyState>
        ) : media.data ? (
          <>
            <ul className="flex flex-col gap-3">
              {media.data.items.map((m) => (
                <li key={m.id}>
                  <UploadRow media={m} />
                </li>
              ))}
            </ul>
            <Pager page={page} pageSize={PAGE_SIZE} total={media.data.total} onPage={setPage} />
          </>
        ) : null}
      </section>
    </>
  );
}

function UploadRow({ media: m }: { media: MediaOwnerView }) {
  return (
    <Link
      href={`/dashboard/media/${m.id}`}
      className="grid grid-cols-[7rem_1fr] gap-3 rounded-xl border border-line bg-surface p-3 hover:border-ink sm:grid-cols-[10rem_1fr_auto] sm:gap-5"
    >
      <MediaThumb url={m.thumbnailUrl} type={m.type} durationSec={m.durationSec} alt="" className="aspect-video w-full" />
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <MediaStatusBadge status={m.status} />
          <CategoryBadge category={m.category} />
        </div>
        <p className="truncate font-bold">{m.title}</p>
        <p className="text-sm text-muted">Uploaded {timeAgo(m.createdAt)}</p>
        {m.status === 'REJECTED' && m.reviewNote ? (
          <p className="text-sm text-danger">Reviewer: {m.reviewNote}</p>
        ) : m.status === 'FAILED' && m.processingError ? (
          <p className="text-sm text-danger">{m.processingError}</p>
        ) : null}
      </div>
      <dl className="col-span-2 flex gap-6 border-t border-line pt-2 text-sm sm:col-span-1 sm:flex-col sm:gap-1 sm:border-0 sm:pt-0 sm:text-right">
        <div>
          <dt className="text-muted">Sales</dt>
          <dd className="tabular font-bold">{m.salesCount}</dd>
        </div>
        <div>
          <dt className="text-muted">Earned</dt>
          <dd className="tabular font-bold">{formatINR(m.earned)}</dd>
        </div>
      </dl>
    </Link>
  );
}
