import { Router } from "express";
import { desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { notes } from "../db/schema.js";

export const notesRouter = Router();

const MAX_LENGTH = 500;

// The template's sample feature: a public list of short notes. There's no
// sign-in, so anyone with the app's link can read and add them.
notesRouter.get("/notes", async (_req, res) => {
  const rows = await db.query.notes.findMany({ orderBy: [desc(notes.id)], limit: 50 });
  res.json({ notes: rows });
});

notesRouter.post("/notes", async (req, res) => {
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body || body.length > MAX_LENGTH) {
    res.status(400).json({ error: `body must be 1 to ${MAX_LENGTH} characters` });
    return;
  }
  const [note] = await db.insert(notes).values({ body }).returning();
  res.status(201).json({ note });
});
