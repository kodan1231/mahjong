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
    winType: text("win_type", { enum: ["ron", "tsumo", "draw", "chombo"] }).notNull(),
    winnerPlayerId: integer("winner_player_id").references(() => players.id),
    // ロン時は放銃者、チョンボ時はチョンボした対象プレイヤーを指す（UI上はどちらも「対象」と表現する）
    loserPlayerId: integer("loser_player_id").references(() => players.id),
    yakuText: text("yaku_text"),
    points: integer("points"), // その局の点数（例: 3900, 8000など。任意）
    // 流局時のテンパイ者（playerIdの配列をJSON文字列として保存。例: "[1,3]"）。任意
    tenpaiPlayerIds: text("tenpai_player_ids"),
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
