import { sqliteTable, text, integer, real, blob, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const players = sqliteTable("players", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const days = sqliteTable(
  "days",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(), // YYYY-MM-DD
    memo: text("memo"),
    // 「対局日を開始」でopen、「対局日を終了」でclosedになる。同時にopenの日は1つまでの運用を想定。
    status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (t) => ({
    // aggregate.tsの年度別/通算集計が date の範囲検索・完全一致検索を多用するため
    dateIdx: index("days_date_idx").on(t.date),
  }),
);

export const dayParticipants = sqliteTable(
  "day_participants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    dayId: integer("day_id").notNull().references(() => days.id),
    playerId: integer("player_id").notNull().references(() => players.id),
  },
  (t) => ({
    uniq: uniqueIndex("day_participants_unique").on(t.dayId, t.playerId),
    // dayId単独の検索はuniq(dayId, playerId)の先頭列で足りるが、playerId単独（個人ページの集計）には別途必要
    playerIdx: index("day_participants_player_id_idx").on(t.playerId),
  }),
);

export const gameSessions = sqliteTable(
  "game_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    dayId: integer("day_id").notNull().references(() => days.id),
    seq: integer("seq").notNull(), // 何半荘目か
    status: text("status", { enum: ["pending", "confirmed"] }).notNull().default("pending"),
    displayMode: text("display_mode", { enum: ["raw", "diff"] }).notNull().default("raw"),
    playedAt: text("played_at"),
    // 小計ブロック（複数半荘分をまとめて登録する行）の任意ラベル。例:「前半」。通常の半荘では未使用
    memo: text("memo"),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (t) => ({
    dayIdx: index("game_sessions_day_id_idx").on(t.dayId),
  }),
);

export const sessionScores = sqliteTable(
  "session_scores",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    gameSessionId: integer("game_session_id").notNull().references(() => gameSessions.id),
    seatIndex: integer("seat_index").notNull(), // 0-3
    playerId: integer("player_id").notNull().references(() => players.id),
    // 「ポイント」単位（実際の素点÷1000。例: 素点32000点 → 32ポイント）で保存する。null until confirmed
    rawScore: real("raw_score"),
    isHakoware: integer("is_hakoware", { mode: "boolean" }).notNull().default(false),
    rank: integer("rank"), // 1-4, null until confirmed
    rankChip: integer("rank_chip"), // null until confirmed
  },
  (t) => ({
    // gameSessionId単独の検索はこのuniqueIndexの先頭列で足りるが、playerId単独（個人ページの集計）には別途必要
    uniq: uniqueIndex("session_scores_seat_unique").on(t.gameSessionId, t.seatIndex),
    playerIdx: index("session_scores_player_id_idx").on(t.playerId),
  }),
);

export const yakumanEvents = sqliteTable(
  "yakuman_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    dayId: integer("day_id").notNull().references(() => days.id),
    gameSessionId: integer("game_session_id").references(() => gameSessions.id),
    winnerPlayerId: integer("winner_player_id").notNull().references(() => players.id),
    yakuName: text("yaku_name").notNull(),
    chipPerLoser: integer("chip_per_loser").notNull().default(5),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (t) => ({
    dayIdx: index("yakuman_events_day_id_idx").on(t.dayId),
  }),
);

// 役満発生時にチップを払った対象者のスナップショット。
// day_participantsを後から編集しても過去の役満チップ集計が変わらないよう、登録時点の対象者を固定して保存する。
export const yakumanEventTargets = sqliteTable(
  "yakuman_event_targets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    yakumanEventId: integer("yakuman_event_id").notNull().references(() => yakumanEvents.id),
    playerId: integer("player_id").notNull().references(() => players.id),
  },
  (t) => ({
    uniq: uniqueIndex("yakuman_event_targets_unique").on(t.yakumanEventId, t.playerId),
  }),
);

export const handLogs = sqliteTable(
  "hand_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    gameSessionId: integer("game_session_id").notNull().references(() => gameSessions.id),
    seq: integer("seq"), // 何局目か（任意）
    roundLabel: text("round_label"), // 「東1局」等（任意）
    // 本場（連荘数）。前の局で親が和了、または流局で親がテンパイのときに+1、それ以外は0に戻る想定だが、
    // 自動計算値は入力フォーム側の初期値でしかなく、ここには実際に保存された（必要なら手修正済みの）値が入る。
    honba: integer("honba").notNull().default(0),
    winType: text("win_type", { enum: ["ron", "tsumo", "draw", "chombo"] }).notNull(),
    winnerPlayerId: integer("winner_player_id").references(() => players.id),
    // ロン時は放銃者、チョンボ時はチョンボした対象プレイヤーを指す（UI上はどちらも「対象」と表現する）
    loserPlayerId: integer("loser_player_id").references(() => players.id),
    yakuText: text("yaku_text"),
    // その局の点数（例: 3900, 8000など。任意）。上がった役由来の点数のみを入力する想定で、
    // 本場・リーチ棒分はここに含めない（現在のスコア計算側でhonba・riichiPlayerIdsから自動加算する）。
    // 子のツモの場合はこの値が「子の支払い額（1人あたり）」を表す（dealerPoints参照）。
    points: integer("points"),
    // 子のツモ時の「親の支払い額」。符・翻の計算過程で親・子それぞれ独立に100点単位で切り上げるため、
    // 親の支払いは子の支払い(points)のちょうど2倍にならないことがある（例: 1300/700）。このため
    // 子のツモに限り、合計から比率で分配するのではなく親・子の支払い額をそれぞれ直接入力してもらう。
    // ロン・親のツモでは未使用（null）。
    dealerPoints: integer("dealer_points"),
    // 流局時のテンパイ者（playerIdの配列をJSON文字列として保存。例: "[1,3]"）。任意
    tenpaiPlayerIds: text("tenpai_player_ids"),
    // この局でリーチした人（playerIdの配列をJSON文字列。例: "[1,3]"）。任意。
    // 和了・流局など結果に関わらず記録する（リーチ率は和了時だけでは正しく集計できないため）
    riichiPlayerIds: text("riichi_player_ids"),
    // この局で鳴き（チー・ポン・カン）をした人（playerIdの配列をJSON文字列）。任意
    nakiPlayerIds: text("naki_player_ids"),
    // 上がった時のドラ枚数（任意、将来の個人成績「表/裏/赤ドラ平均数」用）。それぞれ独立して入力する
    omoteDoraCount: integer("omote_dora_count"),
    uraDoraCount: integer("ura_dora_count"),
    akaDoraCount: integer("aka_dora_count"),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  },
  (t) => ({
    gameSessionIdx: index("hand_logs_game_session_id_idx").on(t.gameSessionId),
  }),
);

export const photoUploads = sqliteTable("photo_uploads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  gameSessionId: integer("game_session_id").references(() => gameSessions.id),
  // 写真本体はR2ではなくD1にBLOBとして保存する（R2の有効化にクレジットカード登録が必要なため見送り）。
  // クライアント側で長辺1600px程度に縮小してからアップロードしているため、D1の1行あたりサイズ上限には収まる想定。
  imageData: blob("image_data", { mode: "buffer" }).notNull(),
  contentType: text("content_type").notNull(),
  ocrRawJson: text("ocr_raw_json"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
