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

// チップ合計はあくまで付録情報のため一覧には出さず、個別成績ページ（/players/:id）でのみ表示する。
export const TotalsTable = ({
  totals,
}: {
  totals: { playerId: number; name: string; rawTotal: number; chipTotal: number }[];
}) => (
  <table>
    <thead>
      <tr>
        <th>プレイヤー</th>
        <th>ポイント合計</th>
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
        </tr>
      ))}
    </tbody>
  </table>
);

export type TabKey = "today" | "year" | "overall";

/** トップ画面の3タブ（当日 / 年度別 / 通算）。年度別タブのリンク先は指定年（省略時は今年）。 */
export const TabBar = ({ active, year }: { active: TabKey; year?: number }) => {
  const targetYear = year ?? new Date().getFullYear();
  return (
    <nav class="tab-bar">
      <a href="/" class={`tab${active === "today" ? " active" : ""}`}>
        当日
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

/** 数値の推移を表すシンプルな折れ線グラフ（追加ライブラリ不要、サーバー側でSVGを生成する）。 */
export const Sparkline = ({ points }: { points: number[] }) => {
  if (points.length < 2) return <p>グラフを表示するにはデータが足りません。</p>;

  const width = 600;
  const height = 140;
  const padding = 10;

  const min = Math.min(...points, 0);
  const max = Math.max(...points, 0);
  const range = max - min || 1;
  const stepX = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;

  const coords = points
    .map((v, i) => {
      const x = padding + i * stepX;
      const y = height - padding - ((v - min) / range) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const zeroY = height - padding - ((0 - min) / range) * (height - padding * 2);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style="max-width:100%; height:auto; display:block"
    >
      <line x1={padding} y1={zeroY} x2={width - padding} y2={zeroY} stroke="#ccc" stroke-dasharray="4,4" />
      <polyline points={coords} fill="none" stroke="#2563eb" stroke-width="2" />
    </svg>
  );
};
