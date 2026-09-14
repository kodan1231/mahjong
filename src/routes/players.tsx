import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { players } from "../db/schema";
import { Layout } from "../views/layout";
import { requireAdmin } from "../lib/auth";

export const playerRoutes = new Hono<{ Bindings: Env }>();

playerRoutes.get("/players", requireAdmin, async (c) => {
  const db = getDb(c.env);
  const all = await db.select().from(players).orderBy(players.id);

  return c.html(
    <Layout title="プレイヤー管理" isAdmin={true}>
      <h1>プレイヤー管理</h1>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>名前</th>
              <th>状態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {all.map((p) => (
              <tr>
                <td>{p.name}</td>
                <td>
                  <span class={`badge ${p.active ? "badge-confirmed" : ""}`}>
                    {p.active ? "有効" : "無効"}
                  </span>
                </td>
                <td>
                  {p.active && (
                    <form method="post" action={`/players/${p.id}/deactivate`}>
                      <button class="link-button" type="submit">
                        無効化
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>プレイヤーを追加</h2>
      <form class="stack" method="post" action="/players">
        <label for="name">名前</label>
        <input type="text" id="name" name="name" required />
        <button class="btn" type="submit">
          追加
        </button>
      </form>
    </Layout>,
  );
});

playerRoutes.post("/players", requireAdmin, async (c) => {
  const body = await c.req.parseBody();
  const name = String(body.name ?? "").trim();
  if (name) {
    const db = getDb(c.env);
    await db.insert(players).values({ name });
  }
  return c.redirect("/players");
});

playerRoutes.post("/players/:id/deactivate", requireAdmin, async (c) => {
  const id = Number(c.req.param("id"));
  const db = getDb(c.env);
  await db.update(players).set({ active: false }).where(eq(players.id, id));
  return c.redirect("/players");
});
