import type { FC, PropsWithChildren, Child } from "hono/jsx";

export const Layout: FC<PropsWithChildren<{ title: string; isAdmin: boolean; extraHead?: Child }>> = ({
  title,
  isAdmin,
  extraHead,
  children,
}) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{title} - 麻雀スコア集計</title>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;600;700;800&display=swap"
      />
      <style>{css}</style>
      {extraHead}
    </head>
    <body>
      <header class="app-header">
        <a class="brand" href="/">
          <span class="brand-tile">🀄</span> 麻雀スコア集計
        </a>
        <nav class="app-nav">
          <a href="/">ホーム</a>
          {isAdmin ? (
            <>
              <a href="/days/new">対局日を開始</a>
              <form method="post" action="/days/close" class="inline-form">
                <button type="submit" class="link-button">
                  対局日を終了
                </button>
              </form>
              <a href="/players">プレイヤー管理</a>
              <form method="post" action="/logout" class="inline-form">
                <button type="submit" class="link-button">
                  ログアウト
                </button>
              </form>
            </>
          ) : (
            <a href="/login">管理者ログイン</a>
          )}
        </nav>
      </header>
      <main class="app-main">{children}</main>
    </body>
  </html>
);

const css = `
  :root {
    color-scheme: light;
    --felt: #0b4a3a;
    --felt-dark: #073226;
    --tile: #faf6ec;
    --tile-edge: #e8dfc8;
    --ink: #23281f;
    --ink-soft: #5b6357;
    --gold: #c9a227;
    --gold-dark: #a3801a;
    --plus: #2f9e58;
    --minus: #c0392b;
  }
  * { box-sizing: border-box; }
  html { font-size: 20px; }
  body {
    margin: 0;
    font-family: "Noto Sans JP", "Hiragino Sans", "Yu Gothic", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background:
      radial-gradient(circle at 20% 20%, rgba(255,255,255,0.05) 0, transparent 40%),
      radial-gradient(circle at 80% 60%, rgba(255,255,255,0.04) 0, transparent 45%),
      linear-gradient(160deg, var(--felt) 0%, var(--felt-dark) 100%);
    background-attachment: fixed;
    /* 緑フェルトの上に直接乗る文字は明るい色をデフォルトにする（濃緑背景×黒文字で見えなくなるのを防ぐ）。
       白系のカード・テーブルの中は .card / table のルールで濃色に戻す。 */
    color: #eef2ec;
    min-height: 100vh;
    line-height: 1.5;
  }
  .app-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 14px 18px;
    background: rgba(7, 50, 38, 0.92);
    backdrop-filter: blur(4px);
    border-bottom: 1px solid rgba(201, 162, 39, 0.35);
  }
  .brand {
    color: #fdf9ec;
    font-weight: 800;
    text-decoration: none;
    font-size: 1.15rem;
    letter-spacing: 0.02em;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .brand-tile { font-size: 1.3rem; }
  .link-button {
    background: none;
    border: none;
    margin: 0;
    padding: 0;
    color: #0d5c3f;
    text-decoration: underline;
    cursor: pointer;
    font-size: inherit;
    font-weight: 600;
    font-family: inherit;
  }
  .link-button:hover { color: var(--gold-dark); }
  .app-nav { display: flex; gap: 8px; flex-wrap: wrap; align-items: stretch; }
  .app-nav a, .app-nav .link-button {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    color: #e8f2ec;
    text-decoration: none;
    font-size: 0.78rem;
    font-weight: 700;
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.14);
    border-radius: 999px;
    padding: 7px 13px;
    margin: 0;
    cursor: pointer;
    line-height: 1.3;
    vertical-align: middle;
  }
  .app-nav a:hover, .app-nav .link-button:hover { background: rgba(201, 162, 39, 0.25); border-color: var(--gold); }
  .app-nav .inline-form { display: inline-flex; align-items: stretch; margin: 0; }
  .inline-form { display: inline-flex; }
  .app-main { max-width: 760px; margin: 0 auto; padding: 10px 12px 32px; }

  h1 { font-size: 1.3rem; color: #fdf9ec; margin: 4px 0 10px; letter-spacing: 0.01em; }
  /* h2/h3は緑背景に直接置かれることもカードの中に置かれることもあるため、色は指定せず親から継承する */
  h2 { font-size: 1.05rem; margin-top: 0.85em; margin-bottom: 0.4em; }
  h3 { font-size: 1rem; }

  .tab-bar {
    display: flex;
    gap: 4px;
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(201, 162, 39, 0.4);
    border-radius: 999px;
    padding: 4px;
    margin-bottom: 18px;
  }
  .tab {
    flex: 1;
    text-align: center;
    padding: 9px 6px;
    border-radius: 999px;
    color: #e8f2ec;
    text-decoration: none;
    font-weight: 700;
    font-size: 0.92rem;
  }
  .tab.active { background: var(--gold); color: #2a2306; }

  table { width: 100%; border-collapse: collapse; margin: 6px 0; color: var(--ink); }
  th, td { padding: 5px 4px; border-bottom: 1px solid var(--tile-edge); text-align: right; font-variant-numeric: tabular-nums; }
  th:first-child, td:first-child { text-align: left; }
  th { color: var(--ink-soft); font-weight: 600; font-size: 0.78rem; }

  .card {
    background: var(--tile);
    border: 1px solid var(--tile-edge);
    border-radius: 14px;
    padding: 12px;
    margin-bottom: 12px;
    box-shadow: 0 6px 18px rgba(0,0,0,0.18);
    color: var(--ink);
  }
  .card h2:first-child, .card h3:first-child { margin-top: 0; }

  .btn {
    display: inline-block;
    padding: 11px 18px;
    border-radius: 999px;
    background: var(--gold);
    color: #2a2306;
    text-decoration: none;
    border: none;
    font-size: 0.95rem;
    font-weight: 700;
    cursor: pointer;
  }
  .btn:hover { background: var(--gold-dark); }
  .btn-secondary { background: var(--felt); color: #fdf9ec; }
  .btn-secondary:hover { background: var(--felt-dark); }
  .btn-danger { background: var(--minus); color: white; }

  form.stack { display: flex; flex-direction: column; gap: 10px; max-width: 440px; }
  /* labelも緑背景・カード両方に置かれるので色は継承させる */
  label { font-size: 0.88rem; font-weight: 700; }
  input[type=text], input[type=password], input[type=number], select, textarea {
    padding: 10px; border-radius: 8px; border: 1px solid var(--tile-edge); font-size: 1rem; width: 100%;
    background: white; color: var(--ink);
  }
  input:focus, select:focus { outline: 2px solid var(--gold); outline-offset: 1px; }

  .seat-block { margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px dashed rgba(255,255,255,0.25); }
  .seat-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
  .seat-row .seat-label { width: 4em; font-weight: 700; flex-shrink: 0; opacity: 0.85; }
  .seat-row select { flex: 1 1 8em; }
  .seat-row input[type=number] { flex: 1 1 6em; }
  .card .seat-block { border-bottom-color: var(--tile-edge); }

  /* ボタン風の選択肢（座席登録・確認画面のプレイヤー選択）。1行に収まるよう横スクロールにする。 */
  .choice-group {
    display: flex;
    flex-wrap: nowrap;
    gap: 6px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    padding-bottom: 3px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .choice-btn {
    position: relative;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    padding: 9px 12px;
    border-radius: 10px;
    border: 1px solid var(--tile-edge);
    background: white;
    color: var(--ink);
    font-weight: 700;
    font-size: 0.92rem;
    cursor: pointer;
    white-space: nowrap;
    user-select: none;
  }
  .choice-btn input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
    pointer-events: none;
  }
  .choice-btn:has(input:checked) { background: var(--gold); border-color: var(--gold-dark); color: #2a2306; }

  .badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 0.72rem; font-weight: 700; background: #e5e7df; color: var(--ink-soft); }
  .badge-pending { background: #fdeecb; color: #92600e; }
  .badge-confirmed { background: #d9efe1; color: #1c6b41; }
  .badge-open { background: #fdeecb; color: #92600e; }
  .badge-closed { background: #e5e7df; color: var(--ink-soft); }

  .warning { color: #7a4a0e; background: #fdeecb; border: 1px solid #e8c66a; padding: 9px 14px; border-radius: 10px; }
  .plus { color: var(--plus); font-weight: 700; }
  .minus { color: var(--minus); font-weight: 700; }

  /* 背景（緑フェルト）に直接乗るリンクは金、白系カードの上に乗るリンクは緑にする（濃緑×濃緑で埋もれるのを防ぐ） */
  a { color: var(--gold); text-decoration-color: rgba(201, 162, 39, 0.6); font-weight: 700; }
  a:hover { color: #e8c766; }
  .card a, table a { color: #0d5c3f; text-decoration-color: rgba(13, 92, 63, 0.4); }
  .card a:hover, table a:hover { color: var(--gold-dark); }
  .app-main > p > a, .card > p > a { text-decoration: none; }

  details summary { cursor: pointer; font-weight: 700; margin-top: 12px; }

  /* まとめて入力（スプレッドシート風グリッド） */
  .sheet-table { width: auto; border-collapse: collapse; background: white; }
  .sheet-table th, .sheet-table td { border: 1px solid var(--tile-edge); padding: 0; text-align: center; }
  .sheet-table th {
    background: rgba(11, 74, 58, 0.06);
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--ink-soft);
    padding: 7px 10px;
    white-space: nowrap;
  }
  .sheet-table td:first-child {
    font-weight: 700;
    color: var(--ink-soft);
    padding: 0 10px;
    background: rgba(11, 74, 58, 0.04);
  }
  .sheet-table input[type=number] {
    width: 5.2em;
    border: none;
    border-radius: 0;
    padding: 9px 6px;
    text-align: right;
    font-variant-numeric: tabular-nums;
    background: transparent;
  }
  .sheet-table input[type=number]:focus { background: #fff6d6; outline: 2px solid var(--gold); outline-offset: -2px; }

  @media (max-width: 480px) {
    .app-header { padding: 12px 14px; }
    .card { padding: 14px; }
    .tab { font-size: 0.85rem; padding: 8px 4px; }
  }
`;
