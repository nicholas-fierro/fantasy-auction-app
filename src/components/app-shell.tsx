'use client';

import { ActiveDraftProvider } from '@/contexts/active-draft-context';
import { MockDraftProvider } from '@/contexts/mock-draft-context';
import { NavigationProvider } from '@/contexts/navigation-context';
import { AuctionProvider } from '@/contexts/auction-context';
import { LeagueProvider } from '@/contexts/league-context';
import { NotificationPreferencesProvider } from '@/contexts/notification-preferences-context';
import { SessionProvider } from '@/components/providers/session-provider';
import { RealtimeSync } from '@/components/providers/realtime-sync';
import { TopNavbar } from '@/components/top-navbar';
import { AppContent } from '@/components/app-content';
import { MobileTabBar } from '@/components/mobile-tab-bar';
import { MobileNominationTicker } from '@/components/mobile-nomination-ticker';
import { PlayerDetailProvider } from '@/contexts/player-detail-context';

export function AppShell() {
  return (
    <SessionProvider>
      <LeagueProvider>
        <AuctionProvider>
          <NavigationProvider>
            <ActiveDraftProvider>
              <MockDraftProvider>
                <PlayerDetailProvider>
                  <NotificationPreferencesProvider>
                    <RealtimeSync />
                    {/* h-dvh (not h-screen) so mobile browser chrome can't
                        clip the bottom tab bar off the layout. */}
                    <div className="flex flex-col h-dvh">
                      <TopNavbar />
                      <AppContent />
                      {/* Docked above the tab bar (NFI-57) — a flex sibling of
                          the scroll area so the players table owns the rest of
                          the viewport and is never hidden behind the rail. */}
                      <MobileNominationTicker />
                      <MobileTabBar />
                    </div>
                  </NotificationPreferencesProvider>
                </PlayerDetailProvider>
              </MockDraftProvider>
            </ActiveDraftProvider>
          </NavigationProvider>
        </AuctionProvider>
      </LeagueProvider>
    </SessionProvider>
  );
}
