'use client';

import { formatDistanceToNow, isValid } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { usePlayerNews } from '@/hooks/use-player-news';
import { getEspnTeamId } from '@/lib/espn-news';
import { Player } from '@/server/types/player';

interface PlayerNewsSectionProps {
  player: Player;
  enabled?: boolean;
  mode?: 'section' | 'teaser' | 'full';
  onShowAll?: () => void;
  onBack?: () => void;
}

function relativePublishedAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!isValid(date)) return null;
  return formatDistanceToNow(date, { addSuffix: true });
}

export function PlayerNewsSection({
  player,
  enabled = true,
  mode = 'section',
  onShowAll,
  onBack,
}: PlayerNewsSectionProps) {
  const teamId = getEspnTeamId(player.team);
  const canFetch = !!player.espn_id || teamId != null;
  const isTeamNews = !player.espn_id && teamId != null;
  const { data: news = [], isLoading, isError } = usePlayerNews(player, enabled);

  if (mode === 'teaser') {
    if (news.length === 0 || isLoading || isError) return null;
    return (
      <section className="flex items-center gap-2 border-t px-5 py-3 text-xs sm:px-6">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Latest</span>
        <span className="min-w-0 flex-1 truncate font-medium">{news[0].headline}</span>
        <button
          type="button"
          onClick={onShowAll}
          className="shrink-0 font-semibold text-blue-600 hover:underline dark:text-blue-400"
        >
          {Math.min(Math.max(news.length - 1, 0), 3)} more →
        </button>
      </section>
    );
  }

  return (
    <section className={mode === 'full' ? '' : 'mt-6 space-y-2 py-2'}>
      {mode === 'full' && (
        <div className="flex items-center gap-4 border-b bg-muted/20 px-5 py-3 sm:px-6">
          <button type="button" onClick={onBack} className="text-xs font-semibold hover:underline">
            ← Overview
          </button>
          <span className="text-sm font-semibold">Recent News</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{news.length}</span>
        </div>
      )}
      {mode !== 'full' && (
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
        Recent News
        {isTeamNews && (
          <span className="ml-1 font-normal text-gray-500 dark:text-gray-400">
            ({player.team.toUpperCase()} team news)
          </span>
        )}
      </h3>
      )}

      {isLoading && canFetch && enabled ? (
        <p className="py-2 text-sm text-gray-500 dark:text-gray-400">Loading…</p>
      ) : isError ? (
        <p className="py-2 text-sm text-gray-500 dark:text-gray-400">
          News unavailable right now.
        </p>
      ) : news.length === 0 ? (
        <p className="py-2 text-sm text-gray-500 dark:text-gray-400">No recent news.</p>
      ) : (
        <div className={mode === 'full' ? 'divide-y' : 'divide-y rounded-md border'}>
          {news.slice(0, 8).map((item, index) => {
            const publishedAt = relativePublishedAt(item.publishedAt);
            const headline = item.url ? (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-gray-900 hover:underline dark:text-gray-100"
              >
                {item.headline}
              </a>
            ) : (
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {item.headline}
              </span>
            );

            return (
              <article key={`${item.url ?? item.headline}-${index}`} className="space-y-1 px-5 py-4 sm:px-6">
                <div className="flex items-start gap-2 text-sm">
                  <div className="min-w-0 flex-1">{headline}</div>
                  {item.premium && <Badge variant="secondary">ESPN+</Badge>}
                </div>
                {publishedAt && (
                  <div className="text-xs text-gray-400 dark:text-gray-500">
                    {publishedAt}
                  </div>
                )}
                {item.description && (
                  <p className="line-clamp-2 text-xs text-gray-500 dark:text-gray-400">
                    {item.description}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
