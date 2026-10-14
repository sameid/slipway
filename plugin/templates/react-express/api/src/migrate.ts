import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./db/client.js";

// Runs as a one-off ECS task before the service switches to a new release.
// Drizzle records applied migrations, so re-running is a no-op.
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

try {
  console.log(`migrate: applying migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations");
  console.log(`migrate: done, ${rows[0].n} migration(s) applied in total`);
} catch (err) {
  console.error("migrate: failed", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
