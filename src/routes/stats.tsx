import { Hono } from "hono";
import { eq, and, gte, lt, desc } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { players, days } from "../db/schema";
import { Layout } from "../views/layout";
import {
  Signed,
  DailyBarChart,
  TotalsTable,
  TabBar,
  HistorySubTabs,
  RankDistributionTable,
  YakumanHistoryList,
} from "../views/components";
import { isAdmin } from "../lib/auth";
import {
  computeTotals,
  yearRange,
  computePlayerRawTotal,
  computePlayerYearlyBreakdown,
  computeRankDistribution,
  computePlayerYakumanWins,
  computePlayerDailyBreakdown,
  computeRankDistributionForAllPlayers,
  computeYakumanHistory,
} from "../lib/aggregate";
import { computeScoreTable, FIXED_TIERS, FU_CALC_TABLE } from "../lib/scoreTable";

export const statsRoutes = new Hono<{ Bindings: Env }>();

// ---------- 年度別タブ ----------

statsRoutes.get("/years/:year", async (c) => {
  const year = Number(c.req.param("year"));
  const db = getDb(c.env);
  const admin = await isAdmin(c);

  const range = yearRange(year);
  const [totals, daysInYear, rankDistribution, yakumanHistory] = await Promise.all([
    computeTotals(db, range),
    db
      .select()
      .from(days)
      .where(and(eq(days.status, "closed"), gte(days.date, range.from!), lt(days.date, range.to!)))
      .orderBy(desc(days.date)),
    computeRankDistributionForAllPlayers(db, range),
    computeYakumanHistory(db, range),
  ]);

  return c.html(
    <Layout title={`${year}年の成績`} isAdmin={admin}>
      <TabBar active="history" />
      <HistorySubTabs active="year" year={year} />
      <h1>{year}年の成績</h1>
      <p>
        <a href={`/years/${year - 1}`}>← {year - 1}年</a> ／ <a href={`/years/${year + 1}`}>{year + 1}年 →</a>
      </p>

      <div class="card">
        <h2>合計</h2>
        <TotalsTable totals={totals} showHeader={false} />
      </div>

      <div class="card">
        <h2>着順分布</h2>
        <RankDistributionTable distribution={rankDistribution} />
      </div>

      <div class="card">
        <h2>役満履歴</h2>
        <YakumanHistoryList entries={yakumanHistory} />
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
  const [totals, rankDistribution, yakumanHistory] = await Promise.all([
    computeTotals(db),
    computeRankDistributionForAllPlayers(db),
    computeYakumanHistory(db),
  ]);

  return c.html(
    <Layout title="通算成績" isAdmin={admin}>
      <TabBar active="history" />
      <HistorySubTabs active="overall" />
      <h1>通算成績</h1>
      <div class="card">
        <TotalsTable totals={totals} showHeader={false} />
      </div>

      <div class="card">
        <h2>着順分布</h2>
        <RankDistributionTable distribution={rankDistribution} />
      </div>

      <div class="card">
        <h2>役満履歴</h2>
        <YakumanHistoryList entries={yakumanHistory} />
      </div>
    </Layout>,
  );
});

// ---------- 点数表タブ ----------

const fmt = (n: number | null) => (n == null ? "-" : n.toLocaleString("ja-JP"));

statsRoutes.get("/scoretable", async (c) => {
  const admin = await isAdmin(c);
  const table = computeScoreTable();

  return c.html(
    <Layout title="点数表" isAdmin={admin}>
      <TabBar active="scoretable" />
      <h1>点数表</h1>
      <p style="font-size:0.85rem; color:var(--felt-soft)">
        符・翻から点数を引く早見表。上段が太字でロンの点数、下段の小さい文字がツモの内訳（子は「他家の支払い/親の支払い」、親は「子3人がそれぞれ支払う額」）。
      </p>

      <div class="card">
        <h2>符の算出表</h2>
        <p style="font-size:0.8rem; color:var(--ink-soft); margin:0 0 10px">
          手牌の形から符を積み上げるための表。合計後は10符単位で切り上げます（例: 22符→30符）。七対子・平和は下記の通り符が固定されます。
        </p>
        {FU_CALC_TABLE.map((group) => (
          <>
            <h3>{group.category}</h3>
            <table class="session-table">
              <tbody>
                {group.rows.map((row) => (
                  <tr>
                    <td style="text-align:left">{row.item}</td>
                    <td>{row.fu}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ))}
      </div>

      <div class="card">
        <h2>子（非親）</h2>
        <div style="overflow-x:auto">
          <table class="session-table">
            <thead>
              <tr>
                <th>符＼翻</th>
                {table.hanCols.map((han) => (
                  <th>{han}翻</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.fuRows.map((fu, fuIndex) => (
                <tr>
                  <td>{fu}符</td>
                  {table.hanCols.map((_, hanIndex) => {
                    const cell = table.nonDealer[fuIndex]![hanIndex]!;
                    if (cell.ron == null && cell.tsumoOther == null) return <td>-</td>;
                    return (
                      <td>
                        <div>{fmt(cell.ron)}</div>
                        <div style="font-size:0.75em; color:var(--ink-soft)">
                          {fmt(cell.tsumoOther)}/{fmt(cell.tsumoDealer)}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>親</h2>
        <div style="overflow-x:auto">
          <table class="session-table">
            <thead>
              <tr>
                <th>符＼翻</th>
                {table.hanCols.map((han) => (
                  <th>{han}翻</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.fuRows.map((fu, fuIndex) => (
                <tr>
                  <td>{fu}符</td>
                  {table.hanCols.map((_, hanIndex) => {
                    const cell = table.dealer[fuIndex]![hanIndex]!;
                    if (cell.ron == null && cell.tsumoEach == null) return <td>-</td>;
                    return (
                      <td>
                        <div>{fmt(cell.ron)}</div>
                        <div style="font-size:0.75em; color:var(--ink-soft)">{fmt(cell.tsumoEach)}オール</div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>満貫以上（符に関わらず翻数のみで決まる）</h2>
        <div style="overflow-x:auto">
          <table class="session-table">
            <thead>
              <tr>
                <th>翻数</th>
                <th>子ロン</th>
                <th>子ツモ</th>
                <th>親ロン</th>
                <th>親ツモ</th>
              </tr>
            </thead>
            <tbody>
              {FIXED_TIERS.map((t) => (
                <tr>
                  <td>
                    {t.label}（{t.hanRange}）
                  </td>
                  <td>{fmt(t.nonDealerRon)}</td>
                  <td>
                    {fmt(t.nonDealerTsumoOther)}/{fmt(t.nonDealerTsumoDealer)}
                  </td>
                  <td>{fmt(t.dealerRon)}</td>
                  <td>{fmt(t.dealerTsumoEach)}オール</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

  const [rawTotal, yearly, rankDist, yakumanWins] = await Promise.all([
    computePlayerRawTotal(db, playerId),
    computePlayerYearlyBreakdown(db, playerId),
    computeRankDistribution(db, playerId),
    computePlayerYakumanWins(db, playerId),
  ]);
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
          ポイント合計: <Signed n={rawTotal} /> ／ 半荘数: {gameCount}
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
