'use client';

import { useMemo } from 'react';
import {
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Line,
  ComposedChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import type { CompDetail } from '@/lib/estimated-value';
import type { HistoricalValue } from '@/server/types/history';
import type { Player } from '@/server/types/player';
import { useAllPlayers } from '@/hooks/use-players';
import { playerFromHistoricalValue } from '@/lib/player-detail';
import { PlayerNameButton } from '@/components/player-name-button';

interface PlayerCompsDistributionProps {
  estimate: number;
  p25: number;
  p75: number;
  compCount: number;
  window: number;
  comps: CompDetail[];
  playerPosition: string;
  playerRank: number;
  playerPositionRank: number;
  compact?: boolean;
}

interface StripPoint {
  price: number;
  y: number;
  name: string;
  year: number;
  rank: number;
  positionRank: number;
  position: string;
  weight: number;
  match: 'position' | 'overall';
  source: HistoricalValue['source'];
  player: Player;
}

interface YearMedianPoint {
  year: number;
  price: number;
}

const POSITION_COLOR = '#2563eb';
const OVERALL_COLOR = '#f59e0b';
const MEDIAN_COLOR = '#7c3aed';

// Deterministic jitter so overlapping prices separate visually without the
// dots reshuffling on every render (no Math.random()).
function jitterFor(name: string, index: number): number {
  let hash = index;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const unit = (Math.abs(hash) % 1000) / 1000; // [0, 1)
  return 0.35 + unit * 0.3; // [0.35, 0.65]
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function StripTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload as StripPoint;
  return (
    <div className="rounded-md border bg-popover px-2.5 py-2 text-xs shadow-md text-popover-foreground">
      <PlayerNameButton player={point.player} className="font-semibold" />
      <div className="tabular-nums">${point.price} &middot; {point.year}</div>
      <div className="text-muted-foreground">
        Overall #{point.rank} &middot; {point.position}{point.positionRank}
      </div>
      {point.source === 'undrafted' && (
        <div className="text-muted-foreground">undrafted</div>
      )}
    </div>
  );
}

function YearTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload as YearMedianPoint;
  return (
    <div className="rounded-md border bg-popover px-2.5 py-2 text-xs shadow-md text-popover-foreground">
      <div className="font-semibold">{point.year} median</div>
      <div className="tabular-nums">${point.price}</div>
    </div>
  );
}

// Custom Scatter point renderer: shape by `match` (circle vs. diamond) and
// opacity by recency weight, so the two comp criteria read apart without
// relying on color alone.
function makeStripShape(maxWeight: number) {
  return function StripShape(props: unknown) {
    const { cx, cy, payload } = props as { cx: number; cy: number; payload: StripPoint };
    const opacity = 0.35 + 0.65 * (maxWeight > 0 ? payload.weight / maxWeight : 1);
    if (payload.match === 'overall') {
      const r = 5;
      const points = `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
      return <polygon points={points} fill={OVERALL_COLOR} fillOpacity={opacity} />;
    }
    return <circle cx={cx} cy={cy} r={4.5} fill={POSITION_COLOR} fillOpacity={opacity} />;
  };
}

export function PlayerCompsDistribution({
  estimate,
  p25,
  p75,
  compCount,
  window,
  comps,
  playerPosition,
  playerRank,
  playerPositionRank,
  compact = false,
}: PlayerCompsDistributionProps) {
  const { data: currentPlayers = [] } = useAllPlayers();
  const points = useMemo<StripPoint[]>(
    () =>
      comps.map((comp, i) => ({
        price: comp.row.price,
        y: jitterFor(comp.row.name, i),
        name: comp.row.name,
        year: comp.row.year,
        rank: comp.row.rank,
        positionRank: comp.row.position_rank,
        position: comp.row.position,
        weight: comp.weight,
        match: comp.match,
        source: comp.row.source,
        player: playerFromHistoricalValue(comp.row, currentPlayers),
      })),
    [comps, currentPlayers]
  );

  const maxWeight = useMemo(
    () => points.reduce((max, point) => Math.max(max, point.weight), 0),
    [points]
  );

  const priceDomain = useMemo<[number, number]>(() => {
    if (points.length === 0) return [0, 1];
    const prices = points.map(point => point.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const pad = Math.max(2, Math.round((max - min) * 0.1));
    return [Math.max(0, min - pad), max + pad];
  }, [points]);

  const yearMedians = useMemo<YearMedianPoint[]>(() => {
    const byYear = new Map<number, number[]>();
    for (const comp of comps) {
      const bucket = byYear.get(comp.row.year) ?? [];
      bucket.push(comp.row.price);
      byYear.set(comp.row.year, bucket);
    }
    return [...byYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, prices]) => ({ year, price: median(prices) }));
  }, [comps]);

  const showBand = compCount >= 4;
  const showTrend = yearMedians.length >= 2;
  const stripShape = useMemo(() => makeStripShape(maxWeight), [maxWeight]);

  return (
    <div className={compact ? '' : 'space-y-4'}>
      <div className={compact ? 'min-w-0 space-y-1' : 'min-w-0 space-y-2 rounded-md border p-3'}>
        <div>
          <div className={compact ? 'text-sm font-semibold text-foreground' : 'text-xs font-semibold text-foreground'}>Comp price distribution</div>
          {!compact && <div className="text-[11px] text-muted-foreground">Each dot is one comparable draft price.</div>}
        </div>
        <div
          className={compact ? 'h-28 w-full' : 'h-32 w-full sm:h-40'}
          role="img"
          aria-label={`${compCount} comparable auction prices, median $${estimate}${
            showBand ? `, middle 50% $${p25}–$${p75}` : ''
          }.`}
        >
          <ResponsiveContainer width="100%" height="100%">
            {/* top margin leaves room for the ReferenceLine's "median $x" label */}
            <ScatterChart margin={{ top: 18, right: 12, bottom: 4, left: -12 }}>
              <XAxis
                type="number"
                dataKey="price"
                domain={priceDomain}
                tick={{ fontSize: 10, fill: 'currentColor' }}
                tickFormatter={value => `$${Math.round(value)}`}
              />
              <YAxis type="number" dataKey="y" domain={[0, 1]} hide />
              <Tooltip
                content={StripTooltip}
                cursor={false}
                wrapperStyle={{ pointerEvents: 'auto' }}
              />
              {showBand && (
                <ReferenceArea
                  x1={p25}
                  x2={p75}
                  fill={MEDIAN_COLOR}
                  fillOpacity={0.1}
                  stroke="none"
                />
              )}
              {showBand && (
                <ReferenceLine
                  x={estimate}
                  stroke={MEDIAN_COLOR}
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  label={{
                    value: `median $${estimate}`,
                    position: 'top',
                    fontSize: 10,
                    fill: 'currentColor',
                  }}
                />
              )}
              <Scatter
                data={points}
                dataKey="y"
                shape={stripShape}
                isAnimationActive={false}
              />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: POSITION_COLOR }}
            />
            Position comp ({playerPosition}{playerPositionRank}&plusmn;{window})
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2"
              style={{
                backgroundColor: OVERALL_COLOR,
                clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
              }}
            />
            Overall-rank comp (#{playerRank}&plusmn;{window})
          </span>
          {showBand && (
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-3 rounded-sm"
                style={{ backgroundColor: MEDIAN_COLOR, opacity: 0.2 }}
              />
              middle 50%
            </span>
          )}
        </div>
      </div>

      {showTrend && !compact && (
        <div className="rounded-md border p-3 space-y-2 min-w-0">
          <div>
            <div className="text-xs font-semibold text-foreground">Median price by year</div>
            <div className="text-[11px] text-muted-foreground">
              How the comp median has moved across prior drafts.
            </div>
          </div>
          <div
            className="h-32 w-full sm:h-40"
            role="img"
            aria-label={`Median comp price by year: ${yearMedians
              .map(point => `${point.year} $${point.price}`)
              .join(', ')}.`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={yearMedians} margin={{ top: 4, right: 12, bottom: 4, left: -12 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis
                  type="number"
                  dataKey="year"
                  domain={['dataMin', 'dataMax']}
                  allowDecimals={false}
                  tick={{ fontSize: 10, fill: 'currentColor' }}
                />
                <YAxis
                  type="number"
                  width={40}
                  tick={{ fontSize: 10, fill: 'currentColor' }}
                  tickFormatter={value => `$${Math.round(value)}`}
                />
                <Tooltip content={YearTooltip} />
                <Line
                  dataKey="price"
                  stroke={MEDIAN_COLOR}
                  strokeWidth={2.5}
                  dot={{ r: 3, fill: MEDIAN_COLOR }}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                  connectNulls
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
