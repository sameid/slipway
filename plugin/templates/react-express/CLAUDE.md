# __APP_NAME__

__APP_DESCRIPTION__

An app on the slipway platform: React, TanStack Query, HeroUI and Tailwind (Vite) in `web/`; Express and Drizzle on Postgres in `api/`. There's no sign-in: the app is public. Every merge to `main` deploys to staging. Prod is promoted from the deployer dashboard by a person.

## How to work

- Every feature, fix or enhancement gets its own git worktree and branch (the `coding-agent` skill sets this up). Never work in the main checkout; it stays on `main`.
- Finish with `/ship`. It commits, rebases onto `main`, opens or updates the PR and tells the user it's submitted, without waiting; the deployer merges it once its check passes and deploys staging. Never push to `main`.
- There's no local database and the app isn't run locally. Check your work with tests and typecheck; the user previews it on staging once the PR has merged.
- Add or update tests with every change (Vitest: see `api/src/app.test.ts` and `web/src/App.test.tsx`). Tests never touch a database: mock `./db/client.js` the way `api/src/app.test.ts` does.
- Before shipping, run `npm run typecheck` and the tests for what you changed, plus `npm run db:check -w api` if the schema changed. So staging updates fast, the PR check only validates `app.yaml` and scans for secrets, and the release build adds the migrations check and the builds.
- Lint and the full test suite run when someone presses Verify on a release in the deployer dashboard. Prod only takes verified releases, so a failure there blocks Promote until a fix ships: read the verify job's log (`slipway jobs`, `slipway log <id>`), run `npm run lint` and `npm test`, and `/ship` the fix.

## Commands

| Command | What it does |
|---|---|
| `npm test`, `npm run typecheck`, `npm run lint` | What Verify runs before a release can go to prod |
| `npm run db:generate -w api` | Write a migration after changing `api/src/db/schema.ts` |
| `npm run db:check -w api` | Check that migrations don't collide |

## Layout

```
app.yaml                 app manifest: name, secrets, platform settings
api/src/app.ts           Express app: /api/health, routers, 404 and error handlers
api/src/index.ts         starts the server
api/src/routes/          one router per area, mounted under /api in app.ts (notes.ts is the template's sample)
api/src/db/schema.ts     Drizzle schema (the notes table is the template's sample)
api/src/db/client.ts     connection pool (do not change how credentials are read)
api/src/migrate.ts       runs migrations; the platform runs it before each deploy
api/drizzle/             generated SQL migrations (committed)
web/src/main.tsx         loads /config.json (environment and release), then QueryClientProvider
web/src/api.ts           useApi() and every TanStack Query hook
web/src/App.tsx          the app's screens (it starts with the sample notes)
web/src/index.css        Tailwind and HeroUI styles
```

## API conventions

- Every route lives under `/api`, in a router in `api/src/routes/`, mounted in `app.ts`.
- The app has no sign-in, so every route is public: anyone with the link can call it. Don't store or show anything that shouldn't be public (personal data, internal documents, anything per-user) until the app has authentication.
- Adding sign-in is the user's decision: which provider, and who may sign in. If a feature needs to know who the user is, stop and ask; don't build a login of your own. A provider's secret key is a secret like any other (see Secrets); a public (publishable) key can reach the frontend through an API route.
- Errors are JSON (`{ "error": "..." }`) with the right status code.
- `/api/health` stays public, returns 200 only when the database is reachable, and keeps its response shape (the platform checks `release`).

## Database and migrations

- Change `api/src/db/schema.ts`, then run `npm run db:generate -w api`. Commit the schema and the generated files in `api/drizzle/` together. Never edit or delete a migration that is already on `main`.
- Migrations must be additive and backward compatible. During a deploy the previous release keeps running against the new schema, and a rollback runs older code against it. Add tables, nullable columns or columns with defaults, and indexes. To rename or drop something, stop using it in one release and drop it in a later one.
- No `CREATE INDEX CONCURRENTLY` or other statements that can't run inside a transaction.
- Never run migrations against staging or prod. The platform runs them on every deploy, before the new release starts.
- If a rebase onto `main` conflicts in `api/drizzle/`, discard this branch's generated migration and run `npm run db:generate -w api` again on top of `main`.

## Frontend conventions

- All server state goes through TanStack Query hooks in `web/src/api.ts` built on `useApi()`: `useQuery` to read, `useMutation` plus `queryClient.invalidateQueries` to write. No `fetch` calls in components.
- Only relative `/api/...` URLs. The same build runs on staging and on prod.
- Build the UI from HeroUI v3 components (`@heroui/react`: `Button`, `Card`, `Table`, `Modal`, `TextField`, `Select`, `Alert`, `Spinner`, ...). Use Tailwind utilities for layout and spacing. Don't add another component library, and don't hand-roll a component HeroUI already has.
- HeroUI v3 is not v2 (NextUI). It has compound parts (`Card.Header`, `Card.Title`, `Alert.Content`), no provider, React Aria props (`onPress`, `isDisabled`) and `variant` instead of `color` (`<Button variant="primary">`). The docs for agents are at https://heroui.com/react/llms.txt. Ignore examples that use `HeroUIProvider` or `@nextui-org`.
- Use HeroUI's theme colours (`bg-background`, `text-foreground`, `text-muted`, `bg-surface`, `text-accent`, `text-danger`, ...) rather than fixed palette colours like `slate-500`.
- Client-side routes work on refresh: the platform serves `index.html` for paths that aren't files.

## Secrets

- Third-party keys (Stripe, OpenAI, ...) are read from `process.env` in the API, never in the frontend.
- Declare each name the code needs under `secrets:` in `app.yaml`, and give it a fake value in tests (`vi.stubEnv`). Before you `/ship`, ask the user to run `/secret set <KEY> --env staging` (and `prod` before promoting); the name doesn't have to be on `main` first. A deploy fails while a declared name has no value for that environment.
- Values never go in code, commits, `app.yaml` or this conversation.

## Don't change

The plugin's hooks block these edits, and the deployer won't auto-merge a PR that makes them:

- `.github/` and `CODEOWNERS`.
- The platform-owned fields in `app.yaml`: `name`, `auto_merge`, `sizes`. Leave the `api:` and `web:` sections alone too unless the user asks.

This repo holds no Terraform, CI workflows or build scripts. Infrastructure and deploys live in the slipway platform that runs your deployer (https://github.com/sameid/slipway).
