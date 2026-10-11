'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, ButtonLink, Field, inputClass } from '@/components/ui';
import { describeError, reportsApi } from '@/lib/api';
import { REPORT_REASON_LABEL } from '@/lib/format';
import type { ReportReason } from '@/lib/types';

const REASONS: { value: ReportReason; help: string }[] = [
  { value: 'PRIVACY', help: 'I am shown in it, or it identifies me or my family, and I did not agree.' },
  { value: 'COPYRIGHT', help: 'I recorded it, and someone else uploaded it.' },
  { value: 'FAKE', help: 'It is AI-made, edited to mislead, or not from where or when it claims.' },
  { value: 'GRAPHIC', help: 'It shows injured people, a child, or something that should not be shared.' },
  { value: 'OTHER', help: 'Anything else about Micky.' },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ReportForm() {
  const raw = useSearchParams().get('media');
  const mediaId = raw && UUID.test(raw) ? raw : null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentId, setSentId] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const reason = f.get('reason') as ReportReason | null;
    if (!reason) return setError('Choose what the problem is.');
    const details = String(f.get('details') ?? '').trim();
    setBusy(true);
    setError(null);
    try {
      const res = await reportsApi.create({
        reporterEmail: String(f.get('email')).trim(),
        reason,
        ...(mediaId ? { mediaId } : {}),
        ...(details ? { details } : {}),
      });
      setSentId(res.id);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  if (sentId) {
    return (
      <div className="flex flex-col gap-4 rounded-xl border border-verified/40 bg-verified-soft p-6" role="status">
        <h2 className="font-display text-3xl font-bold text-verified">Thank you. We have your report.</h2>
        <p>
          A person will look at it and reply to the email address you gave. Reports about privacy or graphic content are
          handled first.
        </p>
        <p className="text-sm text-muted">
          Reference: <span className="font-mono [overflow-wrap:anywhere]">{sentId}</span>
        </p>
        <div>
          <ButtonLink href="/" variant="secondary">
            Back to the home page
          </ButtonLink>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      {mediaId ? (
        <Alert tone="info">
          You are reporting one specific upload. Its reference is added to your report automatically.
        </Alert>
      ) : null}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 font-semibold">What is the problem?</legend>
        {REASONS.map((r) => (
          <label
            key={r.value}
            className="flex cursor-pointer gap-3 rounded-xl border border-line bg-surface p-3 has-[:checked]:border-ink has-[:focus-visible]:outline has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-focus"
          >
            <input type="radio" name="reason" value={r.value} required className="mt-1.5 h-4 w-4 shrink-0" />
            <span className="flex flex-col">
              <span className="font-bold">{REPORT_REASON_LABEL[r.value]}</span>
              <span className="text-sm text-muted">{r.help}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <Field label="Tell us more (optional)" htmlFor="details" hint="Which footage, what is wrong, and what you would like us to do.">
        <textarea id="details" name="details" rows={5} maxLength={2000} aria-describedby="details-hint" className={inputClass} />
      </Field>

      <Field label="Your email" htmlFor="email" hint="We only use it to reply about this report.">
        <input id="email" name="email" type="email" autoComplete="email" required maxLength={254} aria-describedby="email-hint" className={inputClass} />
      </Field>

      {error ? <Alert>{error}</Alert> : null}

      <Button type="submit" size="lg" busy={busy}>
        Send report
      </Button>
      <p className="text-sm text-muted">
        See also our <Link href="/privacy" className="underline">privacy notice</Link>. If someone is in danger now, call 112.
      </p>
    </form>
  );
}
