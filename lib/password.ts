import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** Hash della password di ripristino: scrypt con sale casuale. */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 32);
  return `s1$${salt.toString("base64")}$${h.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [v, s, h] = stored.split("$");
  if (v !== "s1" || !s || !h) return false;
  const a = scryptSync(pw, Buffer.from(s, "base64"), 32), b = Buffer.from(h, "base64");
  return a.length === b.length && timingSafeEqual(a, b);
}
