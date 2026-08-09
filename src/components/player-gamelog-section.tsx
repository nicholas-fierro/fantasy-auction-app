'use client';

import { useEffect, useMemo, useState } from 'react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { Player } from '@/server/types/player';
import { usePlayerGameLogs } from '@/hooks/use-player-game-logs';
import { usePlayerSeasons } from '@/hooks/use-players';
import { useLeague } from '@/hooks/use-league';
import { useAuction } from '@/contexts/auction-context';
import { SCORING_FORMAT_LABELS, type GameLogStats, type ScoringFormat } from '@/lib/fantasy-scoring';
import {
  buildSeasonView,
  defaultSeason,
  seasonsWithLogs,
  statPagesForSeason,
  type StatPage,
  type WeekRow,
} from '@/lib/game-log-view';

interface PlayerGameLogSectionProps {
  player: Player;
  enabled?: boolean;
  /** 'chart' is the modal's summary card; 'table' is the drilled-in box score. */
  mode?: 'chart' | 'table';
  // Season and format are owned by the modal so drilling into the table and
  // coming back keeps whatever the user had selected on the chart. Null means
  // "not chosen yet" — resolved to the league/auction defaults below.
  season?: number | null;
  format?: ScoringFormat | null;
  onSeasonChange?: (season: number) => void;
  onFormatChange?: (format: ScoringFormat) => void;
  onShowTable?: () => void;
  onBack?: () => void;
}

const STAT_PAGE_LABELS: Record<StatPage, string> = {
  passing: 'Passing',
  rushing: 'Rushing',
  receiving: 'Receiving',
  kicking: 'Kicking',
};

const SCORING_FORMATS: ScoringFormat[] = ['std', 'half', 'ppr'];

function num(stats: GameLogStats, key: string): number {
  const value = stats[key];
  return typeof value === 'number' ? value : 0;
}

const sum = (rows: readonly WeekRow[], key: string) =>
  rows.reduce((total, row) => total + num(row.stats, key), 0);

/** Per-attempt averages are blank rather than 0 when nothing was attempted. */
function ratio(numerator: number, denominator: number): string {
  return denominator > 0 ? (numerator / denominator).toFixed(1) : '—';
}

const pointsColumn: Column = {
  label: 'Pts',
  accent: true,
  cell: (row) => row.points.toFixed(1),
  total: (rows) => rows.reduce((total, row) => total + row.points, 0).toFixed(1),
};

interface Column {
  label: string;
  /** Rendered right-aligned with tabular figures; all stat columns are numeric. */
  cell: (row: WeekRow) => string;
  total: (rows: readonly WeekRow[]) => string;
  /** The points column carries the section's accent and extra weight. */
  accent?: boolean;
  /** Derived averages read as secondary information. */
  muted?: boolean;
}

const STAT_COLUMNS: Record<StatPage, Column[]> = {
  passing: [
    {
      label: 'C/A',
      cell: (row) => `${num(row.stats, 'completions')}/${num(row.stats, 'attempts')}`,
      total: (rows) => `${sum(rows, 'completions')}/${sum(rows, 'attempts')}`,
    },
    {
      label: 'Yds',
      cell: (row) => String(num(row.stats, 'passing_yards')),
      total: (rows) => String(sum(rows, 'passing_yards')),
    },
    {
      label: 'TD',
      cell: (row) => String(num(row.stats, 'passing_tds')),
      total: (rows) => String(sum(rows, 'passing_tds')),
    },
    {
      label: 'INT',
      cell: (row) => String(num(row.stats, 'passing_interceptions')),
      total: (rows) => String(sum(rows, 'passing_interceptions')),
    },
    {
      label: 'Sck',
      cell: (row) => String(num(row.stats, 'sacks_suffered')),
      total: (rows) => String(sum(rows, 'sacks_suffered')),
    },
    pointsColumn,
  ],
  rushing: [
    {
      label: 'Att',
      cell: (row) => String(num(row.stats, 'carries')),
      total: (rows) => String(sum(rows, 'carries')),
    },
    {
      label: 'Yds',
      cell: (row) => String(num(row.stats, 'rushing_yards')),
      total: (rows) => String(sum(rows, 'rushing_yards')),
    },
    {
      label: 'Y/A',
      muted: true,
      cell: (row) => ratio(num(row.stats, 'rushing_yards'), num(row.stats, 'carries')),
      total: (rows) => ratio(sum(rows, 'rushing_yards'), sum(rows, 'carries')),
    },
    // The design omits rushing TDs — an artifact of its sample WR never scoring
    // on the ground. They are not optional.
    {
      label: 'TD',
      cell: (row) => String(num(row.stats, 'rushing_tds')),
      total: (rows) => String(sum(rows, 'rushing_tds')),
    },
    {
      label: 'Fum',
      cell: (row) => String(num(row.stats, 'rushing_fumbles_lost')),
      total: (rows) => String(sum(rows, 'rushing_fumbles_lost')),
    },
    pointsColumn,
  ],
  receiving: [
    {
      label: 'Tgt',
      cell: (row) => String(num(row.stats, 'targets')),
      total: (rows) => String(sum(rows, 'targets')),
    },
    {
      label: 'Rec',
      cell: (row) => String(num(row.stats, 'receptions')),
      total: (rows) => String(sum(rows, 'receptions')),
    },
    {
      label: 'Yds',
      cell: (row) => String(num(row.stats, 'receiving_yards')),
      total: (rows) => String(sum(rows, 'receiving_yards')),
    },
    {
      label: 'Y/R',
      muted: true,
      cell: (row) => ratio(num(row.stats, 'receiving_yards'), num(row.stats, 'receptions')),
      total: (rows) => ratio(sum(rows, 'receiving_yards'), sum(rows, 'receptions')),
    },
    {
      label: 'TD',
      cell: (row) => String(num(row.stats, 'receiving_tds')),
      total: (rows) => String(sum(rows, 'receiving_tds')),
    },
    pointsColumn,
  ],
  kicking: [
    {
      label: 'FG',
      cell: (row) => `${num(row.stats, 'fg_made')}/${num(row.stats, 'fg_att')}`,
      total: (rows) => `${sum(rows, 'fg_made')}/${sum(rows, 'fg_att')}`,
    },
    {
      label: 'Long',
      muted: true,
      cell: (row) => (num(row.stats, 'fg_long') > 0 ? String(num(row.stats, 'fg_long')) : '—'),
      // Season long is a maximum, not a sum.
      total: (rows) => {
        const long = Math.max(0, ...rows.map((row) => num(row.stats, 'fg_long')));
        return long > 0 ? String(long) : '—';
      },
    },
    {
      label: 'PAT',
      cell: (row) => `${num(row.stats, 'pat_made')}/${num(row.stats, 'pat_att')}`,
      total: (rows) => `${sum(rows, 'pat_made')}/${sum(rows, 'pat_att')}`,
    },
    pointsColumn,
  ],
};

/** Segmented control matching the design's pill toggles. */
function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
  labels,
  ariaLabel,
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  labels: Record<T, string>;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex gap-0.5 rounded-lg bg-muted p-0.5">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={option === value}
          className={cn(
            'rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors max-md:min-h-9 max-md:px-3',
            option === value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  );
}

function WeeklyPointsChart({
  rows,
  post,
  median,
  maxPoints,
}: {
  rows: readonly WeekRow[];
  post: readonly WeekRow[];
  median: number | null;
  maxPoints: number;
}) {
  // Guard the y-scale: a season of nothing but zeroes would divide by zero.
  const scale = maxPoints > 0 ? maxPoints : 1;
  // Bars stop short of the full height so the per-week points label above the
  // tallest one still fits inside the row. The median line uses the same factor,
  // so line and bars stay on one scale.
  const BAR_MAX = 0.86;
  const fraction = (points: number) => Math.max(0, points / scale) * BAR_MAX;
  // Negative weeks (lost fumbles, interceptions) have no bar to draw — clamp
  // rather than letting a negative height invert the column.
  const heightOf = (points: number) => `${fraction(points) * 100}%`;

  const bar = (row: WeekRow, isPost: boolean) => {
    if (row.kind !== 'game') {
      return (
        <div
          key={row.key}
          className="flex h-full min-w-0 flex-1 flex-col justify-end"
          title={row.kind === 'bye' ? 'Bye week' : 'Did not play'}
        >
          <div className="border-t border-dashed border-border" />
        </div>
      );
    }
    return (
      <div
        key={row.key}
        // h-full is load bearing: the bar's height is a percentage, and in an
        // items-end row this wrapper would otherwise shrink to its content,
        // leaving the percentage nothing to resolve against.
        className="flex h-full min-w-0 flex-1 flex-col justify-end"
        title={`${isPost ? row.label : `Week ${row.label}`} ${row.opponent} · ${row.points.toFixed(1)} pts`}
      >
        <div className="hidden text-center text-[8px] leading-none text-muted-foreground md:block">
          {row.points >= 10 ? row.points.toFixed(0) : ''}
        </div>
        <div
          style={{ height: heightOf(row.points) }}
          className={cn(
            'mt-0.5 min-h-[2px] w-full rounded-t-sm',
            // Playoff bars share the y-scale but read as outside the season.
            isPost
              ? 'bg-violet-400/50 dark:bg-violet-400/40'
              : row.points >= 20
                ? 'bg-emerald-500'
                : row.points < 10
                  ? 'bg-red-400 dark:bg-red-500/80'
                  : 'bg-zinc-400 dark:bg-zinc-500',
          )}
        />
      </div>
    );
  };

  return (
    <div>
      <div className="relative">
        {median != null && maxPoints > 0 && (
          <div
            style={{ bottom: `${fraction(median) * 100}%` }}
            className="pointer-events-none absolute left-0 right-0 z-10 border-t border-dashed border-violet-400"
          >
            <span className="absolute right-0 top-[-13px] bg-background px-1 text-[9px] font-semibold text-violet-600 dark:text-violet-400">
              med {median.toFixed(1)}
            </span>
          </div>
        )}
        <div className="flex h-[72px] items-end gap-[2px] md:h-24 md:gap-[3px]">
          {rows.map((row) => bar(row, false))}
          {post.length > 0 && (
            <>
              {/* Visual break mirroring the table's postseason divider. */}
              <div className="mx-1 h-full w-px shrink-0 bg-border" />
              {post.map((row) => bar(row, true))}
            </>
          )}
        </div>
      </div>
      {/* Week labels live in their own row rather than inside each bar's column:
          content below the bar would compete with its percentage height. The
          spacer mirrors the chart's postseason divider so labels stay aligned. */}
      <div className="mt-1 hidden gap-[3px] md:flex">
        {rows.map((row) => (
          <div key={row.key} className="min-w-0 flex-1 text-center text-[8px] text-muted-foreground">
            {row.label}
          </div>
        ))}
        {post.length > 0 && (
          <>
            <div className="mx-1 w-px shrink-0" />
            {post.map((row) => (
              <div
                key={row.key}
                className="min-w-0 flex-1 text-center text-[8px] font-medium text-violet-600 dark:text-violet-400"
              >
                {row.label}
              </div>
            ))}
          </>
        )}
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-muted-foreground md:hidden">
        <span>Wk 1</span>
        <span>{post.length > 0 ? 'Postseason' : `Wk ${rows.length}`}</span>
      </div>
    </div>
  );
}

export function PlayerGameLogSection({
  player,
  enabled = true,
  mode = 'chart',
  season,
  format,
  onSeasonChange,
  onFormatChange,
  onShowTable,
  onBack,
}: PlayerGameLogSectionProps) {
  const { selectedYear } = useAuction();
  const { settings } = useLeague();
  const { data: logs = [], isLoading } = usePlayerGameLogs(player.id, enabled);
  const { data: seasons = [] } = usePlayerSeasons(player.id, enabled);

  const availableSeasons = useMemo(() => seasonsWithLogs(logs), [logs]);
  const [statPage, setStatPage] = useState<StatPage | null>(null);

  // Season and format are seeded from data/league config, which arrive after the
  // first render — hold null until then rather than guessing a value that would
  // flash and change.
  const activeSeason = season ?? defaultSeason(availableSeasons, selectedYear);
  const activeFormat = format ?? settings.scoringFormat;
  const isTable = mode === 'table';

  const seasonLogs = useMemo(
    () => logs.filter((log) => log.season === activeSeason),
    [logs, activeSeason],
  );
  const pages = useMemo(
    () => statPagesForSeason(player.position, seasonLogs),
    [player.position, seasonLogs],
  );
  const activePage = statPage && pages.includes(statPage) ? statPage : (pages[0] ?? null);

  // A season change can invalidate the chosen stat page (a back who caught passes
  // one year but not the next); fall back to that season's primary category.
  useEffect(() => {
    setStatPage(null);
  }, [activeSeason]);

  const byeWeek = useMemo(() => {
    const row = seasons.find((s) => s.year === activeSeason);
    return row?.bye_week && row.bye_week > 0 ? row.bye_week : null;
  }, [seasons, activeSeason]);

  const view = useMemo(
    () =>
      activeSeason == null
        ? null
        : buildSeasonView(logs, activeSeason, byeWeek, activeFormat),
    [logs, activeSeason, byeWeek, activeFormat],
  );

  // The chart is a card in the middle of the overview, so it keeps its divider;
  // the table owns the whole drilled-in view and needs none.
  const shell = isTable ? 'px-5 py-3 sm:px-6' : 'border-b px-5 py-3 sm:px-6';

  if (isLoading) {
    return (
      <section className={shell}>
        <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
      </section>
    );
  }

  // The chart sits in the default view, so an absence has to say so — returning
  // null would silently drop the section. Hits players with no imported logs and
  // positions the import doesn't cover (DST has no team-defense rows).
  if (activeSeason == null || view == null || activePage == null) {
    return (
      <section className={shell}>
        <p className="py-10 text-center text-sm text-muted-foreground">
          No game log data for {player.name}.
        </p>
      </section>
    );
  }

  const columns = STAT_COLUMNS[activePage];
  const playedRegular = view.regular.filter((row) => row.kind === 'game');
  const stickyCell = 'sticky left-0 z-10 bg-background';
  // TableCell's default p-2 costs 16px per column; across eight columns that
  // alone pushed the Pts column off a 375px screen, so the first thing the user
  // saw was the number that matters cut in half. Tighter below md lets the whole
  // line fit; the sticky Wk column and the container's overflow-x-auto still
  // cover anything narrower.
  const cellX = 'px-1 md:px-2';

  const statCells = (row: WeekRow) =>
    columns.map((column) => (
      <TableCell
        key={column.label}
        className={cn(
          'py-1.5 text-right tabular-nums',
          cellX,
          column.muted && 'text-muted-foreground',
          column.accent && 'font-semibold',
        )}
      >
        {column.cell(row)}
      </TableCell>
    ));

  const gameRow = (row: WeekRow) => (
    <TableRow key={row.key}>
      <TableCell className={cn('py-1.5 font-medium', cellX, stickyCell)}>{row.label}</TableCell>
      <TableCell className={cn('py-1.5 text-muted-foreground', cellX)}>
        {row.opponent || '—'}
      </TableCell>
      {row.kind === 'game' ? (
        statCells(row)
      ) : (
        <TableCell
          colSpan={columns.length}
          className={cn('py-1.5 italic text-muted-foreground', cellX)}
        >
          {row.kind === 'bye' ? 'Bye week' : 'Did not play'}
        </TableCell>
      )}
    </TableRow>
  );

  const totalsRow = (label: string, rows: readonly WeekRow[]) => (
    <TableRow className="bg-muted/50 font-semibold hover:bg-muted/50">
      {/* Own background, not the shared stickyCell: a translucent muted row would
          let the scrolling stat columns show through the pinned Wk cell. */}
      <TableCell className={cn('sticky left-0 z-10 bg-muted py-1.5', cellX)}>{label}</TableCell>
      <TableCell className={cn('py-1.5', cellX)} />
      {columns.map((column) => (
        <TableCell
          key={column.label}
          className={cn(
            'py-1.5 text-right tabular-nums',
            cellX,
            column.muted && 'text-muted-foreground',
          )}
        >
          {column.total(rows)}
        </TableCell>
      ))}
    </TableRow>
  );

  // Season and scoring controls ride along in both modes: the drilled-in table is
  // where you'd most want to re-cut the numbers.
  const controls = (
    <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor="gamelog-season">
        Season
      </label>
      <select
        id="gamelog-season"
        value={activeSeason}
        onChange={(event) => onSeasonChange?.(Number(event.target.value))}
        className="h-8 rounded-md bg-muted px-2 text-xs font-semibold text-foreground max-md:h-9"
      >
        {availableSeasons.map((year) => (
          <option key={year} value={year}>
            {year}
          </option>
        ))}
      </select>
      <SegmentedToggle
        ariaLabel="Scoring format"
        options={SCORING_FORMATS}
        value={activeFormat}
        onChange={(next) => onFormatChange?.(next)}
        labels={SCORING_FORMAT_LABELS}
      />
    </div>
  );

  const emptySeason = playedRegular.length === 0 && view.post.length === 0;

  if (!isTable) {
    return (
      <section className={shell}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Scoring by week</h3>
          {controls}
        </div>

        {emptySeason ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No gamelog data for {activeSeason}.
          </p>
        ) : (
          <>
            <WeeklyPointsChart
              rows={view.regular}
              post={view.post}
              median={view.median}
              maxPoints={view.maxPoints}
            />
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={onShowTable}
                className="text-xs font-semibold text-blue-600 hover:underline dark:text-blue-400"
              >
                Full game log →
              </button>
            </div>
          </>
        )}
      </section>
    );
  }

  return (
    <>
      <div className="flex items-center gap-4 border-b bg-muted/20 px-5 py-3 sm:px-6">
        <button type="button" onClick={onBack} className="text-xs font-semibold hover:underline">
          ← Overview
        </button>
        <span className="text-sm font-semibold">Game log</span>
      </div>
      <section className="px-5 py-3 sm:px-6">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          {pages.length > 1 ? (
            <SegmentedToggle
              ariaLabel="Stat category"
              options={pages}
              value={activePage}
              onChange={setStatPage}
              labels={STAT_PAGE_LABELS}
            />
          ) : (
            <span />
          )}
          {controls}
        </div>

        {emptySeason ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No gamelog data for {activeSeason}.
          </p>
        ) : (
          <div className="mt-2">
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead className={cn('h-8', cellX, stickyCell)}>Wk</TableHead>
                  <TableHead className={cn('h-8', cellX)}>Opp</TableHead>
                  {columns.map((column) => (
                    <TableHead
                      key={column.label}
                      className={cn(
                        'h-8 text-right',
                        cellX,
                        column.accent && 'font-semibold text-violet-600 dark:text-violet-400',
                      )}
                    >
                      {column.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.regular.map(gameRow)}
                {totalsRow('Totals', playedRegular)}
                {view.post.length > 0 && (
                  <>
                    <TableRow className="hover:bg-transparent">
                      <TableCell
                        colSpan={columns.length + 2}
                        className="bg-muted/30 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        Postseason · not counted in season totals
                      </TableCell>
                    </TableRow>
                    {view.post.map(gameRow)}
                    {totalsRow('Playoffs', view.post)}
                  </>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </>
  );
}
