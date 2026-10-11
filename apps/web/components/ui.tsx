// Small, reusable building blocks. Server-safe (no hooks), so they can be used anywhere.

import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'signal';
type Size = 'md' | 'lg' | 'sm';

const variantClass: Record<Variant, string> = {
  primary: 'bg-ink text-page hover:opacity-90',
  secondary: 'bg-surface text-ink border border-line hover:bg-sunken',
  ghost: 'text-ink hover:bg-sunken',
  danger: 'bg-danger text-white hover:opacity-90 dark:text-page',
  signal: 'bg-signal text-signal-ink hover:opacity-90',
};
const sizeClass: Record<Size, string> = {
  sm: 'min-h-9 px-3 text-sm',
  md: 'min-h-11 px-4 text-base', // 44px: comfortable tap target on phones
  lg: 'min-h-13 px-6 text-lg',
};

export function buttonClass(variant: Variant = 'primary', size: Size = 'md', extra = ''): string {
  return `inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${variantClass[variant]} ${sizeClass[size]} ${extra}`;
}

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  busy = false,
  children,
  ...props
}: ComponentProps<'button'> & { variant?: Variant; size?: Size; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
      className={buttonClass(variant, size, className)}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function ButtonLink({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link {...props} className={buttonClass(variant, size, className)} />;
}

export function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
    />
  );
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="font-semibold">
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`${htmlFor}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const inputClass =
  'w-full min-h-11 rounded-lg border border-line bg-surface px-3 py-2 text-ink placeholder:text-muted/70 aria-[invalid=true]:border-danger';

export function Alert({ tone = 'danger', children }: { tone?: 'danger' | 'info' | 'success' | 'caution'; children: ReactNode }) {
  const tones = {
    danger: 'border-danger/40 bg-danger-soft text-danger',
    info: 'border-line bg-sunken text-ink',
    success: 'border-verified/40 bg-verified-soft text-verified',
    caution: 'border-caution/40 bg-caution-soft text-caution',
  };
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={`rounded-lg border px-4 py-3 text-sm font-medium ${tones[tone]}`}>
      {children}
    </div>
  );
}

export function Panel({ className = '', children, ...props }: ComponentProps<'section'>) {
  return (
    <section {...props} className={`rounded-xl border border-line bg-surface p-4 sm:p-6 ${className}`}>
      {children}
    </section>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton ${className}`} />;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-line px-5 py-8 sm:items-center sm:text-center">
      <p className="font-display text-2xl font-bold">{title}</p>
      {children ? <div className="max-w-prose text-muted">{children}</div> : null}
      {action}
    </div>
  );
}

export function PageHeader({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-col gap-3 pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-4xl font-extrabold sm:text-5xl">{title}</h1>
        {children ? <div className="max-w-prose text-muted">{children}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

/** Previous / next controls for `Paginated<T>` lists. */
export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-3 pt-4 text-sm">
      <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <span className="tabular text-muted">
        Page {page} of {pages}
      </span>
      <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </nav>
  );
}

/** A detail page that could not load (not found, no access, offline): say so and offer a way back. */
export function LoadFailed({ title, message, backHref, backLabel }: { title: string; message: string; backHref: string; backLabel: string }) {
  return (
    <div className="flex flex-col items-start gap-4 py-6">
      <h1 className="font-display text-4xl font-extrabold">{title}</h1>
      <Alert>{message}</Alert>
      <ButtonLink href={backHref} variant="secondary">
        {backLabel}
      </ButtonLink>
    </div>
  );
}
