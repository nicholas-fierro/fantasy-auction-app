/// <reference path="../pb_data/types.d.ts" />
//
// Optional FantasyPros player identifier. This is deliberately an identity
// field on `players`, not a seasonal ranking field: the same mapping is reused
// for every selected auction year.
migrate((app) => {
  const playersCol = app.findCollectionByNameOrId('players');
  if (!playersCol.fields.getByName('fantasypros_id')) {
    playersCol.fields.add(new Field({
      name: 'fantasypros_id',
      type: 'text',
      required: false,
    }));
    app.save(playersCol);
  }
}, (app) => {
  const playersCol = app.findCollectionByNameOrId('players');
  if (playersCol.fields.getByName('fantasypros_id')) {
    playersCol.fields.removeByName('fantasypros_id');
    app.save(playersCol);
  }
});
