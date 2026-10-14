// Bootstrap the first admin account (design 5.5). On the instance, through SSM
// Session Manager:
//   sudo /opt/slipway/bin/create-admin --email you@example.com --name "Your Name"
// Prints a temporary password; the admin chooses their own at first sign-in.
// --reset gives an existing account a new temporary password and makes it an
// admin, for when every admin is locked out.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { hashPassword, temporaryPassword } from "../auth/passwords.js";
import { openDb } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { users } from "../db/schema.js";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
    reset: { type: "boolean", default: false },
  },
});
const email = values.email?.trim().toLowerCase();
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || (!values.reset && !values.name?.trim())) {
  console.error('Usage: create-admin --email you@example.com --name "Your Name" [--reset]');
  process.exit(2);
}

const db = openDb(join(process.env.DATA_DIR ?? "./data", "deployer.db"));
runMigrations(db);
const password = temporaryPassword();
const passwordHash = await hashPassword(password);
const existing = db.select().from(users).where(eq(users.email, email)).get();

if (existing && !values.reset) {
  console.error(`${email} already has an account. Use --reset to give it a new temporary password.`);
  process.exit(1);
}
if (existing) {
  db.update(users)
    .set({ passwordHash, mustChangePassword: true, isAdmin: true, disabled: false })
    .where(eq(users.id, existing.id))
    .run();
  console.log(`Reset ${email}; it's an enabled admin again.`);
} else {
  db.insert(users)
    .values({
      email,
      name: values.name!.trim(),
      passwordHash,
      isAdmin: true,
      mustChangePassword: true,
      createdAt: new Date().toISOString(),
    })
    .run();
  console.log(`Created admin ${email}.`);
}
console.log(`Temporary password (shown once): ${password}`);
console.log("Sign in to the dashboard with it; you'll be asked to choose your own.");
db.$client.close();
