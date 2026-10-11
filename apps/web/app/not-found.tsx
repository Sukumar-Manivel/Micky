import type { Metadata } from 'next';
import { ButtonLink } from '@/components/ui';

export const metadata: Metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-start gap-5 px-4 py-16">
      <p className="flex items-center gap-2 font-semibold text-muted">
        <span className="rec-dot" aria-hidden="true" />
        404
      </p>
      <h1 className="font-display text-5xl font-extrabold">Nothing was recorded here</h1>
      <p className="text-lg text-muted">The page you followed does not exist, or it has moved.</p>
      <div className="flex flex-wrap gap-3">
        <ButtonLink href="/">Home page</ButtonLink>
        <ButtonLink href="/login" variant="secondary">
          Log in
        </ButtonLink>
      </div>
    </div>
  );
}
