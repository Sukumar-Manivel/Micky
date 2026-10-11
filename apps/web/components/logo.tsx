// The wordmark: a viewfinder bracket around a recording dot, then the name in condensed caps-free type.

export function LogoMark({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <path d="M3 11V3h8M21 3h8v8M29 21v8h-8M11 29H3v-8" fill="none" stroke="currentColor" strokeWidth="3" />
      <circle cx="16" cy="16" r="5.5" fill="var(--signal)" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="flex items-center gap-2">
      <LogoMark />
      <span className="font-display text-2xl font-extrabold">FirstFrame</span>
    </span>
  );
}
