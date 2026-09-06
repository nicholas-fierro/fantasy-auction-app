// FantasyPros ECR-vs-ADP is ADP minus ECR. Inputs must already be flattened
// from the selected scoring board; absence is not a zero delta.
export function deriveAdp(rank: number | null | undefined, delta: number | null | undefined): number | null {
  if (rank == null || delta == null || !Number.isFinite(rank) || !Number.isFinite(delta) || rank <= 0) return null;
  const adp = rank + delta;
  return Number.isFinite(adp) && adp > 0 ? adp : null;
}

export type BoardSort = { column: 'rank' | 'adp'; direction: 'asc' | 'desc' };
type RankedPlayer = { id: string; rank: number; ecr_vs_adp: number | null };

// Missing values stay last in either direction; rank/id make ties deterministic.
export function compareBoardPlayers(a: RankedPlayer, b: RankedPlayer, sort: BoardSort): number {
  const value = (player: RankedPlayer) => sort.column === 'adp'
    ? deriveAdp(player.rank, player.ecr_vs_adp)
    : Number.isFinite(player.rank) && player.rank > 0 ? player.rank : null;
  const left = value(a);
  const right = value(b);
  if (left == null && right != null) return 1;
  if (right == null && left != null) return -1;
  const difference = left == null || right == null ? 0 : left - right;
  return difference * (sort.direction === 'asc' ? 1 : -1)
    || a.rank - b.rank || a.id.localeCompare(b.id);
}
