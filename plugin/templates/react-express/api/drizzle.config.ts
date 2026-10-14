import { defineConfig } from "drizzle-kit";

// `npm run db:generate` writes a numbered SQL migration to ./drizzle after a
// schema change; `npm run db:check` catches migrations that collide.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
