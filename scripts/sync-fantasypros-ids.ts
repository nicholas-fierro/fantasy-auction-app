#!/usr/bin/env -S npx tsx
// Maps local players to FantasyPros player IDs for the compare endpoint using
// DynastyProcess/nflverse's weekly open-data rankings export. The FantasyPros
// free API truncates its player catalog, so it is deliberately not used here.
// Run after PocketBase applies 1784150000_fantasypros_player_id.js:
// PB_SUPERUSER_EMAIL=... PB_SUPERUSER_PASSWORD=... npx tsx scripts/sync-fantasypros-ids.ts --dry-run

import PocketBase from 'pocketbase';
import {
  DP_RANKINGS_URL,
  buildFantasyProsIdIndex,
  matchFantasyProsId,
} from '@/server/lib/player-ids';

const RANKINGS_URL = DP_RANKINGS_URL;
const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');
const baseUrl = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090';
const email = process.env.PB_SUPERUSER_EMAIL || process.env.PB_USER_EMAIL;
const password = process.env.PB_SUPERUSER_PASSWORD || process.env.PB_USER_PASSWORD;
if (!email || !password) throw new Error('Set PocketBase superuser (or user) email and password.');
const pocketBaseEmail: string = email;
const pocketBasePassword: string = password;

// Index building and matching live in src/server/lib/player-ids.ts, shared with
// the in-app "Sync player IDs" action so both map players identically.

async function main() {
  const [pb, response] = await Promise.all([
    Promise.resolve(new PocketBase(baseUrl)),
    fetch(RANKINGS_URL, { headers: { 'user-agent': 'fantasy-auction-app personal ID mapper' } }),
  ]);
  await pb.collection('_superusers').authWithPassword(pocketBaseEmail, pocketBasePassword);
  if (!response.ok) throw new Error(`DynastyProcess rankings request failed (${response.status}).`);

  const index = buildFantasyProsIdIndex(await response.text());
  if (index.size === 0) throw new Error('DynastyProcess rankings contained no usable FantasyPros IDs.');

  const localPlayers = await pb.collection('players').getFullList({ requestKey: null });
  if (localPlayers.length > 0 && !Object.prototype.hasOwnProperty.call(localPlayers[0], 'fantasypros_id')) {
    throw new Error(
      'PocketBase is missing players.fantasypros_id. Copy ' +
      'pb_migrations/1784150000_fantasypros_player_id.js into the running ' +
      'PocketBase pb_migrations directory, restart PocketBase, and rerun this script.',
    );
  }
  let updated = 0;
  let unmatched = 0;
  for (const player of localPlayers) {
    if (!force && player.fantasypros_id) continue;
    const id = matchFantasyProsId(index, String(player.name), String(player.position));
    if (!id) { unmatched += 1; continue; }
    if (!dryRun) {
      const saved = await pb.collection('players').update(player.id, { fantasypros_id: id });
      if (String(saved.fantasypros_id ?? '') !== id) {
        throw new Error(`PocketBase did not persist fantasypros_id for ${String(player.name)}.`);
      }
    }
    updated += 1;
  }
  console.log(`Source: DynastyProcess/nflverse weekly rankings (${index.size} unique players).`);
  console.log(`${dryRun ? 'Would map' : 'Mapped'} ${updated} players; ${unmatched} unmatched or ambiguous.`);
}

void main();
