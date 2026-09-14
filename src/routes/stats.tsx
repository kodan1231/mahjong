import { Hono } from "hono";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { Layout } from "../views/layout";
import { isAdmin } from "../lib/auth";
import { computeTotals, yearRange } from "../lib/aggregate";

export const statsRoutes = new Hono<{ Bindings: Env }>();

statsRoutes.get("/stats/:year", async (c) => {
  const year = Number(c.req.param("year"));
  const db = getDb(c.env);
  const admin = await isAdmin(c);
  const totals = await computeTotals(db, yearRange(year));

  return c.html(
    <Layout title={`${year}年 集計`} isAdmin={admin}>
      <h1>{year}年 集計</h1>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>プレイヤー</th>
              <th>素点合計</th>
              <th>チップ合計</th>
            </tr>
          </thead>
          <tbody>
            {totals.map((t) => (
              <tr>
                <td>{t.name}</td>
                <td>
                  <span class={t.rawTotal >= 0 ? "plus" : "minus"}>
                    {t.rawTotal >= 0 ? "+" : ""}
                    {t.rawTotal}
                  </span>
                </td>
                <td>
                  <span class={t.chipTotal >= 0 ? "plus" : "minus"}>
                    {t.chipTotal >= 0 ? "+" : ""}
                    {t.chipTotal}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        <a href={`/stats/${year - 1}`}>← {year - 1}年</a> / <a href={`/stats/${year + 1}`}>{year + 1}年 →</a>
      </p>
    </Layout>,
  );
});
