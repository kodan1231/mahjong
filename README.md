# 麻雀スコア集計Webアプリ

半荘ごとに局メモ・最終素点を手入力し、年間のポイント・着順チップを集計するWebアプリ。
Cloudflare Workers + D1 (Hono) で構築。

## 構成

- **Cloudflare Workers**: アプリ本体（Hono, TypeScript）
- **D1**: プレイヤー・対局・スコア・チップ・役満・局メモのデータ
- **Drizzle ORM**: D1のスキーマ・マイグレーション管理

## 権限モデル

- **管理者**（共有パスワードでログイン）: 対局日・半荘・スコア・役満・局メモの登録/編集ができる唯一の役割
- **閲覧者**（ログイン不要）: ダッシュボード・対局日詳細・年間集計を誰でも閲覧できる

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. D1データベースの作成

```bash
npx wrangler d1 create mahjong-db
```

出力された `database_id` を `wrangler.toml` の `database_id` に反映する。

### 3. シークレットの設定

本番環境用に以下をWrangler secretとして登録する。

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put AUTH_SECRET   # ランダムな長い文字列（Cookie署名用）
```

ローカル開発では `.dev.vars`（gitignore対象）にこれらを平文で置く。例:

```
ADMIN_PASSWORD=devpassword
AUTH_SECRET=dev-local-secret-change-me
```

### 4. マイグレーション・シードの適用

```bash
# ローカル
npm run db:migrate:local
npm run db:seed:local

# 本番（デプロイ後）
npm run db:migrate:remote
npm run db:seed:remote
```

初期プレイヤーとして「わかさん、もつさん、支店長、たーふる、こだん、あじゃ」の6名がシードされる。

## ローカル開発

```bash
npm run dev
```

`http://127.0.0.1:8787` で起動する。

## テスト

```bash
npm test
```

着順チップ・役満ボーナス・30000点返しの換算・局メモからの暫定スコア（`src/lib/scoring.ts`）、点数表（`src/lib/scoreTable.ts`）、集計（`src/lib/aggregate.ts`）を単体テストしている。

## デプロイ

GitHubの`main`ブランチにpushするとCloudflare側で自動デプロイされる。

## 使い方の流れ

1. （管理者）`/players` で参加者を登録（初期6名は登録済み）
2. （管理者）ナビの「対局日を開始」でその日の参加者を選び対局日を開始（同時に開始できる対局日は1つまで）
3. （管理者）半荘開始前に「次の半荘」で起家から順に座席を登録
4. （管理者）対局中ページで局ごとに局メモを入力（暫定スコアが表示される）
5. （管理者）半荘終了後、確認画面で4人の素点を入力して確定（25000点持ち・30000点返し）。役満が出たら役名と和了者を登録
6. （管理者）その日の対局が終わったらナビの「対局日を終了」で締める
7. （全員）トップページは「直近」「履歴」「点数表」の3タブ。履歴タブ（年度別/通算）から対局日をクリックすると詳細が見られ、プレイヤー名をクリックするとその人の個人成績（通算合計・日別グラフ・特性など）が見られる

過去分のさかのぼり登録は、対局日詳細の「まとめて入力」で最終ポイントを表形式で入力できる。
