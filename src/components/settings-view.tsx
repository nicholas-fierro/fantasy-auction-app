'use client';

import { useEffect, useState } from 'react';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useIsCommissioner } from '@/hooks/use-league';
import { ImportView } from '@/components/import-view';
import { TeamProfilesView } from '@/components/mock-draft/team-profiles-view';
import { LeagueView } from '@/components/league-view';
import { ProfilePanel } from '@/components/settings/profile-panel';
import { OfficialDraftPanel } from '@/components/settings/official-draft-panel';

/**
 * Unified account + config surface (replaces the old commissioner-only Admin
 * view). Profile is visible to everyone; League, Import, Official Draft, and
 * Team Profiles are commissioner-only league-admin surfaces, shown whether or
 * not a draft is active (commissioner status is league-level, not scoped to a
 * selected auction).
 */
export function SettingsView() {
  const isCommissioner = useIsCommissioner();
  const [tab, setTab] = useState('profile');

  // If a commissioner-only tab is open when the role changes out from under it
  // (e.g. commissioner status resolves false), fall back to Profile.
  useEffect(() => {
    if (!isCommissioner && ['league', 'import', 'official', 'profiles'].includes(tab)) {
      setTab('profile');
    }
  }, [isCommissioner, tab]);

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Settings"
        description="Manage your account and league configuration."
      />
      <Tabs value={tab} onValueChange={setTab}>
        {/* Five tabs overflow a phone: scroll the strip instead of squashing it
            (flex-none keeps each trigger at its label width). */}
        <TabsList className="max-md:h-11 max-md:w-full max-md:justify-start max-md:overflow-x-auto max-md:[&>*]:flex-none">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          {isCommissioner && <TabsTrigger value="league">League</TabsTrigger>}
          {isCommissioner && <TabsTrigger value="import">Import</TabsTrigger>}
          {isCommissioner && <TabsTrigger value="official">Official Draft</TabsTrigger>}
          {isCommissioner && <TabsTrigger value="profiles">Team Profiles</TabsTrigger>}
        </TabsList>
        <TabsContent value="profile" className="mt-4">
          <ProfilePanel />
        </TabsContent>
        {isCommissioner && (
          <TabsContent value="league" className="mt-4">
            <LeagueView />
          </TabsContent>
        )}
        {isCommissioner && (
          <TabsContent value="import" className="mt-4">
            <ImportView />
          </TabsContent>
        )}
        {isCommissioner && (
          <TabsContent value="official" className="mt-4">
            <OfficialDraftPanel />
          </TabsContent>
        )}
        {isCommissioner && (
          <TabsContent value="profiles" className="mt-4">
            <TeamProfilesView />
          </TabsContent>
        )}
      </Tabs>
    </PageContainer>
  );
}
