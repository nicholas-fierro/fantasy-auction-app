'use client';

import { useSyncExternalStore } from 'react';

// Below Tailwind's `md` breakpoint (768px). Prefer `max-md:`/`md:` classes —
// reach for this only when the two layouts can't share one DOM tree.
const MOBILE_QUERY = '(max-width: 767.98px)';

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/** True on phone-width viewports. Renders as desktop on the server. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false
  );
}
