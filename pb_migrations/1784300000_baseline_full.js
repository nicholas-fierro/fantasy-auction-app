/// <reference path="../pb_data/types.d.ts" />
//
// BASELINE — full authoritative schema (issue #31, production Phase 0).
//
// Additive baseline: incremental migrations are KEPT and unchanged. This single
// migration rebuilds the ENTIRE final schema from
// an empty instance, so a fresh production PocketBase can be provisioned from the
// baseline alone. On an existing instance it is a safe idempotent no-op/upsert;
// post-baseline migrations likewise tolerate fields and collections already here.
//
// How it stays idempotent:
//   app.importCollections(snapshot, false)  // deleteMissing=false
//     - empty instance     -> creates all collections (matched by id)
//     - populated instance  -> upserts each to match the snapshot; touches nothing else
//
// Scope: `users` (auth) plus every app collection, field, API rule, and index —
// the cumulative end-state of the incremental migration chain.
//
// The 5 PocketBase system collections (_superusers, _mfas, _otps, _externalAuths,
// _authOrigins) are intentionally OMITTED: PocketBase provisions them itself on init,
// and leaving them out guarantees we never clobber a production superuser or built-in.
// The stray local scratch collections `test` and `debts` (created by no repo migration)
// are likewise excluded.
//
// Canonical copy lives here in the repo. To ACTIVATE: copy this file into the
// PocketBase instance's pb_migrations/ dir and restart `pocketbase serve`.
//
// Down migration is a deliberate no-op: a baseline must never drop the schema it
// shares with the incrementals (that would delete production data). Roll back via
// PB backups, not by reverting this migration.

migrate((app) => {
  const snapshot = [
    {
      "id": "_pb_users_auth_",
      "listRule": "id = @request.auth.id",
      "viewRule": "id = @request.auth.id",
      "createRule": null,
      "updateRule": "id = @request.auth.id",
      "deleteRule": "id = @request.auth.id",
      "name": "users",
      "type": "auth",
      "fields": [
        {
          "autogeneratePattern": "[a-z0-9]{15}",
          "hidden": false,
          "id": "text3208210256",
          "max": 15,
          "min": 15,
          "name": "id",
          "pattern": "^[a-z0-9]+$",
          "presentable": false,
          "primaryKey": true,
          "required": true,
          "system": true,
          "type": "text"
        },
        {
          "cost": 0,
          "hidden": true,
          "id": "password901924565",
          "max": 0,
          "min": 8,
          "name": "password",
          "pattern": "",
          "presentable": false,
          "required": true,
          "system": true,
          "type": "password"
        },
        {
          "autogeneratePattern": "[a-zA-Z0-9]{50}",
          "hidden": true,
          "id": "text2504183744",
          "max": 60,
          "min": 30,
          "name": "tokenKey",
          "pattern": "",
          "presentable": false,
          "primaryKey": false,
          "required": true,
          "system": true,
          "type": "text"
        },
        {
          "exceptDomains": null,
          "hidden": false,
          "id": "email3885137012",
          "name": "email",
          "onlyDomains": null,
          "presentable": false,
          "required": true,
          "system": true,
          "type": "email"
        },
        {
          "hidden": false,
          "id": "bool1547992806",
          "name": "emailVisibility",
          "presentable": false,
          "required": false,
          "system": true,
          "type": "bool"
        },
        {
          "hidden": false,
          "id": "bool256245529",
          "name": "verified",
          "presentable": false,
          "required": false,
          "system": true,
          "type": "bool"
        },
        {
          "autogeneratePattern": "",
          "hidden": false,
          "id": "text1579384326",
          "max": 255,
          "min": 0,
          "name": "name",
          "pattern": "",
          "presentable": false,
          "primaryKey": false,
          "required": false,
          "system": false,
          "type": "text"
        },
        {
          "hidden": false,
          "id": "file376926767",
          "maxSelect": 1,
          "maxSize": 0,
          "mimeTypes": [
            "image/jpeg",
            "image/png",
            "image/svg+xml",
            "image/gif",
            "image/webp"
          ],
          "name": "avatar",
          "presentable": false,
          "protected": false,
          "required": false,
          "system": false,
          "thumbs": null,
          "type": "file"
        },
        {
          "hidden": false,
          "id": "autodate2990389176",
          "name": "created",
          "onCreate": true,
          "onUpdate": false,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "hidden": false,
          "id": "autodate3332085495",
          "name": "updated",
          "onCreate": true,
          "onUpdate": true,
          "presentable": false,
          "system": false,
          "type": "autodate"
        }
      ],
      "indexes": [
        "CREATE UNIQUE INDEX `idx_tokenKey__pb_users_auth_` ON `users` (`tokenKey`)",
        "CREATE UNIQUE INDEX `idx_email__pb_users_auth_` ON `users` (`email`) WHERE `email` != ''"
      ],
      "created": "2025-08-03 02:39:37.285Z",
      "updated": "2026-07-13 23:24:35.000Z",
      "system": false,
      "authRule": "",
      "manageRule": null,
      "authAlert": {
        "enabled": true,
        "emailTemplate": {
          "subject": "Login from a new location",
          "body": "<p>Hello,</p>\n<p>We noticed a login to your {APP_NAME} account from a new location.</p>\n<p>If this was you, you may disregard this email.</p>\n<p><strong>If this wasn't you, you should immediately change your {APP_NAME} account password to revoke access from all other locations.</strong></p>\n<p>\n  Thanks,<br/>\n  {APP_NAME} team\n</p>"
        }
      },
      "oauth2": {
        "providers": [],
        "mappedFields": {
          "id": "",
          "name": "name",
          "username": "",
          "avatarURL": "avatar"
        },
        "enabled": false
      },
      "passwordAuth": {
        "enabled": true,
        "identityFields": [
          "email"
        ]
      },
      "mfa": {
        "enabled": false,
        "duration": 1800,
        "rule": ""
      },
      "otp": {
        "enabled": false,
        "duration": 180,
        "length": 8,
        "emailTemplate": {
          "subject": "OTP for {APP_NAME}",
          "body": "<p>Hello,</p>\n<p>Your one-time password is: <strong>{OTP}</strong></p>\n<p><i>If you didn't ask for the one-time password, you can ignore this email.</i></p>\n<p>\n  Thanks,<br/>\n  {APP_NAME} team\n</p>"
        }
      },
      "authToken": {
        "duration": 604800
      },
      "passwordResetToken": {
        "duration": 1800
      },
      "emailChangeToken": {
        "duration": 1800
      },
      "verificationToken": {
        "duration": 259200
      },
      "fileToken": {
        "duration": 180
      },
      "verificationTemplate": {
        "subject": "Verify your {APP_NAME} email",
        "body": "<p>Hello,</p>\n<p>Thank you for joining us at {APP_NAME}.</p>\n<p>Click on the button below to verify your email address.</p>\n<p>\n  <a class=\"btn\" href=\"{APP_URL}/_/#/auth/confirm-verification/{TOKEN}\" target=\"_blank\" rel=\"noopener\">Verify</a>\n</p>\n<p>\n  Thanks,<br/>\n  {APP_NAME} team\n</p>"
      },
      "resetPasswordTemplate": {
        "subject": "Reset your {APP_NAME} password",
        "body": "<p>Hello,</p>\n<p>Click on the button below to reset your password.</p>\n<p>\n  <a class=\"btn\" href=\"{APP_URL}/_/#/auth/confirm-password-reset/{TOKEN}\" target=\"_blank\" rel=\"noopener\">Reset password</a>\n</p>\n<p><i>If you didn't ask to reset your password, you can ignore this email.</i></p>\n<p>\n  Thanks,<br/>\n  {APP_NAME} team\n</p>"
      },
      "confirmEmailChangeTemplate": {
        "subject": "Confirm your {APP_NAME} new email address",
        "body": "<p>Hello,</p>\n<p>Click on the button below to confirm your new email address.</p>\n<p>\n  <a class=\"btn\" href=\"{APP_URL}/_/#/auth/confirm-email-change/{TOKEN}\" target=\"_blank\" rel=\"noopener\">Confirm new email</a>\n</p>\n<p><i>If you didn't ask to change your email address, you can ignore this email.</i></p>\n<p>\n  Thanks,<br/>\n  {APP_NAME} team\n</p>"
      }
    },
    {
      "id": "pbc_2023753168",
      "listRule": "@request.auth.id != \"\"",
      "viewRule": "@request.auth.id != \"\"",
      "createRule": "@collection.leagues.commissioner ?= @request.auth.id",
      "updateRule": "@collection.leagues.commissioner ?= @request.auth.id",
      "deleteRule": "@collection.leagues.commissioner ?= @request.auth.id",
      "name": "players",
      "type": "base",
      "fields": [
        {
          "autogeneratePattern": "[a-z0-9]{15}",
          "hidden": false,
          "id": "text3208210256",
          "max": 15,
          "min": 15,
          "name": "id",
          "pattern": "^[a-z0-9]+$",
          "presentable": false,
          "primaryKey": true,
          "required": true,
          "system": true,
          "type": "text"
        },
        {
          "autogeneratePattern": "",
          "hidden": false,
          "id": "text1579384326",
          "max": 0,
          "min": 0,
          "name": "name",
          "pattern": "",
          "presentable": false,
          "primaryKey": false,
          "required": false,
          "system": false,
          "type": "text"
        },
        {
          "autogeneratePattern": "",
          "hidden": false,
          "id": "text694999214",
          "max": 0,
          "min": 0,
          "name": "team",
          "pattern": "",
          "presentable": false,
          "primaryKey": false,
          "required": false,
          "system": false,
          "type": "text"
        },
        {
          "autogeneratePattern": "",
          "hidden": false,
          "id": "text11773473172",
          "max": 0,
          "min": 0,
          "name": "position",
          "pattern": "",
          "presentable": false,
          "primaryKey": false,
          "required": false,
          "system": false,
          "type": "text"
        },
        {
          "hidden": false,
          "id": "number377003384",
          "max": null,
          "min": null,
          "name": "bye_week",
          "onlyInt": false,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "number1654915119",
          "max": null,
          "min": null,
          "name": "ecr_vs_adp",
          "onlyInt": false,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "number2289690853",
          "max": null,
          "min": null,
          "name": "rank",
          "onlyInt": false,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "number2615264955",
          "max": null,
          "min": null,
          "name": "position_rank",
          "onlyInt": false,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "number614373258",
          "max": null,
          "min": null,
          "name": "tier",
          "onlyInt": false,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "number243487116",
          "max": null,
          "min": null,
          "name": "projected_auction_value",
          "onlyInt": false,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "number1675371831",
          "max": null,
          "min": null,
          "name": "actual_auction_value",
          "onlyInt": false,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "number2191481077",
          "max": null,
          "min": null,
          "name": "sos",
          "onlyInt": false,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "bool304342663",
          "name": "is_rookie",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "bool"
        },
        {
          "hidden": false,
          "id": "autodate2990389176",
          "name": "created",
          "onCreate": true,
          "onUpdate": false,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "hidden": false,
          "id": "autodate3332085495",
          "name": "updated",
          "onCreate": true,
          "onUpdate": true,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "autogeneratePattern": "",
          "hidden": false,
          "id": "text132147209",
          "max": 0,
          "min": 0,
          "name": "sleeper_id",
          "pattern": "",
          "presentable": false,
          "primaryKey": false,
          "required": false,
          "system": false,
          "type": "text"
        },
        {
          "autogeneratePattern": "",
          "hidden": false,
          "id": "text1920974734",
          "max": 0,
          "min": 0,
          "name": "espn_id",
          "pattern": "",
          "presentable": false,
          "primaryKey": false,
          "required": false,
          "system": false,
          "type": "text"
        },
        {
          "autogeneratePattern": "",
          "hidden": false,
          "id": "text3962025260",
          "max": 0,
          "min": 0,
          "name": "fantasypros_id",
          "pattern": "",
          "presentable": false,
          "primaryKey": false,
          "required": false,
          "system": false,
          "type": "text"
        },
        {
          "autogeneratePattern": "",
          "hidden": false,
          "id": "text711185430",
          "max": 0,
          "min": 0,
          "name": "gsis_id",
          "pattern": "",
          "presentable": false,
          "primaryKey": false,
          "required": false,
          "system": false,
          "type": "text"
        },
        {
          "autogeneratePattern": "",
          "hidden": false,
          "id": "text2478702347",
          "max": 0,
          "min": 0,
          "name": "birth_date",
          "pattern": "",
          "presentable": false,
          "primaryKey": false,
          "required": false,
          "system": false,
          "type": "text"
        }
      ],
      "indexes": [
        "CREATE UNIQUE INDEX `idx_players_gsis_id` ON `players` (`gsis_id`) WHERE gsis_id != ''"
      ],
      "created": "2025-08-03 02:43:49.159Z",
      "updated": "2026-07-17 00:16:59.510Z",
      "system": false
    },
    {
      "id": "pbc_3148758976",
      "listRule": "@request.auth.id != \"\"",
      "viewRule": "@request.auth.id != \"\"",
      "createRule": "@request.auth.id != \"\" && (league = \"\" || league.commissioner = @request.auth.id) && @collection.leagues.commissioner ?= @request.auth.id",
      "updateRule": "league.commissioner = @request.auth.id",
      "deleteRule": "league.commissioner = @request.auth.id",
      "name": "fantasy_teams",
      "type": "base",
      "fields": [
        {
          "autogeneratePattern": "[a-z0-9]{15}",
          "hidden": false,
          "id": "text3208210256",
          "max": 15,
          "min": 15,
          "name": "id",
          "pattern": "^[a-z0-9]+$",
          "presentable": false,
          "primaryKey": true,
          "required": true,
          "system": true,
          "type": "text"
        },
        {
          "hidden": false,
          "id": "number4066252727",
          "max": null,
          "min": null,
          "name": "draft_order",
          "onlyInt": false,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "autogeneratePattern": "",
          "hidden": false,
          "id": "text3364167062",
          "max": 0,
          "min": 0,
          "name": "name",
          "pattern": "",
          "presentable": false,
          "primaryKey": false,
          "required": false,
          "system": false,
          "type": "text"
        },
        {
          "hidden": false,
          "id": "autodate2990389176",
          "name": "created",
          "onCreate": true,
          "onUpdate": false,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "hidden": false,
          "id": "autodate3332085495",
          "name": "updated",
          "onCreate": true,
          "onUpdate": true,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "cascadeDelete": false,
          "collectionId": "pbc_2567937140",
          "hidden": false,
          "id": "relation1052033816",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "league",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "relation"
        }
      ],
      "indexes": [],
      "created": "2025-08-03 02:44:53.503Z",
      "updated": "2026-07-17 00:16:59.509Z",
      "system": false
    },
    {
      "id": "pbc_2345463699",
      "listRule": "auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id || (auction_id.type = \"official\" && auction_id.league.league_members_via_league.user ?= @request.auth.id)",
      "viewRule": "auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id || (auction_id.type = \"official\" && auction_id.league.league_members_via_league.user ?= @request.auth.id)",
      "createRule": "@request.auth.id != \"\" && auction_id.status = \"active\" && (auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id || (auction_id.type = \"official\" && fantasy_team_id.league = auction_id.league && fantasy_team_id.league_members_via_fantasy_team.user ?= @request.auth.id))",
      "updateRule": "auction_id.status = \"active\" && (auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id)",
      "deleteRule": "auction_id.status = \"active\" && (auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id)",
      "name": "draft_picks",
      "type": "base",
      "fields": [
        {
          "autogeneratePattern": "[a-z0-9]{15}",
          "hidden": false,
          "id": "text3208210256",
          "max": 15,
          "min": 15,
          "name": "id",
          "pattern": "^[a-z0-9]+$",
          "presentable": false,
          "primaryKey": true,
          "required": true,
          "system": true,
          "type": "text"
        },
        {
          "cascadeDelete": false,
          "collectionId": "pbc_3148758976",
          "hidden": false,
          "id": "relation2646504603",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "fantasy_team_id",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "relation"
        },
        {
          "cascadeDelete": false,
          "collectionId": "pbc_2023753168",
          "hidden": false,
          "id": "relation2582050271",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "player_id",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "relation"
        },
        {
          "hidden": false,
          "id": "number4228234225",
          "max": null,
          "min": null,
          "name": "pick_order",
          "onlyInt": true,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "autodate2782324286",
          "name": "timestamp",
          "onCreate": true,
          "onUpdate": false,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "hidden": false,
          "id": "autodate2990389176",
          "name": "created",
          "onCreate": true,
          "onUpdate": false,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "hidden": false,
          "id": "autodate3332085495",
          "name": "updated",
          "onCreate": true,
          "onUpdate": true,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "cascadeDelete": true,
          "collectionId": "pbc_848867609",
          "hidden": false,
          "id": "relation1471738078",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "auction_id",
          "presentable": false,
          "required": true,
          "system": false,
          "type": "relation"
        },
        {
          "hidden": false,
          "id": "number3402113753",
          "max": null,
          "min": null,
          "name": "price",
          "onlyInt": false,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "date683650853",
          "max": "",
          "min": "",
          "name": "drafted_at",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "date"
        }
      ],
      "indexes": [
        "CREATE UNIQUE INDEX `idx_draft_picks_auction_pick_order` ON `draft_picks` (auction_id, pick_order)",
        "CREATE UNIQUE INDEX `idx_draft_picks_auction_player` ON `draft_picks` (auction_id, player_id)"
      ],
      "created": "2025-08-03 02:47:29.602Z",
      "updated": "2026-07-17 00:16:59.507Z",
      "system": false
    },
    {
      "id": "pbc_1344826955",
      "listRule": "user = @request.auth.id",
      "viewRule": "user = @request.auth.id",
      "createRule": "@request.auth.id != \"\" && user = @request.auth.id",
      "updateRule": "user = @request.auth.id",
      "deleteRule": "user = @request.auth.id",
      "name": "watchlist",
      "type": "base",
      "fields": [
        {
          "autogeneratePattern": "[a-z0-9]{15}",
          "hidden": false,
          "id": "text3208210256",
          "max": 15,
          "min": 15,
          "name": "id",
          "pattern": "^[a-z0-9]+$",
          "presentable": false,
          "primaryKey": true,
          "required": true,
          "system": true,
          "type": "text"
        },
        {
          "cascadeDelete": false,
          "collectionId": "pbc_3148758976",
          "hidden": false,
          "id": "relation2646504603",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "fantasy_team_id",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "relation"
        },
        {
          "cascadeDelete": false,
          "collectionId": "pbc_2023753168",
          "hidden": false,
          "id": "relation2582050271",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "player_id",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "relation"
        },
        {
          "hidden": false,
          "id": "number119173238",
          "max": null,
          "min": null,
          "name": "watch_order",
          "onlyInt": false,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "number_market_nudge",
          "max": 2.5,
          "min": 0.4,
          "name": "market_nudge",
          "onlyInt": false,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "autodate2990389176",
          "name": "created",
          "onCreate": true,
          "onUpdate": false,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "hidden": false,
          "id": "autodate3332085495",
          "name": "updated",
          "onCreate": true,
          "onUpdate": true,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "cascadeDelete": true,
          "collectionId": "_pb_users_auth_",
          "hidden": false,
          "id": "relation2375276105",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "user",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "relation"
        }
      ],
      "indexes": [
        "CREATE UNIQUE INDEX `idx_watchlist_player_user` ON `watchlist` (\n  `player_id`,\n  `user`\n)"
      ],
      "created": "2025-08-03 18:37:25.715Z",
      "updated": "2026-07-13 23:24:34.994Z",
      "system": false
    },
    {
      "id": "pbc_848867609",
      "listRule": "user = @request.auth.id || league.commissioner = @request.auth.id || (type = \"official\" && league.league_members_via_league.user ?= @request.auth.id)",
      "viewRule": "user = @request.auth.id || league.commissioner = @request.auth.id || (type = \"official\" && league.league_members_via_league.user ?= @request.auth.id)",
      "createRule": "@request.auth.id != \"\" && user = @request.auth.id && (type != \"official\" || league.commissioner = @request.auth.id)",
      "updateRule": "user = @request.auth.id || league.commissioner = @request.auth.id",
      "deleteRule": "user = @request.auth.id || league.commissioner = @request.auth.id",
      "name": "auctions",
      "type": "base",
      "fields": [
        {
          "autogeneratePattern": "[a-z0-9]{15}",
          "hidden": false,
          "id": "text3208210256",
          "max": 15,
          "min": 15,
          "name": "id",
          "pattern": "^[a-z0-9]+$",
          "presentable": false,
          "primaryKey": true,
          "required": true,
          "system": true,
          "type": "text"
        },
        {
          "autogeneratePattern": "",
          "hidden": false,
          "id": "text1579384326",
          "max": 0,
          "min": 0,
          "name": "name",
          "pattern": "",
          "presentable": false,
          "primaryKey": false,
          "required": true,
          "system": false,
          "type": "text"
        },
        {
          "hidden": false,
          "id": "number3145888567",
          "max": null,
          "min": null,
          "name": "year",
          "onlyInt": true,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "select2063623452",
          "maxSelect": 1,
          "name": "status",
          "presentable": false,
          "required": true,
          "system": false,
          "type": "select",
          "values": [
            "active",
            "completed"
          ]
        },
        {
          "hidden": false,
          "id": "autodate2990389176",
          "name": "created",
          "onCreate": true,
          "onUpdate": false,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "hidden": false,
          "id": "autodate3332085495",
          "name": "updated",
          "onCreate": true,
          "onUpdate": true,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "cascadeDelete": false,
          "collectionId": "_pb_users_auth_",
          "hidden": false,
          "id": "relation2375276105",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "user",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "relation"
        },
        {
          "hidden": false,
          "id": "select2363381545",
          "maxSelect": 1,
          "name": "type",
          "presentable": false,
          "required": true,
          "system": false,
          "type": "select",
          "values": [
            "official",
            "mock"
          ]
        },
        {
          "hidden": false,
          "id": "bool785039888",
          "name": "sim",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "bool"
        },
        {
          "hidden": false,
          "id": "date683650853",
          "max": "",
          "min": "",
          "name": "drafted_at",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "date"
        },
        {
          "cascadeDelete": false,
          "collectionId": "pbc_2567937140",
          "hidden": false,
          "id": "relation1052033816",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "league",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "relation"
        }
      ],
      "indexes": [
        "CREATE UNIQUE INDEX `idx_auctions_active_user_type` ON `auctions` (`user`, `type`) WHERE status = 'active' AND user != ''"
      ],
      "created": "2026-07-08 00:50:11.565Z",
      "updated": "2026-07-17 00:16:59.505Z",
      "system": false
    },
    {
      "id": "pbc_820151840",
      "listRule": "auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id || (auction_id.type = \"official\" && auction_id.league.league_members_via_league.user ?= @request.auth.id)",
      "viewRule": "auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id || (auction_id.type = \"official\" && auction_id.league.league_members_via_league.user ?= @request.auth.id)",
      "createRule": "@request.auth.id != \"\" && (auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id)",
      "updateRule": "(auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id) && auction_id.status = \"active\"",
      "deleteRule": "auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id",
      "name": "auction_teams",
      "type": "base",
      "fields": [
        {
          "autogeneratePattern": "[a-z0-9]{15}",
          "hidden": false,
          "id": "text3208210256",
          "max": 15,
          "min": 15,
          "name": "id",
          "pattern": "^[a-z0-9]+$",
          "presentable": false,
          "primaryKey": true,
          "required": true,
          "system": true,
          "type": "text"
        },
        {
          "cascadeDelete": true,
          "collectionId": "pbc_848867609",
          "hidden": false,
          "id": "relation1471738078",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "auction_id",
          "presentable": false,
          "required": true,
          "system": false,
          "type": "relation"
        },
        {
          "cascadeDelete": false,
          "collectionId": "pbc_3148758976",
          "hidden": false,
          "id": "relation2646504603",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "fantasy_team_id",
          "presentable": false,
          "required": true,
          "system": false,
          "type": "relation"
        },
        {
          "hidden": false,
          "id": "number4066252727",
          "max": null,
          "min": null,
          "name": "draft_order",
          "onlyInt": true,
          "presentable": false,
          "required": true,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "autodate2990389176",
          "name": "created",
          "onCreate": true,
          "onUpdate": false,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "hidden": false,
          "id": "autodate3332085495",
          "name": "updated",
          "onCreate": true,
          "onUpdate": true,
          "presentable": false,
          "system": false,
          "type": "autodate"
        }
      ],
      "indexes": [
        "CREATE UNIQUE INDEX `idx_auction_teams_auction_team` ON `auction_teams` (`auction_id`, `fantasy_team_id`)"
      ],
      "created": "2026-07-08 00:50:11.566Z",
      "updated": "2026-07-17 00:16:59.508Z",
      "system": false
    },
    {
      "id": "pbc_4075535054",
      "listRule": "@request.auth.id != \"\"",
      "viewRule": "@request.auth.id != \"\"",
      "createRule": "@collection.leagues.commissioner ?= @request.auth.id",
      "updateRule": "@collection.leagues.commissioner ?= @request.auth.id",
      "deleteRule": "@collection.leagues.commissioner ?= @request.auth.id",
      "name": "player_seasons",
      "type": "base",
      "fields": [
        {
          "autogeneratePattern": "[a-z0-9]{15}",
          "hidden": false,
          "id": "text3208210256",
          "max": 15,
          "min": 15,
          "name": "id",
          "pattern": "^[a-z0-9]+$",
          "presentable": false,
          "primaryKey": true,
          "required": true,
          "system": true,
          "type": "text"
        },
        {
          "cascadeDelete": true,
          "collectionId": "pbc_2023753168",
          "hidden": false,
          "id": "relation2582050271",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "player_id",
          "presentable": false,
          "required": true,
          "system": false,
          "type": "relation"
        },
        {
          "hidden": false,
          "id": "number3145888567",
          "max": null,
          "min": null,
          "name": "year",
          "onlyInt": true,
          "presentable": false,
          "required": true,
          "system": false,
          "type": "number"
        },
        {
          "autogeneratePattern": "",
          "hidden": false,
          "id": "text3303056927",
          "max": 0,
          "min": 0,
          "name": "team",
          "pattern": "",
          "presentable": false,
          "primaryKey": false,
          "required": false,
          "system": false,
          "type": "text"
        },
        {
          "hidden": false,
          "id": "number2615264955",
          "max": null,
          "min": null,
          "name": "position_rank",
          "onlyInt": true,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "number377003384",
          "max": null,
          "min": null,
          "name": "bye_week",
          "onlyInt": true,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "number2191481077",
          "max": null,
          "min": null,
          "name": "sos",
          "onlyInt": true,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "number1654915119",
          "max": null,
          "min": null,
          "name": "ecr_vs_adp",
          "onlyInt": true,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "number2289690853",
          "max": null,
          "min": null,
          "name": "rank",
          "onlyInt": true,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "number614373258",
          "max": null,
          "min": null,
          "name": "tier",
          "onlyInt": true,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "number243487116",
          "max": null,
          "min": null,
          "name": "projected_auction_value",
          "onlyInt": false,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "number1675371831",
          "max": null,
          "min": null,
          "name": "actual_auction_value",
          "onlyInt": false,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "bool304342663",
          "name": "is_rookie",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "bool"
        },
        {
          "hidden": false,
          "id": "autodate2990389176",
          "name": "created",
          "onCreate": true,
          "onUpdate": false,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "hidden": false,
          "id": "autodate3332085495",
          "name": "updated",
          "onCreate": true,
          "onUpdate": true,
          "presentable": false,
          "system": false,
          "type": "autodate"
        }
      ],
      "indexes": [
        "CREATE UNIQUE INDEX `idx_player_seasons_player_year` ON `player_seasons` (`player_id`, `year`)",
        "CREATE INDEX `idx_player_seasons_year` ON `player_seasons` (`year`)"
      ],
      "created": "2026-07-11 13:27:11.285Z",
      "updated": "2026-07-17 00:16:59.512Z",
      "system": false
    },
    {
      "id": "pbc_2784567756",
      "listRule": "@request.auth.id != \"\"",
      "viewRule": "@request.auth.id != \"\"",
      "createRule": null,
      "updateRule": null,
      "deleteRule": null,
      "name": "player_game_logs",
      "type": "base",
      "fields": [
        {
          "autogeneratePattern": "[a-z0-9]{15}",
          "hidden": false,
          "id": "text3208210256",
          "max": 15,
          "min": 15,
          "name": "id",
          "pattern": "^[a-z0-9]+$",
          "presentable": false,
          "primaryKey": true,
          "required": true,
          "system": true,
          "type": "text"
        },
        {
          "cascadeDelete": true,
          "collectionId": "pbc_2023753168",
          "hidden": false,
          "id": "relation2582050271",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "player_id",
          "presentable": false,
          "required": true,
          "system": false,
          "type": "relation"
        },
        {
          "hidden": false,
          "id": "number4041497513",
          "max": null,
          "min": null,
          "name": "season",
          "onlyInt": true,
          "presentable": false,
          "required": true,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "number1532651968",
          "max": null,
          "min": null,
          "name": "week",
          "onlyInt": true,
          "presentable": false,
          "required": true,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "select177720247",
          "maxSelect": 1,
          "name": "season_type",
          "presentable": false,
          "required": true,
          "system": false,
          "type": "select",
          "values": [
            "REG",
            "POST"
          ]
        },
        {
          "autogeneratePattern": "",
          "hidden": false,
          "id": "text3834632453",
          "max": 0,
          "min": 0,
          "name": "game_id",
          "pattern": "",
          "presentable": false,
          "primaryKey": false,
          "required": true,
          "system": false,
          "type": "text"
        },
        {
          "autogeneratePattern": "",
          "hidden": false,
          "id": "text3303056927",
          "max": 0,
          "min": 0,
          "name": "team",
          "pattern": "",
          "presentable": false,
          "primaryKey": false,
          "required": true,
          "system": false,
          "type": "text"
        },
        {
          "autogeneratePattern": "",
          "hidden": false,
          "id": "text3288623244",
          "max": 0,
          "min": 0,
          "name": "opponent",
          "pattern": "",
          "presentable": false,
          "primaryKey": false,
          "required": true,
          "system": false,
          "type": "text"
        },
        {
          "hidden": false,
          "id": "json1464297386",
          "maxSize": 0,
          "name": "stats",
          "presentable": false,
          "required": true,
          "system": false,
          "type": "json"
        },
        {
          "hidden": false,
          "id": "autodate2990389176",
          "name": "created",
          "onCreate": true,
          "onUpdate": false,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "hidden": false,
          "id": "autodate3332085495",
          "name": "updated",
          "onCreate": true,
          "onUpdate": true,
          "presentable": false,
          "system": false,
          "type": "autodate"
        }
      ],
      "indexes": [
        "CREATE UNIQUE INDEX `idx_player_game_logs_player_game` ON `player_game_logs` (`player_id`, `game_id`)",
        "CREATE INDEX `idx_player_game_logs_player_season_week` ON `player_game_logs` (`player_id`, `season`, `season_type`, `week`)"
      ],
      "created": "2026-07-29 21:18:13.625Z",
      "updated": "2026-07-29 21:18:13.625Z",
      "system": false
    },
    {
      "id": "pbc_3662046271",
      "listRule": "user = @request.auth.id",
      "viewRule": "user = @request.auth.id",
      "createRule": "@request.auth.id != \"\" && user = @request.auth.id",
      "updateRule": "user = @request.auth.id",
      "deleteRule": "user = @request.auth.id",
      "name": "team_profiles",
      "type": "base",
      "fields": [
        {
          "autogeneratePattern": "[a-z0-9]{15}",
          "hidden": false,
          "id": "text3208210256",
          "max": 15,
          "min": 15,
          "name": "id",
          "pattern": "^[a-z0-9]+$",
          "presentable": false,
          "primaryKey": true,
          "required": true,
          "system": true,
          "type": "text"
        },
        {
          "cascadeDelete": true,
          "collectionId": "_pb_users_auth_",
          "hidden": false,
          "id": "relation2375276105",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "user",
          "presentable": false,
          "required": true,
          "system": false,
          "type": "relation"
        },
        {
          "cascadeDelete": false,
          "collectionId": "pbc_3148758976",
          "hidden": false,
          "id": "relation2646504603",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "fantasy_team_id",
          "presentable": false,
          "required": true,
          "system": false,
          "type": "relation"
        },
        {
          "hidden": false,
          "id": "json3421297402",
          "maxSize": 0,
          "name": "overrides",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "json"
        },
        {
          "hidden": false,
          "id": "autodate2990389176",
          "name": "created",
          "onCreate": true,
          "onUpdate": false,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "hidden": false,
          "id": "autodate3332085495",
          "name": "updated",
          "onCreate": true,
          "onUpdate": true,
          "presentable": false,
          "system": false,
          "type": "autodate"
        }
      ],
      "indexes": [
        "CREATE UNIQUE INDEX `idx_team_profiles_user_team` ON `team_profiles` (`user`, `fantasy_team_id`)"
      ],
      "created": "2026-07-15 12:29:54.934Z",
      "updated": "2026-07-15 12:29:54.934Z",
      "system": false
    },
    {
      "id": "pbc_2567937140",
      "listRule": "commissioner = @request.auth.id || league_members_via_league.user ?= @request.auth.id",
      "viewRule": "commissioner = @request.auth.id || league_members_via_league.user ?= @request.auth.id",
      "createRule": null,
      "updateRule": "commissioner = @request.auth.id",
      "deleteRule": null,
      "name": "leagues",
      "type": "base",
      "fields": [
        {
          "autogeneratePattern": "[a-z0-9]{15}",
          "hidden": false,
          "id": "text3208210256",
          "max": 15,
          "min": 15,
          "name": "id",
          "pattern": "^[a-z0-9]+$",
          "presentable": false,
          "primaryKey": true,
          "required": true,
          "system": true,
          "type": "text"
        },
        {
          "autogeneratePattern": "",
          "hidden": false,
          "id": "text1579384326",
          "max": 0,
          "min": 0,
          "name": "name",
          "pattern": "",
          "presentable": false,
          "primaryKey": false,
          "required": true,
          "system": false,
          "type": "text"
        },
        {
          "cascadeDelete": false,
          "collectionId": "_pb_users_auth_",
          "hidden": false,
          "id": "relation3795674786",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "commissioner",
          "presentable": false,
          "required": true,
          "system": false,
          "type": "relation"
        },
        {
          "hidden": false,
          "id": "json3846545605",
          "maxSize": 0,
          "name": "settings",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "json"
        },
        {
          "hidden": false,
          "id": "autodate2990389176",
          "name": "created",
          "onCreate": true,
          "onUpdate": false,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "hidden": false,
          "id": "autodate3332085495",
          "name": "updated",
          "onCreate": true,
          "onUpdate": true,
          "presentable": false,
          "system": false,
          "type": "autodate"
        }
      ],
      "indexes": [],
      "created": "2026-07-16 23:48:02.579Z",
      "updated": "2026-07-16 23:48:02.590Z",
      "system": false
    },
    {
      "id": "pbc_3689070105",
      "listRule": "league.commissioner = @request.auth.id || league.league_members_via_league.user ?= @request.auth.id",
      "viewRule": "league.commissioner = @request.auth.id || league.league_members_via_league.user ?= @request.auth.id",
      "createRule": "@request.auth.id != \"\" && league.commissioner = @request.auth.id",
      "updateRule": "league.commissioner = @request.auth.id",
      "deleteRule": "league.commissioner = @request.auth.id",
      "name": "league_members",
      "type": "base",
      "fields": [
        {
          "autogeneratePattern": "[a-z0-9]{15}",
          "hidden": false,
          "id": "text3208210256",
          "max": 15,
          "min": 15,
          "name": "id",
          "pattern": "^[a-z0-9]+$",
          "presentable": false,
          "primaryKey": true,
          "required": true,
          "system": true,
          "type": "text"
        },
        {
          "cascadeDelete": true,
          "collectionId": "pbc_2567937140",
          "hidden": false,
          "id": "relation1052033816",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "league",
          "presentable": false,
          "required": true,
          "system": false,
          "type": "relation"
        },
        {
          "cascadeDelete": true,
          "collectionId": "_pb_users_auth_",
          "hidden": false,
          "id": "relation2375276105",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "user",
          "presentable": false,
          "required": true,
          "system": false,
          "type": "relation"
        },
        {
          "cascadeDelete": false,
          "collectionId": "pbc_3148758976",
          "hidden": false,
          "id": "relation4253743078",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "fantasy_team",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "relation"
        },
        {
          "cascadeDelete": false,
          "collectionId": "pbc_2452428166",
          "hidden": false,
          "id": "relation_invite_ssu",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "invite",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "relation"
        },
        {
          "hidden": false,
          "id": "autodate2990389176",
          "name": "created",
          "onCreate": true,
          "onUpdate": false,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "hidden": false,
          "id": "autodate3332085495",
          "name": "updated",
          "onCreate": true,
          "onUpdate": true,
          "presentable": false,
          "system": false,
          "type": "autodate"
        }
      ],
      "indexes": [
        "CREATE UNIQUE INDEX `idx_league_members_league_user` ON `league_members` (`league`, `user`)",
        "CREATE UNIQUE INDEX `idx_league_members_league_team` ON `league_members` (`league`, `fantasy_team`)",
        "CREATE UNIQUE INDEX `idx_league_members_invite` ON `league_members` (`invite`) WHERE `invite` != ''"
      ],
      "created": "2026-07-16 23:48:02.582Z",
      "updated": "2026-07-16 23:48:02.587Z",
      "system": false
    },
    {
      "id": "pbc_2452428166",
      "listRule": "league.commissioner = @request.auth.id",
      "viewRule": "league.commissioner = @request.auth.id",
      "createRule": "@request.auth.id != \"\" && league.commissioner = @request.auth.id",
      "updateRule": "league.commissioner = @request.auth.id",
      "deleteRule": "league.commissioner = @request.auth.id",
      "name": "invites",
      "type": "base",
      "fields": [
        {
          "autogeneratePattern": "[a-z0-9]{15}",
          "hidden": false,
          "id": "text3208210256",
          "max": 15,
          "min": 15,
          "name": "id",
          "pattern": "^[a-z0-9]+$",
          "presentable": false,
          "primaryKey": true,
          "required": true,
          "system": true,
          "type": "text"
        },
        {
          "cascadeDelete": true,
          "collectionId": "pbc_2567937140",
          "hidden": false,
          "id": "relation1052033816",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "league",
          "presentable": false,
          "required": true,
          "system": false,
          "type": "relation"
        },
        {
          "autogeneratePattern": "",
          "hidden": false,
          "id": "text1597481275",
          "max": 0,
          "min": 0,
          "name": "token",
          "pattern": "",
          "presentable": false,
          "primaryKey": false,
          "required": true,
          "system": false,
          "type": "text"
        },
        {
          "exceptDomains": null,
          "hidden": false,
          "id": "email3885137012",
          "name": "email",
          "onlyDomains": null,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "email"
        },
        {
          "cascadeDelete": false,
          "collectionId": "pbc_3148758976",
          "hidden": false,
          "id": "relation4253743078",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "fantasy_team",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "relation"
        },
        {
          "cascadeDelete": false,
          "collectionId": "_pb_users_auth_",
          "hidden": false,
          "id": "relation1391357636",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "used_by",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "relation"
        },
        {
          "hidden": false,
          "id": "date2593941644",
          "max": "",
          "min": "",
          "name": "expires",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "date"
        },
        {
          "hidden": false,
          "id": "autodate2990389176",
          "name": "created",
          "onCreate": true,
          "onUpdate": false,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "hidden": false,
          "id": "autodate3332085495",
          "name": "updated",
          "onCreate": true,
          "onUpdate": true,
          "presentable": false,
          "system": false,
          "type": "autodate"
        }
      ],
      "indexes": [
        "CREATE UNIQUE INDEX `idx_invites_token` ON `invites` (`token`)"
      ],
      "created": "2026-07-16 23:48:02.594Z",
      "updated": "2026-07-16 23:48:02.594Z",
      "system": false
    },
    {
      "id": "pbc_1052204641",
      "listRule": "auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id || (auction_id.type = \"official\" && auction_id.league.league_members_via_league.user ?= @request.auth.id)",
      "viewRule": "auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id || (auction_id.type = \"official\" && auction_id.league.league_members_via_league.user ?= @request.auth.id)",
      "createRule": "@request.auth.id != \"\" && user = @request.auth.id && auction_id.status = \"active\" && auction_id.type = \"official\" && (auction_id.user = @request.auth.id || auction_id.league.commissioner = @request.auth.id || (auction_id.type = \"official\" && auction_id.league.league_members_via_league.user ?= @request.auth.id)) && ((action = \"nominate\" && player_id != \"\") || (action = \"clear\" && player_id = \"\"))",
      "updateRule": null,
      "deleteRule": null,
      "name": "auction_nomination_events",
      "type": "base",
      "fields": [
        {
          "autogeneratePattern": "[a-z0-9]{15}",
          "hidden": false,
          "id": "text3208210256",
          "max": 15,
          "min": 15,
          "name": "id",
          "pattern": "^[a-z0-9]+$",
          "presentable": false,
          "primaryKey": true,
          "required": true,
          "system": true,
          "type": "text"
        },
        {
          "cascadeDelete": true,
          "collectionId": "pbc_848867609",
          "hidden": false,
          "id": "relation1471738078",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "auction_id",
          "presentable": false,
          "required": true,
          "system": false,
          "type": "relation"
        },
        {
          "cascadeDelete": false,
          "collectionId": "pbc_2023753168",
          "hidden": false,
          "id": "relation2582050271",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "player_id",
          "presentable": false,
          "required": false,
          "system": false,
          "type": "relation"
        },
        {
          "cascadeDelete": true,
          "collectionId": "_pb_users_auth_",
          "hidden": false,
          "id": "relation2375276105",
          "maxSelect": 1,
          "minSelect": 0,
          "name": "user",
          "presentable": false,
          "required": true,
          "system": false,
          "type": "relation"
        },
        {
          "hidden": false,
          "id": "select1204587666",
          "maxSelect": 1,
          "name": "action",
          "presentable": false,
          "required": true,
          "system": false,
          "type": "select",
          "values": [
            "nominate",
            "clear"
          ]
        },
        {
          "hidden": false,
          "id": "autodate2990389176",
          "name": "created",
          "onCreate": true,
          "onUpdate": false,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "hidden": false,
          "id": "autodate3332085495",
          "name": "updated",
          "onCreate": true,
          "onUpdate": true,
          "presentable": false,
          "system": false,
          "type": "autodate"
        },
        {
          "hidden": false,
          "id": "number3023184564",
          "max": null,
          "min": 1,
          "name": "event_order",
          "onlyInt": true,
          "presentable": false,
          "required": true,
          "system": false,
          "type": "number"
        },
        {
          "hidden": false,
          "id": "number2364894219",
          "max": null,
          "min": 0,
          "name": "pick_count",
          "onlyInt": true,
          "presentable": false,
          "required": false,
          "system": false,
          "type": "number"
        }
      ],
      "indexes": [
        "CREATE INDEX `idx_auction_nomination_events_latest` ON `auction_nomination_events` (`auction_id`, `created`)",
        "CREATE UNIQUE INDEX `idx_auction_nomination_events_order` ON `auction_nomination_events` (auction_id, event_order)"
      ],
      "created": "2026-07-17 02:03:16.534Z",
      "updated": "2026-07-17 02:39:53.957Z",
      "system": false
    }
  ];

  // deleteMissing=false => upsert; creates on empty, reconciles on existing, drops nothing.
  app.importCollections(snapshot, false);
}, (app) => {
  // no-op: see header. A baseline is not reversible without destroying shared schema/data.
});
