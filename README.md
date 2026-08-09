<a id="readme-top"></a>

<div align="center">
  <a href="https://github.com/nicholas-fierro/fantasy-auction-app">
    <img src="public/icon.svg" alt="Fantasy Football Draft Helper logo" width="96" height="96">
  </a>

  <h3 align="center">Fantasy Football Draft Helper</h3>

  <p align="center">
    A live draft-day command center for auction, snake, or hybrid fantasy football drafts.
    <br />
    <a href="#about-the-project"><strong>Explore the project »</strong></a>
    <br />
    <br />
  </p>
</div>

<div align="center">

[![Next.js][Next.js-shield]][Next.js-url]
[![React][React-shield]][React-url]
[![TypeScript][TypeScript-shield]][TypeScript-url]
[![PocketBase][PocketBase-shield]][PocketBase-url]
[![Issues][Issues-shield]][Issues-url]

</div>

<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About the Project</a>
      <ul>
        <li><a href="#features">Features</a></li>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
        <li><a href="#pocketbase-setup">PocketBase Setup</a></li>
      </ul>
    </li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#architecture">Architecture</a></li>
    <li><a href="#data-workflows">Data Workflows</a></li>
    <li><a href="#testing">Testing</a></li>
    <li><a href="#deployment">Deployment</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#contact">Contact</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>

## About the Project

Fantasy Football Draft Helper is a multi-user draft room built for a 12-team, half-PPR league. It supports a $200 auction across seven paid roster slots, followed by snake rounds, while tracking budgets, rosters, nominations, values, and draft history in real time.

Unlike generic draft tools, projected prices are trained on the league's own official auction history from 2018–2025. The app also includes deterministic AI mock drafts, player usage and scoring analysis, tier-cliff alerts, and live target-price estimates.

### Features

- Live multi-user auction rooms synchronized through PocketBase realtime events
- Auction and snake draft formats in one draft flow
- League-specific projected auction values based on historical prices
- Live target-price estimates, max-bid guardrails, and budget pressure insights
- Deterministic AI mock drafts with per-team profiles
- Player rankings, injuries, news, game logs, usage signals, and watchlists
- Historical draft analysis across official league auctions
- Commissioner-managed leagues, invitations, team assignments, and imports
- Installable progressive web app with mobile navigation

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

- [![Next.js][Next.js-shield]][Next.js-url]
- [![React][React-shield]][React-url]
- [![TypeScript][TypeScript-shield]][TypeScript-url]
- [![Tailwind CSS][Tailwind-shield]][Tailwind-url]
- [![PocketBase][PocketBase-shield]][PocketBase-url]
- [![TanStack Query][TanStack-shield]][TanStack-url]
- [![Radix UI][Radix-shield]][Radix-url]
- [![Vitest][Vitest-shield]][Vitest-url]

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Getting Started

Run the Next.js frontend and PocketBase backend locally.

### Prerequisites

- Node.js 22.x
- npm
- A local [PocketBase](https://pocketbase.io/) installation

### Installation

1. Clone the repository.

   ```sh
   git clone https://github.com/nicholas-fierro/fantasy-auction-app.git
   cd fantasy-auction-app
   ```

2. Install packages.

   ```sh
   npm install
   ```

3. Create local environment configuration.

   ```sh
   cp .env.example .env
   ```

4. Update `.env` if PocketBase does not use the default local address.

   ```dotenv
   NEXT_PUBLIC_POCKETBASE_URL=http://127.0.0.1:8090
   POCKETBASE_URL=http://127.0.0.1:8090
   FANTASYPROS_API_KEY=
   ```

   `FANTASYPROS_API_KEY` is optional for local development. It enables the FantasyPros comparison panel.

5. Start the development server.

   ```sh
   npm run dev
   ```

6. Open [http://localhost:3000](http://localhost:3000).

### PocketBase Setup

PocketBase is required for the app to run. This project expects a local instance at `~/Pocketbase/main` by default.

```sh
cd ~/Pocketbase/main
./pocketbase serve
```

PocketBase will be available at [http://127.0.0.1:8090](http://127.0.0.1:8090).

Canonical migrations and hooks live in this repository:

- `pb_migrations/` contains collection schemas, indexes, and API rules.
- `pb_hooks/` contains server-side draft, permission, admin, and rate-limit behavior.

Copy migrations and hooks into the matching directories under `~/Pocketbase/main`, then restart PocketBase. PocketBase applies migrations at startup and caches its schema in memory.

> [!IMPORTANT]
> Any schema-changing migration must also be reflected in `pb_migrations/1784300000_baseline_full.js`. Integration tests compare an instance built from the baseline with one built from the incremental migration chain.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Usage

### Pre-draft preparation

Commissioners can refresh draft data from the import view:

1. Import the FantasyPros half-PPR cheat sheet CSV.
2. Import the rookies CSV.
3. Run **Sync player IDs** so new players receive provider IDs, headshots, injuries, and comparison data.
4. Run **Recalculate Projected Prices** after every rankings import because estimates depend on current rank.

### Live draft

Create an official auction and invite league members into the shared draft room. Nominations and picks stream to connected clients through PocketBase realtime subscriptions.

Budget guardrails reserve at least $1 for every remaining paid roster slot. Completed auctions are immutable. Undo only removes the latest pick from an active auction and requires confirmation.

### Mock draft

Create a mock auction with simulation enabled. When the auction includes the user's team, the local AI engine handles opponent nominations, auction bidding, and snake-round selections using per-team profiles.

### Command-line data jobs

Data scripts live in `scripts/` and document their supported flags in each file header.

```sh
set -a
source .env
set +a
npx tsx scripts/<name>.ts
```

Standalone scripts do not load `.env` automatically. Player-stat bootstrap jobs are dry-run-first: sync IDs, repair reviewed identities, sync IDs again, then import game logs. Review every generated report before rerunning without `--dry-run`.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Architecture

The browser talks directly to PocketBase through the SDK singleton in `src/lib/pb-client.ts`. Routine reads and writes do not pass through a Next.js server-side data layer.

- **Authorization:** PocketBase API rules are the primary security boundary. Auction, pick, team, and watchlist access is scoped by user, league membership, role, and auction status.
- **Server state:** TanStack Query owns client-side server state. PocketBase realtime subscriptions patch the query cache directly.
- **Query layer:** Hooks in `src/hooks/` expose reads and mutations to components.
- **Authentication:** Login uses PocketBase client-side authentication. A server action mirrors the token into an HTTP-only `pb_auth` cookie for middleware and server actions. Logout and unauthorized responses clear both stores.
- **Server-only work:** CSV imports, auction lifecycle operations, invite signup, session synchronization, and authenticated external-service proxies remain server-side.
- **UI shell:** `NavigationContext` switches views inside a single-page application shell rather than route-per-view navigation.

Key domain modules:

- `src/lib/roster.ts` — roster construction, league defaults, and max-bid math
- `src/lib/value-model.ts` — historical comparable-player model for projected values
- `src/lib/estimated-value.ts` — live target-price estimates using shared comparable logic
- `src/lib/draft-insights.ts` — tier cliffs, pace, recency, and budget pressure
- `src/lib/mock-draft/` — deterministic auction and snake simulation engine
- `src/lib/fantasy-scoring.ts` — fantasy scoring derived from raw game-log inputs

Read [`ARCHITECTURE_DECISIONS.md`](ARCHITECTURE_DECISIONS.md) before changing data flow, authentication, authorization, or the value model.

More detail:

- [Data sources](docs/data-sources.md)
- [Auction value methodology and backtest](docs/auction-value-model.md)
- [Multi-user design](docs/multi-user-plan.md)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Data Workflows

Project data comes from three categories:

- **Live services:** Sleeper injuries, ESPN news, FantasyPros comparisons, and provider-hosted headshots
- **Imported snapshots:** FantasyPros rankings, nflverse weekly stats and snap counts, provider ID mappings, and private league auction history
- **Derived data:** Projected auction values, target prices, usage signals, scoring totals, tier cliffs, and draft insights

Only official auction prices contribute to historical value estimates. Player game logs join through canonical `gsis_id` values, never player names.

See [`docs/data-sources.md`](docs/data-sources.md) for freshness, ownership, and join-key details.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Testing

Run full validation before submitting changes:

```sh
npm test
npm run test:integration
npm run build
npm run lint
```

Additional commands:

```sh
npm run test:watch
npx vitest run src/lib/mock-draft/mock-draft.test.ts
npx vitest run src/lib/mock-draft/mock-draft.test.ts -t "test name"
```

`npm run build` is the best full type-check. Integration tests start a temporary PocketBase instance and verify that the baseline schema matches the incremental migration chain.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Deployment

The Next.js app is designed for Vercel. PocketBase is deployed separately behind HTTPS.

Production requires HTTPS values for both PocketBase environment variables:

```dotenv
NEXT_PUBLIC_POCKETBASE_URL=https://pocketbase.example.com
POCKETBASE_URL=https://pocketbase.example.com
```

Production infrastructure and migration procedures are intentionally kept outside this public repository.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## License

No open-source license has been added yet. Copyright remains with the repository owner unless a license is added later.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Contact

Nicholas Fierro — [@nicholas-fierro](https://github.com/nicholas-fierro)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Acknowledgments

- [Best-README-Template](https://github.com/othneildrew/Best-README-Template)
- [FantasyPros](https://www.fantasypros.com/)
- [Sleeper](https://sleeper.com/)
- [nflverse](https://github.com/nflverse)
- [PocketBase](https://pocketbase.io/)
- [shadcn/ui](https://ui.shadcn.com/)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

[Next.js-shield]: https://img.shields.io/badge/Next.js-15-black?style=for-the-badge&logo=next.js&logoColor=white
[Next.js-url]: https://nextjs.org/
[React-shield]: https://img.shields.io/badge/React-19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB
[React-url]: https://react.dev/
[TypeScript-shield]: https://img.shields.io/badge/TypeScript-strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white
[TypeScript-url]: https://www.typescriptlang.org/
[Tailwind-shield]: https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white
[Tailwind-url]: https://tailwindcss.com/
[PocketBase-shield]: https://img.shields.io/badge/PocketBase-0.26-B8DBE4?style=for-the-badge&logo=pocketbase&logoColor=black
[PocketBase-url]: https://pocketbase.io/
[TanStack-shield]: https://img.shields.io/badge/TanStack_Query-5-FF4154?style=for-the-badge&logo=reactquery&logoColor=white
[TanStack-url]: https://tanstack.com/query/latest
[Radix-shield]: https://img.shields.io/badge/Radix_UI-components-161618?style=for-the-badge&logo=radixui&logoColor=white
[Radix-url]: https://www.radix-ui.com/
[Vitest-shield]: https://img.shields.io/badge/Vitest-4-6E9F18?style=for-the-badge&logo=vitest&logoColor=white
[Vitest-url]: https://vitest.dev/
[Issues-shield]: https://img.shields.io/github/issues/nicholas-fierro/fantasy-auction-app.svg?style=for-the-badge
[Issues-url]: https://github.com/nicholas-fierro/fantasy-auction-app/issues
