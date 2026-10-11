import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RegisterForm } from './register-form';

export const metadata: Metadata = { title: 'Join Micky' };

export default function RegisterPage() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-12">
      <h1 className="font-display text-5xl font-extrabold">Join Micky</h1>
      <Suspense fallback={<div className="skeleton h-96" />}>
        <RegisterForm />
      </Suspense>
    </div>
  );
}
