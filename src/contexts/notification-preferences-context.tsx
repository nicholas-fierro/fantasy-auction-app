'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

// Mute toggle for turn notifications (3d), persisted in localStorage and
// shared between the on-the-clock banner (which fires the chime/title flash)
// and the toggle button in AuctionSwitcherBar (now rendered inside the Admin
// view's Auction Management tab, a descendant, not a sibling).
const STORAGE_KEY = 'draft-turn-notifications-muted';

interface NotificationPreferencesContextType {
  muted: boolean;
  setMuted: (muted: boolean) => void;
}

const NotificationPreferencesContext = createContext<NotificationPreferencesContextType | undefined>(undefined);

export function NotificationPreferencesProvider({ children }: { children: ReactNode }) {
  // Default unmuted for the first (SSR-matching) render; hydrate the real
  // preference from localStorage right after mount.
  const [muted, setMutedState] = useState(false);

  useEffect(() => {
    try {
      setMutedState(window.localStorage.getItem(STORAGE_KEY) === 'true');
    } catch {
      // localStorage unavailable (private browsing, etc.) — stay unmuted.
    }
  }, []);

  const setMuted = (value: boolean) => {
    setMutedState(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // Best-effort persistence only.
    }
  };

  return (
    <NotificationPreferencesContext.Provider value={{ muted, setMuted }}>
      {children}
    </NotificationPreferencesContext.Provider>
  );
}

export function useNotificationPreferences() {
  const context = useContext(NotificationPreferencesContext);
  if (context === undefined) {
    throw new Error('useNotificationPreferences must be used within a NotificationPreferencesProvider');
  }
  return context;
}
