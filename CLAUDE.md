# 麻雀スコア集計Webアプリ - プロジェクトメモ

スマホで点数表示機を撮影 → OCRで点数を解析 → 年間の素点・着順チップを集計するWebアプリ。
Cloudflare Workers + D1 + Workers AI (Hono) で構築。詳細なセットアップ手順は [README.md](README.md) を参照。

このファイルはヒアリングで確定した要件・設計判断をまとめたもの。新しいセッションはこれを読めば経緯を再確認しなくてよい。

## 確定要件

- **撮影対象**: 電子点数表示機（点棒代わりのLED/LCDカウンター、4人分の点数が並んで表示される）
- **OCR**: Cloudflare Workers AI のVisionモデル（`@cf/meta/llama-3.2-11b-vision-instruct`）。追加API契約・課金不要
- **表示パターンが2種類ありうる**: ①素点そのまま ②「集計結果」ボタン押下後は配給原点(25000)からの±差分表示。半荘ごとに管理者が選択し、内部的には常に素点に正規化して保存する（`normalizeRawScore`）。**②の差分表示は1000点単位**（麻雀の慣習で25000点を「25」と表すのと同じ。表示が"+18"なら実際は+18000点）なので、`normalizeRawScore`は`origin + ocrValue * 1000`で計算する。ここを1点単位のまま加算するバグを一度作り込んだことがあるので要注意
- **着順チップ**: 半荘ごとに固定 (1位+3 / 2位0 / 3位-1 / 4位-2)。合計0になる設計
- **役満ボーナス**: 和了者以外の「その日の参加者全員」（その半荘に着席していない人も含む）が-5、和了者が総取り（+5×他の参加者数）
- **箱割れ**: 電子表示機はマイナスを反映しないことがあるため、管理者が該当プレイヤーを「箱割れ」としてマークし、実際のマイナス点数を手動入力して上書きできる
- **年間合計点数の基準点**: 25000点持ち（素点-25000を各半荘の得点として加算）
- **局メモ**: 半荘内の各局で誰が誰から（ロン）／自摸で、どんな手（役）で上がったかを任意記録。スコア計算には影響しない付随記録
- **写真原本**: 後から見返せるように保存する（当初R2を想定していたが、後述の理由でD1にBLOB保存する方式に変更）
- **役割は2種類**:
  - **管理者（こだん）**: 唯一の書き込み権限者。共有パスワードでログイン
  - **閲覧者**: 参加者以外も含め誰でも、ログイン不要で閲覧できる（`noindex`付与、検索エンジン非公開）
- **初期プレイヤー**: わかさん、もつさん、支店長、たーふる、こだん、あじゃ（の6名。後から追加登録可能）

## 運用フロー

1. 事前設定（随時・管理者）: プレイヤーをマスター登録
2. 当日設定（対局日ごと・管理者）: 麻雀開始前にその日の参加者（Day参加者）を選ぶ
3. 半荘開始前（半荘ごと・管理者）: その半荘の参加者を、管理者から見た座席順（＝点数表示機の表示順と一致する想定）で登録。この時点ではまだ点数は未確定（`pending`）
4. 半荘終了後（管理者）: 点数表示機を撮影 → OCR結果を直前に登録した座席順に突き合わせて表示 → 確認・修正して確定（`confirmed`）。役満が出たら役名と和了者を登録
5. 当日終了以降（誰でも閲覧可）: その日の小計と、年間/通算の合計を表示

## アーキテクチャ

- **Cloudflare Workers**（Hono, TypeScript）: アプリ本体。SSRはHono JSX、クライアントJSは撮影ページの最小限のfetch呼び出しのみ
- **D1**（Drizzle ORM）: `src/db/schema.ts` にスキーマ定義。マイグレーションは `drizzle/` ディレクトリ
- **写真の保存先はD1（BLOB）**: 当初R2を想定していたが、R2の有効化にクレジットカード登録が必要だったため見送り、`photo_uploads.image_data`にBLOBとして直接保存する方式に変更した。クライアント側で長辺1600px程度に縮小してからアップロードしているため、D1の1行あたりサイズ上限内に収まる想定。読み出し時は`new Uint8Array(photo.imageData)`で必ずラップしてから`Response`に渡すこと（drizzleのD1ドライバがblobをそのまま返すとバイト列でなく配列的な値になり、`new Response()`に直接渡すと文字列化されて壊れることを確認済み）。`GET /api/photos/:id`（管理者専用）で元写真を見返せる
- **Workers AI**: `AI`バインディング。`src/lib/ocr.ts` で呼び出し
- **認証**: `src/lib/auth.ts`。共有パスワード1つ（`ADMIN_PASSWORD` secret）+ HMAC署名Cookie（`AUTH_SECRET` secret）。書き込み系ルートのみ`requireAdmin`ミドルウェアで保護、閲覧系は認証なし

### データモデル（`src/db/schema.ts`）

- `players`: id, name, active
- `days`: id, date, memo
- `day_participants`: dayId, playerId（その日の参加者。役満登録フォームの選択肢に使う）
- `game_sessions`: id, dayId, seq, status(`pending`/`confirmed`), displayMode(`raw`/`diff`), playedAt
- `session_scores`: gameSessionId, seatIndex(0-3), playerId, rawScore, isHakoware, rank, rankChip
  - 半荘開始前に座席順で4行作成 → 撮影後OCR値を素点正規化してrawScoreを埋める → 確定時にrank/rankChipを計算
- `yakuman_events`: id, dayId, gameSessionId(nullable), winnerPlayerId, yakuName, chipPerLoser(default 5)
- `yakuman_event_targets`: id, yakumanEventId, playerId
  - 役満登録時にチップを払う対象者をチェックボックスで選び、その時点のIDリストをスナップショットとして保存する。`day_participants`を後から編集しても、既に登録済みの役満チップ集計は変わらない（`src/lib/aggregate.ts`の`yakumanChipsForDays`はこのテーブルを参照する）
- `hand_logs`: id, gameSessionId, seq, roundLabel, winType(`ron`/`tsumo`/`draw`), winnerPlayerId, loserPlayerId, yakuText
- `photo_uploads`: id, gameSessionId, imageData(blob), contentType, ocrRawJson
- `settings`: key/value（現状未使用、将来の設定用に予約）

### コアロジック（`src/lib/scoring.ts`）

- `normalizeRawScore(ocrValue, displayMode, origin=25000)`
- `computeRankAndChips(scores)`: 同点時は`hasTie`を返し自動タイブレークしない（呼び出し側で警告し手動調整させる）
- `computeYakumanChips(dayParticipantIds, winnerId, perLoser=5)`
- 単体テスト: `test/scoring.test.ts`（`npm test`）

### 集計（`src/lib/aggregate.ts`）

- `computeTotals(db, range?)`: 期間指定なしで通算、`yearRange(year)`で年間集計
- `computeDaySummary(db, dayId)`: 当日の小計
- `computePlayerYearlyBreakdown(db, playerId)`: そのプレイヤーが参加した年ごとの素点・チップ集計
- `computeRankDistribution(db, playerId)`: 着順（1〜4位）ごとの回数
- `computePlayerYakumanWins(db, playerId)`: そのプレイヤーが和了した役満一覧
- `computePlayerScoreHistory(db, playerId)`: 確定済み半荘を時系列に並べた素点差分の累計推移（個人ページの折れ線グラフ用）

共有UIコンポーネント（`src/views/components.tsx`）: `Signed`（+/-付きの数値表示）、`Sparkline`（追加ライブラリ無しでSVGの折れ線グラフをサーバー側生成）、`TotalsTable`（プレイヤー別 素点/チップ合計テーブル、名前は`/players/:id`へリンク）、`TabBar`（当日/年度別/通算の3タブ、`active`と`year`をpropで指定）

### 対局日のライフサイクル（open/closed）

- `days.status`: `open`（進行中） / `closed`（終了済み）。**「今日の日付」で新規作成するときだけ**、同時にopenな日は1つまでを強制する（`POST /days`は日付が今日と一致し、かつ既にopenな日があれば新規作成せずその日にリダイレクトする）。**過去日付での登録（バックフィル）は進行中の対局日の有無に関わらず常に許可**し、作成時点で最初からclosedとして扱う（後から何日分でもさかのぼって登録できる。この判定を誤ると「今季すでに何日か終わっている分をさかのぼって登録したい」という要件を満たせなくなるので注意）
- 管理者ナビの「対局日を開始」→`/days/new`、「対局日を終了」→`POST /days/close`（現在openな日を探してclosedにし、その日の詳細へリダイレクト。openな日が無ければ`/`へ）。この2つは管理者メニューの先頭に配置（`src/views/layout.tsx`）
- 「当日」タブ（`GET /`）はopenな日があればその内容を表示し、無ければ「現在進行中の対局日はありません」を表示する

### ルート構成（3タブ + 個人ページ + 履歴ドリルダウン）

- 公開:
  - `GET /`（当日タブ。openな対局日の内容をそのまま表示）
  - `GET /years/:year`（年度別タブ。その年の合計テーブル＋終了済み対局日一覧。日付をクリックすると`/days/:id`へ）
  - `GET /overall`（通算タブ。全期間の合計テーブルのみ）
  - `GET /days/:id`（対局日の詳細。年タブから日付をクリックして辿り着く想定。`?autorefresh=1`で20秒ごとの自動更新トグルも維持）
  - `GET /players/:id`（個人成績：通算合計・素点推移グラフ・年別内訳・着順分布・役満一覧。**通算の数値はここでのみ表示**し、他のページではプレイヤー名のリンク経由でここに誘導する）
- 管理者専用: `/login`, `/players`, `/days/new`, `POST /days/close`, `/days/:id/edit`, `/days/:id/sessions/new`, `/days/:id/sessions/:sid/capture`, `/api/ocr`, `/days/:id/sessions/:sid/confirm`, `/days/:id/yakuman`, `/days/:id/sessions/:sid/hands`, `/days/:id/sheet`（下記）, 各種delete系ルート

### まとめて入力（スプレッドシート風の一括登録、過去履歴のバックフィル向け）

`GET/POST /days/:id/sheet`。半荘ごとに座席登録→撮影→確認、という通常フロー（**これは変更しないこと** — 実機での当日運用はこの流れのまま使う）とは別に、「行＝半荘、列＝その日の参加者」の表に直接素点を入力して一括保存できる画面。雀荘の紙の記録用紙をイメージしたUI。

- 列はその日の`day_participants`（登録順）。行は既存の半荘（seq順）＋空行5つ（`SHEET_EXTRA_BLANK_ROWS`）
- 1行につき4人分すべて数値が入っていれば、その場で`computeRankAndChips`を実行し`status: "confirmed"`のgame_session（無ければ新規作成）として保存する。列の並び順がそのままseatIndex 0-3になる
- 空欄のみの行はスキップ（未入力として無視）。1〜3人分しか入っていない行、同点になる行は保存せず、どのseqが保存されなかったか`?skipped=3,4`のようなクエリでGET側に伝えて警告表示する
- 箱割れ・役満・局メモはこの画面では扱わない。保存後に`/days/:id`や個別半荘の確認画面から編集する
- display_modeは常に`raw`固定（素点をそのまま入力する前提。配給原点からの差分入力には対応しない）

`/days`（対局日一覧・年ごとにグループ化する単独ページ）と`/stats/:year`は廃止し、`/years/:year`に統合した。年間の対局数が少ない（12試合程度）想定のため、日別の専用一覧ページは持たず年タブに内包している。

対局日詳細のデータ取得・描画（`src/routes/days.tsx`の`loadDayDetail` + `DayDetailBody`）は「当日」タブと`/days/:id`で共通利用している。新しい表示要素を足す場合は`DayDetailBody`側を触ればどちらにも反映される。

`Layout`（`src/views/layout.tsx`）のナビは公開部分が「ホーム」のみで、タブ切り替えは各ページ内の`TabBar`コンポーネントが担う。管理者ログイン時は「対局日を開始」「対局日を終了」「プレイヤー管理」「ログアウト」がこの順で並ぶ。`extraHead`propでhead内に任意要素（自動更新用の`<meta http-equiv="refresh">`など）を差し込める。

### デザイン

麻雀感のある「今風」デザインへ刷新済み（`src/views/layout.tsx`のCSS）。背景は緑のフェルト風グラデーション、カードは生成り色のタイル風（角丸＋影）、アクセントカラーは金（`--gold`）。タブバーはピル型、アクティブタブは金背景。CSSカスタムプロパティ（`--felt`, `--tile`, `--gold`, `--plus`, `--minus`等）は`:root`で一括管理。

- **フォント**: Google FontsからNoto Sans JPを読み込み（`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:...">`）、`font-family`の先頭に指定。端末のシステムフォント任せだと（特にiOS Safariで）意図と異なる書体になることがあったための対応
- **ナビゲーション**: `.app-nav`内のリンク/ボタンはピル型チップ表示（半透明の背景＋角丸）にしている。カード内の削除リンクなど`.app-nav`外の`.link-button`は下線付きテキストリンクとして別途スタイルしている（`.app-nav .link-button`のセレクタでナビ内だけ上書き）。`<a>`と`<button>`（フォーム内）で高さがズレないよう、両方に`display:inline-flex; align-items:center; margin:0`を明示している
- **文字サイズ**: 利用者に高齢の方が多いため`html { font-size: 18px }`で全体的に大きめに設定。その分、カード内padding・テーブルセルpadding・見出しの上マージンは詰めて、1画面に収まる情報量とのバランスを取っている
- **座席・プレイヤー選択（`.choice-group` / `.choice-btn`）**: `<select>`ではなく、ラジオボタンをボタン風に見せる方式（`.choice-btn:has(input:checked)`でアクティブ状態を表現）。参加者が最大6人程度なので1行に並べたいが、大きめの文字サイズだと画面幅に収まりきらない可能性があるため、`.choice-group`は`flex-wrap:nowrap; overflow-x:auto`とし、2段に折り返す代わりに横スクロールで対応する設計にしている。座席登録画面（`/days/:id/sessions/new`）と確認画面（`/days/:id/sessions/:sid/confirm`）の両方で使用
- **一覧系テーブルからチップ合計を削除**: `TotalsTable`（当日/年度別/通算タブ、対局日の小計）は素点合計のみ表示する。チップ合計は`/players/:id`の個人ページでのみ表示する方針（チップはあくまで付録情報のため）
- **リンクの色は背景で切り替え**: 濃緑のフェルト背景に直接乗るリンク（`a`のデフォルト）は金（`--gold`）、白系カード/テーブルの上のリンク（`.card a`, `table a`）は緑（`#0d5c3f`）。同系色×同系色で文字が埋もれる問題（濃緑背景に濃緑リンク）が実際に起きたための対応。新しく`.card`の外に直接リンクを置く場合は金系の配色になる点に注意

**Honoの罠**: サブルーターに`.use("*", middleware)`を書いて`app.route("/", subApp)`でマウントすると、そのミドルウェアがアプリ全体（他のサブルーターのパスも含む）にかかってしまう。各ルートに個別で `requireAdmin` を渡す方式にしている（`playerRoutes.get("/players", requireAdmin, handler)`）。新しい管理者専用ルートを追加する際もこの書き方を踏襲すること。

## 既知の運用上の懸念

- **チップはあくまで付録**: 年間順位を決めるのは素点合計であり、チップ(着順チップ・役満チップ)は補足情報という位置づけ。誰がいつ役満を出したかが分かればよく、厳密さより見やすさ・分かりやすさを優先する
- **OCR精度は実機未検証**: 実際の点数表示機の写真でのテストがまだできていない。当面は「OCR結果を確認して手直しする」運用が前提
- **共有パスワードにレート制限なし**: 閲覧は認証不要でURLが広まりやすい設計のため、ログインへの総当たりを防ぐ仕組みは未実装
- **ダッシュボードの「今年」判定はサーバー(UTC)時刻基準**: 日本時間の大晦日〜元日をまたぐ対局で、トップページの年別集計の初期表示がずれる可能性がある（`/stats/:year`で明示的に年を指定すれば正しく見られる）

## 将来拡張（未着手・意図的にスコープ外）

- あがり率・放銃率・得意役・平均点などの個人統計（`hand_logs`と`session_scores`から算出可能、データが貯まってから着手）
- 牌の写真からの自動点数計算は精度・実現性の問題で見送り。将来やるなら局メモに役チェックボックス＋翻符入力の手動スコア計算機を追加する方向

## 実装状況

- スコア計算ロジック・集計ロジック・全ルート・OCR連携・D1への写真保存まで実装済み。ローカル(`wrangler dev`)で一連のフロー（ログイン→プレイヤー登録→対局日作成→半荘登録→OCR疎通確認→スコア確定→役満・局メモ登録→ダッシュボード/年間集計表示）を動作確認済み
- **バックフィル・修正用の管理画面も実装済み**（今シーズン開催済みの対局日をさかのぼって登録・修正する用途）:
  - `/days/:id/edit`（GET/POST）: 対局日の日付・メモ・参加者を編集（参加者の追加/削除に対応）
  - 半荘の確認画面（`/days/:id/sessions/:sid/confirm`）は`confirmed`後も再訪問可能な「編集」画面として機能する。各座席のプレイヤーもセレクトボックスで変更可能（座席とプレイヤーの紐づけ自体を後から修正できる）。フォームのフィールド名は`player_{seatIndex}` / `score_{seatIndex}` / `hakoware_{seatIndex}`（座席インデックス基準。playerId基準ではない点に注意）
  - `/days/:id/sessions/:sid/delete`（POST）: 半荘を削除（関連するsession_scores/hand_logs/photo_uploadsも削除、参照しているyakuman_events.gameSessionIdはnullに更新）。確認ダイアログ付き
  - `/days/:id/yakuman/:yid/delete`, `/days/:id/hands/:hid/delete`（POST）: 役満・局メモの削除
  - 対局日自体の削除（day削除）は未実装（意図的に見送り。誤操作の影響が大きいため）
- **撮影ページで写真をアップロード前にクライアント側リサイズ**: `src/routes/days.tsx`の撮影ページ（`/days/:id/sessions/:sid/capture`）で、`canvas`を使い長辺1600px・JPEG品質0.85に縮小してから`/api/ocr`にアップロードする（スマホの高解像度写真をそのまま送るとOCRが遅い/失敗しやすい懸念への対応）。縮小に失敗した場合は元画像にフォールバック
- **本番D1・シークレットは登録済み**: `wrangler d1 create`で実DB作成済み（`wrangler.toml`のdatabase_idを反映）、`wrangler secret put`で`ADMIN_PASSWORD`/`AUTH_SECRET`も登録済み。R2は使わない方針に変更したため未使用（有効化にクレジットカード登録が必要だったため見送り、写真はD1にBLOB保存する方式に変更した）
- 未着手: `wrangler deploy`（本番デプロイ自体はまだ実行していない）
