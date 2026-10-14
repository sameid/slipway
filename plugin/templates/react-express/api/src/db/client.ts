import fs from "node:fs";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import * as schema from "./schema.js";

// Deployed: DB_HOST/DB_PORT/DB_NAME plus DB_SECRET_ARN, the RDS-managed master
// secret. RDS rotates that password, so it's read at connect time rather than
// injected at startup. Locally: DATABASE_URL.

const CACHE_MS = 5 * 60 * 1000;
const secrets = new SecretsManagerClient({});
let cached: { username: string; password: string; fetchedAt: number } | undefined;

async function credentials() {
  if (!cached || Date.now() - cached.fetchedAt > CACHE_MS) {
    const res = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN }));
    const { username, password } = JSON.parse(res.SecretString ?? "{}");
    cached = { username, password, fetchedAt: Date.now() };
  }
  return cached;
}

// Called on a Postgres auth failure (28P01) so the next connection re-reads the secret.
export function forgetCredentials() {
  cached = undefined;
}

async function createPool() {
  if (process.env.DATABASE_URL) {
    return new pg.Pool({ connectionString: process.env.DATABASE_URL });
  }
  const { username } = await credentials();
  return new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: username,
    password: async () => (await credentials()).password,
    // RDS Postgres requires TLS; the CA bundle is baked into the image.
    ssl: process.env.DB_SSL_CA ? { ca: fs.readFileSync(process.env.DB_SSL_CA, "utf8") } : undefined,
    max: 5,
  });
}

export const pool = await createPool();
export const db = drizzle(pool, { schema });
