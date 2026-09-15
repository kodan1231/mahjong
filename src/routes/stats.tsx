import { Hono } from "hono";
import { eq, and, gte, lt, desc } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { players, days } from "../db/schema";
import { Layout } from "../views/layout";
import { Signed, DailyBarChart, TotalsTable, TabBar } from "../views/components";
import { isAdmin } from "../lib/auth";
import {
  computeTotals,
  yearRange,
  computePlayerYearlyBreakdown,
  computeRankDistribution,
  computePlayerYakumanWins,
  computePlayerDailyBreakdown,
} from "../lib/aggregate";

export const statsRoutes = new Hono<{ Bindings: Env }>();

// ---------- 年度別タブ ----------

statsRoutes.get("/years/:year", async (c) => {
  const year = Number(c.req.param("year"));
  const db = getDb(c.env);
  const admin = await isAdmin(c);

  const range = yearRange(year);
  const [totals, daysInYear] = await Promise.all([
    computeTotals(db, range),
    db
      .select()
      .from(days)
      .where(and(eq(days.status, "closed"), gte(days.date, range.from!), lt(days.date, range.to!)))
      .orderBy(desc(days.date)),
  ]);

  return c.html(
    <Layout title={`${year}年の成績`} isAdmin={admin}>
      <TabBar active="year" year={year} />
      <h1>{year}年の成績</h1>
      <p>
        <a href={`/years/${year - 1}`}>← {year - 1}年</a> ／ <a href={`/years/${year + 1}`}>{year + 1}年 →</a>
      </p>

      <div class="card">
        <h2>合計</h2>
        <TotalsTable totals={totals} showHeader={false} />
      </div>

      <div class="card">
        <h2>対局日一覧</h2>
        {daysInYear.length === 0 && <p>この年の対局日（終了済み）はまだありません。</p>}
        <ul>
          {daysInYear.map((d) => (
            <li>
              <a href={`/days/${d.id}`}>
                {d.date} {d.memo ? `(${d.memo})` : ""}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </Layout>,
  );
});

// ---------- 通算タブ ----------

statsRoutes.get("/overall", async (c) => {
  const db = getDb(c.env);
  const admin = await isAdmin(c);
  const totals = await computeTotals(db);

  return c.html(
    <Layout title="通算成績" isAdmin={admin}>
      <TabBar active="overall" />
      <h1>通算成績</h1>
      <div class="card">
        <TotalsTable totals={totals} showHeader={false} />
      </div>
    </Layout>,
  );
});

// ---------- 個人ページ ----------

statsRoutes.get("/players/:id", async (c) => {
  const playerId = Number(c.req.param("id"));
  const db = getDb(c.env);
  const admin = await isAdmin(c);

  const [player] = await db.select().from(players).where(eq(players.id, playerId));
  if (!player) return c.notFound();

  const [overall, yearly, rankDist, yakumanWins] = await Promise.all([
    computeTotals(db),
    computePlayerYearlyBreakdown(db, playerId),
    computeRankDistribution(db, playerId),
    computePlayerYakumanWins(db, playerId),
  ]);
  const mine = overall.find((t) => t.playerId === playerId);
  const gameCount = rankDist.reduce((sum, r) => sum + r.count, 0);

  // 日別集計は年で絞り込む（?yearクエリ省略時はこのプレイヤーの最新の対局年、それも無ければ今年）。
  const yearQuery = c.req.query("year");
  const selectedYear = yearQuery
    ? Number(yearQuery)
    : (yearly[yearly.length - 1]?.year ?? new Date().getFullYear());
  const dailyBreakdown = await computePlayerDailyBreakdown(db, playerId, yearRange(selectedYear));

  return c.html(
    <Layout title={`${player.name} の成績`} isAdmin={admin}>
      <h1>{player.name} の成績</h1>

      <div class="card">
        <h2>通算</h2>
        <p>
          ポイント合計: <Signed n={mine?.rawTotal ?? 0} /> ／ チップ合計: <Signed n={mine?.chipTotal ?? 0} /> ／ 半荘数:{" "}
          {gameCount}
        </p>
      </div>

      <div class="card">
        <h2>日別</h2>
        <p>
          <a href={`/players/${playerId}?year=${selectedYear - 1}`}>← {selectedYear - 1}年</a> ／ {selectedYear}年 ／{" "}
          <a href={`/players/${playerId}?year=${selectedYear + 1}`}>{selectedYear + 1}年 →</a>
        </p>
        <p style="font-size:0.8rem; color:var(--ink-soft); margin:6px 0 2px">
          対局日ごとのポイント合計を0を基準にした棒グラフで表示（プラスの日は緑で上、マイナスの日は赤で下）
        </p>
        <DailyBarChart points={dailyBreakdown.map((d) => ({ date: d.date, value: d.rawTotal }))} />
        {dailyBreakdown.length === 0 && <p>{selectedYear}年の対局記録はまだありません。</p>}
        {dailyBreakdown.length > 0 && (
          <table class="session-table">
            <thead>
              <tr>
                <th>対局日</th>
                <th>ポイント</th>
                <th>チップ</th>
              </tr>
            </thead>
            <tbody>
              {[...dailyBreakdown].reverse().map((d) => (
                <tr>
                  <td>
                    <a href={`/days/${d.dayId}`}>
                      {d.date}
                      {d.memo ? `(${d.memo})` : ""}
                    </a>
                  </td>
                  <td>
                    <Signed n={d.rawTotal} />
                  </td>
                  <td>
                    <Signed n={d.chipTotal} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div class="card">
        <h2>年別</h2>
        {yearly.length === 0 && <p>まだ対局記録がありません。</p>}
        {yearly.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>年</th>
                <th>ポイント合計</th>
                <th>チップ合計</th>
              </tr>
            </thead>
            <tbody>
              {[...yearly].reverse().map((y) => (
                <tr>
                  <td>
                    <a href={`/years/${y.year}`}>{y.year}年</a>
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
        <h2>着順分布</h2>
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
        <h2>役満（{yakumanWins.length}回）</h2>
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
