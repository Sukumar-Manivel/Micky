// A thumbnail with a placeholder when there is none yet (still processing) or it fails to load.
// Thumbnails are signed, watermarked JPEGs served by the API, so we use a plain <img> and let
// the browser cache them (the API sends Cache-Control: private, max-age=3600).

'use client';

import { useState } from 'react';
import { formatDuration } from '@/lib/format';
import type { MediaType } from '@/lib/types';

export function MediaThumb({
  url,
  type,
  durationSec,
  alt,
  className = 'aspect-video w-full',
}: {
  url: string | null;
  type: MediaType;
  durationSec?: number | null;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const duration = formatDuration(durationSec ?? null);
  return (
    <div className={`relative overflow-hidden rounded-lg bg-sunken ${className}`} onContextMenu={(e) => e.preventDefault()}>
      {url && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed, expiring URL; must not go through an image proxy
        <img src={url} alt={alt} loading="lazy" draggable={false} onError={() => setFailed(true)} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-muted">
          {type === 'VIDEO' ? 'Video' : 'Photo'}
        </div>
      )}
      {type === 'VIDEO' && duration ? (
        <span className="tabular absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-xs font-bold text-white">
          {duration}
        </span>
      ) : null}
    </div>
  );
}
