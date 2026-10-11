'use client';

// Building blocks shared by the admin screens (app/admin/**).

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useId, useState, type ReactNode } from 'react';
import { describeError } from '@/lib/api';
import { Alert, Button, inputClass } from './ui';

const ADMIN_LINKS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/review', label: 'Review queue' },
  { href: '/admin/channels', label: 'Newsrooms' },
  { href: '/admin/payouts', label: 'Payouts' },
  { href: '/admin/reports', label: 'Reports' },
] as const;

/** Section tabs. Scrolls sideways inside itself on a narrow phone instead of widening the page. */
export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin sections" className="-mx-4 mb-6 overflow-x-auto border-b border-line px-4">
      <ul className="flex min-w-max gap-1">
        {ADMIN_LINKS.map((l) => {
          const active = l.href === '/admin' ? pathname === '/admin' : pathname.startsWith(l.href);
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                aria-current={active ? 'page' : undefined}
                className={`inline-flex min-h-11 items-center border-b-3 px-3 font-semibold ${
                  active ? 'border-signal text-ink' : 'border-transparent text-muted hover:text-ink'
                }`}
              >
                {l.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** A row of toggle buttons for a list's status filter. */
export function StatusFilter<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | undefined;
  options: { value: T | undefined; label: string }[];
  onChange: (value: T | undefined) => void;
}) {
  return (
    <div role="group" aria-label={label} className="mb-5 flex flex-wrap gap-2">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.label}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={`min-h-11 rounded-full border px-4 text-sm font-semibold ${
              active ? 'border-ink bg-ink text-page' : 'border-line bg-surface text-muted hover:text-ink'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A small inline form that asks for a reason (or a reference) before a decision is sent.
 * Mirrors the API's length rules so most mistakes are caught before the request.
 */
export function ReasonForm({
  label,
  hint,
  submitLabel,
  variant = 'primary',
  minLength = 3,
  maxLength = 500,
  required = true,
  multiline = true,
  placeholder,
  children,
  onSubmit,
  onCancel,
}: {
  label: string;
  hint?: string;
  submitLabel: string;
  variant?: 'primary' | 'danger' | 'signal' | 'secondary';
  minLength?: number;
  maxLength?: number;
  required?: boolean;
  multiline?: boolean;
  placeholder?: string;
  /** Extra controls, e.g. a checkbox. They are read from the same <form>. */
  children?: ReactNode;
  onSubmit: (value: string, form: FormData) => Promise<void>;
  onCancel?: () => void;
}) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const value = String(data.get('reason') ?? '').trim();
    if ((required || value) && value.length < minLength)
      return setError(`Write at least ${minLength} characters.`);
    if (value.length > maxLength) return setError(`Keep it under ${maxLength} characters.`);
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value, data);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  const common = {
    id,
    name: 'reason',
    maxLength,
    placeholder,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
    className: inputClass,
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="font-semibold">
          {label}
        </label>
        {multiline ? <textarea rows={3} {...common} /> : <input {...common} autoComplete="off" />}
        {hint ? (
          <p id={`${id}-hint`} className="text-sm text-muted">
            {hint}
          </p>
        ) : null}
        {error ? (
          <p id={`${id}-error`} className="text-sm font-semibold text-danger">
            {error}
          </p>
        ) : null}
      </div>
      {children}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={variant} busy={busy}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** The error shown above a list, with a retry button, when its first load failed. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <Alert>{message}</Alert>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
