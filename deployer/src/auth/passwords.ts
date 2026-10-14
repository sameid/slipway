import { randomBytes } from "node:crypto";
import argon2 from "argon2";

export const MIN_PASSWORD_LENGTH = 12;

export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });

// Verifying against a throwaway hash when the email is unknown keeps response
// times the same, so login timing doesn't reveal which emails have accounts.
let dummy: Promise<string> | undefined;

export async function verifyPassword(hash: string | undefined, password: string): Promise<boolean> {
  dummy ??= hashPassword(randomBytes(16).toString("hex"));
  try {
    return await argon2.verify(hash ?? (await dummy), password);
  } catch {
    return false;
  }
}

/** A temporary password an admin hands over; the user must change it at first login. */
export const temporaryPassword = () => randomBytes(12).toString("base64url");

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 200) return "That password is too long.";
  return null;
}
