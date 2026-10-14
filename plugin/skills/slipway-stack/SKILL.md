---
name: slipway-stack
description: House conventions for slipway apps (React + TanStack Query + HeroUI + Tailwind, Express + Drizzle + Postgres, Clerk sign-in). Use whenever you write or change code in a repo with an app.yaml that has a template key, including API routes, database schema and migrations, frontend data fetching, auth, tests and third-party keys.
---

# slipway stack conventions

These apps run on the slipway platform. Every merge to `main` deploys to staging after an automated check; a person promotes staging to prod from the deployer dashboard. Nothing in the app repo decides how it's built or deployed, so stick to these conventions and the app's `CLAUDE.md`.

## Shape of an app

- `api/`: Express 5, Drizzle ORM on Postgres (`node-postgres`), `@clerk/express`. `web/`: React, TanStack Query, HeroUI v3 (`@heroui/react`), Tailwind, Vite, `@clerk/react`. npm workspaces with one root `package-lock.json`.
- `app.yaml` is the manifest. You may edit `description`, `api`, `web` and `secrets`. `name`, `auth`, `auto_merge` and `sizes` are platform-owned: the plugin's hooks block changes, and the deployer won't auto-merge them. `.github/` and `CODEOWNERS` are off limits too. If one of these really has to change, stop and tell the colleague to ask the dev team.
- No Terraform, CI workflows, Dockerfiles for other services or deploy scripts in the app repo. `api/Dockerfile` exists for the platform's build; leave its base image, user and the RDS CA bundle alone.

## API

- Every route lives under `/api` in a router in `api/src/routes/`, mounted in `api/src/app.ts` after `clerkMiddleware()`.
- Every route except `/api/health` uses `requireUser`, which returns 401 JSON when signed out and sets `req.user` to the local `users` row. A public route is a deliberate, commented decision.
- Reference `req.user.id` in app tables, never the Clerk user id directly.
- Being signed in only proves the user is a colleague: any colleague can sign in to any app. Do authorization in the app's own tables (owner columns, roles).
- Return JSON errors (`{ "error": "..." }`) with proper status codes. Don't use Clerk's `requireAuth()` (it redirects) and don't call Clerk's Backend API per request (the rate limit is shared by every app).
- Validate request bodies at the route boundary.
- `/api/health` stays public, returns 200 only when the database is reachable, and keeps its `{ ok, release, migrations }` shape.
- Don't change how `api/src/db/client.ts` reads database credentials: it fetches the rotating RDS password from Secrets Manager in staging and prod.

## Database

- Change `api/src/db/schema.ts`, then `npm run db:generate -w api`, and commit the schema with the generated `api/drizzle/` files. Never edit a migration that's already on `main`.
- Migrations are additive and backward compatible: new tables, nullable columns or columns with defaults, indexes. The previous release keeps running against the new schema during a deploy, and rollbacks run old code against it. Rename or drop in two releases: stop using it first, drop it later.
- No `CREATE INDEX CONCURRENTLY` or anything else that can't run in a transaction.
- Never run migrations yourself; the platform runs them before each deploy to staging and prod. There's no local database.

## Frontend

- All server state goes through TanStack Query hooks in `web/src/api.ts` built on `useApi()`, which adds the Clerk session token as `Authorization: Bearer`. No `fetch` in components.
- Only relative `/api/...` URLs. The same build runs locally, on staging and on prod; per-environment settings come from `/config.json` at runtime.
- HeroUI v3 components (`@heroui/react`) for the UI, Tailwind utilities for layout and spacing, and HeroUI's theme colours (`bg-background`, `text-muted`, `text-danger`, ...) instead of fixed palette colours. No other component library. Apps created before the template had HeroUI don't have `@heroui/react` in `web/package.json`; keep to plain Tailwind there unless the colleague asks to adopt it.
- HeroUI v3 is not v2 (NextUI): compound parts (`Card.Header`, `Alert.Content`), no provider, React Aria props (`onPress`, `isDisabled`), and `variant` instead of `color`. Check https://heroui.com/react/llms.txt rather than relying on v2 examples.
- Clerk's `<SignIn />` and `<UserButton />` for auth UI.

## Tests and checks

- Every change comes with tests (Vitest in both packages; `supertest` for API routes, Testing Library for components). Tests never touch a database: mock `./db/client.js` as `api/src/app.test.ts` does.
- Before `/ship`, run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run db:check -w api` if migrations changed. The PR check runs these plus a secret scan, the Docker build and the frontend build.

## Third-party keys

- Read them from `process.env` in the API only, never in the frontend.
- Declare the name under `secrets:` in `app.yaml`, and give it a fake value in tests (`vi.stubEnv`).
- The colleague sets staging and prod values with `/secret set <KEY> --env staging|prod`, which opens a one-time browser link. Never ask for, accept or write a secret value in the conversation, code, commits or `app.yaml`. If a colleague pastes one, don't use it; tell them to rotate it.

## No local running

- Apps don't run on the laptop: there's no local database, dev server or `.env`. Check work with tests, typecheck and lint, and the colleague previews it on staging after `/ship` merges it.
- Work on features in a worktree (the `coding-agent` skill), and finish with `/ship`.
