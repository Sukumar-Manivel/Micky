'use client';

// Shown when a page throws while rendering. Error boundaries must be Client Components.
// Data-loading errors are handled inside each page (an <Alert> with the API's message); this is
// the last line of defence for bugs, so the header and navigation keep working.

import { useEffect } from 'react';
import { Button, ButtonLink } from '@/components/ui';

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-start gap-5 px-4 py-16" role="alert">
      <h1 className="font-display text-5xl font-extrabold">Something went wrong</h1>
      <p className="text-lg text-muted">
        This page hit an unexpected problem. Trying again usually fixes it. If it keeps happening, reload the page.
      </p>
      {error.digest ? <p className="text-sm text-muted">Error reference: <span className="font-mono">{error.digest}</span></p> : null}
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => retry()}>Try again</Button>
        <ButtonLink href="/" variant="secondary">
          Home page
        </ButtonLink>
      </div>
    </div>
  );
}
