'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
} from 'react';
import { Player } from '@/server/types/player';
import { FantasyTeam } from '@/server/types/fantasy-team';
import { isUserTeam, calculateBudgetSummary } from '@/lib/roster';
import { useLeague, useUserTeamId } from '@/hooks/use-league';
import { buildHistoryIndex } from '@/lib/estimated-value';
import { useAuction } from '@/contexts/auction-context';
import { useAllDraftPicks, useCreateDraftPick } from '@/hooks/use-draft-picks';
import { useAuctionTeams } from '@/hooks/use-fantasy-teams';
import { useAllPlayers } from '@/hooks/use-players';
import { useHistoricalValues } from '@/hooks/use-history';
import { useTeamProfiles } from '@/hooks/use-team-profiles';
import { useWatchlist } from '@/hooks/use-watchlist';
import { deriveMockDraftState, buildTeamStates } from '@/lib/mock-draft/engine';
import { computeBase } from '@/lib/mock-draft/pricing';
import { chooseNomination } from '@/lib/mock-draft/nomination';
import { resolveNomination, counterBid } from '@/lib/mock-draft/auction-resolver';
import { getMockBidState } from '@/lib/mock-draft/bid-state';
import { RUN_WINDOW } from '@/lib/mock-draft/profiles';
import { chooseSnakePick } from '@/lib/mock-draft/snake-ai';
import { MockPhase, RankedPlayer, WtpBreakdown } from '@/lib/mock-draft/types';

// Stable identity for "this auction has no no-sales", so the memos that depend on
// it do not rerun on every render.
const EMPTY_UNSOLD: ReadonlySet<string> = new Set();

// Delay between auto-advanced AI snake picks so the board fills at a readable pace.
const SNAKE_DELAY_MS = 800;

export type SimStatus =
  | 'idle' // sim not active for the current auction
  | 'ai-nominating' // AI team's turn to nominate (about to resolve)
  | 'nomination' // a nomination is on the table, awaiting the user's Pass/Counter
  | 'user-nominate' // the user's turn to nominate — waiting for them to pick a player
  | 'snake-user' // the user's snake turn
  | 'snake-ai' // AI snake picks auto-advancing
  | 'complete'
  | 'paused';

// The nomination currently on the table, as the UI needs it. Hidden AI maxes live
// in `bids` and are never surfaced until after the pick commits.
export interface MockPendingView {
  player: Player;
  nominatorTeam: FantasyTeam | null;
  reason: 'drain' | 'target' | 'user';
  // The current team-to-beat (an AI team), or null when the user's own nomination
  // drew no AI interest (uncontested).
  winnerTeam: FantasyTeam | null;
  price: number;
  uncontested: boolean;
  log: string[];
}

interface PendingInternal extends MockPendingView {
  bids: Map<string, WtpBreakdown>;
  pickOrder: number;
  // The auction this nomination belongs to. Switching drafts invalidates it by
  // derivation rather than by an effect — see `pending` below.
  auctionId: string;
}

interface MockDraftContextType {
  // True only when this auction is a simulated mock and the user's team is in it.
  isActive: boolean;
  // The auction is flagged as a simulated mock (regardless of whether it can run).
  simFlagged: boolean;
  // Why the sim can't run despite being flagged (e.g. the user team is missing).
  disabledReason: string | null;

  status: SimStatus;
  phase: MockPhase;
  currentTeam: FantasyTeam | null;
  nextPickOrder: number;
  pending: MockPendingView | null;
  userMaxBid: number;
  paused: boolean;
  autoAdvance: boolean;
  // Bumped every time the user wins a nomination — the ticker fires its
  // confetti burst off the change, not off the value.
  winPulse: number;

  // Actions
  pass: () => void;
  counter: (amount?: number) => void;
  nominate: (player: Player) => void;
  submitSnakePick: (player: Player) => void;
  stepSnake: () => void;
  setPaused: (p: boolean) => void;
  setAutoAdvance: (a: boolean) => void;
}

const MockDraftContext = createContext<MockDraftContextType | undefined>(undefined);

export function MockDraftProvider({ children }: { children: ReactNode }) {
  // The sim runs against the SELECTED auction (isReadOnly already restricts to
  // active ones) — activeAuction is the user's own lifecycle auction, which can
  // differ now that league members see foreign active auctions.
  const { selectedAuction, isReadOnly, selectedYear } = useAuction();
  // The signed-in user's team (from their league membership). The sim only
  // activates when this team is part of the auction, so every orchestration
  // path below can rely on it being non-null while running.
  const userTeamId = useUserTeamId();
  const { league, settings } = useLeague();
  const { data: draftPicks = [], isLoading: picksLoading } = useAllDraftPicks();
  const { data: teams = [], isLoading: teamsLoading } = useAuctionTeams();
  const { data: players = [], isLoading: playersLoading } = useAllPlayers();
  const { data: historyRows = [], isLoading: historyLoading } = useHistoricalValues();
  const { data: profiles = new Map(), isLoading: profilesLoading } = useTeamProfiles();
  const { data: watchlist = [], isLoading: watchlistLoading } = useWatchlist();
  const createDraftPick = useCreateDraftPick();

  // The manager's own read on specific players, as a multiplier on the model value.
  // This IS loading-gated (see `dataReady`): an empty map is a valid neutral state
  // but not a valid DEFAULT here, because a nomination resolved before the
  // watchlist lands prices the player and seals every AI bid without the nudge,
  // and `pending` then blocks the effect from recomputing it. A brief wait beats a
  // permanently mispriced nomination.
  const marketNudges = useMemo(
    () =>
      new Map(
        watchlist
          .filter((row) => row.market_nudge > 0 && row.market_nudge !== 1)
          .map((row) => [row.player_id, row.market_nudge])
      ),
    [watchlist]
  );

  const [pendingRaw, setPending] = useState<PendingInternal | null>(null);
  const [paused, setPaused] = useState(false);
  // Auction-phase no-sales: nominated players every AI team was capped or broke on
  // (see atAuctionPositionCap in pricing.ts) and the user declined. Without this the
  // same nominator re-offers the same player forever. Local to the session on
  // purpose — they stay fully draftable in the snake rounds.
  const [unsoldRaw, setUnsold] = useState<{ auctionId: string; ids: ReadonlySet<string> }>({
    auctionId: '',
    ids: new Set(),
  });
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [isCommitting, setIsCommitting] = useState(false);
  const [winPulse, setWinPulse] = useState(0);
  // Prevents concurrent PB writes (double-commit) during async pick creation.
  const busyRef = useRef(false);
  // Player id of a submitted user snake pick not yet visible in the picks cache.
  const pendingUserSnakeRef = useRef<string | null>(null);

  const auctionId = selectedAuction?.id ?? '';

  // A nomination belongs to the auction it was generated for. Deriving that
  // instead of clearing it from a `[auctionId]` effect matters: the AI-nomination
  // effect is declared first, so on the commit that switches drafts it would set
  // a nomination the reset effect then wiped in the same commit — leaving
  // `pending` unchanged at null, no dep changed, and the sim stuck on
  // "…is nominating" until a reload.
  const pending = pendingRaw && pendingRaw.auctionId === auctionId ? pendingRaw : null;
  // Same derivation as `pending`, for the same reason: a no-sale belongs to the
  // auction it happened in. Held as provider state it leaked across drafts and
  // silently removed a perfectly available player from every AI nomination in the
  // next mock.
  const unsold = unsoldRaw.auctionId === auctionId ? unsoldRaw.ids : EMPTY_UNSOLD;

  const leagueSettingsReady = !selectedAuction?.league || league !== null;
  const dataReady =
    leagueSettingsReady &&
    !picksLoading && !teamsLoading && !playersLoading && !historyLoading && !profilesLoading &&
    !watchlistLoading;

  const simFlagged =
    !!selectedAuction && selectedAuction.type === 'mock' && selectedAuction.sim === true && !isReadOnly;
  const userTeamPresent = teams.some((t) => isUserTeam(t, userTeamId));
  const isActive = simFlagged && userTeamPresent;
  const disabledReason =
    simFlagged && !userTeamPresent
      ? 'Your team is not part of this auction, so the simulation cannot run.'
      : null;

  const teamsById = useMemo(() => {
    const map = new Map<string, FantasyTeam>();
    for (const t of teams) map.set(t.id, t);
    return map;
  }, [teams]);

  const state = useMemo(
    () => deriveMockDraftState(draftPicks, teams, settings),
    [draftPicks, teams, settings]
  );

  const teamStates = useMemo(
    () => buildTeamStates(draftPicks, teams, profiles, settings),
    [draftPicks, teams, profiles, settings]
  );

  const index = useMemo(() => buildHistoryIndex(historyRows), [historyRows]);

  const availablePlayers = useMemo(() => {
    const drafted = new Set(draftPicks.map((p) => p.player_id));
    return players.filter((p) => !drafted.has(p.id));
  }, [players, draftPicks]);

  // Positions of the most recent picks, oldest first — what the snake AI reads to
  // tell whether a run at a position is underway right now.
  const recentPositions = useMemo(
    () =>
      [...draftPicks]
        .sort((a, b) => a.pick_order - b.pick_order)
        .slice(-RUN_WINDOW)
        .map((pick) => pick.player.position),
    [draftPicks]
  );

  const availableRanked = useMemo<RankedPlayer[]>(
    () =>
      availablePlayers.filter((player) => !unsold.has(player.id)).map((player) => ({
        player,
        base: computeBase(index, selectedYear, player, auctionId, undefined, marketNudges),
      })),
    [availablePlayers, index, selectedYear, auctionId, marketNudges, unsold]
  );

  const userMaxBid = useMemo(() => {
    const userPicks = draftPicks.filter((p) => p.fantasy_team_id === userTeamId);
    return calculateBudgetSummary(userPicks, settings).maxBid;
  }, [draftPicks, userTeamId, settings]);

  const currentTeam = state.currentTeamId ? teamsById.get(state.currentTeamId) ?? null : null;

  // Derived UI status.
  const status: SimStatus = useMemo(() => {
    if (!isActive) return 'idle';
    if (paused) return 'paused';
    if (state.phase === 'complete') return 'complete';
    if (pending) return 'nomination';
    if (state.phase === 'auction') {
      return state.currentTeamId === userTeamId ? 'user-nominate' : 'ai-nominating';
    }
    return state.currentTeamId === userTeamId ? 'snake-user' : 'snake-ai';
  }, [isActive, paused, state.phase, state.currentTeamId, pending, userTeamId]);

  // --- Commit helper -----------------------------------------------------------
  // pick_order is assigned server-side (pb_hooks/draft_picks_pick_order.pb.js);
  // the sim's local pickOrder counter survives only as an engine RNG seed input.
  const commitPick = useCallback(
    async (args: {
      fantasy_team_id: string;
      player_id: string;
      price?: number | null;
    }) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setIsCommitting(true);
      try {
        await createDraftPick.mutateAsync(args);
      } catch (e) {
        console.error('Mock draft pick failed', e);
        // Failed writes never reach the cache — release the snake spam guard
        // so the user isn't locked out of their turn.
        pendingUserSnakeRef.current = null;
      } finally {
        busyRef.current = false;
        setIsCommitting(false);
      }
    },
    [createDraftPick]
  );

  // --- Orchestration: AI nomination (auction phase) ----------------------------
  useEffect(() => {
    if (!isActive || !dataReady || paused || pending || isCommitting) return;
    if (state.phase !== 'auction') return;
    if (!state.currentTeamId || state.currentTeamId === userTeamId) return;

    const nominator = teamStates.get(state.currentTeamId);
    if (!nominator || availableRanked.length === 0) return;

    const choice = chooseNomination(nominator, availableRanked, auctionId, state.nextPickOrder, settings);
    const aiTeams = [...teamStates.values()].filter((t) => t.teamId !== userTeamId);
    const result = resolveNomination(
      choice.player,
      choice.base,
      aiTeams,
      auctionId,
      state.nextPickOrder,
      settings
    );
    const winnerTeam = result.winnerTeamId ? teamsById.get(result.winnerTeamId) ?? null : null;

    setPending({
      auctionId,
      player: choice.player,
      pickOrder: state.nextPickOrder,
      reason: choice.reason,
      nominatorTeam: teamsById.get(state.currentTeamId) ?? null,
      winnerTeam,
      price: result.winnerTeamId ? result.price : Math.max(1, settings.minimumBid),
      uncontested: !result.winnerTeamId,
      bids: result.bids,
      log: [],
    });
  }, [
    isActive,
    dataReady,
    paused,
    pending,
    isCommitting,
    state.phase,
    state.currentTeamId,
    state.nextPickOrder,
    teamStates,
    availableRanked,
    auctionId,
    teamsById,
    userTeamId,
    settings,
  ]);

  // --- Orchestration: AI snake auto-advance ------------------------------------
  const runAiSnake = useCallback(async () => {
    if (busyRef.current) return;
    if (state.phase !== 'snake' || !state.currentTeamId || state.currentTeamId === userTeamId) {
      return;
    }
    const team = teamStates.get(state.currentTeamId);
    if (!team || availablePlayers.length === 0) return;
    const pick = chooseSnakePick(
      team,
      availablePlayers,
      auctionId,
      state.nextPickOrder,
      settings,
      recentPositions
    );
    await commitPick({
      fantasy_team_id: state.currentTeamId,
      player_id: pick.id,
      price: null,
    });
  }, [state.phase, state.currentTeamId, state.nextPickOrder, teamStates, availablePlayers, auctionId, commitPick, userTeamId, settings, recentPositions]);

  useEffect(() => {
    if (!isActive || !dataReady || paused || pending || isCommitting || !autoAdvance) return;
    if (state.phase !== 'snake') return;
    if (!state.currentTeamId || state.currentTeamId === userTeamId) return;
    const timer = setTimeout(() => {
      void runAiSnake();
    }, SNAKE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isActive, dataReady, paused, pending, isCommitting, autoAdvance, state.phase, state.currentTeamId, runAiSnake, userTeamId]);

  // --- User actions ------------------------------------------------------------
  const pass = useCallback(() => {
    if (paused || !pending) return;
    const { winnerTeam, price, player } = pending;
    setPending(null);
    // Nobody could bid and the user declined too: retire the player from the
    // auction pool rather than committing a pick with no buyer. Returning early
    // here (the old behaviour) left `pending` set and stalled the draft.
    if (!winnerTeam) {
      setUnsold((prev) => ({
        auctionId,
        ids: new Set(prev.auctionId === auctionId ? prev.ids : []).add(player.id),
      }));
      return;
    }
    void commitPick({
      fantasy_team_id: winnerTeam.id,
      player_id: player.id,
      price,
    });
  }, [paused, pending, commitPick, auctionId]);

  // `amount` is the keypad bid from the expanded mobile sheet; omitted, the user
  // simply takes the next legal increment. Anything below that increment (or
  // above the budget) is not a legal bid and is dropped rather than clamped —
  // silently bidding a different number than the one entered is worse.
  const counter = useCallback((amount?: number) => {
    if (paused || !pending || !userTeamId) return;
    const { minBid } = getMockBidState(pending, userMaxBid);
    const userBid = amount ?? minBid;
    if (!Number.isInteger(userBid) || userBid < minBid || userBid > userMaxBid) return;

    const result = counterBid(pending.bids, userBid);
    if (result.outbid) {
      const byTeam = teamsById.get(result.byTeamId) ?? null;
      setPending({
        ...pending,
        price: result.newPrice,
        winnerTeam: byTeam,
        uncontested: false,
        log: [...pending.log, `${byTeam?.name ?? 'A team'} counters at $${result.newPrice}`],
      });
    } else {
      const { player } = pending;
      setPending(null);
      setWinPulse((n) => n + 1);
      void commitPick({
        fantasy_team_id: userTeamId,
        player_id: player.id,
        price: userBid,
      });
    }
  }, [paused, pending, userMaxBid, teamsById, commitPick, userTeamId]);

  const nominate = useCallback(
    (player: Player) => {
      if (!dataReady || pending || !availablePlayers.some((candidate) => candidate.id === player.id)) return;
      if (!userTeamId || state.phase !== 'auction' || state.currentTeamId !== userTeamId) return;
      const base = computeBase(index, selectedYear, player, auctionId, undefined, marketNudges);
      const aiTeams = [...teamStates.values()].filter((t) => t.teamId !== userTeamId);
      const result = resolveNomination(player, base, aiTeams, auctionId, state.nextPickOrder, settings);
      const winnerTeam = result.winnerTeamId ? teamsById.get(result.winnerTeamId) ?? null : null;
      setPending({
        auctionId,
        player,
        pickOrder: state.nextPickOrder,
        reason: 'user',
        nominatorTeam: teamsById.get(userTeamId) ?? null,
        winnerTeam,
        price: result.winnerTeamId ? result.price : Math.max(1, settings.minimumBid),
        uncontested: !result.winnerTeamId,
        bids: result.bids,
        log: [],
      });
    },
    [dataReady, pending, availablePlayers, state.phase, state.currentTeamId, state.nextPickOrder, index, selectedYear, teamStates, auctionId, teamsById, userTeamId, settings, marketNudges]
  );

  const submitSnakePick = useCallback(
    (player: Player) => {
      // Spam guard: hold until the picks cache reflects the submitted pick.
      // busyRef alone is too short — a fast local PB can finish the POST and
      // release it before the cache/realtime update lands, and the stale
      // currentTeamId would then pass the state check and steal the next
      // team's turn.
      if (busyRef.current || pendingUserSnakeRef.current) return;
      if (!userTeamId || state.phase !== 'snake' || state.currentTeamId !== userTeamId) return;
      pendingUserSnakeRef.current = player.id;
      void commitPick({
        fantasy_team_id: userTeamId,
        player_id: player.id,
        price: null,
      });
    },
    [state.phase, state.currentTeamId, commitPick, userTeamId]
  );

  const stepSnake = useCallback(() => {
    void runAiSnake();
  }, [runAiSnake]);

  // A running auction/mock changed under us — drop any stale pending nomination
  // when the sim turns off (e.g. the user switches auctions).
  useEffect(() => {
    if (!isActive) setPending(null);
  }, [isActive]);

  // Pending is invalidated by derivation (see above), so only the pause flag
  // needs resetting when the draft changes.
  useEffect(() => {
    setPaused(false);
  }, [auctionId]);

  useEffect(() => {
    if (
      pending &&
      (pending.pickOrder !== state.nextPickOrder ||
        draftPicks.some((pick) => pick.player_id === pending.player.id))
    ) {
      setPending(null);
    }
  }, [pending, state.nextPickOrder, draftPicks]);

  // Release the user-snake spam guard as soon as the submitted pick is visible
  // in the picks cache. That is the render in which `state` is recomputed from
  // those same picks, so the committed click handler can no longer pass a stale
  // turn check — while the guard was held, every earlier (stale) handler was
  // blocked. Waiting for the turn to move OFF the user instead would strand the
  // guard forever at a snake turn boundary, where the same team picks twice in
  // a row (draft slots 1 and 12), locking the user out of their second pick
  // until a reload.
  useEffect(() => {
    if (
      pendingUserSnakeRef.current &&
      draftPicks.some((pick) => pick.player_id === pendingUserSnakeRef.current)
    ) {
      pendingUserSnakeRef.current = null;
    }
  }, [draftPicks]);

  useEffect(() => {
    pendingUserSnakeRef.current = null;
  }, [auctionId, isActive]);

  const value = useMemo<MockDraftContextType>(
    () => ({
      isActive,
      simFlagged,
      disabledReason,
      status,
      phase: state.phase,
      currentTeam,
      nextPickOrder: state.nextPickOrder,
      pending,
      userMaxBid,
      paused,
      autoAdvance,
      winPulse,
      pass,
      counter,
      nominate,
      submitSnakePick,
      stepSnake,
      setPaused,
      setAutoAdvance,
    }),
    [
      isActive,
      simFlagged,
      disabledReason,
      status,
      state.phase,
      state.nextPickOrder,
      currentTeam,
      pending,
      userMaxBid,
      paused,
      autoAdvance,
      winPulse,
      pass,
      counter,
      nominate,
      submitSnakePick,
      stepSnake,
    ]
  );

  return <MockDraftContext.Provider value={value}>{children}</MockDraftContext.Provider>;
}

export function useMockDraft() {
  const context = useContext(MockDraftContext);
  if (context === undefined) {
    throw new Error('useMockDraft must be used within a MockDraftProvider');
  }
  return context;
}
