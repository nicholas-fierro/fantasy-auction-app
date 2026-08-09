interface PlayerImageSource {
  position: string;
  team?: string | null;
  sleeperId?: string | null;
  espnId?: string | null;
}

/**
 * Resolves a player headshot URL following a source-priority cascade:
 * 1. Defenses (DST) render their team logo instead of a headshot.
 * 2. ESPN's combiner endpoint (sharper crops, requested at 2x for retina).
 * 3. Sleeper's static per-player headshot as a fallback.
 * 4. `null` when no identifier is available, so callers can render initials.
 */
export function getPlayerImageUrl(source: PlayerImageSource, sizePx: number): string | null {
  const { position, team, sleeperId, espnId } = source;

  if (position === 'DST' && team) {
    return `https://sleepercdn.com/images/team_logos/nfl/${team.toLowerCase()}.png`;
  }

  if (espnId) {
    const dimension = sizePx * 2;
    return `https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/${espnId}.png&w=${dimension}`;
  }

  if (sleeperId) {
    return `https://sleepercdn.com/content/nfl/players/${sleeperId}.jpg`;
  }

  return null;
}
