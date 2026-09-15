// ポイントは0.1刻みの小数になりうるため、合計時の浮動小数点誤差（24.700000000000003等）を防ぐために丸める。
const cleanNumber = (n: number) => Math.round(n * 10) / 10;

export const Signed = ({ n, unit = "" }: { n: number; unit?: string }) => {
  const v = cleanNumber(n);
  return (
    <span class={v >= 0 ? "plus" : "minus"}>
      {v >= 0 ? "+" : ""}
      {v}
      {unit}
    </span>
  );
};

/** 年度別・通算タブ共通の着順分布テーブル（プレイヤー別の1〜4着回数）。 */
export const RankDistributionTable = ({
  distribution,
}: {
  distribution: { playerId: number; name: string; counts: [number, number, number, number] }[];
}) => (
  <table class="session-table">
    <thead>
      <tr>
        <th>プレイヤー</th>
        <th>1着</th>
        <th>2着</th>
        <th>3着</th>
        <th>4着</th>
      </tr>
    </thead>
    <tbody>
      {distribution.map((d) => (
        <tr>
          <td>
            <a href={`/players/${d.playerId}`}>{d.name}</a>
          </td>
          <td>{d.counts[0]}</td>
          <td>{d.counts[1]}</td>
          <td>{d.counts[2]}</td>
          <td>{d.counts[3]}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

/** 年度別・通算タブ共通の役満履歴一覧。 */
export const YakumanHistoryList = ({
  entries,
}: {
  entries: { dayId: number; date: string; winnerName: string; yakuName: string }[];
}) =>
  entries.length === 0 ? (
    <p>まだ役満はありません。</p>
  ) : (
    <ul>
      {entries.map((e) => (
        <li>
          <a href={`/days/${e.dayId}`}>{e.date}</a>: {e.winnerName} - {e.yakuName}
        </li>
      ))}
    </ul>
  );

// チップ合計はあくまで付録情報のため、通算/年度別/当日タブの一覧には出さない
// （個人成績ページと、その日限りのチップ動向がわかる対局日の小計でのみ showChips で表示する）。
export const TotalsTable = ({
  totals,
  showHeader = true,
  showChips = false,
}: {
  totals: { playerId: number; name: string; rawTotal: number; chipTotal: number }[];
  showHeader?: boolean;
  showChips?: boolean;
}) => (
  <table class="session-table">
    {showHeader && (
      <thead>
        <tr>
          <th>プレイヤー</th>
          <th>ポイント合計</th>
          {showChips && <th>チップ合計</th>}
        </tr>
      </thead>
    )}
    <tbody>
      {totals.map((t) => (
        <tr>
          <td>
            <a href={`/players/${t.playerId}`}>{t.name}</a>
          </td>
          <td>
            <Signed n={t.rawTotal} />
          </td>
          {showChips && (
            <td>
              <Signed n={t.chipTotal} />
            </td>
          )}
        </tr>
      ))}
    </tbody>
  </table>
);

export type TabKey = "today" | "year" | "overall";

/** トップ画面の3タブ（直近 / 年度別 / 通算）。年度別タブのリンク先は指定年（省略時は今年）。 */
export const TabBar = ({ active, year }: { active: TabKey; year?: number }) => {
  const targetYear = year ?? new Date().getFullYear();
  return (
    <nav class="tab-bar">
      <a href="/" class={`tab${active === "today" ? " active" : ""}`}>
        直近
      </a>
      <a href={`/years/${targetYear}`} class={`tab${active === "year" ? " active" : ""}`}>
        年度別
      </a>
      <a href="/overall" class={`tab${active === "overall" ? " active" : ""}`}>
        通算
      </a>
    </nav>
  );
};

/**
 * 対局日単位のポイント合計を表す0起点の棒グラフ（追加ライブラリ不要、サーバー側でSVGを生成する）。
 * 1本＝1対局日のその日のポイント合計。プラスなら基準線から上に緑、マイナスなら下に赤の棒を伸ばす。
 * 当初はローソク足（始値/終値/高値/安値）で実装していたが、見せたいのは「その日の増減」であって
 * 累計の推移ではないという指摘を受け、よりシンプルな0起点の棒グラフに置き換えた（2026-09-16）。
 */
export const DailyBarChart = ({ points }: { points: { date: string; value: number }[] }) => {
  if (points.length === 0) return <p>この年のデータがありません。</p>;

  const width = 600;
  const height = 160;
  const padTop = 10;
  const padBottom = 10;
  const padSide = 12;

  const maxAbs = Math.max(...points.map((p) => Math.abs(p.value)), 1);
  const plotHalf = (height - padTop - padBottom) / 2;
  const zeroY = padTop + plotHalf;
  const scale = plotHalf / maxAbs;

  const slotWidth = (width - padSide * 2) / points.length;
  const barWidth = Math.max(2, Math.min(slotWidth * 0.6, 20));

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style="max-width:100%; height:auto; display:block"
    >
      <line x1={0} y1={zeroY} x2={width} y2={zeroY} stroke="#999" />
      {points.map((p, i) => {
        const cx = padSide + slotWidth * i + slotWidth / 2;
        const barHeight = Math.max(Math.abs(p.value) * scale, p.value === 0 ? 0 : 1.5);
        const isUp = p.value >= 0;
        const color = isUp ? "#2f9e58" : "#c0392b";
        const y = isUp ? zeroY - barHeight : zeroY;
        return <rect x={cx - barWidth / 2} y={y} width={barWidth} height={barHeight} fill={color} />;
      })}
    </svg>
  );
};
