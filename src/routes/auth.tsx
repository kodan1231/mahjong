import { Hono } from "hono";
import type { Env } from "../types";
import { Layout } from "../views/layout";
import { setAdminSession, clearAdminSession, isAdmin } from "../lib/auth";

export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.get("/login", async (c) => {
  const admin = await isAdmin(c);
  if (admin) return c.redirect("/");

  const error = c.req.query("error");
  return c.html(
    <Layout title="管理者ログイン" isAdmin={false}>
      <h1>管理者ログイン</h1>
      {error && <p class="warning">パスワードが違います</p>}
      <form class="stack" method="post" action="/login">
        <label for="password">共有パスワード</label>
        <input type="password" id="password" name="password" required autofocus />
        <button class="btn" type="submit">
          ログイン
        </button>
      </form>
    </Layout>,
  );
});

authRoutes.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const password = String(body.password ?? "");

  if (password !== c.env.ADMIN_PASSWORD || !c.env.ADMIN_PASSWORD) {
    return c.redirect("/login?error=1");
  }

  await setAdminSession(c);
  return c.redirect("/");
});

authRoutes.post("/logout", async (c) => {
  clearAdminSession(c);
  return c.redirect("/");
});
