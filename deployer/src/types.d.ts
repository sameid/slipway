import type { User } from "./db/schema.js";

declare module "express-session" {
  interface SessionData {
    userId?: number;
    csrf?: string;
    flash?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      /** Signed-in dashboard user. */
      user?: User;
      /** GitHub login of a plugin API caller. */
      login?: string;
    }
  }
}

export {};
