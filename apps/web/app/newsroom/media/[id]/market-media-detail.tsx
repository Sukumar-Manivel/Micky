'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useSignedInUser } from '@/components/auth-provider';
import { CategoryBadge } from '@/components/badges';
import { LicensePanel } from '@/components/license-panel';
import { PreviewPlayer } from '@/components/preview-player';
import { PageSkeleton } from '@/components/require-role';
import { Alert, LoadFailed, Panel } from '@/components/ui';
import { VerificationPanel } from '@/components/verification-panel';
import { marketApi } from '@/lib/api';
import { formatDateTime, formatDuration } from '@/lib/format';
import type { MediaMarketView } from '@/lib/types';
import { useApi } from '@/lib/use-api';
import { approximatePlace } from '@/components/maps';

export function MarketMediaDetail() {
  const { id } = useParams<{ id: string }>();
  const user = useSignedInUser();
  const { data: m, error, loading, reload } = useApi(`market media ${id}`, () => marketApi.mediaById(id));

  if (loading) return <PageSkeleton />;
  if (error && !m)
    return <LoadFailed title="Footage not available" message={error} backHref="/newsroom" backLabel="Back to the live feed" />;
  if (!m) return null;

  const facts: [string, string][] = [
    ['Recorded', formatDateTime(m.capturedAt)],
    ['Place', m.locationName ?? approximatePlace(m.latitude, m.longitude)],
    ['Approved', formatDateTime(m.publishedAt)],
  ];
  if (m.width && m.height) facts.push(['Original size', `${m.width} × ${m.height}`]);
  const duration = formatDuration(m.durationSec);
  if (duration) facts.push(['Length', duration]);

  return (
    <article className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="text-sm">
        {m.incidentId ? (
          <Link href={`/newsroom/incidents/${m.incidentId}`} className="font-semibold text-muted hover:text-ink">
            ← Back to the incident
          </Link>
        ) : (
          <Link href="/newsroom" className="font-semibold text-muted hover:text-ink">
            ← Live feed
          </Link>
        )}
      </nav>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <div className="flex flex-col gap-6">
          <PreviewPlayer mediaId={m.id} posterUrl={m.thumbnailUrl} type={m.type} title={m.title} audience={user.role === 'ADMIN' ? 'admin' : 'buyer'} />
          <header className="flex flex-col gap-2">
            <CategoryBadge category={m.category} />
            <h1 className="font-display text-4xl font-extrabold sm:text-5xl">{m.title}</h1>
            {m.description ? <p className="max-w-prose whitespace-pre-line">{m.description}</p> : null}
          </header>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-4 sm:grid-cols-3">
            {facts.map(([k, v]) => (
              <div key={k}>
                <dt className="text-sm text-muted">{k}</dt>
                <dd className="font-semibold">{v}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="flex flex-col gap-6">
          {user.role === 'CHANNEL' ? (
            <>
              <LicensePanel media={m} onPurchased={reload} />
              <DeliveryNote purchased={m.purchased} />
            </>
          ) : (
            <Alert tone="info">You are viewing the marketplace as an admin. Only newsrooms can buy licences.</Alert>
          )}
          <Panel aria-labelledby="checks-h">
            <h2 id="checks-h" className="mb-4 text-xl font-bold">
              Verification
            </h2>
            <VerificationPanel verification={m.verification} />
          </Panel>
          <p className="text-sm text-muted">
            Something wrong with this footage?{' '}
            <Link href={`/report?media=${m.id}`} className="font-semibold underline">
              Report it
            </Link>
          </p>
        </div>
      </div>
    </article>
  );
}

/**
 * What a buyer downloads (docs/REVIEW.md H3): the full-quality file with the witness's
 * identifying metadata removed, and its SHA-256 so the newsroom can check the bytes.
 * `fileSha256` comes from the API (MediaMarketView.purchased); it is null while the copy
 * is still being prepared.
 */
function DeliveryNote({ purchased }: { purchased: MediaMarketView['purchased'] }) {
  if (!purchased) return null;
  const sha256 = (purchased as { fileSha256?: string | null }).fileSha256 ?? null;
  return (
    <p className="text-sm text-muted">
      The download is the full-quality file with details that could identify the witness (GPS, phone make and serial
      number, names) removed; the recording time is kept.
      {sha256 ? (
        <>
          {' '}
          SHA-256: <code className="break-all text-xs" data-testid="file-sha256">{sha256}</code>
        </>
      ) : null}
    </p>
  );
}
