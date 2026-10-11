'use client';

// The moderation queue: every upload waiting for a human decision (status IN_REVIEW), oldest
// first. Nothing goes on sale until an admin approves it here.
//
// Layout: on a wide screen the queue sits on the left and the selected upload on the right,
// so a reviewer can work down the list. On a phone only one of the two is shown at a time.

import { useMemo, useState } from 'react';
import { LoadError, ReasonForm, StatusFilter } from '@/components/admin-ui';
import { CategoryBadge, MediaStatusBadge, RiskBadge } from '@/components/badges';
import { PointsMap } from '@/components/maps';
import { MediaThumb } from '@/components/media-thumb';
import { PreviewPlayer } from '@/components/preview-player';
import { useToast } from '@/components/toast';
import { Button, EmptyState, PageHeader, Pager, Panel, Skeleton } from '@/components/ui';
import { VerificationPanel } from '@/components/verification-panel';
import { ApiError, adminApi } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/format';
import { formatINR } from '@/lib/money';
import type { ReviewItem, RiskLevel } from '@/lib/types';
import { useApi } from '@/lib/use-api';
import { useNow } from '@/lib/use-now';

const PAGE_SIZE = 20;
const RISK_OPTIONS: { value: RiskLevel | undefined; label: string }[] = [
  { value: undefined, label: 'All' },
  { value: 'HIGH', label: 'High risk' },
  { value: 'MEDIUM', label: 'Medium risk' },
  { value: 'LOW', label: 'Low risk' },
];

export function ReviewQueue() {
  const [page, setPage] = useState(1);
  const [risk, setRisk] = useState<RiskLevel | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const now = useNow();
  const queue = useApi(`admin/review-queue?page=${page}&risk=${risk ?? ''}`, () =>
    adminApi.reviewQueue({ page, pageSize: PAGE_SIZE, risk }),
  );

  const items = queue.data?.items ?? [];
  // With nothing chosen, wide screens show the oldest upload; phones show the list.
  const current = items.find((m) => m.id === selectedId) ?? items[0] ?? null;

  /** After a decision: drop the item locally, move on to the next one, refill in the background. */
  function decided(id: string) {
    const index = items.findIndex((m) => m.id === id);
    const next = items[index + 1] ?? items[index - 1] ?? null;
    queue.setData((d) => ({ ...d, items: d.items.filter((m) => m.id !== id), total: Math.max(0, d.total - 1) }));
    setSelectedId(next?.id ?? null);
    queue.reload();
  }

  return (
    <>
      <PageHeader
        title="Review queue"
        actions={
          <Button variant="secondary" size="sm" onClick={queue.reload} busy={queue.refreshing}>
            Refresh
          </Button>
        }
      >
        Uploads waiting for a decision, oldest first. Look at the footage and every signal: the AI score alone is never
        enough to approve or reject.
      </PageHeader>

      <StatusFilter
        label="Filter by risk"
        value={risk}
        options={RISK_OPTIONS}
        onChange={(r) => {
          setRisk(r);
          setPage(1);
          setSelectedId(null);
        }}
      />

      {queue.error && !queue.data ? <LoadError message={queue.error} onRetry={queue.reload} /> : null}

      {queue.loading ? (
        <div className="grid gap-6 lg:grid-cols-[22rem_1fr]" aria-busy="true" aria-label="Loading">
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
          <Skeleton className="hidden h-96 lg:block" />
        </div>
      ) : queue.data && items.length === 0 ? (
        <EmptyState title={risk ? 'Nothing at this risk level' : 'All caught up'}>
          {risk
            ? 'No uploads with this risk level are waiting. Choose “All” to see the rest of the queue.'
            : 'No uploads are waiting for review. New uploads appear here once their checks have finished.'}
        </EmptyState>
      ) : current ? (
        <div className="grid items-start gap-6 lg:grid-cols-[22rem_1fr]">
          <section aria-labelledby="queue-h" className={selectedId ? 'hidden lg:block' : ''}>
            <h2 id="queue-h" className="mb-2 text-sm font-semibold text-muted">
              <span className="tabular">{queue.data?.total ?? 0}</span> waiting
            </h2>
            <ul className="flex flex-col gap-2">
              {items.map((m) => (
                <li key={m.id}>
                  <QueueRow item={m} now={now} selected={m.id === current.id} onSelect={() => setSelectedId(m.id)} />
                </li>
              ))}
            </ul>
            <Pager
              page={page}
              pageSize={PAGE_SIZE}
              total={queue.data?.total ?? 0}
              onPage={(p) => {
                setPage(p);
                setSelectedId(null);
              }}
            />
          </section>

          <div className={selectedId ? '' : 'hidden lg:block'}>
            <Button variant="ghost" size="sm" className="mb-3 lg:hidden" onClick={() => setSelectedId(null)}>
              ← Back to the queue
            </Button>
            {/* key: a fresh panel (and fresh forms) for each upload. */}
            <ReviewPanel key={current.id} item={current} now={now} onDecided={decided} onConflict={queue.reload} />
          </div>
        </div>
      ) : null}
    </>
  );
}

function QueueRow({ item: m, now, selected, onSelect }: { item: ReviewItem; now: number; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={`grid w-full grid-cols-[5.5rem_1fr] gap-3 rounded-xl border p-2 text-left ${
        selected ? 'border-ink bg-surface' : 'border-line bg-surface hover:border-ink'
      }`}
    >
      <MediaThumb url={m.thumbnailUrl} type={m.type} durationSec={m.durationSec} alt="" className="aspect-video w-full" />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap gap-1.5">
          {m.verification ? <RiskBadge risk={m.verification.riskLevel} /> : <span className="text-xs text-muted">No checks</span>}
        </span>
        <span className="truncate font-bold">{m.title}</span>
        <span className="truncate text-xs text-muted">
          {m.uploader.name} · {timeAgo(m.createdAt, now)}
        </span>
      </span>
    </button>
  );
}

function ReviewPanel({
  item: m,
  now,
  onDecided,
  onConflict,
}: {
  item: ReviewItem;
  now: number;
  onDecided: (id: string) => void;
  onConflict: () => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<'idle' | 'approve' | 'reject'>('idle');
  // Stable array, so the map does not re-fit its view on every render.
  const pin = useMemo(
    () => [{ id: m.id, lat: m.latitude, lng: m.longitude, title: m.title, category: m.category }],
    [m.id, m.latitude, m.longitude, m.title, m.category],
  );

  // Another admin may have decided first: the API answers 409. Refresh the queue so it disappears.
  async function guard(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) onConflict();
      throw err;
    }
  }

  const hoursToUpload = Math.round((new Date(m.createdAt).getTime() - new Date(m.capturedAt).getTime()) / 3_600_000);
  const facts: [string, string][] = [
    ['Uploaded by', `${m.uploader.name} (${m.uploader.email})`],
    ['Uploaded', `${formatDateTime(m.createdAt)} · ${timeAgo(m.createdAt, now)}`],
    ['Recorded (as stated)', `${formatDateTime(m.capturedAt)}${hoursToUpload >= 1 ? ` · ${hoursToUpload} h before upload` : ''}`],
    ['Place (as stated)', `${m.locationName ? `${m.locationName} · ` : ''}${m.latitude.toFixed(5)}, ${m.longitude.toFixed(5)}`],
    ['Prices', `${formatINR(m.priceNonExclusive)} non-exclusive · ${formatINR(m.priceExclusive)} exclusive`],
  ];
  if (m.width && m.height) facts.push(['Original size', `${m.width} × ${m.height}`]);

  return (
    <article aria-labelledby="review-title" className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <MediaStatusBadge status={m.status} />
          <CategoryBadge category={m.category} />
          {m.verification ? <RiskBadge risk={m.verification.riskLevel} /> : null}
        </div>
        <h2 id="review-title" className="font-display text-3xl font-extrabold [overflow-wrap:anywhere] sm:text-4xl">
          {m.title}
        </h2>
        {m.description ? <p className="max-w-prose whitespace-pre-line [overflow-wrap:anywhere]">{m.description}</p> : null}
      </header>

      <PreviewPlayer mediaId={m.id} type={m.type} title={m.title} audience="admin" />

      <Panel aria-labelledby="decision-h" className="border-ink">
        <h3 id="decision-h" className="mb-3 text-xl font-bold">
          Decision
        </h3>
        {mode === 'idle' ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">
              Approving puts it on sale and alerts every newsroom straight away. Rejecting tells the uploader why.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => setMode('approve')}>
                Approve…
              </Button>
              <Button variant="secondary" onClick={() => setMode('reject')}>
                Reject…
              </Button>
            </div>
          </div>
        ) : mode === 'approve' ? (
          <ReasonForm
            label="Note (optional)"
            hint="Kept with the decision. Leave empty if there is nothing to add."
            submitLabel="Approve and put on sale"
            required={false}
            minLength={1}
            onCancel={() => setMode('idle')}
            onSubmit={async (note) => {
              await guard(() => adminApi.approve(m.id, note || undefined));
              toast(`Approved: ${m.title}`, 'success');
              onDecided(m.id);
            }}
          />
        ) : (
          <ReasonForm
            label="Why is it not approved?"
            hint="The uploader sees this. Be specific, e.g. “The same clip was posted online two days earlier.”"
            submitLabel="Reject upload"
            variant="danger"
            onCancel={() => setMode('idle')}
            onSubmit={async (note) => {
              await guard(() => adminApi.reject(m.id, note));
              toast(`Rejected: ${m.title}`, 'info');
              onDecided(m.id);
            }}
          />
        )}
      </Panel>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel aria-labelledby="checks-h">
          <h3 id="checks-h" className="mb-4 text-xl font-bold">
            Verification signals
          </h3>
          <VerificationPanel verification={m.verification} showMetadata />
        </Panel>
        <div className="flex flex-col gap-6">
          <Panel aria-labelledby="facts-h">
            <h3 id="facts-h" className="mb-3 text-xl font-bold">
              Details
            </h3>
            <dl className="flex flex-col gap-2 text-sm">
              {facts.map(([k, v]) => (
                <div key={k}>
                  <dt className="text-muted">{k}</dt>
                  <dd className="font-semibold [overflow-wrap:anywhere]">{v}</dd>
                </div>
              ))}
            </dl>
          </Panel>
          <PointsMap
            points={pin}
            className="h-56 w-full rounded-xl"
          />
        </div>
      </div>
    </article>
  );
}
