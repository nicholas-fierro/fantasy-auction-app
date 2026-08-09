'use client';

import { useEffect, useRef } from 'react';
import { useOnTheClockState } from '@/hooks/use-on-the-clock-state';
import { useNotificationPreferences } from '@/contexts/notification-preferences-context';
import { TURN_CHIME_DATA_URI } from '@/lib/notification-chime';

const FLASH_TITLE = '🔔 Your turn!';
const FLASH_INTERVAL_MS = 1000;

// 3d: on a false -> true on-the-clock transition, play a short chime and
// flash the document title until the tab regains focus or the turn ends.
// Consumes the same derived state as the ticker turn segment (useOnTheClockState)
// so the notification and the banner never disagree.
export function useTurnNotifications() {
  const { onTheClock } = useOnTheClockState();
  const { muted } = useNotificationPreferences();
  const wasOnTheClockRef = useRef(false);

  useEffect(() => {
    const wasOnTheClock = wasOnTheClockRef.current;
    wasOnTheClockRef.current = onTheClock;

    if (!onTheClock) return;

    // Only chime on the edge (turn just started), not on every re-render
    // while still on the clock (e.g. when the mute toggle flips).
    const isNewTurn = !wasOnTheClock;
    if (isNewTurn && !muted) {
      try {
        const audio = new Audio(TURN_CHIME_DATA_URI);
        void audio.play().catch(() => {
          // Autoplay can be blocked without a prior user gesture — the title
          // flash below still gets the member's attention.
        });
      } catch {
        // Audio unsupported in this environment — skip the chime.
      }
    }

    if (typeof document === 'undefined') return;

    const originalTitle = document.title;
    let flashOn = false;
    const intervalId = setInterval(() => {
      flashOn = !flashOn;
      document.title = flashOn ? FLASH_TITLE : originalTitle;
    }, FLASH_INTERVAL_MS);

    const stopFlashing = () => {
      clearInterval(intervalId);
      document.title = originalTitle;
    };
    window.addEventListener('focus', stopFlashing);

    return () => {
      window.removeEventListener('focus', stopFlashing);
      stopFlashing();
    };
  }, [onTheClock, muted]);
}
