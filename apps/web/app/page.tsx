import type { Metadata } from 'next';
import { ButtonLink } from '@/components/ui';

export const metadata: Metadata = { title: { absolute: 'FirstFrame — eyewitness footage for newsrooms' } };

// A Server Component: no JavaScript is shipped for this page's content, only HTML and CSS.
export default function HomePage() {
  return (
    <>
      <Hero />
      <SafetyBand />
      <HowItWorks />
      <Trust />
      <ClosingCta />
    </>
  );
}

function Hero() {
  return (
    <section className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 pb-16 pt-10 md:grid-cols-[1.1fr_1fr] md:pt-16">
      <div className="flex flex-col gap-6">
        <h1 className="font-display text-[3.25rem] font-extrabold sm:text-7xl">
          The first frame of every story is on someone’s phone.
        </h1>
        <p className="max-w-[34rem] text-lg text-muted sm:text-xl">
          When a fire, accident or flood happens, reporters arrive late. FirstFrame lets the people who were there share
          checked footage with newsrooms, and get paid for it.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <ButtonLink href="/register?as=witness" size="lg" variant="signal">
            I witnessed something
          </ButtonLink>
          <ButtonLink href="/register?as=newsroom" size="lg" variant="secondary">
            I’m a newsroom
          </ButtonLink>
        </div>
      </div>
      <Viewfinder />
    </section>
  );
}

/** A stylised camera viewfinder showing what an upload carries: place, time and checks. */
function Viewfinder() {
  return (
    <figure
      aria-label="Example: a witness video from Gandhipuram, Coimbatore, with location, time and verification checks"
      className="relative aspect-[4/5] w-full max-w-md justify-self-center overflow-hidden rounded-2xl bg-[#0c141b] text-[#e6edf2] sm:aspect-[4/3] md:aspect-[4/5]"
    >
      {/* Abstract night street scene made from gradients: no stock photo needed. */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 60% at 70% 85%, rgb(255 98 71 / 0.55), transparent 60%), radial-gradient(60% 40% at 25% 70%, rgb(240 181 74 / 0.35), transparent 70%), linear-gradient(180deg, #16232e 0%, #0c141b 55%, #1b120f 100%)',
        }}
      />
      <div aria-hidden="true" className="viewfinder absolute inset-5 text-[#e6edf2]/85" />
      <div className="absolute left-8 top-8 flex items-center gap-2 text-sm font-bold">
        <span className="rec-dot" data-live="true" aria-hidden="true" />
        REC
      </div>
      <div className="tabular absolute right-8 top-8 text-sm font-bold text-[#e6edf2]/80">00:00:47</div>
      <figcaption className="absolute inset-x-8 bottom-8 flex flex-col gap-3">
        <p className="font-display text-3xl font-bold">Godown fire, Gandhipuram</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-[#e6edf2]/80">
          <dt className="sr-only">Place</dt>
          <dd>Coimbatore, 11.017° N</dd>
          <dt className="sr-only">Time</dt>
          <dd className="tabular">Today, 9:42 pm</dd>
        </dl>
        <ul className="flex flex-wrap gap-2 text-xs font-bold">
          <li className="rounded-full bg-[#3cc4ae]/20 px-2.5 py-1 text-[#7fe0cf]">Location matches</li>
          <li className="rounded-full bg-[#3cc4ae]/20 px-2.5 py-1 text-[#7fe0cf]">Not a copy</li>
          <li className="rounded-full bg-[#e6edf2]/15 px-2.5 py-1">Human review</li>
        </ul>
      </figcaption>
    </figure>
  );
}

function SafetyBand() {
  return (
    <section aria-labelledby="safety" className="border-y border-line bg-surface">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-6 sm:flex-row sm:items-baseline sm:gap-6">
        <h2 id="safety" className="font-display shrink-0 text-3xl font-extrabold text-signal">
          Help first. Film only if safe.
        </h2>
        <p className="text-muted">
          Call 112 for police, fire or ambulance. Never get in the way of rescuers, and never film people who are hurt
          close up. No footage is worth a life.
        </p>
      </div>
    </section>
  );
}

const witnessSteps = [
  { title: 'Upload from your phone', body: 'Pick the photo or video from your gallery. Add where and when it happened.' },
  { title: 'We check it', body: 'Our system looks for signs of editing or AI, and a person reviews every upload.' },
  { title: 'Newsrooms see a preview', body: 'They see a small, watermarked version. Your original stays private.' },
  { title: 'You get paid by UPI', body: 'Every time a newsroom buys a licence, your share is added to your balance.' },
];

const newsroomSteps = [
  { title: 'Watch incidents as they trend', body: 'A live feed ranks incidents by how many separate witnesses filmed them.' },
  { title: 'Check before you buy', body: 'Every clip shows its location, time, provenance and an AI-likelihood signal.' },
  { title: 'License the original', body: 'Choose a non-exclusive or exclusive licence and pay with Razorpay.' },
  { title: 'Download and broadcast', body: 'Get the full-quality file through a private, time-limited link.' },
];

function StepList({ steps }: { steps: { title: string; body: string }[] }) {
  return (
    <ol className="flex flex-col">
      {steps.map((s, i) => (
        <li key={s.title} className="grid grid-cols-[2.5rem_1fr] gap-x-3 border-t border-line py-4">
          <span className="font-display tabular text-3xl font-bold text-muted" aria-hidden="true">
            {i + 1}
          </span>
          <div>
            <h4 className="text-lg font-bold">{s.title}</h4>
            <p className="text-muted">{s.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how" className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-16">
      <h2 id="how" className="font-display max-w-3xl text-5xl font-extrabold">
        How it works
      </h2>
      <div className="mt-10 grid gap-12 md:grid-cols-2">
        <div>
          <h3 className="mb-4 text-xl font-bold">If you saw it happen</h3>
          <StepList steps={witnessSteps} />
        </div>
        <div>
          <h3 className="mb-4 text-xl font-bold">If you run a newsroom</h3>
          <StepList steps={newsroomSteps} />
        </div>
      </div>
    </section>
  );
}

const checks = [
  {
    title: 'Where and when',
    body: 'We compare the place and time you give with the data inside the file, when the file still has it.',
  },
  {
    title: 'Content Credentials',
    body: 'Some phones sign their photos (C2PA). A valid signature is strong proof the image came from a camera.',
  },
  {
    title: 'AI-likelihood signal',
    body: 'A detector estimates how likely the frames are AI-made. Detectors make mistakes, so this is a signal, not a verdict.',
  },
  {
    title: 'Copies',
    body: 'We spot footage that has already been uploaded, even when it has been resized or re-encoded.',
  },
  {
    title: 'A person decides',
    body: 'Nothing goes on sale until a reviewer has looked at the footage and every signal.',
  },
];

function Trust() {
  return (
    <section aria-labelledby="trust" className="bg-surface">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-16 md:grid-cols-[1fr_1.4fr]">
        <div className="flex flex-col gap-4">
          <h2 id="trust" className="font-display text-5xl font-extrabold">
            Checked before anyone pays
          </h2>
          <p className="text-lg text-muted">
            A newsroom’s reputation depends on not airing a fake. A witness’s footage deserves to be believed. So every
            upload carries an evidence report, and a human reviews it.
          </p>
        </div>
        <dl className="grid gap-x-8 sm:grid-cols-2">
          {checks.map((c) => (
            <div key={c.title} className="border-t border-line py-4">
              <dt className="font-bold">{c.title}</dt>
              <dd className="text-muted">{c.body}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function ClosingCta() {
  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-16 md:flex-row md:items-end md:justify-between">
      <div className="max-w-2xl">
        <h2 className="font-display text-5xl font-extrabold">Your footage stays yours.</h2>
        <p className="mt-3 text-lg text-muted">
          You keep the copyright. Newsrooms buy a licence to use it, and anyone shown in footage can ask us to take it down.
        </p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <ButtonLink href="/register?as=witness" size="lg" variant="primary">
          Start uploading
        </ButtonLink>
        <ButtonLink href="/terms" size="lg" variant="secondary">
          Read the terms
        </ButtonLink>
      </div>
    </section>
  );
}
