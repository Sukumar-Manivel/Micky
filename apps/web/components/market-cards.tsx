import Link from 'next/link';
import { CATEGORY_LABEL, formatKm, timeAgo } from '@/lib/format';
import { formatINR } from '@/lib/money';
import type { IncidentView, MediaMarketView } from '@/lib/types';
import { CategoryBadge, RiskBadge } from './badges';
import { MediaThumb } from './media-thumb';

/** One incident in the trending feed. `rank` is its position, since the list is ordered. */
export function IncidentRow({ incident: i, rank, now }: { incident: IncidentView; rank: number; now: number }) {
  const fresh = now - new Date(i.lastSeenAt).getTime() < 60 * 60_000;
  return (
    <Link
      href={`/newsroom/incidents/${i.id}`}
      className="grid grid-cols-[2rem_6.5rem_1fr] items-start gap-3 border-b border-line py-4 hover:bg-surface sm:grid-cols-[3rem_11rem_1fr_auto] sm:gap-5 sm:px-2"
    >
      <span className="font-display tabular pt-1 text-3xl font-bold text-muted" aria-label={`Rank ${rank}`}>
        {rank}
      </span>
      <MediaThumb url={i.thumbnailUrl} type="PHOTO" alt="" className="aspect-video w-full" />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {fresh ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-signal">
              <span className="rec-dot" data-live="true" aria-hidden="true" />
              New footage in the last hour
            </span>
          ) : null}
          <CategoryBadge category={i.category} />
        </div>
        <p className="font-display text-xl font-bold leading-tight sm:text-2xl">{i.title}</p>
        <p className="text-sm text-muted">
          {i.locationName ?? `${i.latitude.toFixed(3)}, ${i.longitude.toFixed(3)}`} · started {timeAgo(i.firstSeenAt, now)}
        </p>
      </div>
      <dl className="col-span-3 flex gap-5 pl-[2.75rem] text-sm sm:col-span-1 sm:flex-col sm:gap-0.5 sm:pl-0 sm:text-right">
        <div>
          <dt className="sr-only">Clips</dt>
          <dd>
            <span className="tabular font-bold">{i.mediaCount}</span> {i.mediaCount === 1 ? 'clip' : 'clips'}
          </dd>
        </div>
        <div>
          <dt className="sr-only">Witnesses</dt>
          <dd>
            <span className="tabular font-bold">{i.uploaderCount}</span> {i.uploaderCount === 1 ? 'witness' : 'witnesses'}
          </dd>
        </div>
      </dl>
    </Link>
  );
}

/** A media card in grids (incident page, search results). */
export function MediaCard({ media: m, now }: { media: MediaMarketView; now: number }) {
  const sold = !m.availability.nonExclusive && !m.availability.exclusive;
  return (
    <Link href={`/newsroom/media/${m.id}`} className="group flex flex-col gap-2 rounded-xl border border-line bg-surface p-2 hover:border-ink">
      <MediaThumb url={m.thumbnailUrl} type={m.type} durationSec={m.durationSec} alt="" />
      <div className="flex flex-col gap-1 px-1 pb-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <RiskBadge risk={m.verification.riskLevel} />
          {m.purchased ? <span className="text-xs font-bold text-verified">Licensed</span> : null}
        </div>
        <p className="line-clamp-2 font-bold leading-snug">{m.title}</p>
        <p className="text-xs text-muted">
          {CATEGORY_LABEL[m.category]} · {timeAgo(m.capturedAt, now)}
          {m.distanceKm !== undefined ? ` · ${formatKm(m.distanceKm)}` : ''}
        </p>
        <p className="tabular text-sm font-semibold">
          {sold ? <span className="text-muted">No longer available</span> : `From ${formatINR(m.priceNonExclusive)}`}
        </p>
      </div>
    </Link>
  );
}
