'use client';

// Grievances sent through the public /report form (privacy, copyright, fake, graphic...).
// The IT Rules (as amended in 2026, see docs/RESEARCH.md "Law") expect grievances to be resolved
// within 7 days, and some takedowns within hours. So the list is oldest first and each open
// report shows how long is left.

const RESOLVE_WITHIN_DAYS = 7;

import Link from 'next/link';
import { useState } from 'react';
import { LoadError, ReasonForm, StatusFilter } from '@/components/admin-ui';
import { Badge, ReportStatusBadge } from '@/components/badges';
import { useToast } from '@/components/toast';
import { Button, EmptyState, PageHeader, Pager, Skeleton } from '@/components/ui';
import { adminApi } from '@/lib/api';
import { REPORT_REASON_LABEL, formatDateTime, timeAgo } from '@/lib/format';
import type { Report, ReportStatus } from '@/lib/types';
import { useApi } from '@/lib/use-api';
import { useNow } from '@/lib/use-now';

const PAGE_SIZE = 20;
const STATUS_OPTIONS: { value: ReportStatus | undefined; label: string }[] = [
  { value: 'OPEN', label: 'Open' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'DISMISSED', label: 'Dismissed' },
  { value: undefined, label: 'All' },
];

export function ReportQueue() {
  const [status, setStatus] = useState<ReportStatus | undefined>('OPEN');
  const [page, setPage] = useState(1);
  const now = useNow();
  const list = useApi(`admin/reports?status=${status ?? ''}&page=${page}`, () =>
    adminApi.reports({ status, page, pageSize: PAGE_SIZE }),
  );

  return (
    <>
      <PageHeader title="Reports">
        Complaints from the public, oldest first. Resolve privacy and copyright complaints quickly: they have legal
        deadlines.
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
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : list.data && list.data.items.length === 0 ? (
        <EmptyState title={status === 'OPEN' ? 'No open reports' : 'No reports here'}>
          {status === 'OPEN' ? 'Reports sent through the “Report content” page appear here.' : 'Try another filter.'}
        </EmptyState>
      ) : list.data ? (
        <>
          <ul className="flex flex-col gap-3">
            {list.data.items.map((r) => (
              <li key={r.id}>
                <ReportCard report={r} now={now} onChanged={list.reload} />
              </li>
            ))}
          </ul>
          <Pager page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </>
      ) : null}
    </>
  );
}

function ReportCard({ report: r, now, onChanged }: { report: Report; now: number; onChanged: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'idle' | 'resolve' | 'dismiss'>('idle');
  const daysLeft = Math.ceil(RESOLVE_WITHIN_DAYS - (now - new Date(r.createdAt).getTime()) / 86_400_000);
  const open = r.status === 'OPEN';

  return (
    <article className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <ReportStatusBadge status={r.status} />
            <Badge tone={r.reason === 'PRIVACY' || r.reason === 'GRAPHIC' ? 'bad' : 'neutral'}>{REPORT_REASON_LABEL[r.reason]}</Badge>
            <span className="text-sm text-muted">Received {timeAgo(r.createdAt, now)}</span>
            {open ? (
              <span className={`text-sm font-semibold ${daysLeft <= 0 ? 'text-danger' : daysLeft <= 2 ? 'text-caution' : 'text-muted'}`}>
                {daysLeft <= 0 ? '· Past the 7-day deadline' : `· ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left`}
              </span>
            ) : null}
          </div>
          <p className="text-sm [overflow-wrap:anywhere]">
            From <a href={`mailto:${r.reporterEmail}`} className="underline">{r.reporterEmail}</a>
          </p>
          {r.mediaId ? (
            <p className="text-sm">
              About{' '}
              <Link href={`/newsroom/media/${r.mediaId}`} className="font-semibold underline">
                this footage
              </Link>{' '}
              <span className="text-muted">(opens if it is still on sale)</span>
            </p>
          ) : (
            <p className="text-sm text-muted">Not about a specific upload</p>
          )}
          {r.details ? (
            <blockquote className="mt-1 max-w-prose whitespace-pre-line border-l-4 border-line pl-3 [overflow-wrap:anywhere]">
              {r.details}
            </blockquote>
          ) : (
            <p className="text-sm text-muted">No details given.</p>
          )}
          {r.resolution ? (
            <p className="text-sm">
              <span className="text-muted">Outcome{r.resolvedAt ? ` (${formatDateTime(r.resolvedAt)})` : ''}: </span>
              {r.resolution}
            </p>
          ) : null}
        </div>
        {r.status === 'OPEN' && mode === 'idle' ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button onClick={() => setMode('resolve')}>Resolve…</Button>
            <Button variant="secondary" onClick={() => setMode('dismiss')}>
              Dismiss…
            </Button>
          </div>
        ) : null}
      </div>
      {mode === 'resolve' ? (
        <ReasonForm
          label="What did you do?"
          hint="Kept on record and may be shared with the person who reported it."
          submitLabel="Resolve report"
          maxLength={2000}
          onCancel={() => setMode('idle')}
          onSubmit={async (resolution, form) => {
            const removeMedia = form.get('removeMedia') === 'on';
            await adminApi.resolveReport(r.id, resolution, removeMedia);
            toast(removeMedia ? 'Report resolved and the footage taken down' : 'Report resolved', 'success');
            onChanged();
          }}
        >
          {r.mediaId ? (
            <label className="flex items-start gap-3 rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm">
              <input type="checkbox" name="removeMedia" className="mt-1 h-5 w-5 shrink-0" />
              <span>
                <strong>Also take the footage down.</strong> It is removed from the marketplace at once.
              </span>
            </label>
          ) : null}
        </ReasonForm>
      ) : mode === 'dismiss' ? (
        <ReasonForm
          label="Why is no action needed?"
          hint="Kept on record and may be shared with the person who reported it."
          submitLabel="Dismiss report"
          variant="secondary"
          maxLength={2000}
          onCancel={() => setMode('idle')}
          onSubmit={async (resolution) => {
            await adminApi.dismissReport(r.id, resolution);
            toast('Report dismissed', 'info');
            onChanged();
          }}
        />
      ) : null}
    </article>
  );
}
