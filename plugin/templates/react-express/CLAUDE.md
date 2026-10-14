# __APP_NAME__

__APP_DESCRIPTION__

An internal app on the slipway platform: React, TanStack Query, HeroUI and Tailwind (Vite) in `web/`; Express and Drizzle on Postgres in `api/`; sign-in by Clerk. Every merge to `main` deploys to staging. Prod is promoted from the deployer dashboard by a person.

## How to work

- Every feature, fix or enhancement gets its own git worktree and branch (the `coding-agent` skill sets this up). Never work in the main checkout; it stays on `main`.
- Finish with `/ship`. It commits, rebases onto `main`, opens or updates the PR, and waits for the check, the auto-merge and the staging deploy. Never push to `main`.
- There's no local database and the app isn't run locally. Check your work with tests, typecheck and lint; the colleague previews it on staging once `/ship` has merged it.
- Add or update tests with every change (Vitest: see `api/src/app.test.ts` and `web/src/App.test.tsx`). Tests never touch a database: mock `./db/client.js` the way `api/src/app.test.ts` does.
- Before shipping, run `npm run typecheck`, `npm run lint` and `npm test`, plus `npm run db:check -w api` if the schema changed. The PR check runs the same commands, a secret scan, the Docker build and the frontend build. A failing check blocks the merge.

## Commands

| Command | What it does |
|---|---|
| `npm test`, `npm run typecheck`, `npm run lint` | What the PR check runs |
| `npm run db:generate -w api` | Write a migration after changing `api/src/db/schema.ts` |
| `npm run db:check -w api` | Check that migrations don't collide |

## Layout

```
app.yaml                 app manifest: name, secrets, platform settings
api/src/app.ts           Express app: /api/health, clerkMiddleware(), routers, 404 and error handlers
api/src/index.ts         starts the server
api/src/auth.ts          requireUser: 401 when signed out, sets req.user (the local users row)
api/src/routes/          one router per area, mounted under /api in app.ts
api/src/db/schema.ts     Drizzle schema
api/src/db/client.ts     connection pool (do not change how credentials are read)
api/src/migrate.ts       runs migrations; the platform runs it before each deploy
api/drizzle/             generated SQL migrations (committed)
web/src/main.tsx         loads /config.json, then ClerkProvider and QueryClientProvider
web/src/api.ts           useApi() and every TanStack Query hook
web/src/App.tsx          signed out: <SignIn />; signed in: the app and <UserButton />
web/src/index.css        Tailwind and HeroUI styles
```

## API conventions

- Every route lives under `/api`, in a router in `api/src/routes/`, mounted in `app.ts` after `clerkMiddleware()`.
- Every route except `/api/health` uses `requireUser`. A public route is a deliberate decision: put it above `clerkMiddleware()` in `app.ts` with a comment saying why.
- App tables reference `req.user.id` (the local `users` row), never the Clerk user id.
- Signing in only proves the user is a colleague. Who may see or change what is this app's job: check ownership or roles in its own tables.
- Errors are JSON (`{ "error": "..." }`) with the right status code. Don't use Clerk's `requireAuth()`; it redirects instead of returning 401.
- Don't call Clerk's Backend API per request. Its rate limit is shared by every app; use the local `users` table.
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
- Signed-out users see Clerk's `<SignIn />`; don't build custom sign-in pages.
- Client-side routes work on refresh: the platform serves `index.html` for paths that aren't files.

## Secrets

- Third-party keys (Stripe, OpenAI, ...) are read from `process.env` in the API, never in the frontend.
- Declare each name under `secrets:` in `app.yaml`, and give it a fake value in tests (`vi.stubEnv`). Then tell the colleague to run `/secret set <KEY> --env staging` (and `prod`). The deploy fails until the value is set for that environment.
- Values never go in code, commits, `app.yaml` or this conversation.

## Don't change

The plugin's hooks block these edits, and the deployer won't auto-merge a PR that makes them:

- `.github/` and `CODEOWNERS`.
- The platform-owned fields in `app.yaml`: `name`, `auth`, `auto_merge`, `sizes`. Leave the `api:` and `web:` sections alone too unless the dev team asks.

This repo holds no Terraform, CI workflows or build scripts. Infrastructure and deploys live in `sameid/slipway`.
