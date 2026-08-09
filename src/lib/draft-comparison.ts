import type { Player } from '@/server/types/player';

export type ComparablePlayer = Pick<Player, 'id' | 'name' | 'position' | 'fantasypros_id'>;

export type ComparisonSource = 'local' | 'fantasypros';

export interface ComparisonReason {
  label: string;
  detail: string;
  winnerId: string | null;
}

export interface PlayerComparisonScore {
  playerId: string;
  score: number;
}

export interface DraftComparison {
  source: ComparisonSource;
  winnerId: string | null;
  scores: [PlayerComparisonScore, PlayerComparisonScore];
  reasons: ComparisonReason[];
  label: string;
  updatedAt?: string;
  totalExperts?: number;
  votes?: Record<string, number>;
}

function betterLower(first: number, second: number): -1 | 0 | 1 {
  if (!first || !second || first === second) return 0;
  return first < second ? -1 : 1;
}

// Higher is better, and 0 is a legitimate value (ecr_vs_adp is zero or negative
// for players going at or above their consensus rank), so unlike betterLower it
// must participate in the comparison rather than mean "missing".
function betterHigher(first: number, second: number): -1 | 0 | 1 {
  if (first === second) return 0;
  return first > second ? -1 : 1;
}

function formatSigned(value: number): string {
  return `${value > 0 ? '+' : ''}${value}`;
}

function playerByDirection(
  players: readonly [Player, Player],
  direction: -1 | 0 | 1
): Player | null {
  if (direction === 0) return null;
  return direction === -1 ? players[0] : players[1];
}

/**
 * A transparent fallback used until a FantasyPros API key + player mappings are
 * configured. It deliberately uses "ranking edge" language rather than making
 * an expert-consensus claim.
 */
export function buildLocalDraftComparison(players: readonly [Player, Player]): DraftComparison {
  const [first, second] = players;
  const reasons: ComparisonReason[] = [];
  const rankDirection = betterLower(first.rank, second.rank);
  const tierDirection = betterLower(first.tier, second.tier);
  const positionDirection = betterLower(first.position_rank, second.position_rank);
  const ecrAdpDirection = betterHigher(first.ecr_vs_adp, second.ecr_vs_adp);

  if (rankDirection !== 0) {
    const winner = playerByDirection(players, rankDirection);
    reasons.push({
      label: 'Overall rank',
      detail: `Rank #${winner?.rank} versus #${winner === first ? second.rank : first.rank}`,
      winnerId: winner?.id ?? null,
    });
  }

  if (tierDirection !== 0) {
    const winner = playerByDirection(players, tierDirection);
    reasons.push({
      label: 'Tier',
      detail: `Tier ${winner?.tier} versus Tier ${winner === first ? second.tier : first.tier}`,
      winnerId: winner?.id ?? null,
    });
  }

  if (positionDirection !== 0) {
    const winner = playerByDirection(players, positionDirection);
    reasons.push({
      label: 'Position rank',
      detail: `${winner?.position}${winner?.position_rank} versus ${winner === first ? second.position : first.position}${winner === first ? second.position_rank : first.position_rank}`,
      winnerId: winner?.id ?? null,
    });
  }

  if (ecrAdpDirection !== 0) {
    const winner = playerByDirection(players, ecrAdpDirection);
    const winnerEcrVsAdp = winner?.ecr_vs_adp ?? 0;
    const loserEcrVsAdp = winner === first ? second.ecr_vs_adp : first.ecr_vs_adp;
    reasons.push({
      label: 'ECR vs. ADP',
      detail: `${formatSigned(winnerEcrVsAdp)} versus ${formatSigned(loserEcrVsAdp)}`,
      winnerId: winner?.id ?? null,
    });
  }

  // Rank is intentionally decisive. Tiers and position rank only resolve a tie
  // or reinforce the ranking result so the fallback stays explainable.
  const winner = playerByDirection(players, rankDirection || tierDirection || positionDirection || ecrAdpDirection);
  const rankGap = first.rank && second.rank ? Math.abs(first.rank - second.rank) : 0;
  const strength = winner ? Math.min(95, 55 + Math.round(rankGap * 1.5) + (tierDirection !== 0 ? 8 : 0)) : 50;
  const firstWins = winner?.id === first.id;

  return {
    source: 'local',
    winnerId: winner?.id ?? null,
    scores: [
      { playerId: first.id, score: winner ? (firstWins ? strength : 100 - strength) : 50 },
      { playerId: second.id, score: winner ? (firstWins ? 100 - strength : strength) : 50 },
    ],
    reasons,
    label: winner ? 'Ranking edge' : 'Even comparison',
  };
}

export interface ExpertBallot {
  expertId: string;
  playerRanks: Record<string, number>;
  expertName?: string;
  updatedAt?: string;
}

export function buildExpertDraftComparison(
  players: readonly [ComparablePlayer, ComparablePlayer],
  ballots: readonly ExpertBallot[],
  updatedAt?: string
): DraftComparison {
  const votes: Record<string, number> = { [players[0].id]: 0, [players[1].id]: 0 };
  let totalExperts = 0;

  for (const ballot of ballots) {
    const firstRank = ballot.playerRanks[players[0].id];
    const secondRank = ballot.playerRanks[players[1].id];
    if (!firstRank || !secondRank || firstRank === secondRank) continue;
    totalExperts += 1;
    votes[firstRank < secondRank ? players[0].id : players[1].id] += 1;
  }

  const winner = totalExperts === 0
    ? null
    : votes[players[0].id] === votes[players[1].id]
      ? null
      : votes[players[0].id] > votes[players[1].id] ? players[0] : players[1];
  const firstScore = totalExperts === 0 ? 50 : Math.round((votes[players[0].id] / totalExperts) * 100);

  return {
    source: 'fantasypros',
    winnerId: winner?.id ?? null,
    scores: [
      { playerId: players[0].id, score: firstScore },
      { playerId: players[1].id, score: 100 - firstScore },
    ],
    votes,
    totalExperts,
    updatedAt,
    label: winner ? 'Expert vote' : 'Experts are split',
    reasons: winner ? [{
      label: 'Expert vote',
      detail: `${votes[winner.id]} of ${totalExperts} eligible experts ranked ${winner.name} higher.`,
      winnerId: winner.id,
    }] : [],
  };
}
