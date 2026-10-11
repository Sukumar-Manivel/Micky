'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from './auth-provider';
import { Logo } from './logo';
import type { UserView } from '@/lib/types';

function navFor(user: UserView | null): { href: string; label: string }[] {
  if (!user) return [{ href: '/#how-it-works', label: 'How it works' }];
  if (user.role === 'UPLOADER')
    return [
      { href: '/upload', label: 'Upload' },
      { href: '/dashboard', label: 'My footage' },
      { href: '/dashboard/earnings', label: 'Earnings' },
    ];
  if (user.role === 'CHANNEL')
    return [
      { href: '/newsroom', label: 'Live feed' },
      { href: '/newsroom/map', label: 'Map' },
      { href: '/newsroom/purchases', label: 'Purchases' },
    ];
  return [
    { href: '/admin', label: 'Overview' },
    { href: '/admin/review', label: 'Review' },
    { href: '/admin/channels', label: 'Newsrooms' },
    { href: '/admin/payouts', label: 'Payouts' },
    { href: '/admin/reports', label: 'Reports' },
    { href: '/newsroom', label: 'Marketplace' },
  ];
}

export function SiteHeader() {
  const { user, ready, logout } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const links = navFor(user);

  async function onLogout() {
    setOpen(false);
    await logout();
    router.push('/');
  }

  return (
    <header className="sticky top-0 z-[900] border-b border-line bg-page/90 backdrop-blur supports-[backdrop-filter]:bg-page/75">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-4">
        <Link href="/" className="shrink-0" aria-label="FirstFrame home">
          <Logo />
        </Link>

        <nav aria-label="Main" className="ml-4 hidden flex-1 items-center gap-1 md:flex">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="rounded-md px-3 py-2 font-semibold text-muted hover:bg-sunken hover:text-ink">
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto hidden items-center gap-2 md:flex">
          {!ready ? null : user ? (
            <>
              <span className="max-w-48 truncate text-sm text-muted" title={user.email}>
                {user.channel?.organization ?? user.name}
              </span>
              <button type="button" onClick={onLogout} className="rounded-md px-3 py-2 font-semibold hover:bg-sunken">
                Log out
              </button>
            </>
          ) : (
            <>
              <Link href="/login" className="rounded-md px-3 py-2 font-semibold hover:bg-sunken">
                Log in
              </Link>
              <Link href="/register" className="rounded-lg bg-ink px-4 py-2 font-semibold text-page hover:opacity-90">
                Join
              </Link>
            </>
          )}
        </div>

        <button
          type="button"
          className="ml-auto inline-flex min-h-11 items-center rounded-md border border-line px-3 font-semibold md:hidden"
          aria-expanded={open}
          aria-controls="mobile-nav"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Close' : 'Menu'}
        </button>
      </div>

      {open ? (
        <nav id="mobile-nav" aria-label="Main" className="border-t border-line bg-page px-4 pb-4 md:hidden">
          <ul className="flex flex-col py-2">
            {links.map((l) => (
              <li key={l.href}>
                <Link href={l.href} onClick={() => setOpen(false)} className="block rounded-md px-2 py-3 text-lg font-semibold">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
          {ready && user ? (
            <button type="button" onClick={onLogout} className="w-full rounded-lg border border-line py-3 font-semibold">
              Log out of {user.channel?.organization ?? user.name}
            </button>
          ) : ready ? (
            <div className="grid grid-cols-2 gap-2">
              <Link href="/login" onClick={() => setOpen(false)} className="rounded-lg border border-line py-3 text-center font-semibold">
                Log in
              </Link>
              <Link href="/register" onClick={() => setOpen(false)} className="rounded-lg bg-ink py-3 text-center font-semibold text-page">
                Join
              </Link>
            </div>
          ) : null}
        </nav>
      ) : null}
    </header>
  );
}
