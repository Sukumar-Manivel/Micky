import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Log in' };

export default function LoginPage() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-12">
      <h1 className="font-display text-5xl font-extrabold">Log in</h1>
      {/* The form reads ?next= from the URL, which is only known per request, so it sits in Suspense. */}
      <Suspense fallback={<div className="skeleton h-72" />}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
