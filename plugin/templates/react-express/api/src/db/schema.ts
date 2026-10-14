import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Local copy of each Clerk user, created on their first request (see auth.ts).
export const users = pgTable("users", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  clerkId: text("clerk_id").notNull().unique(),
  email: text(),
  name: text(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
