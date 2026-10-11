import type { LiveStatus } from '@/lib/use-live';

export function LiveIndicator({ status }: { status: LiveStatus }) {
  const label = status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Offline, retrying';
  return (
    <span
      role="status"
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-bold ${
        status === 'live' ? 'border-signal/40 bg-signal-soft text-signal' : 'border-line text-muted'
      }`}
    >
      <span className="rec-dot" data-live={status === 'live'} aria-hidden="true" style={status === 'live' ? undefined : { background: 'currentColor' }} />
      {label}
    </span>
  );
}
