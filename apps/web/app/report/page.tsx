import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ReportForm } from './report-form';

export const metadata: Metadata = { title: 'Report content' };

// Public: anyone can report footage, including people who appear in it and have no account.
export default function ReportPage() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-12">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-5xl font-extrabold">Report content</h1>
        <p className="text-muted">
          Are you shown in footage on Micky, or is something here wrong, stolen or harmful? Tell us and a person will
          review it. You do not need an account.
        </p>
      </div>
      {/* The form reads ?media= from the URL, which is only known per request. */}
      <Suspense fallback={<div className="skeleton h-96" />}>
        <ReportForm />
      </Suspense>
    </div>
  );
}
