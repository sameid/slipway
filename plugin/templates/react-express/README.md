# __APP_NAME__

__APP_DESCRIPTION__

Owner: @__APP_OWNER__. Built on slipway: React, TanStack Query, HeroUI and Tailwind in `web/`, Express and Drizzle on Postgres in `api/`. There's no sign-in, so anyone with the app's link can use it; add authentication before it holds anything private.

## Make changes

Ask Claude Code for a feature, fix or tweak. It works in its own worktree, so you can run several tasks at once. When it's done, run `/ship`: it opens a pull request, the deployer merges it once a quick check passes (app.yaml and a secret scan), and staging updates a few minutes later. Before prod, someone presses Verify on the deployer dashboard, which runs typecheck, lint and tests, then Promote. Preview every change on staging; there's nothing to run on your laptop.

- `/status` shows what's on staging and prod.
- Promote a staging release to prod from the deployer dashboard.
- `/secret set <KEY> --env staging` gives you a one-time link to set an API key; the deployer dashboard's secrets page sets several at once. Names the code needs go under `secrets:` in `app.yaml`, so a deploy without them fails early.

See `CLAUDE.md` for the conventions Claude follows in this repo.
