import type { ReactNode } from 'react';

/** Layout for the plain-language legal pages (terms, privacy). Server component, no JavaScript. */
export function LegalPage({ title, intro, children }: { title: string; intro: ReactNode; children: ReactNode }) {
  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-12">
      <header className="flex flex-col gap-3">
        <h1 className="font-display text-5xl font-extrabold">{title}</h1>
        <div className="text-lg text-muted">{intro}</div>
        <p className="rounded-lg border-l-4 border-caution bg-caution-soft px-4 py-3 text-sm font-semibold text-caution">
          Draft summary in plain language. The binding legal text will be reviewed by a lawyer and published here before
          FirstFrame opens to the public.
        </p>
      </header>
      <div className="flex flex-col gap-8">{children}</div>
    </article>
  );
}

export function LegalSection({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-h` : undefined} className="scroll-mt-20 border-t border-line pt-6">
      <h2 id={id ? `${id}-h` : undefined} className="mb-3 text-2xl font-bold">
        {title}
      </h2>
      <div className="flex flex-col gap-3 [&_li]:ml-5 [&_li]:list-disc [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-1.5">{children}</div>
    </section>
  );
}
