import fs from 'node:fs';
import vm from 'node:vm';

const [baselinePath, outputPath] = process.argv.slice(2);
if (!baselinePath || !outputPath) {
  throw new Error('Usage: create-legacy-migration.mjs <baseline> <output>');
}

// The incremental chain predates this repo's first complete migration. Rewind the
// authoritative baseline to the five legacy collections it originally expected,
// then let the incremental chain rebuild the final schema for parity comparison.
let snapshot;
vm.runInNewContext(fs.readFileSync(baselinePath, 'utf8'), {
  migrate(up) {
    up({
      importCollections(value) {
        snapshot = value;
      },
    });
  },
});

if (!Array.isArray(snapshot)) throw new Error('Baseline did not import a collection snapshot');

const legacyNames = new Set(['users', 'players', 'fantasy_teams', 'draft_picks', 'watchlist']);
const legacy = structuredClone(snapshot.filter((collection) => legacyNames.has(collection.name)));

for (const collection of legacy) {
  collection.listRule = '';
  collection.viewRule = '';
  collection.createRule = '';
  collection.updateRule = '';
  collection.deleteRule = '';

  if (collection.name === 'players') {
    collection.fields = collection.fields.filter(
      (field) => !['sleeper_id', 'espn_id', 'fantasypros_id', 'gsis_id'].includes(field.name)
    );
    collection.indexes = collection.indexes.filter((index) => !index.includes('idx_players_gsis_id'));
  }
  if (collection.name === 'fantasy_teams') {
    collection.fields = collection.fields.filter((field) => field.name !== 'league');
  }
  if (collection.name === 'draft_picks') {
    collection.fields = collection.fields.filter(
      (field) => !['auction_id', 'price', 'drafted_at'].includes(field.name)
    );
    collection.indexes = [];
  }
  if (collection.name === 'watchlist') {
    collection.fields = collection.fields.filter((field) => field.name !== 'user');
    const teamField = collection.fields.find((field) => field.name === 'fantasy_team_id');
    if (!teamField) throw new Error('Baseline watchlist is missing fantasy_team_id');
    teamField.required = true;
    collection.indexes = [
      'CREATE UNIQUE INDEX `idx_UkVzg4Tflo` ON `watchlist` (\n  `player_id`,\n  `fantasy_team_id`\n)',
    ];
  }
}

fs.writeFileSync(
  outputPath,
  `migrate((app) => { app.importCollections(${JSON.stringify(legacy)}, false); }, () => {});\n`
);
