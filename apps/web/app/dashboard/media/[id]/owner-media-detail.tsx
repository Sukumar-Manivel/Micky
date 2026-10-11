'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { CategoryBadge, MediaStatusBadge } from '@/components/badges';
import { PreviewPlayer } from '@/components/preview-player';
import { PageSkeleton } from '@/components/require-role';
import { useToast } from '@/components/toast';
import { Alert, Button, Field, LoadFailed, Panel, inputClass } from '@/components/ui';
import { VerificationPanel } from '@/components/verification-panel';
import { describeError, myMediaApi } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { MAX_PRICE_PAISE, MIN_PRICE_PAISE, formatINR, paiseToRupeeInput, rupeesToPaise } from '@/lib/money';
import type { MediaOwnerView } from '@/lib/types';
import { useApi } from '@/lib/use-api';

export function OwnerMediaDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: media, error, loading, setData } = useApi(`me/media/${id}`, () => myMediaApi.get(id));

  if (loading) return <PageSkeleton />;
  if (error && !media)
    return <LoadFailed title="Upload not found" message={error} backHref="/dashboard" backLabel="Back to my footage" />;
  if (!media) return null;

  const previewable = media.status === 'APPROVED' || media.status === 'IN_REVIEW';

  return (
    <article className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/dashboard" className="font-semibold text-muted hover:text-ink">
          ← My footage
        </Link>
      </nav>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <MediaStatusBadge status={media.status} />
          <CategoryBadge category={media.category} />
        </div>
        <h1 className="font-display text-4xl font-extrabold sm:text-5xl">{media.title}</h1>
        <p className="text-muted">
          Recorded {formatDateTime(media.capturedAt)}
          {media.locationName ? ` · ${media.locationName}` : ''}
        </p>
      </header>

      <StatusExplainer media={media} />

      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <div className="flex flex-col gap-6">
          {previewable ? (
            <PreviewPlayer mediaId={media.id} type={media.type} title={media.title} audience="owner" />
          ) : (
            <div className="flex aspect-video items-center justify-center rounded-xl bg-sunken p-6 text-center text-muted">
              {media.status === 'PROCESSING' ? 'The preview will appear here once it is ready.' : 'No preview available.'}
            </div>
          )}
          <Panel aria-labelledby="checks-h">
            <h2 id="checks-h" className="mb-4 text-xl font-bold">
              Our checks
            </h2>
            <VerificationPanel verification={media.verification} />
          </Panel>
        </div>
        <div className="flex flex-col gap-6">
          <Panel aria-labelledby="sales-h">
            <h2 id="sales-h" className="mb-3 text-xl font-bold">
              Sales
            </h2>
            <dl className="grid grid-cols-2 gap-3">
              <div>
                <dt className="text-sm text-muted">Licences sold</dt>
                <dd className="font-display tabular text-3xl font-bold">{media.salesCount}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted">You earned</dt>
                <dd className="font-display tabular text-3xl font-bold">{formatINR(media.earned)}</dd>
              </div>
            </dl>
            {media.exclusiveSold ? (
              <p className="mt-3 text-sm font-semibold text-verified">Sold with an exclusive licence.</p>
            ) : null}
          </Panel>
          <EditPanel media={media} onSaved={(m) => setData(() => m)} />
          <RemovePanel media={media} />
        </div>
      </div>
    </article>
  );
}

function StatusExplainer({ media }: { media: MediaOwnerView }) {
  switch (media.status) {
    case 'PROCESSING':
      return <Alert tone="info">We are making a preview and running checks. This usually takes a few minutes.</Alert>;
    case 'IN_REVIEW':
      return <Alert tone="caution">A reviewer will look at your upload soon. Newsrooms cannot see it yet.</Alert>;
    case 'APPROVED':
      return <Alert tone="success">Approved and on sale. Newsrooms can see a watermarked preview.</Alert>;
    case 'REJECTED':
      return <Alert>Not approved{media.reviewNote ? `: ${media.reviewNote}` : '.'}</Alert>;
    case 'FAILED':
      return <Alert>We could not process this file{media.processingError ? `: ${media.processingError}` : '.'} Try uploading the original again.</Alert>;
    case 'REMOVED':
      return <Alert tone="info">This upload has been removed and is no longer on sale.</Alert>;
  }
}

function EditPanel({ media, onSaved }: { media: MediaOwnerView; onSaved: (m: MediaOwnerView) => void }) {
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = media.salesCount > 0 || media.status === 'REMOVED';

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const nonEx = rupeesToPaise(String(f.get('priceNonExclusive')));
    const ex = rupeesToPaise(String(f.get('priceExclusive')));
    if (nonEx === null || ex === null || [nonEx, ex].some((p) => p < MIN_PRICE_PAISE || p > MAX_PRICE_PAISE))
      return setError(`Prices must be between ${formatINR(MIN_PRICE_PAISE)} and ${formatINR(MAX_PRICE_PAISE)}.`);
    if (ex < nonEx) return setError('The exclusive price must be at least the non-exclusive price.');
    setBusy(true);
    setError(null);
    try {
      const updated = await myMediaApi.update(media.id, {
        title: String(f.get('title')).trim(),
        description: String(f.get('description')).trim(),
        priceNonExclusive: nonEx,
        priceExclusive: ex,
      });
      onSaved(updated);
      toast('Changes saved', 'success');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel aria-labelledby="edit-h">
      <h2 id="edit-h" className="mb-3 text-xl font-bold">
        Title and price
      </h2>
      {locked ? (
        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">Non-exclusive</dt>
            <dd className="tabular font-bold">{formatINR(media.priceNonExclusive)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Exclusive</dt>
            <dd className="tabular font-bold">{formatINR(media.priceExclusive)}</dd>
          </div>
          <p className="pt-2 text-muted">Prices are fixed once a newsroom has bought a licence.</p>
        </dl>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="Title" htmlFor="edit-title">
            <input id="edit-title" name="title" defaultValue={media.title} required minLength={5} maxLength={120} className={inputClass} />
          </Field>
          <Field label="Details" htmlFor="edit-description">
            <textarea id="edit-description" name="description" defaultValue={media.description ?? ''} rows={3} maxLength={2000} className={inputClass} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Non-exclusive (₹)" htmlFor="edit-ne">
              <input id="edit-ne" name="priceNonExclusive" inputMode="decimal" defaultValue={paiseToRupeeInput(media.priceNonExclusive)} required className={inputClass} />
            </Field>
            <Field label="Exclusive (₹)" htmlFor="edit-ex">
              <input id="edit-ex" name="priceExclusive" inputMode="decimal" defaultValue={paiseToRupeeInput(media.priceExclusive)} required className={inputClass} />
            </Field>
          </div>
          {error ? <Alert>{error}</Alert> : null}
          <Button type="submit" busy={busy}>
            Save changes
          </Button>
        </form>
      )}
    </Panel>
  );
}

function RemovePanel({ media }: { media: MediaOwnerView }) {
  const router = useRouter();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (media.status === 'REMOVED') return null;

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await myMediaApi.remove(media.id);
      toast('Upload removed', 'success');
      router.push('/dashboard');
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <Panel aria-labelledby="remove-h">
      <h2 id="remove-h" className="mb-2 text-xl font-bold">
        Remove upload
      </h2>
      <p className="mb-3 text-sm text-muted">
        Removing takes it off sale. Footage that a newsroom has already bought cannot be removed, because they hold a licence.
      </p>
      {error ? <div className="mb-3"><Alert>{error}</Alert></div> : null}
      {confirming ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" onClick={remove} busy={busy}>
            Yes, remove it
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Keep it
          </Button>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setConfirming(true)}>
          Remove upload
        </Button>
      )}
    </Panel>
  );
}
