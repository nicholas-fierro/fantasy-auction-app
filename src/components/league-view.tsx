'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, KeyRound, RefreshCw, Trash2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useLeague } from '@/hooks/use-league';
import { useAllFantasyTeams } from '@/hooks/use-fantasy-teams';
import {
  useCreateInvite,
  useDeleteInvite,
  useInvites,
  useLeagueMembers,
  useRegenerateInvite,
  type LeagueMember,
} from '@/hooks/use-invites';
import {
  useDeleteLeagueMember,
  useHasActiveAuction,
  useUpdateLeagueMember,
  useUpdateLeagueSettings,
} from '@/hooks/use-league-members';
import type { RosterSettings } from '@/lib/roster';
import type { ScoringFormat } from '@/lib/fantasy-scoring';
import { resetMemberPassword } from '@/server/actions/members';

const NO_TEAM = '__none__';

// Commissioner tools: manage who's in the league (team assignment, removal,
// password resets), edit league settings, and hand out invite links. Rendered
// only for the commissioner (admin-view gates the tab).
export function LeagueView() {
  const { league, settings } = useLeague();
  const leagueId = league?.id ?? null;

  const { data: invites = [] } = useInvites(leagueId);
  const { data: members = [] } = useLeagueMembers(leagueId);
  const { data: teams = [] } = useAllFantasyTeams();
  const createInvite = useCreateInvite(leagueId);
  const deleteInvite = useDeleteInvite(leagueId);
  const regenerateInvite = useRegenerateInvite(leagueId);

  const [email, setEmail] = useState('');
  const [teamId, setTeamId] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const claimedTeamIds = useMemo(
    () => new Set(members.map(member => member.fantasy_team).filter(Boolean)),
    [members]
  );
  const teamNameById = useMemo(
    () => new Map(teams.map(team => [team.id, team.name])),
    [teams]
  );

  const handleCreate = async () => {
    try {
      await createInvite.mutateAsync({ email: email.trim() || undefined, fantasy_team: teamId || undefined });
      setEmail('');
      setTeamId('');
      toast.success('Invite created');
    } catch {
      toast.error('Could not create the invite');
    }
  };

  const copyLink = async (invite: { id: string; token: string }) => {
    const url = `${window.location.origin}/signup?token=${invite.token}`;
    await navigator.clipboard.writeText(url);
    setCopiedId(invite.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleRegenerate = async (id: string) => {
    try {
      await regenerateInvite.mutateAsync(id);
      toast.success('Invite link regenerated — the old link no longer works');
    } catch {
      toast.error('Could not regenerate the invite');
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>Assign teams, reset a locked-out member&apos;s password, or remove someone from {league?.name ?? 'the league'}.</CardDescription>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members yet.</p>
          ) : (
            <div className="space-y-2">
              {members.map(member => (
                <MemberRow
                  key={member.id}
                  member={member}
                  leagueId={leagueId}
                  teams={teams}
                  claimedTeamIds={claimedTeamIds}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <LeagueSettingsCard leagueId={leagueId} settings={settings} />

      <Card>
        <CardHeader>
          <CardTitle>Invites</CardTitle>
          <CardDescription>
            Share a link to let a league member create their account. Pinning a team
            assigns it on signup; pinning an email restricts who can use the link.
            Links expire after a week by default.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1 max-md:w-full">
              <Label htmlFor="invite-email">Email (optional)</Label>
              <Input
                id="invite-email"
                type="email"
                placeholder="member@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-56 max-md:w-full"
              />
            </div>
            <div className="space-y-1 max-md:w-full">
              <Label htmlFor="invite-team">Team (optional)</Label>
              <select
                id="invite-team"
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
                className="h-9 w-48 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs max-md:h-11 max-md:w-full max-md:text-base"
              >
                <option value="">No team</option>
                {teams.map(team => (
                  <option key={team.id} value={team.id} disabled={claimedTeamIds.has(team.id)}>
                    {team.name}{claimedTeamIds.has(team.id) ? ' (claimed)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <Button
              onClick={handleCreate}
              disabled={createInvite.isPending || !leagueId}
              className="max-md:h-11 max-md:w-full"
            >
              <UserPlus className="mr-1 h-4 w-4" />
              Create invite
            </Button>
          </div>

          {invites.length > 0 && (
            <div className="space-y-2">
              {invites.map(invite => {
                const used = !!invite.used_by;
                const expired = !used && !!invite.expires && new Date(invite.expires) < new Date();
                return (
                  <div key={invite.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm max-md:flex-wrap">
                    <div className="min-w-0 flex-1 max-md:basis-full">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="truncate font-mono text-xs text-muted-foreground">…{invite.token.slice(-8)}</code>
                        {invite.email && <Badge variant="outline">{invite.email}</Badge>}
                        {invite.fantasy_team && (
                          <Badge variant="secondary">{teamNameById.get(invite.fantasy_team) ?? 'Team'}</Badge>
                        )}
                        {used && <Badge className="bg-emerald-600">Used</Badge>}
                        {expired && <Badge variant="destructive">Expired</Badge>}
                        {!used && !expired && invite.expires && (
                          <span className="text-xs text-muted-foreground">
                            expires {new Date(invite.expires).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                    {!used && (
                      <>
                        {!expired && (
                          <Button variant="outline" size="sm" className="max-md:h-11" onClick={() => copyLink(invite)}>
                            {copiedId === invite.id ? (
                              <Check className="h-4 w-4 text-emerald-600" />
                            ) : (
                              <Copy className="h-4 w-4" />
                            )}
                            <span className="ml-1">{copiedId === invite.id ? 'Copied' : 'Copy link'}</span>
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          className="max-md:h-11"
                          onClick={() => handleRegenerate(invite.id)}
                          disabled={regenerateInvite.isPending}
                          title="Issue a fresh link and invalidate the old one"
                        >
                          <RefreshCw className="h-4 w-4" />
                          <span className="ml-1">Regenerate</span>
                        </Button>
                      </>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="max-md:size-11"
                      onClick={() => deleteInvite.mutate(invite.id)}
                      title={used ? 'Remove record' : 'Revoke invite'}
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface FantasyTeamLite {
  id: string;
  name: string;
}

function MemberRow({
  member,
  leagueId,
  teams,
  claimedTeamIds,
}: {
  member: LeagueMember;
  leagueId: string | null;
  teams: FantasyTeamLite[];
  claimedTeamIds: Set<string>;
}) {
  const updateMember = useUpdateLeagueMember(leagueId);
  const deleteMember = useDeleteLeagueMember(leagueId);

  const [confirmRemove, setConfirmRemove] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [passwordCopied, setPasswordCopied] = useState(false);

  const handleTeamChange = async (value: string) => {
    const fantasy_team = value === NO_TEAM ? null : value;
    if (fantasy_team === (member.fantasy_team || null)) return;
    try {
      await updateMember.mutateAsync({ id: member.id, fantasy_team });
      toast.success(fantasy_team ? 'Team assigned' : 'Team cleared');
    } catch {
      toast.error('Could not update the team — it may already be claimed');
    }
  };

  const handleRemove = async () => {
    try {
      await deleteMember.mutateAsync(member.id);
      toast.success('Member removed');
      setConfirmRemove(false);
    } catch {
      toast.error('Could not remove the member');
    }
  };

  const handleResetPassword = async () => {
    setIsResetting(true);
    try {
      const result = await resetMemberPassword(member.id);
      if (result.ok && result.password) {
        setTempPassword(result.password);
        setPasswordCopied(false);
      } else {
        toast.error(result.error ?? 'Could not reset the password');
      }
    } catch {
      toast.error('Could not reset the password');
    } finally {
      setIsResetting(false);
    }
  };

  const copyPassword = async () => {
    if (!tempPassword) return;
    await navigator.clipboard.writeText(tempPassword);
    setPasswordCopied(true);
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
      <div className="min-w-0 max-md:w-full">
        <span className="font-medium">{member.userName || member.userEmail}</span>
        {member.userName && (
          <span className="ml-2 text-muted-foreground max-md:ml-0 max-md:block max-md:truncate">{member.userEmail}</span>
        )}
      </div>
      <div className="flex items-center gap-2 max-md:w-full">
        <Select value={member.fantasy_team || NO_TEAM} onValueChange={handleTeamChange}>
          <SelectTrigger size="sm" className="w-44 max-md:h-11 max-md:w-auto max-md:flex-1">
            <SelectValue placeholder="No team" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_TEAM}>No team</SelectItem>
            {teams.map(team => {
              // Teams claimed by OTHER members are off-limits; this member's own
              // team stays selectable so the trigger can render it.
              const takenByOther = claimedTeamIds.has(team.id) && team.id !== member.fantasy_team;
              return (
                <SelectItem key={team.id} value={team.id} disabled={takenByOther}>
                  {team.name}{takenByOther ? ' (claimed)' : ''}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>

        <Button
          variant="outline"
          size="sm"
          className="max-md:size-11"
          onClick={handleResetPassword}
          disabled={isResetting}
          title="Set a temporary password for this member"
        >
          <KeyRound className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="max-md:size-11"
          onClick={() => setConfirmRemove(true)}
          title="Remove member from the league"
        >
          <Trash2 className="h-4 w-4 text-red-500" />
        </Button>
      </div>

      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent variant="alert">
          <DialogHeader>
            <DialogTitle>Remove member?</DialogTitle>
            <DialogDescription>
              {member.userName || member.userEmail} will lose access to the league and
              their team will be unclaimed. Their account and draft history are not
              deleted. This can&apos;t be undone from here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRemove(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleRemove} disabled={deleteMember.isPending}>
              Remove member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={tempPassword !== null} onOpenChange={(open) => { if (!open) setTempPassword(null); }}>
        <DialogContent variant="alert">
          <DialogHeader>
            <DialogTitle>Temporary password</DialogTitle>
            <DialogDescription>
              Give this to {member.userName || member.userEmail} so they can log in, then
              have them change it. It&apos;s shown once — you won&apos;t be able to see it again.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md border bg-muted px-3 py-2 font-mono text-sm">{tempPassword}</code>
            <Button variant="outline" size="sm" onClick={copyPassword}>
              {passwordCopied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
              <span className="ml-1">{passwordCopied ? 'Copied' : 'Copy'}</span>
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setTempPassword(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LeagueSettingsCard({
  leagueId,
  settings,
}: {
  leagueId: string | null;
  settings: RosterSettings;
}) {
  const updateSettings = useUpdateLeagueSettings(leagueId);
  const locked = useHasActiveAuction(leagueId);
  const formDisabled = locked || !leagueId;

  // Local form mirrors the persisted settings; strings so number inputs can be
  // cleared while editing. starterPositions edits as a comma-separated list.
  const [budget, setBudget] = useState(String(settings.budget));
  const [paidAuctionSlots, setPaidAuctionSlots] = useState(String(settings.paidAuctionSlots));
  const [minimumBid, setMinimumBid] = useState(String(settings.minimumBid));
  const [benchSize, setBenchSize] = useState(String(settings.benchSize));
  const [starterPositions, setStarterPositions] = useState(settings.starterPositions.join(', '));
  const [scoringFormat, setScoringFormat] = useState<ScoringFormat>(settings.scoringFormat);

  // Re-sync when the league's settings load or change out from under the form.
  useEffect(() => {
    setBudget(String(settings.budget));
    setPaidAuctionSlots(String(settings.paidAuctionSlots));
    setMinimumBid(String(settings.minimumBid));
    setBenchSize(String(settings.benchSize));
    setStarterPositions(settings.starterPositions.join(', '));
    setScoringFormat(settings.scoringFormat);
  }, [settings]);

  const handleSave = async () => {
    const parsedPositions = starterPositions
      .split(',')
      .map(p => p.trim().toUpperCase())
      .filter(Boolean);

    const next: RosterSettings = {
      budget: Number(budget),
      paidAuctionSlots: Number(paidAuctionSlots),
      minimumBid: Number(minimumBid),
      benchSize: Number(benchSize),
      starterPositions: parsedPositions,
      scoringFormat,
      draftFormat: settings.draftFormat,
    };

    if (!Number.isFinite(next.budget) || next.budget <= 0) {
      toast.error('Budget must be a positive number');
      return;
    }
    if (!Number.isFinite(next.paidAuctionSlots) || !Number.isInteger(next.paidAuctionSlots) || next.paidAuctionSlots <= 0) {
      toast.error('Paid slots must be a positive integer');
      return;
    }
    if (!Number.isFinite(next.minimumBid) || next.minimumBid < 1) {
      toast.error('Minimum bid must be at least $1');
      return;
    }
    if (!Number.isFinite(next.benchSize) || !Number.isInteger(next.benchSize) || next.benchSize < 0) {
      toast.error('Bench size must be a non-negative integer');
      return;
    }
    if (next.budget < next.paidAuctionSlots * next.minimumBid) {
      toast.error('Budget must cover all paid slots at the minimum bid');
      return;
    }
    if (parsedPositions.length === 0) {
      toast.error('Add at least one starter position');
      return;
    }
    if (next.paidAuctionSlots > parsedPositions.length + next.benchSize) {
      toast.error('Paid slots cannot exceed starter positions plus bench size');
      return;
    }

    try {
      await updateSettings.mutateAsync(next);
      toast.success('League settings saved');
    } catch {
      toast.error('Could not save settings');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>League settings</CardTitle>
        <CardDescription>
          Budget and roster shape used across the app. These feed max-bid math and
          roster construction.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {locked && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            A draft is live. Settings are locked until it&apos;s completed so changes
            can&apos;t invalidate picks already made.
          </p>
        )}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="settings-budget">Budget</Label>
            <Input
              id="settings-budget"
              type="number"
              inputMode="numeric"
              min={1}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              disabled={formDisabled}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="settings-slots">Paid slots</Label>
            <Input
              id="settings-slots"
              type="number"
              inputMode="numeric"
              min={1}
              value={paidAuctionSlots}
              onChange={(e) => setPaidAuctionSlots(e.target.value)}
              disabled={formDisabled}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="settings-minbid">Minimum bid</Label>
            <Input
              id="settings-minbid"
              type="number"
              inputMode="numeric"
              min={1}
              value={minimumBid}
              onChange={(e) => setMinimumBid(e.target.value)}
              disabled={formDisabled}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="settings-bench">Bench size</Label>
            <Input
              id="settings-bench"
              type="number"
              inputMode="numeric"
              min={0}
              value={benchSize}
              onChange={(e) => setBenchSize(e.target.value)}
              disabled={formDisabled}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="settings-starters">Starter positions</Label>
          <Input
            id="settings-starters"
            value={starterPositions}
            onChange={(e) => setStarterPositions(e.target.value)}
            disabled={formDisabled}
            placeholder="QB, RB, RB, WR, WR, TE, FLEX, K, DST"
          />
          <p className="text-xs text-muted-foreground">Comma-separated, in starting-lineup order. Use FLEX for RB/WR/TE flex spots.</p>
        </div>
        <div className="space-y-1 sm:max-w-xs">
          <Label htmlFor="settings-scoring">Scoring format</Label>
          <Select
            value={scoringFormat}
            onValueChange={(value) => setScoringFormat(value as ScoringFormat)}
            disabled={formDisabled}
          >
            <SelectTrigger id="settings-scoring">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="std">Standard (no PPR)</SelectItem>
              <SelectItem value="half">Half PPR (0.5 per catch)</SelectItem>
              <SelectItem value="ppr">Full PPR (1 per catch)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Points per reception. Sets the default for game-log scoring.
          </p>
        </div>
        <div>
          <Button
            onClick={handleSave}
            disabled={formDisabled || updateSettings.isPending}
            className="max-md:h-11 max-md:w-full"
          >
            Save settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
