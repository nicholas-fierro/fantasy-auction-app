/// <reference path="../pb_data/types.d.ts" />
// PB number fields cannot distinguish missing from zero. Track source presence
// separately per scoring board; ADP itself remains derived, never stored.
migrate((app) => {
  const seasons = app.findCollectionByNameOrId('player_seasons');
  const deltaFields = ['ecr_vs_adp', 'ecr_vs_adp_ppr'];
  const added = [];
  for (const field of deltaFields) {
    const name = `${field}_known`;
    if (seasons.fields.getByName(name)) continue;
    seasons.fields.add(new Field({ name, type: 'bool', required: false }));
    added.push(field);
  }
  app.save(seasons);

  // Historical zeros are ambiguous: leave unknown until a source reimport.
  // Only backfill newly added markers, so replay cannot resurrect cleared data.
  if (added.length > 0) {
    for (const row of app.findAllRecords('player_seasons')) {
      let changed = false;
      for (const field of added) {
        if (row.getFloat(field) !== 0) {
          row.set(`${field}_known`, true);
          changed = true;
        }
      }
      if (changed) app.save(row);
    }
  }
}, (app) => {
  const seasons = app.findCollectionByNameOrId('player_seasons');
  for (const name of ['ecr_vs_adp_known', 'ecr_vs_adp_ppr_known']) {
    if (seasons.fields.getByName(name)) seasons.fields.removeByName(name);
  }
  app.save(seasons);
});
