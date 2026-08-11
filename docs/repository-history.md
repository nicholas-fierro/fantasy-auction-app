# Repository history

## This repository was published from a private predecessor

The project was built in a private repository and later republished here, in
August 2026, so it could serve as a public portfolio piece. The cutover was not
a rename — it produced a new repository with:

- **Squashed history.** Everything before `Initial public release` is
  intentionally absent. Commits here start at that point.
- **Cleansed data.** Real league, team, and user data was removed. Fixtures and
  sample data are synthetic or belong to the author.
- **No operational documentation.** Deployment, incident, and infrastructure
  runbooks were deliberately left behind and are not in this tree.

**This repository is now canonical.** Development and deployment both happen
from here; the private predecessor is frozen history, not a mirror, and the two
trees have diverged.

## Why the missing history matters when reading the code

A few things look odder than they are because the history that explains them is
not here:

- `ARCHITECTURE_DECISIONS.md` is the substitute for that history. It is the
  decision log, and it is the best available answer to "why is this like this."
- Migrations in `pb_migrations/` reach back further than the commit log does.
  The chain is complete even though the commits are not, and
  `1784300000_baseline_full.js` can rebuild the whole schema from empty.
- Some code comments reference decisions (AD-*) rather than commits or PRs,
  because the commits they would have pointed at no longer exist here.
- Fields marked "frozen legacy" in `AGENTS.md` are the residue of schema
  changes whose migrations are present but whose discussion is not.

## What is deliberately absent, and where it belongs

Operational material is not missing by accident and should not be added:

| Not here | Why |
|---|---|
| Deployment, upgrade, and incident runbooks | Name the production host, its filesystem layout, and its service topology |
| Infrastructure notes (firewall, hosting, uptime, CDN) | Same |
| Production bootstrap and ownership docs | Same |
| Anything with real user or league data | Cleansed at cutover; must stay that way |

These live outside this repository. See the public-repository rules at the top
of `AGENTS.md` for the full statement of what must never be committed here, and
what remains fine to commit — notably that migrations and API rules **are**
committed, because they are the authorization logic and have to stay reviewable.

If you find yourself wanting to add an operational detail "just for
convenience," that is the moment the rules are for.
