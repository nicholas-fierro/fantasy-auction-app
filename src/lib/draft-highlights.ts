import type { DraftPickWithDetails } from '@/server/types/draft-pick';

export interface ValueHighlight {
  pick: DraftPickWithDetails;
  difference: number;
}

export interface DraftHighlights {
  priciest: DraftPickWithDetails | null;
  biggestBargain: ValueHighlight | null;
  biggestOverpay: ValueHighlight | null;
  durationMs: number | null;
  viewerLine: string | null;
}

export function getDraftHighlights(
  picks: DraftPickWithDetails[],
  viewerTeamId: string | null = null,
): DraftHighlights {
  const pricedPicks = picks.filter((pick) => pick.price != null);
  const priciest = pricedPicks.reduce<DraftPickWithDetails | null>(
    (best, pick) => !best || pick.price! > best.price! ? pick : best,
    null,
  );
  const projectedPicks = pricedPicks.filter(
    (pick) => pick.player.projected_auction_value != null,
  );
  const bargainPick = projectedPicks
    .filter((pick) => pick.player.projected_auction_value! - pick.price! > 0)
    .reduce<DraftPickWithDetails | null>(
      (best, pick) => !best || pick.player.projected_auction_value! - pick.price!
        > best.player.projected_auction_value! - best.price! ? pick : best,
      null,
    );
  const overpayPick = projectedPicks
    .filter((pick) => pick.price! - pick.player.projected_auction_value! > 0)
    .reduce<DraftPickWithDetails | null>(
      (best, pick) => !best || pick.price! - pick.player.projected_auction_value!
        > best.price! - best.player.projected_auction_value! ? pick : best,
      null,
    );

  const orderedPicks = [...picks].sort((a, b) => a.pick_order - b.pick_order);
  const firstTimestamp = orderedPicks[0] ? Date.parse(orderedPicks[0].timestamp) : NaN;
  const lastTimestamp = orderedPicks.at(-1) ? Date.parse(orderedPicks.at(-1)!.timestamp) : NaN;
  const durationMs = Number.isFinite(firstTimestamp)
    && Number.isFinite(lastTimestamp)
    && lastTimestamp >= firstTimestamp
    ? lastTimestamp - firstTimestamp
    : null;

  const viewerPicks = viewerTeamId
    ? orderedPicks.filter((pick) => pick.fantasy_team_id === viewerTeamId)
    : [];
  let viewerLine: string | null = null;
  if (viewerTeamId) {
    if (viewerPicks.length === 0) {
      viewerLine = 'Your team made no picks.';
    } else {
      const bestValuePick = viewerPicks
        .filter((pick) => pick.price != null && pick.player.projected_auction_value != null
          && pick.player.projected_auction_value - pick.price > 0)
        .reduce<DraftPickWithDetails | null>(
          (best, pick) => !best || pick.player.projected_auction_value! - pick.price!
            > best.player.projected_auction_value! - best.price! ? pick : best,
          null,
        );
      viewerLine = bestValuePick
        ? `Your best value: ${bestValuePick.player.name}, $${bestValuePick.player.projected_auction_value! - bestValuePick.price!} under projection.`
        : 'Your team had no picks under projection.';
    }
  }

  return {
    priciest,
    biggestBargain: bargainPick ? {
      pick: bargainPick,
      difference: Math.max(0, bargainPick.player.projected_auction_value! - bargainPick.price!),
    } : null,
    biggestOverpay: overpayPick ? {
      pick: overpayPick,
      difference: Math.max(0, overpayPick.price! - overpayPick.player.projected_auction_value!),
    } : null,
    durationMs,
    viewerLine,
  };
}

export function formatDraftDuration(durationMs: number | null): string {
  if (durationMs == null) return 'Not available';
  if (durationMs < 60_000) return 'Under a minute';

  const totalMinutes = Math.round(durationMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}
