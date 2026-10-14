import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Db } from "./client.js";

// drizzle/ sits at the package root, two levels above both src/db and dist/db.
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder });
}
