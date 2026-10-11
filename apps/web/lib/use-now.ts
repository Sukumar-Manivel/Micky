'use client';

import { useEffect, useState } from 'react';

/** A clock that ticks every minute, so "5 minutes ago" labels stay current without a reload. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}
