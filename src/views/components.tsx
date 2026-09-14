export const Signed = ({ n, unit = "" }: { n: number; unit?: string }) => (
  <span class={n >= 0 ? "plus" : "minus"}>
    {n >= 0 ? "+" : ""}
    {n}
    {unit}
  </span>
);

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
