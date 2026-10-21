---
name: slipway-stack
description: House conventions for slipway apps (React + TanStack Query + HeroUI + Tailwind, Express + Drizzle + Postgres, no sign-in by default). Use whenever you write or change code in a repo with an app.yaml that has a template key, including API routes, database schema and migrations, frontend data fetching, auth, tests and third-party keys.
---

# slipway stack conventions

These apps run on the slipway platform. Every merge to `main` deploys to staging after an automated check; a person promotes staging to prod from the deployer dashboard. Nothing in the app repo decides how it's built or deployed, so stick to these conventions and the app's `CLAUDE.md`.

## Shape of an app

- `api/`: Express 5, Drizzle ORM on Postgres (`node-postgres`). `web/`: React, TanStack Query, HeroUI v3 (`@heroui/react`), Tailwind, Vite. npm workspaces with one root `package-lock.json`.
- New apps have no sign-in: every page and `/api` route is public to anyone with the link. The template's `notes` table and routes are a sample to replace.
- `app.yaml` is the manifest. You may edit `description`, `api`, `web` and `secrets`. `name`, `auto_merge` and `sizes` are platform-owned: the plugin's hooks block changes, and the deployer won't auto-merge them. `.github/` and `CODEOWNERS` are off limits too. If one of these really has to change, stop and tell the user: someone in the app's CODEOWNERS changes it by hand.
- No Terraform, CI workflows, Dockerfiles for other services or deploy scripts in the app repo. `api/Dockerfile` exists for the platform's build; leave its base image, user and the RDS CA bundle alone.

## API

- Every route lives under `/api` in a router in `api/src/routes/`, mounted in `api/src/app.ts`.
- Without sign-in, treat every route as public. Don't store or return personal data, internal documents or anything per-user until the app has authentication.
- Sign-in is the user's choice (provider, who may sign in). If a feature needs to know who the user is and the app has no auth yet, stop and ask; don't hand-roll a login. Once an app has auth, do authorization in its own tables (owner columns, roles): being signed in isn't permission. A provider's secret key goes under `secrets:` like any other key; a publishable key can reach the frontend through an API route.
- Return JSON errors (`{ "error": "..." }`) with proper status codes; an auth check returns 401 JSON rather than redirecting.
- Validate request bodies at the route boundary.
- `/api/health` stays public, returns 200 only when the database is reachable, and keeps its `{ ok, release, migrations }` shape.
- Don't change how `api/src/db/client.ts` reads database credentials: it fetches the rotating RDS password from Secrets Manager in staging and prod.

## Database

- Change `api/src/db/schema.ts`, then `npm run db:generate -w api`, and commit the schema with the generated `api/drizzle/` files. Never edit a migration that's already on `main`.
- Migrations are additive and backward compatible: new tables, nullable columns or columns with defaults, indexes. The previous release keeps running against the new schema during a deploy, and rollbacks run old code against it. Rename or drop in two releases: stop using it first, drop it later.
- No `CREATE INDEX CONCURRENTLY` or anything else that can't run in a transaction.
- Never run migrations yourself; the platform runs them before each deploy to staging and prod. There's no local database.

## Frontend

- All server state goes through TanStack Query hooks in `web/src/api.ts` built on `useApi()`. No `fetch` in components.
- Only relative `/api/...` URLs. The same build runs on staging and on prod; the environment and release come from `/config.json` at runtime.
- HeroUI v3 components (`@heroui/react`) for the UI, Tailwind utilities for layout and spacing, and HeroUI's theme colours (`bg-background`, `text-muted`, `text-danger`, ...) instead of fixed palette colours. No other component library. Apps created before the template had HeroUI don't have `@heroui/react` in `web/package.json`; keep to plain Tailwind there unless the user asks to adopt it.
- HeroUI v3 is not v2 (NextUI): compound parts (`Card.Header`, `Alert.Content`), no provider, React Aria props (`onPress`, `isDisabled`), and `variant` instead of `color`. Check https://heroui.com/react/llms.txt rather than relying on v2 examples.

## Tests and checks

- Every change comes with tests (Vitest in both packages; `supertest` for API routes, Testing Library for components). Tests never touch a database: mock `./db/client.js` as `api/src/app.test.ts` does.
- Before `/ship`, run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run db:check -w api` if migrations changed. The PR check runs these plus a secret scan, the Docker build and the frontend build.

## Third-party keys

- Read them from `process.env` in the API only, never in the frontend.
- Declare the name under `secrets:` in `app.yaml`, and give it a fake value in tests (`vi.stubEnv`).
- The user sets staging and prod values with `/secret set <KEY> --env staging|prod`, which opens a one-time browser link. Never ask for, accept or write a secret value in the conversation, code, commits or `app.yaml`. If a user pastes one, don't use it; tell them to rotate it.

## No local running

- Apps don't run on the laptop: there's no local database, dev server or `.env`. Check work with tests, typecheck and lint, and the user previews it on staging once the PR `/ship` opened has merged.
- Work on features in a worktree (the `coding-agent` skill), and finish with `/ship`.
