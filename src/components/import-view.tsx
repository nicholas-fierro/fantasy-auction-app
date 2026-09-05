'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import { Upload, FileText, X, CheckCircle2, AlertTriangle, TriangleAlert, Calculator, IdCard, Wand2 } from 'lucide-react';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useAuction } from '@/contexts/auction-context';
import { useLeague } from '@/hooks/use-league';
import {
  useImportRankings,
  useImportRookies,
  useImportAuctionValues,
  useCalculateProjectedValues,
  useSyncPlayerIds,
} from '@/hooks/use-imports';
import type {
  FuzzyRow,
  ImportReport,
  RankingScoringFormat,
} from '@/server/types/import';
import { useAllPlayers } from '@/hooks/use-players';
import { PlayerNameButton } from '@/components/player-name-button';

type ImportKind = 'rankings' | 'rookies' | 'values' | 'unrecognized';

interface SniffedFile {
  id: string;
  file: File;
  kind: ImportKind;
  headers: string[];
}

const KIND_LABEL: Record<ImportKind, string> = {
  rankings: 'Rankings',
  rookies: 'Rookies',
  values: 'Auction Values',
  unrecognized: 'Unrecognized',
};

// Order the "Import all" flow runs in: rankings create season rows, so rookies
// and values (which need those rows) must follow.
const KIND_ORDER: ImportKind[] = ['rankings', 'rookies', 'values'];

const RANKING_FORMAT_LABELS: Record<RankingScoringFormat, string> = {
  std: 'Standard',
  half: 'Half-PPR',
  ppr: 'Full-PPR',
};

// Classify a CSV by its header row (client-side sniff, mirrors the server).
export function sniffKind(headers: string[]): ImportKind {
  const upper = headers.map((h) => h.trim().toUpperCase());
  const has = (name: string) => upper.includes(name);
  if (has('TIERS') && has('SOS SEASON')) return 'rankings';
  if (has('AGE')) return 'rookies';
  if (upper.some((h) => ['VALUE', 'AAV', 'PRICE'].some((t) => h.includes(t)))) return 'values';
  return 'unrecognized';
}

// Steps 2 and 3 are only *needed* after an import, but nothing about their
// cards said so — the order lived in a doc. Flagged here instead: an import
// marks both pending, and each clears its own flag when it runs.
//
// Kept in sessionStorage, not component state: leaving Settings (or reloading)
// unmounts this view, and a reminder that vanishes the moment you go look at
// the players table is no reminder at all. Dies with the tab, which is the
// right lifetime — it's a nudge about work started in this sitting, not
// durable state.
const PENDING_KEY = 'import-pending-steps';

interface PendingSteps {
  ids: boolean;
  /** Season year whose projected prices are stale, or null if none. */
  valuesYear: number | null;
}

const NO_PENDING: PendingSteps = { ids: false, valuesYear: null };

function usePendingSteps() {
  const [pending, setPending] = useState<PendingSteps>(NO_PENDING);

  // Read after mount, so the server and first client render agree.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(PENDING_KEY);
      if (raw) setPending({ ...NO_PENDING, ...JSON.parse(raw) });
    } catch {
      // Unparseable or unavailable storage just means no reminder.
    }
  }, []);

  const update = useCallback((fn: (prev: PendingSteps) => PendingSteps) => {
    setPending((prev) => {
      const next = fn(prev);
      try {
        sessionStorage.setItem(PENDING_KEY, JSON.stringify(next));
      } catch {
        // Non-fatal: the in-memory flag still works for this mount.
      }
      return next;
    });
  }, []);

  return [pending, update] as const;
}

function StaleBadge({ show, label }: { show: boolean; label: string }) {
  if (!show) return null;
  return (
    <Badge variant="outline" className="gap-1 border-amber-400 text-amber-700 dark:text-amber-400">
      <AlertTriangle className="h-3 w-3" />
      {label}
    </Badge>
  );
}

function KindBadge({ kind }: { kind: ImportKind }) {
  if (kind === 'unrecognized') {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertTriangle className="h-3 w-3" />
        {KIND_LABEL[kind]}
      </Badge>
    );
  }
  return <Badge variant="secondary">{KIND_LABEL[kind]}</Badge>;
}

export function ImportView() {
  const { selectedYear } = useAuction();
  const { league, settings } = useLeague();
  const selectedLeagueRankingFormat = settings.scoringFormat;
  const [year, setYear] = useState<string>(String(selectedYear));
  const [rankingFormat, setRankingFormat] =
    useState<RankingScoringFormat>(selectedLeagueRankingFormat);
  const [files, setFiles] = useState<SniffedFile[]>([]);
  const [reports, setReports] = useState<Record<string, ImportReport>>({});
  const [isImporting, setIsImporting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [pending, setPending] = usePendingSteps();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importRankings = useImportRankings();
  const importRookies = useImportRookies();
  const importValues = useImportAuctionValues();

  useEffect(() => {
    setRankingFormat(selectedLeagueRankingFormat);
  }, [league?.id, selectedLeagueRankingFormat]);

  const parsedYear = parseInt(year, 10);
  const isYearValid = !Number.isNaN(parsedYear);

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const list = Array.from(incoming).filter((f) => f.name.toLowerCase().endsWith('.csv'));
    list.forEach((file) => {
      Papa.parse<Record<string, unknown>>(file, {
        header: true,
        preview: 1,
        skipEmptyLines: true,
        complete: (result) => {
          const headers = result.meta.fields ?? [];
          setFiles((prev) => [
            ...prev,
            {
              id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              file,
              kind: sniffKind(headers),
              headers,
            },
          ]);
        },
      });
    });
  }, []);

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
    setReports((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  };

  const importableFiles = useMemo(
    () => files.filter((f) => f.kind !== 'unrecognized'),
    [files]
  );
  const hasRankings = importableFiles.some((file) => file.kind === 'rankings');
  const rankingFormatMatchesLeague = settings.scoringFormat === rankingFormat;
  const selectedLeagueFormatLabel = RANKING_FORMAT_LABELS[settings.scoringFormat];
  const canImport =
    isYearValid &&
    importableFiles.length > 0 &&
    (!hasRankings || (!!league && rankingFormatMatchesLeague));

  const handleImportAll = async () => {
    if (!canImport) return;
    setIsImporting(true);
    try {
      // Run in dependency order: rankings -> rookies -> values.
      const ordered = [...importableFiles].sort(
        (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
      );
      for (const sniffed of ordered) {
        const csvText = await sniffed.file.text();
        let report: ImportReport;
        switch (sniffed.kind) {
          case 'rankings':
            if (!league) throw new Error('Select a league before importing rankings');
            report = await importRankings.mutateAsync({
              year: parsedYear,
              csvText,
              leagueId: league.id,
              scoringFormat: rankingFormat,
            });
            break;
          case 'rookies':
            report = await importRookies.mutateAsync({ year: parsedYear, csvText });
            break;
          case 'values':
            report = await importValues.mutateAsync({ year: parsedYear, csvText });
            break;
          default:
            continue;
        }
        setReports((prev) => ({ ...prev, [sniffed.id]: report }));
        // Any import can add players (step 2) and shift ranks (step 3). Step 3
        // is per-season, so remember which year needs repricing.
        setPending(() => ({ ids: true, valuesYear: parsedYear }));
      }
    } catch (error) {
      console.error('Import failed:', error);
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Import FantasyPros rankings, rookies, and auction values into a season.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>1. Import CSVs</CardTitle>
          <CardDescription>
            Drop one or more CSV files. Each is auto-detected by its columns. &quot;Import all&quot;
            runs rankings first, then rookies, then auction values. Run steps 2 and 3 below
            afterwards — they depend on what this step writes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-end gap-3 max-sm:flex-col max-sm:items-stretch">
            <div className="space-y-2">
              <Label htmlFor="import-year">Season year</Label>
              <Input
                id="import-year"
                type="number"
                inputMode="numeric"
                value={year}
                onChange={(e) => setYear(e.target.value)}
                className={cn('w-32 max-sm:w-full', !isYearValid && 'border-red-400 focus-visible:ring-red-400')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ranking-format">Rankings scoring format</Label>
              <Select
                value={rankingFormat}
                onValueChange={(value) => setRankingFormat(value as RankingScoringFormat)}
              >
                <SelectTrigger id="ranking-format" className="w-40 max-sm:w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="std">Standard</SelectItem>
                  <SelectItem value="half">Half-PPR</SelectItem>
                  <SelectItem value="ppr">Full-PPR</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1 text-sm" aria-live="polite">
            <p className="text-muted-foreground">
              Rankings destination:{' '}
              <span className="font-medium text-foreground">
                {RANKING_FORMAT_LABELS[rankingFormat]} {isYearValid ? parsedYear : 'season'} board
                {league ? ` for ${league.name}` : ''}
              </span>
              .
            </p>
            {hasRankings && !rankingFormatMatchesLeague && (
              <p className="text-red-600 dark:text-red-400">
                Selected league uses {selectedLeagueFormatLabel} scoring. Choose its rankings
                format or switch leagues before importing.
              </p>
            )}
          </div>

          {/* Dropzone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center cursor-pointer transition-colors max-md:px-4 max-md:py-8',
              isDragging
                ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20'
                : 'border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50'
            )}
          >
            <Upload className="h-8 w-8 text-gray-400" />
            <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
              <span className="max-md:hidden">Drop CSV files here, or click to browse</span>
              <span className="md:hidden">Tap to choose CSV files</span>
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Rankings, rookies, and auction-value exports
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          {/* File list */}
          {files.length > 0 && (
            <div className="space-y-2">
              {files.map((f) => {
                const report = reports[f.id];
                return (
                  <div
                    key={f.id}
                    className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-3"
                  >
                    <div className="flex items-center gap-3 max-md:flex-wrap max-md:gap-y-2">
                      <FileText className="h-4 w-4 text-gray-400 shrink-0" />
                      {/* On a phone the filename takes the first line on its own and
                          the badge + controls wrap underneath. */}
                      <span className="text-sm font-medium truncate flex-1 max-md:basis-[calc(100%-1.75rem)]">
                        {f.file.name}
                      </span>
                      <KindBadge kind={f.kind} />
                      {report && (
                        <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                      )}
                      <button
                        onClick={() => removeFile(f.id)}
                        className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 max-md:ml-auto max-md:flex max-md:size-11 max-md:items-center max-md:justify-center"
                        title="Remove"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    {f.kind === 'unrecognized' && (
                      <p className="text-xs text-red-600 dark:text-red-400">
                        Could not detect this file&apos;s type from its columns. Expected a rankings,
                        rookies, or auction-values export.
                      </p>
                    )}
                    {report && <ReportSummary report={report} />}
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex items-center justify-between max-md:flex-col max-md:items-stretch max-md:gap-3">
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {importableFiles.length} file{importableFiles.length === 1 ? '' : 's'} ready to import
              {isYearValid ? ` into ${parsedYear}` : ''}
            </div>
            <Button
              onClick={handleImportAll}
              disabled={!canImport || isImporting}
              className="min-w-32 max-md:h-11 max-md:w-full"
            >
              {isImporting ? 'Importing…' : 'Import all'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <PlayerIdSync
        stale={pending.ids}
        onSynced={() => setPending((prev) => ({ ...prev, ids: false }))}
      />

      <ProjectedValueCalculator
        year={parsedYear}
        isYearValid={isYearValid}
        staleYear={pending.valuesYear}
        onCalculated={(calculatedYear) =>
          setPending((prev) =>
            // Only the year that was actually repriced stops being stale.
            prev.valuesYear === calculatedYear ? { ...prev, valuesYear: null } : prev
          )
        }
      />
    </div>
  );
}

// Fills in the provider IDs a rankings import leaves blank on new players.
// Its own card rather than part of the import: it downloads ~14MB from Sleeper
// plus two DynastyProcess CSVs, and its ambiguous/unmatched rows deserve to be
// read rather than buried in a per-file import report.
function PlayerIdSync({ stale, onSynced }: { stale: boolean; onSynced: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const sync = useSyncPlayerIds();
  const report = sync.data;

  const handleSync = async () => {
    setError(null);
    try {
      await sync.mutateAsync({});
      onSynced();
    } catch (err) {
      console.error('Failed to sync player IDs:', err);
      setError(err instanceof Error ? err.message : 'Failed to sync player IDs');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <IdCard className="h-5 w-5" />
          2. Sync player IDs
          <StaleBadge show={stale} label="Needed after your import" />
        </CardTitle>
        <CardDescription>
          Matches players to their Sleeper, ESPN, and FantasyPros IDs — the source of
          headshots, injury badges, and the compare panel. New players arrive from a rankings
          import with none of these, so run this afterwards. Only fills blanks; existing IDs are
          left alone.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        {report && (
          <div className="space-y-2 text-xs text-gray-600 dark:text-gray-300">
            <div>
              Scanned {report.playersScanned} players; wrote {report.written}. Sleeper matched{' '}
              {report.sleeperMatched}, ESPN backfilled {report.espnBackfilled}, FantasyPros
              matched {report.fantasyProsMatched} ({report.fantasyProsUnmatched} unmatched).
            </div>
            {(report.ambiguous.length > 0 || report.unmatched.length > 0) && (
              <div className="rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="h-8">Player</TableHead>
                      <TableHead className="h-8">Pos</TableHead>
                      <TableHead className="h-8">Result</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.ambiguous.map((row) => (
                      <TableRow key={`amb-${row.name}-${row.position}`}>
                        <TableCell className="py-1.5">{row.name}</TableCell>
                        <TableCell className="py-1.5">{row.position}</TableCell>
                        <TableCell className="py-1.5">
                          ambiguous ({row.candidates} candidates) — skipped
                        </TableCell>
                      </TableRow>
                    ))}
                    {report.unmatched.map((row) => (
                      <TableRow key={`un-${row.name}-${row.position}`}>
                        <TableCell className="py-1.5">{row.name}</TableCell>
                        <TableCell className="py-1.5">{row.position}</TableCell>
                        <TableCell className="py-1.5">no Sleeper match</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-end">
          <Button
            variant="outline"
            onClick={handleSync}
            disabled={sync.isPending}
            className="max-md:h-11 max-md:w-full"
          >
            {sync.isPending ? 'Syncing…' : 'Sync player IDs'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ReportSummary({ report }: { report: ImportReport }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 px-2 py-1 font-medium">
          {report.created} created
        </span>
        <span className="rounded bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 px-2 py-1 font-medium">
          {report.updated} updated
        </span>
        <span className="rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 px-2 py-1 font-medium">
          {report.skipped} skipped
        </span>
        {report.unmatched.length > 0 && (
          <span className="rounded bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 px-2 py-1 font-medium">
            {report.unmatched.length} unmatched
          </span>
        )}
        {report.ambiguous.length > 0 && (
          <span className="rounded bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400 px-2 py-1 font-medium">
            {report.ambiguous.length} ambiguous
          </span>
        )}
        {report.fuzzy.length > 0 && (
          <span className="rounded bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400 px-2 py-1 font-medium">
            {report.fuzzy.length} fuzzy matched
          </span>
        )}
      </div>

      {report.unmatched.length > 0 && (
        <RowTable
          title="Unmatched"
          icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />}
          rows={report.unmatched.map((r) => ({
            name: r.name,
            team: r.team,
            position: r.position,
          }))}
        />
      )}

      {report.ambiguous.length > 0 && (
        <RowTable
          title="Ambiguous (skipped — matched multiple players)"
          icon={<TriangleAlert className="h-3.5 w-3.5 text-orange-600 dark:text-orange-400" />}
          rows={report.ambiguous.map((r) => ({
            name: r.name,
            team: r.team,
            position: r.position,
            matches: r.matches,
          }))}
        />
      )}

      {report.fuzzy.length > 0 && <FuzzyTable rows={report.fuzzy} />}
    </div>
  );
}

function FuzzyTable({ rows }: { rows: FuzzyRow[] }) {
  const { data: players = [] } = useAllPlayers();
  const playerByName = useMemo(
    () => new Map(players.map((player) => [player.name, player])),
    [players],
  );

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-300">
        <Wand2 className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
        Fuzzy matched — verify these are right ({rows.length})
      </div>
      <div className="max-h-48 overflow-y-auto rounded border border-gray-200 dark:border-gray-700">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="h-8">CSV name</TableHead>
              <TableHead className="h-8">Matched player</TableHead>
              <TableHead className="h-8">Position</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={`${r.csvName}-${i}`}>
                <TableCell className="py-1.5">{r.csvName}</TableCell>
                <TableCell className="py-1.5">
                  {playerByName.has(r.matchedName) ? (
                    <PlayerNameButton player={playerByName.get(r.matchedName)!} />
                  ) : (
                    r.matchedName
                  )}
                </TableCell>
                <TableCell className="py-1.5">{r.position || '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function RowTable({
  title,
  icon,
  rows,
}: {
  title: string;
  icon: React.ReactNode;
  rows: { name: string; team: string; position: string; matches?: number }[];
}) {
  const hasMatches = rows.some((r) => r.matches != null);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-300">
        {icon}
        {title} ({rows.length})
      </div>
      <div className="max-h-48 overflow-y-auto rounded border border-gray-200 dark:border-gray-700">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="h-8">Name</TableHead>
              <TableHead className="h-8">Team</TableHead>
              <TableHead className="h-8">Position</TableHead>
              {hasMatches && <TableHead className="h-8">Matches</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={`${r.name}-${i}`}>
                <TableCell className="py-1.5">{r.name}</TableCell>
                <TableCell className="py-1.5">{r.team || '—'}</TableCell>
                <TableCell className="py-1.5">{r.position || '—'}</TableCell>
                {hasMatches && <TableCell className="py-1.5">{r.matches ?? '—'}</TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ProjectedValueCalculator({
  year,
  isYearValid,
  staleYear,
  onCalculated,
}: {
  year: number;
  isYearValid: boolean;
  staleYear: number | null;
  onCalculated: (calculatedYear: number) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { league, settings } = useLeague();
  const calculate = useCalculateProjectedValues();
  const result = calculate.data;

  const handleApply = async () => {
    setError(null);
    try {
      if (!league) throw new Error('Select a league before recalculating projected values');
      await calculate.mutateAsync({
        year,
        leagueId: league.id,
        scoringFormat: settings.scoringFormat,
      });
      onCalculated(year);
    } catch (err) {
      console.error('Failed to recalculate projected values:', err);
      setError(err instanceof Error ? err.message : 'Failed to recalculate projected values');
    } finally {
      setConfirmOpen(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calculator className="h-5 w-5" />
          3. Recalculate Projected Prices
          <StaleBadge
            show={staleYear !== null}
            label={`Needed after your ${staleYear} import`}
          />
        </CardTitle>
        <CardDescription>
          Runs the League Value Model — recency-weighted comps from this league&apos;s own
          official auction history, scaled so the drafted pool sums to the league budget.
          Same model as <code>scripts/calc-projected-values.ts</code>. Re-run this after every
          rankings import, since estimates key off each player&apos;s rank.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        {result && (
          <div className="space-y-2">
            <div className="text-xs text-gray-600 dark:text-gray-300">
              Updated {result.updated} {result.updated === 1 ? 'player' : 'players'},{' '}
              {result.unchanged} unchanged. Priced from{' '}
              {result.historyYears.length > 0 ? result.historyYears.join(', ') : 'no'} official{' '}
              {result.historyYears.length === 1 ? 'auction' : 'auctions'}.
            </div>
            <div className="rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-8">Player</TableHead>
                    <TableHead className="h-8">Pos</TableHead>
                    <TableHead className="h-8 text-right">Was</TableHead>
                    <TableHead className="h-8 text-right">Now</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.top.map((row) => (
                    <TableRow key={`${row.name}-${row.position}`}>
                      <TableCell className="py-1.5">{row.name}</TableCell>
                      <TableCell className="py-1.5">{row.position}</TableCell>
                      <TableCell className="py-1.5 text-right text-gray-500">
                        ${row.previous}
                      </TableCell>
                      <TableCell className="py-1.5 text-right font-medium">${row.value}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        <div className="flex items-center justify-end">
          <Button
            variant="outline"
            onClick={() => setConfirmOpen(true)}
            disabled={!isYearValid || !league || calculate.isPending}
            className="max-md:h-11 max-md:w-full"
          >
            {calculate.isPending ? 'Recalculating…' : `Recalculate ${isYearValid ? year : '—'}`}
          </Button>
        </div>
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent variant="alert">
          <DialogHeader>
            <DialogTitle>
              Recalculate {RANKING_FORMAT_LABELS[settings.scoringFormat]} projected prices for{' '}
              {year}?
            </DialogTitle>
            <DialogDescription>
              This replaces the Projected Price for <strong>every</strong> player in the{' '}
              {year} season, including any values you edited by hand. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={calculate.isPending}>
              Cancel
            </Button>
            <Button onClick={handleApply} disabled={calculate.isPending}>
              {calculate.isPending ? 'Recalculating…' : 'Recalculate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
