'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { homeFor, useAuth } from '@/components/auth-provider';
import { Alert, Button, Field, inputClass } from '@/components/ui';
import { describeError } from '@/lib/api';
import { safeNext } from './safe-next';

export function LoginForm() {
  const { login, user, ready } = useAuth();
  const router = useRouter();
  const rawNext = useSearchParams().get('next');
  // A client component, so `window` exists whenever this runs in the browser. During the
  // server render there is no origin to compare against; nothing navigates there anyway.
  const next = typeof window === 'undefined' ? null : safeNext(rawNext, window.location.origin);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already logged in (e.g. the refresh cookie was still valid): go straight on.
  useEffect(() => {
    if (ready && user) router.replace(next ?? homeFor(user));
  }, [ready, user, next, router]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const u = await login(String(form.get('email')), String(form.get('password')));
      router.replace(next ?? homeFor(u));
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate={false}>
      {error ? <Alert>{error}</Alert> : null}
      <Field label="Email" htmlFor="email">
        <input id="email" name="email" type="email" autoComplete="email" required className={inputClass} />
      </Field>
      <Field label="Password" htmlFor="password">
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          minLength={8}
          className={inputClass}
        />
      </Field>
      <Button type="submit" size="lg" busy={busy}>
        Log in
      </Button>
      <p className="text-muted">
        New to FirstFrame?{' '}
        <Link href="/register" className="font-semibold text-ink underline">
          Create an account
        </Link>
      </p>
    </form>
  );
}
