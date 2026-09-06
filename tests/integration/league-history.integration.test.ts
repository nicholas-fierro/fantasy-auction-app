import PocketBase, { type RecordModel } from 'pocketbase';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeHistoricalValues } from '@/lib/history-client';
import { loadTeamProfiles } from '@/lib/team-profiles-client';
import { DEFAULT_ROSTER_SETTINGS } from '@/lib/roster';
import { leagueValueModelConfig } from '@/lib/league-history';
import { buildHistory, buildTargets, loadFromPocketBase, toValueTarget } from '@/server/lib/value-data';
import { calculateProjectedValuesCore } from '@/server/lib/import-core';
import { computeAuctionEstimates } from '@/lib/value-model';

const admin = new PocketBase(process.env.PB_INTEGRATION_URL);
let member: PocketBase;
let user: RecordModel;
const leagues: RecordModel[] = [];
const teams: RecordModel[][] = [];
const auctions: RecordModel[] = [];
const players: RecordModel[] = [];
const seasons: RecordModel[] = [];
const memberships: RecordModel[] = [];
let external: RecordModel;

beforeAll(async () => {
  await admin.collection('_superusers').authWithPassword(
    process.env.PB_INTEGRATION_ADMIN_EMAIL!, process.env.PB_INTEGRATION_ADMIN_PASSWORD!
  );
  const password = `${process.env.PB_INTEGRATION_ADMIN_PASSWORD}Aa1!`;
  user = await admin.collection('users').create({
    email: 'history-member@example.test', password, passwordConfirm: password, verified: true,
  });
  member = await admin.collection('users').impersonate(user.id, 3600);
  for (const name of ['History A', 'History B']) {
    const league = await admin.collection('leagues').create({
      name, commissioner: user.id, settings: DEFAULT_ROSTER_SETTINGS,
    });
    leagues.push(league);
    const leagueTeams = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      admin.collection('fantasy_teams').create({ name: `${name} Team ${index}`, league: league.id }, { requestKey: null })
    ));
    teams.push(leagueTeams);
    memberships.push(await admin.collection('league_members').create({
      league: league.id, user: user.id, fantasy_team: leagueTeams[0].id,
    }));
    auctions.push(await admin.collection('auctions').create({
      name: `${name} Draft`, league: league.id, user: user.id, type: 'official',
      year: 2031, status: 'active',
    }));
  }
  for (let index = 0; index < 6; index++) {
    const player = await admin.collection('players').create({ name: `History Player ${index}`, position: 'RB' });
    players.push(player);
    for (const year of [2031, 2032]) {
      seasons.push(await admin.collection('player_seasons').create({
        player_id: player.id, year, rank: index + 1, position_rank: index + 1,
        rank_ppr: index + 2, position_rank_ppr: index + 2,
      }));
    }
  }
  for (let index = 0; index < 5; index++) {
    await admin.collection('draft_picks').create({
      auction_id: auctions[0].id, fantasy_team_id: teams[0][index].id,
      player_id: players[index].id, price: 41 - index, pick_order: index + 1,
    });
  }
  await admin.collection('draft_picks').create({
    auction_id: auctions[1].id, fantasy_team_id: teams[1][0].id,
    player_id: players[0].id, price: 79, pick_order: 1,
  });
  await admin.collection('auctions').update(auctions[0].id, { status: 'completed' });
});

afterAll(async () => {
  if (external) await admin.collection('auctions').delete(external.id);
  for (const auction of auctions) await admin.collection('auctions').delete(auction.id);
  for (const season of seasons) await admin.collection('player_seasons').delete(season.id);
  for (const player of players) await admin.collection('players').delete(player.id);
  for (const membership of memberships) await admin.collection('league_members').delete(membership.id);
  for (const leagueTeams of teams) {
    for (const team of leagueTeams) await admin.collection('fantasy_teams').delete(team.id);
  }
  for (const league of leagues) await admin.collection('leagues').delete(league.id);
  if (user) await admin.collection('users').delete(user.id);
});

describe('same-season league history isolation', () => {
  it('keeps prices, synthesis, teams and profiles isolated for a member of both leagues', async () => {
    const before = await computeHistoricalValues(leagues[0].id, member);
    await admin.collection('auctions').update(auctions[1].id, { status: 'completed' });
    const readable = await member.collection('auctions').getFullList({
      filter: 'type = "official" && status = "completed" && year = 2031',
    });
    expect(readable.map(row => row.id)).toEqual(expect.arrayContaining(auctions.map(row => row.id)));
    expect(auctions[1].created > auctions[0].created).toBe(true);

    const history = await computeHistoricalValues(leagues[0].id, member);
    expect(history).toEqual(before);
    expect(history).toHaveLength(6);
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({ player_id: players[0].id, price: 41, source: 'official' }),
      expect.objectContaining({ player_id: players[5].id, price: 0, source: 'undrafted' }),
    ]));
    expect(history.some(row => row.price === 79)).toBe(false);
    const otherHistory = await computeHistoricalValues(leagues[1].id, member);
    expect(otherHistory.filter(row => row.source === 'official')).toEqual([
      expect.objectContaining({ player_id: players[0].id, price: 79 }),
    ]);

    for (let index = 0; index < 2; index++) {
      const profiles = await loadTeamProfiles(member, leagues[index].id);
      expect([...profiles.keys()].sort()).toEqual(teams[index].map(team => team.id).sort());
      expect([...profiles.values()].reduce((count, profile) => count + profile.sampleSize, 0)).toBe(index === 0 ? 5 : 1);
      const selectedTeams = await member.collection('fantasy_teams').getFullList({
        filter: member.filter('league = {:leagueId}', { leagueId: leagues[index].id }),
      });
      expect(selectedTeams.map(team => team.id).sort()).toEqual(teams[index].map(team => team.id).sort());
    }

    const data = await loadFromPocketBase(member, { leagueId: leagues[0].id, scoringFormat: 'half' });
    expect(data.auctions.map(row => row.id)).toEqual([auctions[0].id]);
    expect(data.picks.every(row => row.auction_id === auctions[0].id)).toBe(true);
    expect(buildHistory(data, 2032)).toEqual(history.map(row => ({
      year: row.year, position: row.position, rank: row.rank, position_rank: row.position_rank,
      price: row.price, external: false,
    })));
    expect(await loadFromPocketBase(admin, { leagueId: leagues[0].id, scoringFormat: 'half' })).toEqual(data);
  });

  it('writes the same projected prices as the CLI model path, using the selected league', async () => {
    const data = await loadFromPocketBase(admin, { leagueId: leagues[0].id, scoringFormat: 'half' });
    const targets = buildTargets(data, 2032);
    const expected = computeAuctionEstimates(buildHistory(data, 2032), targets.map(toValueTarget), 2032, leagueValueModelConfig(data.scope));
    expect([...expected.values()].some(value => value > 0)).toBe(true);
    await calculateProjectedValuesCore(member, 2032, leagues[0].id, 'half');
    const rows = await admin.collection('player_seasons').getFullList({ filter: 'year = 2032' });
    expect(rows).toHaveLength(targets.length);
    for (const row of rows) expect(row.projected_auction_value).toBe(expected.get(row.id) ?? 0);
    expect(await calculateProjectedValuesCore(member, 2032, leagues[0].id, 'half')).toMatchObject({ updated: 0 });
  });

  it('admits external comps only for matching auction leagues and never into profiles', async () => {
    external = await admin.collection('auctions').create({
      name: 'History External Board', year: 2031, type: 'official', status: 'completed', external: true,
    });
    const profilesBefore = await loadTeamProfiles(member, leagues[0].id);
    await admin.collection('draft_picks').create({
      auction_id: external.id, player_id: players[0].id, price: 23, pick_order: 1,
    });
    expect(await loadTeamProfiles(member, leagues[0].id)).toEqual(profilesBefore);
    expect((await computeHistoricalValues(leagues[0].id, member)).some(row => row.source === 'external' && row.price === 23)).toBe(true);
    for (const change of [{ budget: 250 }, { paidAuctionSlots: 8 }, { draftFormat: 'snake' }]) {
      await admin.collection('leagues').update(leagues[0].id, { settings: { ...DEFAULT_ROSTER_SETTINGS, ...change } });
      const data = await loadFromPocketBase(member, { leagueId: leagues[0].id, scoringFormat: 'half' });
      expect(data.auctions.some(row => row.external)).toBe(false);
      expect((await computeHistoricalValues(leagues[0].id, member)).some(row => row.external)).toBe(false);
    }
    await admin.collection('leagues').update(leagues[0].id, { settings: DEFAULT_ROSTER_SETTINGS });
    await admin.collection('fantasy_teams').update(teams[0][11].id, { league: leagues[1].id });
    expect((await loadFromPocketBase(member, { leagueId: leagues[0].id, scoringFormat: 'half' })).auctions.some(row => row.external)).toBe(false);
    await admin.collection('fantasy_teams').update(teams[0][11].id, { league: leagues[0].id });

    await admin.collection('leagues').update(leagues[1].id, { settings: {
      ...DEFAULT_ROSTER_SETTINGS, draftFormat: 'snake', budget: 0, paidAuctionSlots: 0, minimumBid: 0,
    } });
    expect(await computeHistoricalValues(leagues[1].id, member)).toEqual([]);
    const snake = await loadFromPocketBase(member, { leagueId: leagues[1].id, scoringFormat: 'half' });
    expect(buildHistory(snake, 2032)).toEqual([]);
    await expect(calculateProjectedValuesCore(member, 2032, leagues[1].id, 'half')).rejects.toThrow('Snake leagues');
    expect([...(await loadTeamProfiles(member, leagues[1].id)).keys()].sort()).toEqual(teams[1].map(team => team.id).sort());
  });
});
