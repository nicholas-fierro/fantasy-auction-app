'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, useMemo, ReactNode } from 'react';
import { useAuction } from '@/contexts/auction-context';

export type ViewType = 'players' | 'fantasy-teams' | 'draft-board' | 'analysis' | 'settings' | 'draft-history';
export type DraftMode = 'auction' | 'snake';
export type FilterPosition = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DST' | 'Flex';

interface NavigationContextType {
  currentView: ViewType;
  setCurrentView: (view: ViewType) => void;
  landingOverride: boolean;
  setLandingOverride: (show: boolean) => void;
  // The two whole-app transitions, in one place so every entry point moves the
  // same three pieces of state in the same order.
  returnToDashboard: () => void;
  enterDraftRoom: (auctionId: string) => void;
  draftMode: DraftMode;
  setDraftMode: (mode: DraftMode) => void;
  isSnakeMode: boolean;
  showDraftedPlayers: boolean;
  setShowDraftedPlayers: (show: boolean) => void;
  selectedPositions: Set<FilterPosition>;
  setSelectedPositions: (positions: Set<FilterPosition>) => void;
  showWatchlist: boolean;
  setShowWatchlist: (show: boolean) => void;
  completedDraftModalOpen: boolean;
  setCompletedDraftModalOpen: (open: boolean) => void;
}

const NavigationContext = createContext<NavigationContextType | undefined>(undefined);

// Must render inside AuctionProvider: whole-app transitions own selected-auction state.
export function NavigationProvider({ children }: { children: ReactNode }) {
  const [currentView, setCurrentView] = useState<ViewType>('players');
  const [landingOverride, setLandingOverride] = useState(false);
  const { setSelectedAuctionId } = useAuction();

  const returnToDashboard = useCallback(() => {
    setSelectedAuctionId(null);
    setLandingOverride(true);
    setCurrentView('players');
  }, [setSelectedAuctionId]);

  const enterDraftRoom = useCallback((auctionId: string) => {
    setSelectedAuctionId(auctionId);
    setLandingOverride(false);
    setCurrentView('players');
  }, [setSelectedAuctionId]);

  const [draftMode, setDraftMode] = useState<DraftMode>('auction');
  const [showDraftedPlayers, setShowDraftedPlayers] = useState<boolean>(true);
  const [selectedPositions, setSelectedPositions] = useState<Set<FilterPosition>>(new Set());
  const [showWatchlist, setShowWatchlist] = useState<boolean>(true);
  const [completedDraftModalOpen, setCompletedDraftModalOpen] = useState(false);

  const isSnakeMode = draftMode === 'snake';

  const value = useMemo(() => ({
    currentView,
    setCurrentView,
    landingOverride,
    setLandingOverride,
    returnToDashboard,
    enterDraftRoom,
    draftMode,
    setDraftMode,
    isSnakeMode,
    showDraftedPlayers,
    setShowDraftedPlayers,
    selectedPositions,
    setSelectedPositions,
    showWatchlist,
    setShowWatchlist,
    completedDraftModalOpen,
    setCompletedDraftModalOpen,
  }), [currentView, landingOverride, returnToDashboard, enterDraftRoom, draftMode, isSnakeMode, showDraftedPlayers, selectedPositions, showWatchlist, completedDraftModalOpen]);

  return (
    <NavigationContext.Provider value={value}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigation() {
  const context = useContext(NavigationContext);
  if (context === undefined) {
    throw new Error('useNavigation must be used within a NavigationProvider');
  }
  return context;
}

// "In the draft room" — the live pick-entry surface, as opposed to the landing
// dashboard, draft history, or a completed draft. Every piece of draft chrome
// (nav tabs, watchlist, live ticker) keys off this one predicate so they cannot
// drift out of sync with each other.
export function useIsDraftRoom(): boolean {
  const { currentView, landingOverride } = useNavigation();
  const { selectedAuction } = useAuction();
  return selectedAuction?.status === 'active' && !landingOverride && currentView !== 'draft-history';
}

// Detect completion without moving the viewer out from under the recap modal.
// The exported name stays for callers that used the old silent redirect hook.
export function useCompletedDraftRedirect() {
  const {
    currentView,
    landingOverride,
    returnToDashboard,
    setCompletedDraftModalOpen,
  } = useNavigation();
  const { selectedAuction, isLoading } = useAuction();
  const previous = useRef<{ resolved: boolean; id: string | null; isActive: boolean }>({
    resolved: false,
    id: null,
    isActive: false,
  });

  useEffect(() => {
    if (isLoading) return;

    const id = selectedAuction?.id ?? null;
    const isActive = selectedAuction?.status === 'active';
    const firstResolution = !previous.current.resolved;
    const completedUnderViewer = previous.current.id === id
      && previous.current.isActive
      && !isActive;
    previous.current = { resolved: true, id, isActive };

    // A persisted completed selection should not reopen the completion
    // experience on refresh. Draft history is the one intentional cold-load
    // destination for a completed selection.
    if (firstResolution && selectedAuction?.status === 'completed' && currentView !== 'draft-history') {
      returnToDashboard();
      return;
    }

    if (completedUnderViewer && !landingOverride && currentView !== 'draft-history' && currentView !== 'settings') {
      setCompletedDraftModalOpen(true);
    }
  }, [
    selectedAuction,
    isLoading,
    landingOverride,
    currentView,
    returnToDashboard,
    setCompletedDraftModalOpen,
  ]);
}
