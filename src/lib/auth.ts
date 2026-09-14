import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";

const COOKIE_NAME = "mj_admin";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30日

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function createSessionToken(env: Env): Promise<string> {
  const expires = Date.now() + SESSION_TTL_SECONDS * 1000;
  const payload = `admin.${expires}`;
  const sig = await hmac(env.AUTH_SECRET, payload);
  return `${payload}.${sig}`;
}

async function verifySessionToken(env: Env, token: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [role, expiresStr, sig] = parts;
  if (role !== "admin") return false;
  const expires = Number(expiresStr);
  if (!Number.isFinite(expires) || Date.now() > expires) return false;
  const expectedSig = await hmac(env.AUTH_SECRET, `${role}.${expiresStr}`);
  return sig === expectedSig;
}

export async function setAdminSession(c: Context<{ Bindings: Env }>): Promise<void> {
  const token = await createSessionToken(c.env);
  const isHttps = new URL(c.req.url).protocol === "https:";
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearAdminSession(c: Context<{ Bindings: Env }>): void {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

export async function isAdmin(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return false;
  return verifySessionToken(c.env, token);
}

/** 書き込み系ルートを保護するミドルウェア。未ログインなら /login にリダイレクトする。 */
export async function requireAdmin(c: Context<{ Bindings: Env }>, next: Next) {
  if (!(await isAdmin(c))) {
    return c.redirect("/login");
  }
  await next();
}
