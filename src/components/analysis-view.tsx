'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTheme } from 'next-themes';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import { ChevronDown, ChevronRight, LineChart as LineChartIcon, SlidersHorizontal } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { PageContainer } from '@/components/page-container';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { PositionBadge } from '@/components/position-badge';
import { cn } from '@/lib/utils';
import { getPositionBadgeClasses, getPositionSelectedBadgeClasses } from '@/lib/position-colors';
import { useHistoricalValues } from '@/hooks/use-history';
import { computeRollingMedian } from '@/lib/estimated-value';
import type { HistoricalValue } from '@/server/types/history';
import { useAllPlayers } from '@/hooks/use-players';
import { useIsSnakeLeague } from '@/hooks/use-league';
import { playerFromHistoricalValue } from '@/lib/player-detail';
import { PlayerNameButton } from '@/components/player-name-button';
import type { Player } from '@/server/types/player';

const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] as const;
type AnalysisPosition = (typeof POSITIONS)[number];

function isAnalysisPosition(position: string): position is AnalysisPosition {
  return (POSITIONS as readonly string[]).includes(position);
}

type ShapeKind = 'circle' | 'square' | 'triangle' | 'diamond' | 'cross' | 'ring';

// Categorical palette for the scatter dots/median lines, matching the app's
// position-color convention in src/lib/position-colors.ts (QB=yellow, RB=green,
// WR=purple, TE=red, K=blue, DST=orange), tuned per-mode for the chart surfaces.
// Validated with the dataviz skill's all-pairs check:
//   node scripts/validate_palette.js "#eda100,#008300,#9333ea,#e34948,#2a78d6,#eb6834" --mode light --pairs all
//   node scripts/validate_palette.js "#c98500,#008300,#a855f7,#e66767,#3987e5,#d95926" --mode dark --pairs all
// -> PASS lightness band, chroma floor, contrast (QB yellow under 3:1 on light is
// relieved by the table view); CVD separation WARNs in the 8-12 floor band (K blue
// vs WR purple is the closest pair) — legal only with secondary encoding, covered
// here by a distinct marker *shape* per position (composite hue x shape encoding)
// plus the always-on legend and tooltip text. Do not use Tailwind purple-400 for
// dark: it FAILs the lightness band and collapses with K's blue under protanopia.
const POSITION_STYLE: Record<AnalysisPosition, { light: string; dark: string; shape: ShapeKind }> = {
  QB: { light: '#eda100', dark: '#c98500', shape: 'circle' },
  RB: { light: '#008300', dark: '#008300', shape: 'square' },
  WR: { light: '#9333ea', dark: '#a855f7', shape: 'triangle' },
  TE: { light: '#e34948', dark: '#e66767', shape: 'diamond' },
  K: { light: '#2a78d6', dark: '#3987e5', shape: 'cross' },
  DST: { light: '#eb6834', dark: '#d95926', shape: 'ring' },
};

// Chart surfaces the palette above was validated against (references/palette.md).
const SURFACE = { light: '#fcfcfb', dark: '#1a1a19' };
const GRID = { light: '#e1e0d9', dark: '#2c2c2a' };
const INK_MUTED = '#898781';

interface ScatterPoint {
  x: number;
  y: number;
  name: string;
  year: number;
  rank: number;
  position_rank: number;
  source: HistoricalValue['source'];
  position: AnalysisPosition;
  player: Player;
}

interface CurvePoint {
  x: number;
  median: number;
  compCount: number;
  position: AnalysisPosition;
  scope?: 'overall';
}

interface YearCurvePoint extends CurvePoint {
  year: number;
}

const YEAR_LINE_STYLES = [
  { dash: undefined, opacity: 1 },
  { dash: '8 4', opacity: 0.88 },
  { dash: '3 3', opacity: 0.78 },
  { dash: '10 3 2 3', opacity: 0.68 },
  { dash: '2 5', opacity: 0.58 },
] as const;

// A ~9px visible mark plus a 24px transparent hit circle — per the dataviz
// skill's interaction guidance, an 8px dot is a pinpoint nobody can reliably
// hover or click, so the hit target must be larger than the painted pixels.
function PointMark({ shape, color, surface }: { shape: ShapeKind; color: string; surface: string }) {
  const r = 4.5;
  switch (shape) {
    case 'circle':
      return <circle r={r} fill={color} stroke={surface} strokeWidth={1.25} />;
    case 'square':
      return <rect x={-r} y={-r} width={r * 2} height={r * 2} fill={color} stroke={surface} strokeWidth={1.25} />;
    case 'triangle': {
      const h = r * 1.2;
      return <polygon points={`0,${-h} ${h},${h} ${-h},${h}`} fill={color} stroke={surface} strokeWidth={1.25} />;
    }
    case 'diamond': {
      const d = r * 1.3;
      return <polygon points={`0,${-d} ${d},0 0,${d} ${-d},0`} fill={color} stroke={surface} strokeWidth={1.25} />;
    }
    case 'cross':
      return (
        <g stroke={color} strokeWidth={2} strokeLinecap="round">
          <line x1={-r} y1={-r} x2={r} y2={r} />
          <line x1={-r} y1={r} x2={r} y2={-r} />
        </g>
      );
    case 'ring':
      return <circle r={r} fill="none" stroke={color} strokeWidth={2} />;
  }
}

function makeScatterShape(shape: ShapeKind, color: string, surface: string) {
  function ScatterShape(props: { cx?: number; cy?: number }) {
    const { cx = 0, cy = 0 } = props;
    return (
      <g transform={`translate(${cx}, ${cy})`}>
        <circle r={12} fill="transparent" />
        <PointMark shape={shape} color={color} surface={surface} />
      </g>
    );
  }
  return ScatterShape;
}

function ChartTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload as ScatterPoint | CurvePoint;

  if ('median' in point) {
    return (
      <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md text-popover-foreground">
        <div className="font-semibold flex items-center gap-1.5">
          {point.scope === 'overall' ? (
            'Overall rolling median'
          ) : (
            <>
              <PositionBadge position={point.position} className="px-1.5 py-0 text-[10px]" />
              rolling median
            </>
          )}
        </div>
        <div className="mt-1 font-semibold tabular-nums">
          ${point.median}{' '}
          <span className="font-normal text-muted-foreground">
            ({point.compCount} comp{point.compCount === 1 ? '' : 's'})
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md text-popover-foreground space-y-1 min-w-40">
      <div className="flex items-center justify-between gap-2">
        <PlayerNameButton player={point.player} className="font-semibold text-sm" />
        <PositionBadge position={point.position} className="px-1.5 py-0 text-[10px]" />
      </div>
      <div className="font-semibold tabular-nums text-sm">${point.y}</div>
      <div className="text-muted-foreground">
        {point.year} &middot; Rank {point.rank} &middot; Pos rank {point.position_rank}
      </div>
      <div className="text-muted-foreground">
        {point.source === 'official' ? 'Official draft price' : 'Imported historical value'}
      </div>
    </div>
  );
}

function PositionYearTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload as YearCurvePoint | ScatterPoint;

  if (!('median' in point)) {
    return (
      <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md text-popover-foreground space-y-1">
        <div className="font-semibold flex items-center gap-1.5">
          <PositionBadge position={point.position} className="px-1.5 py-0 text-[10px]" />
          <PlayerNameButton player={point.player} className="font-semibold" />
        </div>
        <div className="font-semibold tabular-nums">${point.y}</div>
        <div className="text-muted-foreground">{point.year} &middot; Pos rank {point.position_rank}</div>
      </div>
    );
  }

  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md text-popover-foreground">
      <div className="font-semibold flex items-center gap-1.5">
        <PositionBadge position={point.position} className="px-1.5 py-0 text-[10px]" />
        {point.year} median
      </div>
      <div className="mt-1 font-semibold tabular-nums">
        Rank {point.x}: ${point.median}{' '}
        <span className="font-normal text-muted-foreground">
          ({point.compCount} comp{point.compCount === 1 ? '' : 's'})
        </span>
      </div>
    </div>
  );
}

function toggleInSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

export function AnalysisView() {
  const { data: historicalValues = [], isLoading, error } = useHistoricalValues();
  const { data: currentPlayers = [] } = useAllPlayers();
  const { resolvedTheme } = useTheme();
  // Price-vs-rank charts are auction history — a snake league has none.
  const isSnakeLeague = useIsSnakeLeague();

  // Avoid a light/dark flash from an SSR/hydration mismatch — resolvedTheme is
  // undefined until next-themes mounts client-side.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const mode: 'light' | 'dark' = mounted && resolvedTheme === 'dark' ? 'dark' : 'light';

  // Empty set == "no filter, show everything" (same idiom as the players-table
  // position filter): toggling a chip narrows to just the toggled values.
  const [selectedYears, setSelectedYears] = useState<Set<number>>(new Set());
  const [selectedPositions, setSelectedPositions] = useState<Set<AnalysisPosition>>(new Set());
  const [showTable, setShowTable] = useState(false);
  const [isFilterSheetOpen, setIsFilterSheetOpen] = useState(false);
  const activeFilterCount = selectedYears.size + selectedPositions.size;

  const availableYears = useMemo(
    () => [...new Set(historicalValues.map(row => row.year))].sort((a, b) => b - a),
    [historicalValues]
  );

  const filteredRows = useMemo(() => {
    return historicalValues.filter(row => {
      // This view charts actual historical prices, not the live estimate — the
      // synthesized $0 'undrafted' rows that feed Target Price would otherwise
      // read as real (and very cheap) auction results.
      if (row.source === 'undrafted') return false;
      if (!isAnalysisPosition(row.position)) return false;
      if (selectedYears.size > 0 && !selectedYears.has(row.year)) return false;
      if (selectedPositions.size > 0 && !selectedPositions.has(row.position)) return false;
      return true;
    });
  }, [historicalValues, selectedYears, selectedPositions]);

  const overallSeriesByPosition = useMemo(() => {
    return POSITIONS.map(position => {
      const rows = filteredRows.filter(row => row.position === position && row.rank > 0);
      const points: ScatterPoint[] = rows.map(row => ({
        x: row.rank,
        y: row.price,
        name: row.name,
        year: row.year,
        rank: row.rank,
        position_rank: row.position_rank,
        source: row.source,
        position,
        player: playerFromHistoricalValue(row, currentPlayers),
      }));
      return { position, points };
    }).filter(series => series.points.length > 0);
  }, [filteredRows, currentPlayers]);

  const overallMedian = useMemo<CurvePoint[]>(() => {
    const rows = filteredRows.filter(row => row.rank > 0);
    return computeRollingMedian(rows.map(row => ({ x: row.rank, price: row.price })))
      .map(point => ({ ...point, position: 'RB', scope: 'overall' }));
  }, [filteredRows]);

  const overallPriceMedian = useMemo(() => {
    const prices = filteredRows.filter(row => row.rank > 0).map(row => row.price).sort((a, b) => a - b);
    if (prices.length === 0) return null;
    const middle = Math.floor(prices.length / 2);
    return prices.length % 2 === 1
      ? prices[middle]
      : Math.round((prices[middle - 1] + prices[middle]) / 2);
  }, [filteredRows]);

  const positionalSeries = useMemo(() => {
    return POSITIONS.map(position => {
      const rows = filteredRows.filter(row => row.position === position && row.position_rank > 0);
      const years = availableYears
        .filter(year => selectedYears.size === 0 || selectedYears.has(year))
        .map(year => {
          const yearRows = rows.filter(row => row.year === year);
          const points: ScatterPoint[] = yearRows.map(row => ({
            x: row.position_rank,
            y: row.price,
            name: row.name,
            year: row.year,
            rank: row.rank,
            position_rank: row.position_rank,
            source: row.source,
            position,
            player: playerFromHistoricalValue(row, currentPlayers),
          }));
          const curve: YearCurvePoint[] = computeRollingMedian(
            yearRows.map(row => ({ x: row.position_rank, price: row.price }))
          ).map(point => ({ ...point, position, year }));
          return { year, curve, points, count: yearRows.length };
        })
        .filter(series => series.count > 0);
      return { position, years };
    }).filter(series => series.years.length > 0);
  }, [availableYears, filteredRows, selectedYears, currentPlayers]);

  if (error) {
    return (
      <PageContainer>
        <PageHeader title="Analysis" className="mb-6" />
        <p className="text-red-600 dark:text-red-400">Failed to load historical values.</p>
      </PageContainer>
    );
  }

  // Shared between the inline desktop row and the mobile filter sheet below —
  // same Year/Position controls, rendered twice via CSS visibility rather
  // than as a component with props neither call site would otherwise need.
  const filterControls = (
    <>
      <div className="space-y-1.5">
        <div className="text-xs font-medium text-muted-foreground">Year</div>
        <div className="flex flex-wrap gap-2">
          {availableYears.map(year => {
            const isSelected = selectedYears.size === 0 || selectedYears.has(year);
            return (
              <Badge
                key={year}
                variant="outline"
                onClick={() => setSelectedYears(prev => toggleInSet(prev, year))}
                className={cn(
                  'cursor-pointer select-none font-semibold transition-none',
                  'max-md:min-h-11 max-md:px-3.5 max-md:text-sm',
                  isSelected
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'opacity-50 hover:opacity-80'
                )}
              >
                {year}
              </Badge>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-xs font-medium text-muted-foreground">Position</div>
        <div className="flex flex-wrap gap-2">
          {/* Same badge treatment as the players table's PositionFilter (which
              can't be reused as-is: it hardcodes a Flex pill this view has no
              series for), so the two filter sheets read as one control. */}
          {POSITIONS.map(position => {
            const isSelected = selectedPositions.size === 0 || selectedPositions.has(position);
            return (
              <Badge
                key={position}
                variant="outline"
                onClick={() => setSelectedPositions(prev => toggleInSet(prev, position))}
                className={cn(
                  isSelected
                    ? getPositionSelectedBadgeClasses(position)
                    : getPositionBadgeClasses(position),
                  'cursor-pointer select-none font-semibold transition-none',
                  'max-md:min-h-11 max-md:px-4 max-md:text-sm',
                  !isSelected && 'opacity-40 hover:opacity-70'
                )}
              >
                {position}
              </Badge>
            );
          })}
        </div>
      </div>
    </>
  );

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Analysis"
        description={(
          <>
            Auction price vs. draft rank across your official drafts and imported history —
            the history behind Target Price in each player&apos;s detail modal.
          </>
        )}
      />

      {isSnakeLeague ? (
        <Card>
          <CardContent className="py-12 text-center space-y-2">
            <LineChartIcon className="h-8 w-8 mx-auto text-muted-foreground" />
            <p className="font-medium">No auction analysis for snake leagues.</p>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              This view charts historical auction prices, which do not exist in a
              snake draft. Tier cliffs on the players table carry over unchanged.
            </p>
          </CardContent>
        </Card>
      ) : isLoading ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Loading historical values...
          </CardContent>
        </Card>
      ) : historicalValues.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-2">
            <LineChartIcon className="h-8 w-8 mx-auto text-muted-foreground" />
            <p className="font-medium">No historical auction data yet.</p>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              This view charts prices from your completed official drafts, plus any imported
              historical values. Complete an official auction or import auction-value history
              from the Import view to see it here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Below md, Year + Position move into a bottom sheet — sixteen 44px
              badges otherwise ate most of the screen before any chart. */}
          <Sheet open={isFilterSheetOpen} onOpenChange={setIsFilterSheetOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" className="h-11 shrink-0 gap-2 md:hidden">
                <SlidersHorizontal className="h-4 w-4" />
                Filters
                {activeFilterCount > 0 && (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1 text-[11px] font-bold text-white">
                    {activeFilterCount}
                  </span>
                )}
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" className="gap-0">
              <SheetHeader>
                <SheetTitle>Filters</SheetTitle>
              </SheetHeader>
              <div className="flex flex-col gap-4 px-4 pb-4">
                {filterControls}
                {activeFilterCount > 0 && (
                  <Button
                    variant="ghost"
                    className="h-11"
                    onClick={() => {
                      setSelectedYears(new Set());
                      setSelectedPositions(new Set());
                    }}
                  >
                    Clear filters
                  </Button>
                )}
              </div>
            </SheetContent>
          </Sheet>

          {/* Filter row — standard HTML controls, one row above everything they scope. */}
          <div className="max-md:hidden flex flex-wrap items-start gap-6">
            {filterControls}
          </div>

          <Card>
            <CardHeader className="max-md:px-4">
              <CardTitle>Overall rank pricing trend</CardTitle>
              <CardDescription>
                Every historical auction price mapped to overall rank. The solid curve is the
                cross-position rolling median (&plusmn;2 ranks, widening to &plusmn;4 under 3 comps);
                the horizontal dashed line is the median price of the visible data.
              </CardDescription>
            </CardHeader>
            <CardContent className="max-md:px-4">
              {/* Legend — always present for 2+ series; color + shape carry identity. */}
              <div className="flex flex-wrap gap-x-4 gap-y-2 mb-4 text-sm">
                {overallSeriesByPosition.map(({ position }) => {
                  const style = POSITION_STYLE[position];
                  return (
                    <div key={position} className="flex items-center gap-1.5">
                      <svg width={14} height={14} viewBox="-7 -7 14 14" aria-hidden="true">
                        <PointMark shape={style.shape} color={style[mode]} surface={SURFACE[mode]} />
                      </svg>
                      <span className="text-foreground">{position}</span>
                    </div>
                  );
                })}
                <div className="flex items-center gap-1.5">
                  <span className="w-5 border-t-2 border-foreground" aria-hidden="true" />
                  <span className="text-foreground">Rolling median</span>
                </div>
                {overallPriceMedian != null && (
                  <div className="flex items-center gap-1.5">
                    <span className="w-5 border-t-2 border-dashed border-muted-foreground" aria-hidden="true" />
                    <span className="text-foreground">Visible median ${overallPriceMedian}</span>
                  </div>
                )}
              </div>

              <div
                className="h-[280px] w-full md:h-[420px]"
                role="img"
                aria-label={`Historical auction prices by overall player rank with ${filteredRows.filter(row => row.rank > 0).length} observations and a rolling median trend.`}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                    <CartesianGrid stroke={GRID[mode]} strokeDasharray="0" vertical={false} />
                    <XAxis
                      type="number"
                      dataKey="x"
                      name="Overall rank"
                      tick={{ fill: INK_MUTED, fontSize: 12 }}
                      stroke={GRID[mode]}
                      label={{ value: 'Overall rank', position: 'insideBottom', offset: -4, fill: INK_MUTED, fontSize: 12 }}
                    />
                    <YAxis
                      type="number"
                      dataKey="y"
                      name="Price"
                      tick={{ fill: INK_MUTED, fontSize: 12 }}
                      stroke={GRID[mode]}
                      tickFormatter={value => `$${value}`}
                      width={48}
                    />
                    <Tooltip
                      content={ChartTooltip}
                      cursor={{ stroke: GRID[mode] }}
                      wrapperStyle={{ pointerEvents: 'auto' }}
                    />
                    {overallPriceMedian != null && (
                      <ReferenceLine
                        y={overallPriceMedian}
                        stroke={INK_MUTED}
                        strokeDasharray="6 4"
                        label={{ value: `$${overallPriceMedian}`, position: 'insideTopRight', fill: INK_MUTED, fontSize: 12 }}
                      />
                    )}
                    <Line
                      data={overallMedian}
                      dataKey="median"
                      stroke={mode === 'dark' ? '#f4f4f2' : '#242422'}
                      strokeWidth={2.5}
                      dot={false}
                      activeDot={{ r: 4 }}
                      isAnimationActive={false}
                      legendType="none"
                      connectNulls
                    />
                    {overallSeriesByPosition.map(({ position, points }) => (
                      <Scatter
                        key={position}
                        data={points}
                        dataKey="y"
                        fill={POSITION_STYLE[position][mode]}
                        shape={makeScatterShape(POSITION_STYLE[position].shape, POSITION_STYLE[position][mode], SURFACE[mode])}
                        isAnimationActive={false}
                      />
                    ))}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="max-md:px-4">
              <CardTitle>Position-rank pricing by year</CardTitle>
              <CardDescription>
                Each panel compares rolling median prices at the same position rank across
                seasons while retaining every observed price. Line styles run newest to oldest;
                hover a point or curve for player, year, median, and comp details.
              </CardDescription>
            </CardHeader>
            <CardContent className="max-md:px-4">
              <div className="grid gap-6 lg:grid-cols-2">
                {positionalSeries.map(({ position, years }) => (
                  <section key={position} className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <PositionBadge position={position} />
                      <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {years.map(({ year }, index) => {
                          const lineStyle = YEAR_LINE_STYLES[index % YEAR_LINE_STYLES.length];
                          return (
                            <span key={year} className="flex items-center gap-1.5">
                              <svg width="20" height="6" aria-hidden="true">
                                <line
                                  x1="0"
                                  y1="3"
                                  x2="20"
                                  y2="3"
                                  stroke={POSITION_STYLE[position][mode]}
                                  strokeWidth="2"
                                  strokeDasharray={lineStyle.dash}
                                  opacity={lineStyle.opacity}
                                />
                              </svg>
                              {year}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                    <div
                      className="h-[220px] w-full md:h-[260px]"
                      role="img"
                      aria-label={`${position} auction price rolling medians by position rank for ${years.map(series => series.year).join(', ')}.`}
                    >
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                          <CartesianGrid stroke={GRID[mode]} vertical={false} />
                          <XAxis
                            type="number"
                            dataKey="x"
                            name="Position rank"
                            allowDecimals={false}
                            tick={{ fill: INK_MUTED, fontSize: 11 }}
                            stroke={GRID[mode]}
                            label={{ value: 'Position rank', position: 'insideBottom', offset: -4, fill: INK_MUTED, fontSize: 11 }}
                          />
                          <YAxis
                            type="number"
                            dataKey="median"
                            name="Median price"
                            tick={{ fill: INK_MUTED, fontSize: 11 }}
                            stroke={GRID[mode]}
                            tickFormatter={value => `$${value}`}
                            width={44}
                          />
                          <Tooltip
                            content={PositionYearTooltip}
                            cursor={{ stroke: GRID[mode] }}
                            wrapperStyle={{ pointerEvents: 'auto' }}
                          />
                          {years.map(({ year, curve }, index) => {
                            const lineStyle = YEAR_LINE_STYLES[index % YEAR_LINE_STYLES.length];
                            return (
                              <Line
                                key={year}
                                data={curve}
                                dataKey="median"
                                stroke={POSITION_STYLE[position][mode]}
                                strokeOpacity={lineStyle.opacity}
                                strokeWidth={2}
                                strokeDasharray={lineStyle.dash}
                                dot={false}
                                activeDot={{ r: 4 }}
                                isAnimationActive={false}
                                connectNulls
                              />
                            );
                          })}
                          {years.map(({ year, points }, index) => {
                            const lineStyle = YEAR_LINE_STYLES[index % YEAR_LINE_STYLES.length];
                            return (
                              <Scatter
                                key={`${year}-points`}
                                data={points}
                                dataKey="y"
                                fill={POSITION_STYLE[position][mode]}
                                fillOpacity={lineStyle.opacity * 0.72}
                                shape={makeScatterShape(POSITION_STYLE[position].shape, POSITION_STYLE[position][mode], SURFACE[mode])}
                                isAnimationActive={false}
                              />
                            );
                          })}
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  </section>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Table-view twin — the WCAG-clean equivalent, and the relief channel for
              the two dot colors that sit under 3:1 contrast on a light surface. */}
          <Card>
            <CardHeader
              className="cursor-pointer select-none max-md:px-4"
              onClick={() => setShowTable(prev => !prev)}
            >
              <CardTitle className="flex items-center gap-1.5 text-base">
                {showTable ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                Table view
              </CardTitle>
              <CardDescription>
                The same {filteredRows.length} data point{filteredRows.length === 1 ? '' : 's'} plotted above.
              </CardDescription>
            </CardHeader>
            {showTable && (
              <CardContent className="max-md:px-4">
                <div className="rounded-md border max-h-96 overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-card">
                      <TableRow>
                        <TableHead>Player</TableHead>
                        <TableHead>Position</TableHead>
                        <TableHead>Year</TableHead>
                        <TableHead className="text-right max-md:hidden">Rank</TableHead>
                        <TableHead className="text-right max-md:hidden">Pos rank</TableHead>
                        <TableHead className="text-right">Price</TableHead>
                        <TableHead className="max-md:hidden">Source</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...filteredRows]
                        .sort((a, b) => b.price - a.price)
                        .map(row => (
                          <TableRow key={`${row.player_id}-${row.year}`}>
                            <TableCell className="font-medium">
                              <PlayerNameButton player={playerFromHistoricalValue(row, currentPlayers)} />
                            </TableCell>
                            <TableCell>
                              <PositionBadge position={row.position} />
                            </TableCell>
                            <TableCell>{row.year}</TableCell>
                            <TableCell className="text-right tabular-nums max-md:hidden">{row.rank}</TableCell>
                            <TableCell className="text-right tabular-nums max-md:hidden">{row.position_rank}</TableCell>
                            <TableCell className="text-right tabular-nums font-medium">${row.price}</TableCell>
                            <TableCell className="text-muted-foreground text-sm max-md:hidden">
                              {row.source === 'official' ? 'Official' : 'Imported'}
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            )}
          </Card>
        </>
      )}
    </PageContainer>
  );
}
