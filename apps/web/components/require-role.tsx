'use client';

// Client-side route protection. This is a convenience for users, NOT security: the API checks
// the role on every request, so a user who bypasses this guard still gets 403s.

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { homeFor, useAuth } from './auth-provider';
import { ButtonLink, Skeleton } from './ui';
import type { Role, UserView } from '@/lib/types';

export function RequireRole({
  roles,
  children,
  allowUnapprovedChannel = false,
}: {
  roles: readonly Role[];
  children: React.ReactNode;
  allowUnapprovedChannel?: boolean;
}) {
  const { user, ready } = useAuth();
  const router = useRouter();
  const allowed = user !== null && roles.includes(user.role);

  useEffect(() => {
    if (!ready) return;
    if (!user) {
      // Remember where they were going, so login can send them back.
      const next = window.location.pathname + window.location.search;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    } else if (!roles.includes(user.role)) {
      router.replace(homeFor(user));
    }
  }, [ready, user, roles, router]);

  if (!ready || !allowed) return <PageSkeleton />;

  if (user.role === 'CHANNEL' && user.channel?.status !== 'APPROVED' && !allowUnapprovedChannel) {
    return <AwaitingApproval user={user} />;
  }
  return <>{children}</>;
}

export function PageSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-12 w-2/3 max-w-md" />
      <Skeleton className="h-5 w-full max-w-xl" />
      <div className="grid gap-4 pt-4 sm:grid-cols-3">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    </div>
  );
}

function AwaitingApproval({ user }: { user: UserView }) {
  const rejected = user.channel?.status === 'REJECTED';
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-16">
      <p className="flex items-center gap-2 font-semibold text-muted">
        <span className="rec-dot" aria-hidden="true" />
        {user.channel?.organization ?? 'Your newsroom'}
      </p>
      <h1 className="font-display text-5xl font-extrabold">
        {rejected ? 'Your newsroom was not approved' : 'Your newsroom is waiting for approval'}
      </h1>
      {rejected ? (
        <p className="text-lg text-muted">
          We could not verify this organisation. If you think this is a mistake, write to the grievance officer listed in
          our terms with your organisation’s details and a work email address.
        </p>
      ) : (
        <>
          <p className="text-lg text-muted">
            We check every newsroom by hand before it can see footage, so witnesses know who is watching. This usually takes
            one working day.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-muted">
            <li>Use an email address at your organisation’s own domain if you can.</li>
            <li>Make sure your website shows your newsroom’s contact details.</li>
          </ul>
        </>
      )}
      <div className="flex flex-wrap gap-3">
        <ButtonLink href="/terms" variant="secondary">
          Read the licence terms
        </ButtonLink>
        <ButtonLink href="/" variant="ghost">
          Back to the home page
        </ButtonLink>
      </div>
    </div>
  );
}
