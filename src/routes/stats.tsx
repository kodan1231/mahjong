import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { players } from "../db/schema";
import { Layout } from "../views/layout";
import { Signed, Sparkline } from "../views/components";
import { isAdmin } from "../lib/auth";
import {
  computeTotals,
  yearRange,
  computePlayerYearlyBreakdown,
  computeRankDistribution,
  computePlayerYakumanWins,
  computePlayerScoreHistory,
} from "../lib/aggregate";

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
                <td>
                  <a href={`/players/${t.playerId}`}>{t.name}</a>
                </td>
                <td>
                  <Signed n={t.rawTotal} />
                </td>
                <td>
                  <Signed n={t.chipTotal} />
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

statsRoutes.get("/players/:id", async (c) => {
  const playerId = Number(c.req.param("id"));
  const db = getDb(c.env);
  const admin = await isAdmin(c);

  const [player] = await db.select().from(players).where(eq(players.id, playerId));
  if (!player) return c.notFound();

  const [overall, yearly, rankDist, yakumanWins, history] = await Promise.all([
    computeTotals(db),
    computePlayerYearlyBreakdown(db, playerId),
    computeRankDistribution(db, playerId),
    computePlayerYakumanWins(db, playerId),
    computePlayerScoreHistory(db, playerId),
  ]);
  const mine = overall.find((t) => t.playerId === playerId);
  const gameCount = rankDist.reduce((sum, r) => sum + r.count, 0);

  return c.html(
    <Layout title={`${player.name} の成績`} isAdmin={admin}>
      <h1>{player.name} の成績</h1>

      <div class="card">
        <h2 style="margin-top:0">通算</h2>
        <p>
          素点合計: <Signed n={mine?.rawTotal ?? 0} /> ／ チップ合計: <Signed n={mine?.chipTotal ?? 0} /> ／ 半荘数:{" "}
          {gameCount}
        </p>
        <Sparkline points={history.map((h) => h.cumulativeRaw)} />
      </div>

      <div class="card">
        <h2 style="margin-top:0">年別</h2>
        {yearly.length === 0 && <p>まだ対局記録がありません。</p>}
        {yearly.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>年</th>
                <th>素点合計</th>
                <th>チップ合計</th>
              </tr>
            </thead>
            <tbody>
              {[...yearly].reverse().map((y) => (
                <tr>
                  <td>
                    <a href={`/stats/${y.year}`}>{y.year}年</a>
                  </td>
                  <td>
                    <Signed n={y.rawTotal} />
                  </td>
                  <td>
                    <Signed n={y.chipTotal} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div class="card">
        <h2 style="margin-top:0">着順分布</h2>
        <table>
          <thead>
            <tr>
              <th>着順</th>
              <th>回数</th>
            </tr>
          </thead>
          <tbody>
            {rankDist.map((r) => (
              <tr>
                <td>{r.rank}位</td>
                <td>{r.count}回</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2 style="margin-top:0">役満（{yakumanWins.length}回）</h2>
        {yakumanWins.length === 0 && <p>まだありません。</p>}
        <ul>
          {yakumanWins.map((y) => (
            <li>
              <a href={`/days/${y.dayId}`}>{y.date}</a>: {y.yakuName}
            </li>
          ))}
        </ul>
      </div>
    </Layout>,
  );
});
