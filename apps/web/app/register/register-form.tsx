'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { homeFor, useAuth } from '@/components/auth-provider';
import { Alert, Button, Field, inputClass } from '@/components/ui';
import { describeError } from '@/lib/api';

type Kind = 'UPLOADER' | 'CHANNEL';

export function RegisterForm() {
  const { register } = useAuth();
  const router = useRouter();
  const initial: Kind = useSearchParams().get('as') === 'newsroom' ? 'CHANNEL' : 'UPLOADER';
  const [role, setRole] = useState<Kind>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const website = String(f.get('website') ?? '').trim();
    setBusy(true);
    setError(null);
    try {
      const user = await register({
        name: String(f.get('name')).trim(),
        email: String(f.get('email')).trim(),
        password: String(f.get('password')),
        role,
        ...(role === 'CHANNEL'
          ? { organization: String(f.get('organization')).trim(), ...(website ? { website } : {}) }
          : {}),
      });
      router.replace(user.role === 'UPLOADER' ? '/upload' : homeFor(user));
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 font-semibold">Which describes you?</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <RoleOption
            checked={role === 'UPLOADER'}
            onChange={() => setRole('UPLOADER')}
            title="I witnessed something"
            body="Upload photos and videos you took, and earn when newsrooms use them."
          />
          <RoleOption
            checked={role === 'CHANNEL'}
            onChange={() => setRole('CHANNEL')}
            title="I’m a newsroom"
            body="Browse checked eyewitness footage and buy licences. We approve newsrooms by hand."
          />
        </div>
      </fieldset>

      {error ? <Alert>{error}</Alert> : null}

      <Field label={role === 'CHANNEL' ? 'Your name' : 'Name'} htmlFor="name">
        <input id="name" name="name" autoComplete="name" required minLength={2} maxLength={80} className={inputClass} />
      </Field>
      {role === 'CHANNEL' ? (
        <>
          <Field label="Organisation" htmlFor="organization" hint="The newsroom, channel or publication you work for.">
            <input
              id="organization"
              name="organization"
              autoComplete="organization"
              required
              maxLength={120}
              aria-describedby="organization-hint"
              className={inputClass}
            />
          </Field>
          <Field label="Website (optional)" htmlFor="website" hint="Helps us approve you faster.">
            <input
              id="website"
              name="website"
              type="url"
              inputMode="url"
              placeholder="https://"
              aria-describedby="website-hint"
              className={inputClass}
            />
          </Field>
        </>
      ) : null}
      <Field label="Email" htmlFor="email">
        <input id="email" name="email" type="email" autoComplete="email" required className={inputClass} />
      </Field>
      <Field label="Password" htmlFor="password" hint="At least 8 characters.">
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={128}
          aria-describedby="password-hint"
          className={inputClass}
        />
      </Field>
      <p className="text-sm text-muted">
        By creating an account you agree to the{' '}
        <Link href="/terms" className="underline">
          terms
        </Link>{' '}
        and{' '}
        <Link href="/privacy" className="underline">
          privacy notice
        </Link>
        .
      </p>
      <Button type="submit" size="lg" busy={busy}>
        Create account
      </Button>
      <p className="text-muted">
        Already have an account?{' '}
        <Link href="/login" className="font-semibold text-ink underline">
          Log in
        </Link>
      </p>
    </form>
  );
}

function RoleOption({
  checked,
  onChange,
  title,
  body,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  body: string;
}) {
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-xl border-2 p-4 has-[:focus-visible]:outline has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-focus ${
        checked ? 'border-ink bg-surface' : 'border-line'
      }`}
    >
      <input type="radio" name="role" checked={checked} onChange={onChange} className="mt-1.5 h-4 w-4 accent-current" />
      <span className="flex flex-col gap-1">
        <span className="font-bold">{title}</span>
        <span className="text-sm text-muted">{body}</span>
      </span>
    </label>
  );
}
