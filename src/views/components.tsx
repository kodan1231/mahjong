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

export interface DailyCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * 登録日単位の累計ポイント推移を表すローソク足チャート（追加ライブラリ不要、サーバー側でSVGを生成する）。
 * 1本＝1対局日。始値=その日の最初の半荘が始まる前の累計、終値=その日の最後の半荘を終えた時点の累計、
 * ひげ（高値・安値）=その日の中で累計が到達した最高値・最安値。終値が始値以上なら陽線（プラス色）、
 * 未満なら陰線（マイナス色）にする。折れ線グラフだと半荘単位の細かい上下が分かりにくいというフィードバックで導入。
 */
export const Candlestick = ({ candles }: { candles: DailyCandle[] }) => {
  if (candles.length === 0) return <p>グラフを表示するにはデータが足りません。</p>;

  const width = 600;
  const height = 160;
  const padTop = 10;
  const padBottom = 10;
  const padSide = 12;

  const values = candles.flatMap((c) => [c.open, c.high, c.low, c.close, 0]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const plotHeight = height - padTop - padBottom;
  const yFor = (v: number) => padTop + plotHeight * (1 - (v - min) / range);

  const slotWidth = (width - padSide * 2) / candles.length;
  const bodyWidth = Math.max(2, Math.min(slotWidth * 0.6, 18));
  const zeroY = yFor(0);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style="max-width:100%; height:auto; display:block"
    >
      <line x1={0} y1={zeroY} x2={width} y2={zeroY} stroke="#ccc" stroke-dasharray="4,4" />
      {candles.map((c, i) => {
        const cx = padSide + slotWidth * i + slotWidth / 2;
        const isUp = c.close >= c.open;
        const color = isUp ? "#2f9e58" : "#c0392b";
        const yHigh = yFor(c.high);
        const yLow = yFor(c.low);
        const yOpen = yFor(c.open);
        const yClose = yFor(c.close);
        const bodyTop = Math.min(yOpen, yClose);
        const bodyHeight = Math.max(Math.abs(yClose - yOpen), 1.5);
        return (
          <g>
            <line x1={cx} y1={yHigh} x2={cx} y2={yLow} stroke={color} stroke-width="1.5" />
            <rect x={cx - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyHeight} fill={color} />
          </g>
        );
      })}
    </svg>
  );
};
