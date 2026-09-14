import type { FC, PropsWithChildren, Child } from "hono/jsx";

const PUBLIC_NAV_LINKS = [
  { href: "/", label: "ホーム" },
  { href: "/days", label: "対局日一覧" },
];

const ADMIN_NAV_LINKS = [
  { href: "/days/new", label: "対局日を開始" },
  { href: "/players", label: "プレイヤー管理" },
];

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
      <style>{css}</style>
      {extraHead}
    </head>
    <body>
      <header class="app-header">
        <a class="brand" href="/">
          麻雀スコア集計
        </a>
        <nav class="app-nav">
          {PUBLIC_NAV_LINKS.map((l) => (
            <a href={l.href}>{l.label}</a>
          ))}
          {isAdmin ? (
            <>
              {ADMIN_NAV_LINKS.map((l) => (
                <a href={l.href}>{l.label}</a>
              ))}
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
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #f7f5f2;
    color: #1f2933;
  }
  .app-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: #1f2933;
    color: white;
  }
  .brand { color: white; font-weight: 700; text-decoration: none; font-size: 1.1rem; }
  .app-nav { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .app-nav a, .link-button { color: #d7dee3; text-decoration: none; font-size: 0.9rem; background: none; border: none; padding: 0; cursor: pointer; }
  .inline-form { display: inline; }
  .app-main { max-width: 720px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 1.3rem; }
  h2 { font-size: 1.1rem; margin-top: 1.5em; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  th, td { padding: 8px; border-bottom: 1px solid #ddd; text-align: right; font-variant-numeric: tabular-nums; }
  th:first-child, td:first-child { text-align: left; }
  .card { background: white; border-radius: 8px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .btn { display: inline-block; padding: 10px 16px; border-radius: 6px; background: #2563eb; color: white; text-decoration: none; border: none; font-size: 1rem; cursor: pointer; }
  .btn-secondary { background: #6b7280; }
  .btn-danger { background: #dc2626; }
  form.stack { display: flex; flex-direction: column; gap: 10px; max-width: 420px; }
  label { font-size: 0.9rem; font-weight: 600; }
  input[type=text], input[type=password], input[type=number], select, textarea {
    padding: 10px; border-radius: 6px; border: 1px solid #ccc; font-size: 1rem; width: 100%;
  }
  .seat-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
  .seat-row .seat-label { width: 4em; font-weight: 600; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; background: #e5e7eb; }
  .badge-pending { background: #fef3c7; color: #92400e; }
  .badge-confirmed { background: #d1fae5; color: #065f46; }
  .warning { color: #b45309; background: #fffbeb; border: 1px solid #fcd34d; padding: 8px 12px; border-radius: 6px; }
  .plus { color: #047857; }
  .minus { color: #b91c1c; }
`;
