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
  PlayerSubTabs,
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
  computePlayerTraits,
} from "../lib/aggregate";
import { getOpenDayId } from "../lib/dayState";
import { computeScoreTable, FIXED_TIERS, FU_CALC_TABLE } from "../lib/scoreTable";

export const statsRoutes = new Hono<{ Bindings: Env }>();

// ---------- 年度別タブ ----------

statsRoutes.get("/years/:year", async (c) => {
  const year = Number(c.req.param("year"));
  const db = getDb(c.env);
  const admin = await isAdmin(c);

  const range = yearRange(year);
  const [totals, daysInYear, rankDistribution, yakumanHistory, openDayId] = await Promise.all([
    computeTotals(db, range),
    db
      .select()
      .from(days)
      .where(and(eq(days.status, "closed"), gte(days.date, range.from!), lt(days.date, range.to!)))
      .orderBy(desc(days.date)),
    computeRankDistributionForAllPlayers(db, range),
    computeYakumanHistory(db, range),
    admin ? getOpenDayId(db) : Promise.resolve(null),
  ]);

  return c.html(
    <Layout title={`${year}年の成績`} isAdmin={admin} openDayId={openDayId}>
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
  const [totals, rankDistribution, yakumanHistory, openDayId] = await Promise.all([
    computeTotals(db),
    computeRankDistributionForAllPlayers(db),
    computeYakumanHistory(db),
    admin ? getOpenDayId(db) : Promise.resolve(null),
  ]);

  return c.html(
    <Layout title="通算成績" isAdmin={admin} openDayId={openDayId}>
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
  const openDayId = admin ? await getOpenDayId(getDb(c.env)) : null;
  const table = computeScoreTable();

  return c.html(
    <Layout title="点数表" isAdmin={admin} openDayId={openDayId}>
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

const fmtPercent = (n: number) => `${(n * 100).toFixed(1)}%`;
const fmtDoraAvg = (n: number | null) => (n == null ? "-" : `${n.toFixed(2)}枚`);

statsRoutes.get("/players/:id", async (c) => {
  const playerId = Number(c.req.param("id"));
  const db = getDb(c.env);
  const admin = await isAdmin(c);
  const tab = c.req.query("tab") === "traits" ? "traits" : "results";

  const [player, openDayId] = await Promise.all([
    db.select().from(players).where(eq(players.id, playerId)).then((rows) => rows[0]),
    admin ? getOpenDayId(db) : Promise.resolve(null),
  ]);
  if (!player) return c.notFound();

  if (tab === "traits") {
    const traits = await computePlayerTraits(db, playerId);

    return c.html(
      <Layout title={`${player.name} の成績`} isAdmin={admin} openDayId={openDayId}>
        <h1>{player.name} の成績</h1>
        <PlayerSubTabs playerId={playerId} active="traits" />

        {traits.handCount === 0 ? (
          <div class="card">
            <p>まだ局メモの記録がありません。</p>
          </div>
        ) : (
          <>
            <div class="card">
              <h2>和了・進行（{traits.handCount}局中）</h2>
              <table>
                <tbody>
                  <tr>
                    <td>上がり率</td>
                    <td>{fmtPercent(traits.winRate)}</td>
                  </tr>
                  <tr>
                    <td>振り込み率</td>
                    <td>{fmtPercent(traits.dealInRate)}</td>
                  </tr>
                  <tr>
                    <td>リーチ率</td>
                    <td>{fmtPercent(traits.riichiRate)}</td>
                  </tr>
                  <tr>
                    <td>鳴き率</td>
                    <td>{fmtPercent(traits.nakiRate)}</td>
                  </tr>
                  <tr>
                    <td>自摸率</td>
                    <td>{fmtPercent(traits.tsumoRate)}</td>
                  </tr>
                  <tr>
                    <td>一発率</td>
                    <td>{fmtPercent(traits.ippatsuRate)}</td>
                  </tr>
                  <tr>
                    <td>平均上がり点数</td>
                    <td>{traits.avgWinPoints != null ? `${Math.round(traits.avgWinPoints).toLocaleString("ja-JP")}点` : "-"}</td>
                  </tr>
                  <tr>
                    <td>親での平均連荘回数</td>
                    <td>
                      {traits.avgDealerRenchan != null
                        ? `${traits.avgDealerRenchan.toFixed(2)}回（親${traits.dealerTurnCount}回）`
                        : "-"}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p style="font-size:0.8rem; color:var(--ink-soft); margin:8px 0 0">
                リーチ・鳴き・自摸率・一発率・平均上がり点数・親での平均連荘回数は局メモへの入力状況に精度が左右されます（未入力の局は「無かった」として扱われます）。平均上がり点数は本場・リーチ棒分を含まない、役由来の点数のみの平均です。自摸率は和了数、一発率は立直回数に対する比率です。
              </p>
            </div>

            <div class="card">
              <h2>ドラ平均（和了時）</h2>
              <table>
                <tbody>
                  <tr>
                    <td>表ドラ平均</td>
                    <td>{fmtDoraAvg(traits.avgOmoteDora)}</td>
                  </tr>
                  <tr>
                    <td>裏ドラ平均</td>
                    <td>{fmtDoraAvg(traits.avgUraDora)}</td>
                  </tr>
                  <tr>
                    <td>赤ドラ平均</td>
                    <td>{fmtDoraAvg(traits.avgAkaDora)}</td>
                  </tr>
                </tbody>
              </table>
              <p style="font-size:0.8rem; color:var(--ink-soft); margin:8px 0 0">
                ドラ枚数が入力された和了のみで平均しています（未入力の和了は分母に含めません）。
              </p>
            </div>

            <div class="card">
              <h2>得意役</h2>
              {traits.favoriteYaku.length === 0 ? <p>まだ役の記録がありません。</p> : <p>{traits.favoriteYaku.join("、")}</p>}
            </div>

            <div class="card">
              <h2>上がり役別比率</h2>
              {traits.yakuBreakdown.length === 0 ? (
                <p>まだ役の記録がありません。</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>役</th>
                      <th>回数</th>
                      <th>比率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {traits.yakuBreakdown.map((y) => (
                      <tr>
                        <td>{y.yaku}</td>
                        <td>{y.count}回</td>
                        <td>{fmtPercent(y.rate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p style="font-size:0.8rem; color:var(--ink-soft); margin:8px 0 0">
                比率は和了数（{traits.winCount}回）に対する割合です。役の入力が無い和了があると合計が100%未満になります。
              </p>
            </div>
          </>
        )}
      </Layout>,
    );
  }

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
    <Layout title={`${player.name} の成績`} isAdmin={admin} openDayId={openDayId}>
      <h1>{player.name} の成績</h1>
      <PlayerSubTabs playerId={playerId} active="results" year={selectedYear} />

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
          <table class="session-table">
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
        <table class="session-table">
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
