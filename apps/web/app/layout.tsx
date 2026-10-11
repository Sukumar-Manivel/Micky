import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { AuthProvider } from '@/components/auth-provider';
import { SiteHeader } from '@/components/site-header';
import { ToastProvider } from '@/components/toast';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Micky — eyewitness footage for newsrooms', template: '%s | Micky' },
  description:
    'Witnesses upload verified photos and videos of incidents in Tamil Nadu. Newsrooms preview and license them. Witnesses get paid.',
  applicationName: 'Micky',
  appleWebApp: { capable: true, title: 'Micky', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f3f6f8' },
    { media: '(prefers-color-scheme: dark)', color: '#0c141b' },
  ],
};

// The root layout is a Server Component. The providers inside are Client Components
// ('use client'), and they wrap `children` without turning every page into client code.
export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en-IN" className="h-full antialiased">
      <head>
        {/* Sets window.__MICKY_CONFIG__ (the API address) from the container's environment.
            Deliberately blocking: it is tiny, and it must run before the app's code. See lib/config.ts. */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/runtime-config.js" />
      </head>
      <body className="flex min-h-full flex-col">
        <AuthProvider>
          <ToastProvider>
            <SiteHeader />
            <main id="main" className="flex flex-1 flex-col">
              {children}
            </main>
            <SiteFooter />
          </ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
        <p>Micky. Made in Tamil Nadu for witnesses and newsrooms.</p>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
          <Link href="/terms" className="hover:text-ink">
            Terms
          </Link>
          <Link href="/privacy" className="hover:text-ink">
            Privacy
          </Link>
          <Link href="/report" className="hover:text-ink">
            Report content
          </Link>
        </nav>
      </div>
    </footer>
  );
}
