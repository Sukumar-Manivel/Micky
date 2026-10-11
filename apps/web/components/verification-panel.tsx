// Shows the evidence report for one upload. Used by newsrooms (no metadata), uploaders (their
// own) and admins (full metadata). The AI score is presented as a signal with an honest
// caption, because detectors are often wrong on new generators (see docs/RESEARCH.md).

import Link from 'next/link';
import type { C2paStatus, Signal, VerificationView } from '@/lib/types';
import { RiskBadge } from './badges';

const c2paText: Record<C2paStatus, { label: string; detail: string }> = {
  valid: { label: 'Valid Content Credentials', detail: 'The file carries a valid C2PA signature from the capture device or app.' },
  invalid: { label: 'Credentials do not match', detail: 'A C2PA signature is present but does not match the file. It may have been edited.' },
  absent: { label: 'No Content Credentials', detail: 'Normal for most phones and for files shared through WhatsApp.' },
  error: { label: 'Could not check', detail: 'The provenance check failed for this file.' },
  unsupported: { label: 'Not supported', detail: 'Provenance checks are not available for this file type.' },
};

const signalTone: Record<Signal['level'], string> = {
  positive: 'text-verified',
  info: 'text-muted',
  warning: 'text-caution',
  danger: 'text-danger',
};
const signalIcon: Record<Signal['level'], string> = { positive: '✓', info: 'i', warning: '!', danger: '✕' };
const signalName: Record<Signal['level'], string> = {
  positive: 'Good sign',
  info: 'Note',
  warning: 'Warning',
  danger: 'Problem',
};

export function AiScoreBar({ score }: { score: number | null }) {
  if (score === null) {
    return <p className="text-sm text-muted">The AI detector was unavailable for this file.</p>;
  }
  const pct = Math.round(score * 100);
  const tone = score >= 0.7 ? 'bg-danger' : score >= 0.4 ? 'bg-caution' : 'bg-verified';
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-semibold">AI-likelihood</span>
        <span className="tabular font-bold">{pct}%</span>
      </div>
      <div
        role="meter"
        aria-label="AI-likelihood score"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-2.5 w-full overflow-hidden rounded-full bg-sunken"
      >
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(pct, 2)}%` }} />
      </div>
      <p className="text-xs text-muted">
        A signal, not a verdict. Detectors miss many new AI tools and sometimes flag real footage. Weigh it with the other
        checks.
      </p>
    </div>
  );
}

export function VerificationPanel({
  verification,
  showMetadata = false,
  duplicateHref,
}: {
  verification: VerificationView | null;
  showMetadata?: boolean;
  /** Where a duplicate link should point, for roles that can open the original. */
  duplicateHref?: (id: string) => string;
}) {
  if (!verification) {
    return <p className="text-muted">Checks have not finished yet.</p>;
  }
  const c2pa = c2paText[verification.c2paStatus];
  const metaEntries = Object.entries(verification.metadata);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <RiskBadge risk={verification.riskLevel} />
        {verification.aiModel ? <span className="text-xs text-muted">Model: {verification.aiModel}</span> : null}
      </div>

      <AiScoreBar score={verification.aiScore} />

      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-semibold">Provenance</p>
        <p className={verification.c2paStatus === 'valid' ? 'font-semibold text-verified' : verification.c2paStatus === 'invalid' ? 'font-semibold text-danger' : ''}>
          {c2pa.label}
          {verification.c2paIssuer ? ` · ${verification.c2paIssuer}` : ''}
        </p>
        <p className="text-sm text-muted">{c2pa.detail}</p>
      </div>

      {verification.duplicateOfId ? (
        <p className="rounded-lg border border-caution/40 bg-caution-soft px-3 py-2 text-sm font-semibold text-caution">
          Looks like a copy of an earlier upload.{' '}
          {duplicateHref ? (
            <Link href={duplicateHref(verification.duplicateOfId)} className="underline">
              Open the earlier upload
            </Link>
          ) : showMetadata ? (
            <span className="block font-mono text-xs font-normal [overflow-wrap:anywhere]">Earlier upload ID: {verification.duplicateOfId}</span>
          ) : null}
        </p>
      ) : null}

      {verification.signals.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold">What we found</p>
          <ul className="flex flex-col gap-1.5">
            {verification.signals.map((s) => (
              <li key={s.code} className="flex gap-2 text-sm">
                <span
                  className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs font-bold ${signalTone[s.level]}`}
                  aria-hidden="true"
                >
                  {signalIcon[s.level]}
                </span>
                <span>
                  <span className="sr-only">{signalName[s.level]}: </span>
                  {s.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {showMetadata ? (
        <details className="rounded-lg border border-line">
          <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">Full metadata ({metaEntries.length})</summary>
          {metaEntries.length === 0 ? (
            <p className="px-3 pb-3 text-sm text-muted">The file has no metadata. Messaging apps often remove it.</p>
          ) : (
            <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-1 px-3 pb-3 text-sm">
              {metaEntries.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="font-semibold text-muted [overflow-wrap:anywhere]">{k}</dt>
                  <dd className="font-mono text-xs [overflow-wrap:anywhere]">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </details>
      ) : null}
    </div>
  );
}
