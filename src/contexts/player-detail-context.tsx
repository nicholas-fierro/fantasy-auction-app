'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { PlayerDetailModal } from '@/components/player-detail-modal';
import type { Player } from '@/server/types/player';

const PlayerCompareModal = dynamic(
  () => import('@/components/player-compare-modal').then((mod) => mod.PlayerCompareModal),
  { ssr: false }
);

interface PlayerDetailContextValue {
  showPlayerDetail: (player: Player) => void;
  showPlayerCompare: (player: Player) => void;
}

const PlayerDetailContext = createContext<PlayerDetailContextValue | null>(null);

export function PlayerDetailProvider({ children }: { children: React.ReactNode }) {
  const [player, setPlayer] = useState<Player | null>(null);
  const [comparePlayer, setComparePlayer] = useState<Player | null>(null);
  const showPlayerDetail = useCallback((nextPlayer: Player) => setPlayer(nextPlayer), []);
  // Hand off from the detail modal to the compare modal — close detail first
  // so the two dialogs never stack.
  const showPlayerCompare = useCallback((nextPlayer: Player) => {
    setPlayer(null);
    setComparePlayer(nextPlayer);
  }, []);
  const value = useMemo(() => ({ showPlayerDetail, showPlayerCompare }), [showPlayerDetail, showPlayerCompare]);

  return (
    <PlayerDetailContext.Provider value={value}>
      {children}
      {player && (
        <PlayerDetailModal
          player={player}
          isOpen
          onClose={() => setPlayer(null)}
        />
      )}
      {comparePlayer && (
        <PlayerCompareModal
          initialPlayer={comparePlayer}
          isOpen
          onClose={() => setComparePlayer(null)}
        />
      )}
    </PlayerDetailContext.Provider>
  );
}

export function usePlayerDetail() {
  const context = useContext(PlayerDetailContext);
  if (!context) {
    throw new Error('usePlayerDetail must be used within PlayerDetailProvider');
  }
  return context;
}
