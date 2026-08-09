'use client';

import dynamic from 'next/dynamic';
import { JoinLiveDraftBanner } from '@/components/join-live-draft-banner';
import { WatchlistSidebar } from '@/components/watchlist-sidebar';
import { PlayersTable } from '@/components/players-table';
import { FantasyTeamsView } from '@/components/fantasy-teams-view';
import { PageHeader } from '@/components/page-header';
import { PageContainer } from '@/components/page-container';
import { NoActiveDraftLanding } from '@/components/no-active-draft-landing';
import { DraftCompleteModal } from '@/components/draft-complete-modal';
import { useAuction } from '@/contexts/auction-context';
import {
  useCompletedDraftRedirect,
  useIsDraftRoom,
  useNavigation,
} from '@/contexts/navigation-context';
import { useAutoDraftMode } from '@/hooks/use-auto-draft-mode';
import { useTurnNotifications } from '@/hooks/use-turn-notifications';
import { useIsMobile } from '@/hooks/use-is-mobile';

function ViewLoadingFallback() {
  return (
    <div className="text-center py-8 text-gray-500 dark:text-gray-400">
      Loading...
    </div>
  );
}

const DraftBoardView = dynamic(
  () => import('@/components/draft-board-view').then((mod) => mod.DraftBoardView),
  { ssr: false, loading: ViewLoadingFallback }
);

const SettingsView = dynamic(
  () => import('@/components/settings-view').then((mod) => mod.SettingsView),
  { ssr: false, loading: ViewLoadingFallback }
);

const AnalysisView = dynamic(
  () => import('@/components/analysis-view').then((mod) => mod.AnalysisView),
  { ssr: false, loading: ViewLoadingFallback }
);

const DraftHistoryView = dynamic(
  () => import('@/components/draft-history-view').then((mod) => mod.DraftHistoryView),
  { ssr: false, loading: ViewLoadingFallback }
);

export function AppContent() {
  const { currentView, showWatchlist, landingOverride, completedDraftModalOpen } = useNavigation();
  const { selectedAuction, isLoading: auctionsLoading } = useAuction();
  const isDraftRoom = useIsDraftRoom();
  const isMobile = useIsMobile();
  const canShowLanding = currentView !== 'settings' && currentView !== 'draft-history';
  // `selectedAuction` already falls back to the user's own active draft, so its
  // absence is the "nothing to enter" signal.
  const showNoActiveDraft =
    !auctionsLoading && canShowLanding && (landingOverride || !selectedAuction);

  useAutoDraftMode();
  useCompletedDraftRedirect();
  // Chime + title flash used to ride along with the turn banner; it lives here
  // now so it still fires on views the ticker doesn't render on.
  useTurnNotifications();

  const renderPlayersView = () => (
    <PageContainer className="flex h-full flex-col">
      <PageHeader
        title="Players"
        description="Search, filter, and manage player auction values"
        className="mb-6 shrink-0"
      />
      <div className="flex-1 min-h-0">
        <PlayersTable />
      </div>
    </PageContainer>
  );

  const renderCurrentView = () => {
    switch (currentView) {
      case 'players':
        return renderPlayersView();
      case 'fantasy-teams':
        return <FantasyTeamsView />;
      case 'draft-board':
        return <DraftBoardView />;
      case 'analysis':
        return <AnalysisView />;
      case 'settings':
        return <SettingsView />;
      case 'draft-history':
        return <DraftHistoryView />;
      default:
        return <PlayersTable />;
    }
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      <main className="flex-1 overflow-auto bg-gray-50 dark:bg-gray-900">
        {/* Hold the draft-dependent views on a loading state until the auctions
            query settles: rendering the draft room while `selectedAuction` is
            merely unresolved flashes an empty board before the landing page
            takes over. Settings and draft history don't need an auction, so
            they stay reachable while the request is in flight. */}
        {auctionsLoading && canShowLanding ? <ViewLoadingFallback /> : showNoActiveDraft ? (
          <NoActiveDraftLanding />
        ) : (
          <>
            {/* Nudge toward a live official draft the member isn't currently
                viewing; renders nothing outside its trigger conditions. The
                turn prompt lives in the ticker now (NFI-53). */}
            <div className="px-4 pt-4 sm:px-6 empty:hidden [&>*]:mb-0">
              <JoinLiveDraftBanner />
            </div>
            {renderCurrentView()}
          </>
        )}
      </main>
      {/* On phones the watchlist is a drawer opened from the top-bar overflow
          menu instead of a fixed side column — see MobileNavActions. */}
      {showWatchlist && isDraftRoom && !isMobile && <WatchlistSidebar />}
      {completedDraftModalOpen && <DraftCompleteModal open />}
    </div>
  );
}
