import { Router } from "express";
import { requireUser } from "../auth.js";

export const me = Router();

// The signed-in user's local record.
me.get("/me", requireUser, (req, res) => {
  res.json({ user: req.user });
});
