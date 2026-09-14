import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const players = sqliteTable("players", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const days = sqliteTable("days", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(), // YYYY-MM-DD
  memo: text("memo"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const dayParticipants = sqliteTable(
  "day_participants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    dayId: integer("day_id").notNull().references(() => days.id),
    playerId: integer("player_id").notNull().references(() => players.id),
  },
  (t) => ({
    uniq: uniqueIndex("day_participants_unique").on(t.dayId, t.playerId),
  }),
);

export const gameSessions = sqliteTable("game_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dayId: integer("day_id").notNull().references(() => days.id),
  seq: integer("seq").notNull(), // 何半荘目か
  status: text("status", { enum: ["pending", "confirmed"] }).notNull().default("pending"),
  displayMode: text("display_mode", { enum: ["raw", "diff"] }).notNull().default("raw"),
  playedAt: text("played_at"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const sessionScores = sqliteTable(
  "session_scores",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    gameSessionId: integer("game_session_id").notNull().references(() => gameSessions.id),
    seatIndex: integer("seat_index").notNull(), // 0-3
    playerId: integer("player_id").notNull().references(() => players.id),
    rawScore: integer("raw_score"), // null until confirmed
    isHakoware: integer("is_hakoware", { mode: "boolean" }).notNull().default(false),
    rank: integer("rank"), // 1-4, null until confirmed
    rankChip: integer("rank_chip"), // null until confirmed
  },
  (t) => ({
    uniq: uniqueIndex("session_scores_seat_unique").on(t.gameSessionId, t.seatIndex),
  }),
);

export const yakumanEvents = sqliteTable("yakuman_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dayId: integer("day_id").notNull().references(() => days.id),
  gameSessionId: integer("game_session_id").references(() => gameSessions.id),
  winnerPlayerId: integer("winner_player_id").notNull().references(() => players.id),
  yakuName: text("yaku_name").notNull(),
  chipPerLoser: integer("chip_per_loser").notNull().default(5),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

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

export const handLogs = sqliteTable("hand_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  gameSessionId: integer("game_session_id").notNull().references(() => gameSessions.id),
  seq: integer("seq"), // 何局目か（任意）
  roundLabel: text("round_label"), // 「東1局」等（任意）
  winType: text("win_type", { enum: ["ron", "tsumo", "draw"] }).notNull(),
  winnerPlayerId: integer("winner_player_id").references(() => players.id),
  loserPlayerId: integer("loser_player_id").references(() => players.id),
  yakuText: text("yaku_text"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const photoUploads = sqliteTable("photo_uploads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  gameSessionId: integer("game_session_id").references(() => gameSessions.id),
  r2Key: text("r2_key").notNull(),
  ocrRawJson: text("ocr_raw_json"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
