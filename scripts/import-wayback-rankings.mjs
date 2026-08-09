#!/usr/bin/env node
// One-shot converter: Wayback Machine snapshots of FantasyPros' half-PPR
// draft cheat sheet -> CSVs compatible with the rankings importer
// (src/server/lib/import-core.ts -> importRankingsCore).
//
// Usage:
//   node scripts/import-wayback-rankings.mjs                 # all of 2019-2024
//   node scripts/import-wayback-rankings.mjs --year 2024      # single year
//
// For each year this:
//   1. Downloads (or reuses a cached copy of) the Wayback snapshot HTML.
//   2. Extracts player rankings — either from the embedded `ecrData` JSON
//      (2021+) or by parsing the server-rendered table (2019/2020, which
//      have no ecrData).
//   3. Validates the extracted data (player count, DST count, dup names,
//      scoring/type where available).
//   4. Writes data/historical-rankings/fp-half-ppr-<year>.csv for years that
//      pass validation, and prints a per-year summary.
//
// Zero npm dependencies — uses Node's built-in fetch (auto-decompresses
// gzip/br responses) and regex-based HTML extraction.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(__dirname, '.wayback-cache');
const OUTPUT_DIR = path.join(REPO_ROOT, 'data', 'historical-rankings');

// Latest snapshot before each season's kickoff (Wayback redirects a bare
// timestamp to the nearest capture, so these don't need to be exact hits).
// 2019 is the earliest available capture of this URL and lands a few days
// into the season — see the 2019-specific note in the final report.
const YEAR_TIMESTAMPS = {
  2019: '20190913',
  2020: '20200827',
  2021: '20210907',
  2022: '20220906',
  2023: '20230904',
  2024: '20240831',
};

const USER_AGENT =
  'Mozilla/5.0 (compatible; fantasy-auction-app-wayback-converter/1.0; +https://github.com/)';
const REQUEST_DELAY_MS = 1500;
const FETCH_TIMEOUT_MS = 30000;

function waybackUrl(timestamp) {
  return `https://web.archive.org/web/${timestamp}id_/https://www.fantasypros.com/nfl/rankings/half-point-ppr-cheatsheets.php`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Download the snapshot HTML, caching the raw response so re-runs don't
// re-hit Wayback. Retries once on failure/timeout after a short backoff.
async function fetchSnapshot(year, timestamp) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, `${year}.html`);
  if (fs.existsSync(cachePath)) {
    console.log(`[${year}] using cached snapshot (${cachePath})`);
    return fs.readFileSync(cachePath, 'utf8');
  }

  const url = waybackUrl(timestamp);
  console.log(`[${year}] fetching ${url}`);
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const html = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      fs.writeFileSync(cachePath, html, 'utf8');
      await sleep(REQUEST_DELAY_MS);
      return html;
    } catch (err) {
      lastErr = err;
      console.warn(`[${year}] attempt ${attempt} failed: ${err.message}`);
      if (attempt < 2) await sleep(REQUEST_DELAY_MS);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Extraction: modern path — embedded `var ecrData = {...};` JSON (2021+)
// ---------------------------------------------------------------------------

// Balanced-brace scan for the ecrData object literal. A naive
// `indexOf(';')` end marker breaks: the object is immediately followed on
// the same line by `var sosData = {...}; var newsData = ...;` etc, and
// those also contain `};` sequences well before ecrData's real close brace.
function extractEcrDataJson(html) {
  const marker = 'var ecrData = ';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const jsonStart = start + marker.length;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let i = jsonStart;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  const jsonStr = html.slice(jsonStart, i);
  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`failed to parse ecrData JSON: ${err.message}`);
  }
}

function playersFromEcrData(data) {
  return data.players.map((p) => ({
    name: p.player_name,
    team: p.player_team_id || '',
    posRank: p.pos_rank,
    rank: p.rank_ecr,
    tier: p.tier ?? 0,
    bye: p.player_bye_week != null ? String(p.player_bye_week) : '0',
  }));
}

// ---------------------------------------------------------------------------
// Extraction: 2019/2020 fallback — server-rendered table, no ecrData
// ---------------------------------------------------------------------------

// Each player row looks like:
//   <tr class="mpb-player-<id> player-row" data-id="<id>" >
//     <td class="sticky-cell sticky-cell-one"><RANK></td>
//     <td class="hide-print wsis-cell">
//       <input class="wsis" data-id="..." data-name="NAME" data-team="TEAM" data-position="POS">
//     </td>
//     <td class="player-label ..."> ... </td>
//     <td>POS_RANK</td>
//     <td>BYE_WEEK</td>
//     <td class="view-options ranks">...</td>  (rank_min, rank_max, etc — unused)
//     ...
//   </tr>
// The rank/pos-rank/bye cells are the only childless <td>s before the row's
// closes, so a childless-<td> scan in document order yields
// [rank, posRank, bye, ...]. `data-name`/`data-team`/`data-position` on the
// checkbox input are cleaner than scraping the `full-name` span (which for
// DST rows reads "San Francisco (SF)" rather than "San Francisco 49ers").
//
// Tier isn't in any per-row cell in this layout — it's carried by an
// interspersed `<tr class="tier-row static" data-tier="N">` header row
// before each tier's block of players, so we track it as we scan.
function playersFromTable(html) {
  const scanRe =
    /<tr class="tier-row static"\s+data-tier="(\d+)">|<tr class="mpb-player-\d+ player-row" data-id="\d+"\s*>([\s\S]*?)<\/tr>/g;
  const plainTdRe = /<td(?:\s+class="[^"]*")?>([^<]*)<\/td>/g;
  const attrsRe = /data-name="([^"]*)"[^>]*data-team="([^"]*)"[^>]*data-position="([^"]*)"/;

  const players = [];
  let tier = 0;
  let m;
  while ((m = scanRe.exec(html))) {
    if (m[1] !== undefined) {
      tier = parseInt(m[1], 10);
      continue;
    }
    const block = m[2];
    const attrs = block.match(attrsRe);
    if (!attrs) continue;
    const [, name, team, posRank] = attrs;
    const tds = [...block.matchAll(plainTdRe)].map((t) => t[1]);
    const [rank, tablePosRank, bye] = tds;
    if (!rank || !tablePosRank) continue;
    players.push({
      name,
      team: team || '',
      posRank: tablePosRank || posRank,
      rank: parseInt(rank, 10),
      tier,
      bye: bye || '0',
    });
  }
  return players;
}

// ---------------------------------------------------------------------------
// Position helpers (mirror parsePos in import-core.ts: strip trailing digits)
// ---------------------------------------------------------------------------

function basePosition(posRank) {
  return String(posRank ?? '')
    .replace(/[0-9]/g, '')
    .trim()
    .toUpperCase();
}

// ---------------------------------------------------------------------------
// CSV writing
// ---------------------------------------------------------------------------

const CSV_HEADERS = ['PLAYER NAME', 'TEAM', 'POS', 'RK', 'TIERS', 'BYE WEEK'];

// RFC4180-quote a field if needed (Papa.parse on the import side handles
// quoted fields correctly). We additionally warn loudly if a comma ever
// shows up in FantasyPros data, since none of 2019-2024 ever produced one —
// an unexpected comma is worth a human look, not a silent pass-through.
function csvField(value, { name, warnings }) {
  const s = String(value ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    warnings.push(`field required CSV quoting (unexpected for FP data): ${JSON.stringify(s)} (row: ${name})`);
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function playersToCsv(players, warnings) {
  const lines = [CSV_HEADERS.join(',')];
  for (const p of players) {
    const row = [
      csvField(p.name, { name: p.name, warnings }),
      csvField(p.team, { name: p.name, warnings }),
      csvField(p.posRank, { name: p.name, warnings }),
      csvField(p.rank, { name: p.name, warnings }),
      csvField(p.tier, { name: p.name, warnings }),
      csvField(p.bye, { name: p.name, warnings }),
    ];
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validatePlayers(players, { source, ecrMeta }) {
  const errors = [];
  const notes = [];

  if (players.length < 300) {
    errors.push(`only ${players.length} players extracted (expected >= 300)`);
  }

  const dstCount = players.filter((p) => basePosition(p.posRank) === 'DST').length;
  if (dstCount !== 32) {
    errors.push(`found ${dstCount} DST rows (expected exactly 32)`);
  }

  // Same (name, team, position) appearing twice means the same row got
  // scraped twice — a real extraction bug, so it's a hard failure.
  // Same bare name with a *different* team/position is a genuine two-people
  // coincidence (e.g. "Mike Davis" RB/CHI vs "Mike Davis" WR/FA) — FP data
  // is expected to occasionally contain these, so it's a note, not a
  // validation failure (the importer's matchPlayer disambiguates by
  // position, and by team when position also collides).
  const rowKey = (p) => `${p.name}|${p.team}|${basePosition(p.posRank)}`;
  const rowCounts = new Map();
  for (const p of players) rowCounts.set(rowKey(p), (rowCounts.get(rowKey(p)) ?? 0) + 1);
  const trueDupes = [...rowCounts.entries()].filter(([, c]) => c > 1);
  if (trueDupes.length > 0) {
    errors.push(`duplicate (name, team, position) rows: ${trueDupes.map(([k]) => k).join(', ')}`);
  }

  const nameCounts = new Map();
  for (const p of players) nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1);
  const sameNameDiffPlayer = [...nameCounts.entries()].filter(([, c]) => c > 1).map(([n]) => n);
  if (sameNameDiffPlayer.length > 0) {
    notes.push(`same name, different player (distinct team/position): ${sameNameDiffPlayer.join(', ')}`);
  }

  if (source === 'json') {
    if (String(ecrMeta.scoring ?? '').toUpperCase() !== 'HALF') {
      errors.push(`ecrData.scoring is "${ecrMeta.scoring}" (expected "HALF")`);
    }
    if (String(ecrMeta.ranking_type_name ?? '').toLowerCase() !== 'draft') {
      errors.push(`ecrData.ranking_type_name is "${ecrMeta.ranking_type_name}" (expected "draft")`);
    }
  }

  return { errors, notes };
}

function positionCounts(players) {
  const counts = {};
  for (const p of players) {
    const pos = basePosition(p.posRank);
    counts[pos] = (counts[pos] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Per-year pipeline
// ---------------------------------------------------------------------------

async function processYear(year) {
  const timestamp = YEAR_TIMESTAMPS[year];
  if (!timestamp) throw new Error(`no snapshot timestamp configured for year ${year}`);

  const html = await fetchSnapshot(year, timestamp);

  let players;
  let source;
  let ecrMeta = {};
  const ecrData = extractEcrDataJson(html);
  if (ecrData) {
    source = 'json';
    ecrMeta = {
      scoring: ecrData.scoring,
      ranking_type_name: ecrData.ranking_type_name,
      year: ecrData.year,
    };
    players = playersFromEcrData(ecrData);
  } else {
    source = 'table';
    players = playersFromTable(html);
  }

  // Sort by overall rank so the CSV (and the "top 3" sanity line) reads
  // top-down regardless of source ordering.
  players.sort((a, b) => a.rank - b.rank);

  const { errors, notes } = validatePlayers(players, { source, ecrMeta });
  const counts = positionCounts(players);
  const top3 = players.slice(0, 3).map((p) => `${p.rank}. ${p.name} (${p.posRank})`);

  console.log(`\n=== ${year} (source: ${source}) ===`);
  console.log(`  players: ${players.length}`);
  console.log(
    `  QB ${counts.QB ?? 0}  RB ${counts.RB ?? 0}  WR ${counts.WR ?? 0}  TE ${counts.TE ?? 0}  K ${counts.K ?? 0}  DST ${counts.DST ?? 0}`
  );
  console.log(`  top 3: ${top3.join(' | ')}`);
  for (const n of notes) console.log(`  NOTE: ${n}`);

  if (errors.length > 0) {
    console.error(`  VALIDATION FAILED:`);
    for (const e of errors) console.error(`    - ${e}`);
    return { year, ok: false, players, counts };
  }

  const warnings = [];
  const csv = playersToCsv(players, warnings);
  for (const w of warnings) console.warn(`  WARNING: ${w}`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, `fp-half-ppr-${year}.csv`);
  fs.writeFileSync(outPath, csv, 'utf8');
  console.log(`  wrote ${outPath}`);

  return { year, ok: true, players, counts, outPath };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { years: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--year') {
      const y = parseInt(argv[++i], 10);
      if (!Number.isFinite(y)) throw new Error(`--year requires a numeric value`);
      args.years = [y];
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const years = args.years ?? Object.keys(YEAR_TIMESTAMPS).map(Number).sort();

  const results = [];
  for (const year of years) {
    try {
      results.push(await processYear(year));
    } catch (err) {
      console.error(`\n=== ${year} ===`);
      console.error(`  FAILED: ${err.message}`);
      results.push({ year, ok: false, error: err.message });
    }
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`  ${r.year}: ${r.ok ? `OK (${r.players.length} players)` : 'FAILED'}`);
  }

  const anyFailed = results.some((r) => !r.ok);
  process.exit(anyFailed ? 1 : 0);
}

main();
