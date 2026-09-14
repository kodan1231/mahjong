# 麻雀スコア集計Webアプリ

スマホで点数表示機を撮影 → OCRで点数を解析 → 年間の素点・着順チップを集計するWebアプリ。
Cloudflare Workers + D1 + Workers AI (Hono) で構築。

## 構成

- **Cloudflare Workers**: アプリ本体（Hono, TypeScript）
- **D1**: プレイヤー・対局・スコア・チップ・役満・局メモのデータに加え、撮影した元写真もBLOBとして保存する（R2はクレジットカード登録なしでは有効化できないため見送った）
- **Workers AI**: 点数表示機の写真から数値を読み取るVisionモデル（`@cf/meta/llama-3.2-11b-vision-instruct`）
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

### 3. Workers AIの有効化

Cloudflareダッシュボードで対象アカウントのWorkers AIが有効になっていることを確認する（`[ai]` バインディングは追加設定不要）。

### 4. シークレットの設定

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

### 5. マイグレーション・シードの適用

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

`http://127.0.0.1:8787` で起動する。Workers AIはローカル実行でも実際のCloudflareアカウントを使用するため、少量の利用料が発生する点に注意（無料枠内であれば課金なし）。

## テスト

```bash
npm test
```

着順チップ・役満ボーナス・素点正規化のロジック（`src/lib/scoring.ts`）を単体テストしている。

## デプロイ

```bash
npx wrangler deploy
```

## 使い方の流れ

1. （管理者）`/players` で参加者を登録（初期6名は登録済み）
2. （管理者）`/days/new` でその日の参加者を選び対局日を開始
3. （管理者）半荘開始前に `/days/:id/sessions/new` でその半荘の座席順（管理者から見た並び＝点数表示機の表示順）を登録
4. （管理者）半荘終了後、点数表示機を撮影 → OCR結果を確認・修正して確定（箱割れがあれば手動で実際のマイナス点数に上書き）
5. （管理者）役満が出たら役名と和了者を登録。局ごとの和了メモも任意で追加可能
6. （全員）トップページや `/days/:id`、`/stats/:year` でいつでも閲覧可能
