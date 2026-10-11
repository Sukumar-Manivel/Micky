'use client';

// Newsroom approval. A CHANNEL account cannot see any footage until an admin approves its
// organisation, so witnesses know every viewer is a real newsroom.

import { useState } from 'react';
import { LoadError, ReasonForm, StatusFilter } from '@/components/admin-ui';
import { ChannelStatusBadge } from '@/components/badges';
import { useToast } from '@/components/toast';
import { Button, EmptyState, PageHeader, Pager, Skeleton } from '@/components/ui';
import { adminApi } from '@/lib/api';
import { domainMatch } from '@/lib/domain';
import { formatDate } from '@/lib/format';
import type { ChannelStatus, UserView } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const PAGE_SIZE = 20;
const STATUS_OPTIONS: { value: ChannelStatus | undefined; label: string }[] = [
  { value: 'PENDING', label: 'Waiting' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: undefined, label: 'All' },
];

export function ChannelApprovals() {
  const [status, setStatus] = useState<ChannelStatus | undefined>('PENDING');
  const [page, setPage] = useState(1);
  const list = useApi(`admin/channels?status=${status ?? ''}&page=${page}`, () =>
    adminApi.channels({ status, page, pageSize: PAGE_SIZE }),
  );

  return (
    <>
      <PageHeader title="Newsrooms">
        Approve an organisation only when you are confident it is a real newsroom: check its website, and that the
        email address belongs to it.
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
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      ) : list.data && list.data.items.length === 0 ? (
        <EmptyState title={status === 'PENDING' ? 'No newsrooms waiting' : 'No newsrooms here'}>
          {status === 'PENDING' ? 'New newsroom sign-ups appear here for approval.' : 'Try another filter.'}
        </EmptyState>
      ) : list.data ? (
        <>
          <ul className="flex flex-col gap-3">
            {list.data.items.map((u) => (
              <li key={u.id}>
                <ChannelCard user={u} onChanged={list.reload} />
              </li>
            ))}
          </ul>
          <Pager page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </>
      ) : null}
    </>
  );
}

function ChannelCard({ user: u, onChanged }: { user: UserView; onChanged: () => void }) {
  const toast = useToast();
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const channel = u.channel;
  const match = domainMatch(u.email, channel?.website ?? null);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await adminApi.approveChannel(u.id);
      toast(`${channel?.organization ?? u.name} approved`, 'success');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not approve.');
      setBusy(false);
    }
  }

  return (
    <article className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            {channel ? <ChannelStatusBadge status={channel.status} /> : null}
            <span className="text-sm text-muted">Signed up {formatDate(u.createdAt)}</span>
          </div>
          <h2 className="font-display text-2xl font-bold [overflow-wrap:anywhere]">{channel?.organization ?? '(no organisation)'}</h2>
          <p className="text-sm [overflow-wrap:anywhere]">
            {u.name} · <a href={`mailto:${u.email}`} className="underline">{u.email}</a>
          </p>
          {channel?.website ? (
            <p className="text-sm [overflow-wrap:anywhere]">
              {/* noreferrer: the newsroom's site must not learn our admin URLs. */}
              <a href={channel.website} target="_blank" rel="noopener noreferrer nofollow" className="font-semibold underline">
                {channel.website}
              </a>
            </p>
          ) : (
            <p className="text-sm text-muted">No website given</p>
          )}
          {match === 'match' ? (
            <p className="text-sm font-semibold text-verified">✓ Email address is on the website’s domain</p>
          ) : match === 'mismatch' ? (
            <p className="text-sm font-semibold text-caution">! Email address is not on the website’s domain. Check before approving.</p>
          ) : null}
        </div>
        {channel && !rejecting ? (
          // The API allows every change: approve, reject, revoke an approval, or approve after a rejection.
          <div className="flex shrink-0 flex-wrap gap-2">
            {channel.status !== 'APPROVED' ? (
              <Button onClick={approve} busy={busy}>
                {channel.status === 'REJECTED' ? 'Approve after all' : 'Approve'}
              </Button>
            ) : null}
            {channel.status !== 'REJECTED' ? (
              <Button variant="secondary" onClick={() => setRejecting(true)} disabled={busy}>
                {channel.status === 'APPROVED' ? 'Revoke approval…' : 'Reject…'}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {error ? <p className="text-sm font-semibold text-danger" role="alert">{error}</p> : null}
      {rejecting ? (
        <ReasonForm
          label="Reason"
          hint={
            channel?.status === 'APPROVED'
              ? 'Kept on record. The newsroom loses access to the marketplace at once.'
              : 'Kept on record. The newsroom is told it was not approved and can write to the grievance officer.'
          }
          submitLabel={channel?.status === 'APPROVED' ? 'Revoke approval' : 'Reject newsroom'}
          variant="danger"
          onCancel={() => setRejecting(false)}
          onSubmit={async (note) => {
            await adminApi.rejectChannel(u.id, note);
            toast(`${channel?.organization ?? u.name} rejected`, 'info');
            onChanged();
          }}
        />
      ) : null}
    </article>
  );
}
