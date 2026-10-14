import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// The template's sample table (see routes/notes.ts). Replace it with the app's own.
export const notes = pgTable("notes", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  body: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Note = typeof notes.$inferSelect;
