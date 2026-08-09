'use client';

import { useEffect, useState } from 'react';
import { useMockDraft } from '@/contexts/mock-draft-context';

// Screen position of the last bid/draft button the user clicked. Module-level
// because the button unmounts the instant the pick commits — the burst renders
// from a sibling that outlives it.
let lastBidPoint: { x: number; y: number } | null = null;

/** Record the burst origin from the bid/draft button that was just pressed. */
export function markBidPoint(el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  lastBidPoint = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

const CONFETTI_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ec4899', '#a855f7'];

// ponytail: 16 CSS-animated spans, no physics and no confetti dependency.
export function WinConfetti() {
  const { winPulse } = useMockDraft();
  const [burst, setBurst] = useState<{ x: number; y: number; key: number } | null>(null);

  useEffect(() => {
    if (!winPulse || !lastBidPoint) return;
    setBurst({ ...lastBidPoint, key: winPulse });
    const timer = setTimeout(() => setBurst(null), 900);
    return () => clearTimeout(timer);
  }, [winPulse]);

  if (!burst) return null;

  return (
    <div key={burst.key} className="pointer-events-none fixed z-50" style={{ left: burst.x, top: burst.y }}>
      <style>{`@keyframes sim-confetti{to{transform:translate(var(--dx),var(--dy)) rotate(var(--rot));opacity:0}}`}</style>
      {Array.from({ length: 16 }, (_, i) => {
        const angle = -Math.PI * (0.12 + 0.76 * (i / 15));
        const dist = 30 + (i % 4) * 16;
        return (
          <span
            key={i}
            style={{
              position: 'absolute',
              width: 6,
              height: 6,
              borderRadius: i % 2 ? '50%' : '1px',
              background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
              animation: 'sim-confetti 900ms cubic-bezier(.2,.7,.4,1) forwards',
              ['--dx' as string]: `${Math.cos(angle) * dist}px`,
              ['--dy' as string]: `${Math.sin(angle) * dist}px`,
              ['--rot' as string]: `${i * 57}deg`,
            }}
          />
        );
      })}
    </div>
  );
}
