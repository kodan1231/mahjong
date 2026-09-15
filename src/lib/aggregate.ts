import { eq, and, gte, lt, inArray, desc } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  players,
  days,
  dayParticipants,
  gameSessions,
  sessionScores,
  yakumanEvents,
  yakumanEventTargets,
} from "../db/schema";
import { computeYakumanChips } from "./scoring";

export interface PlayerTotal {
  playerId: number;
  name: string;
  rawTotal: number;
  chipTotal: number;
}

interface DateRange {
  /** YYYY-MM-DD (inclusive) */
  from?: string;
  /** YYYY-MM-DD (exclusive) */
  to?: string;
}

async function yakumanChipsForDays(db: Db, dayIds: number[]): Promise<Map<number, number>> {
  const totals = new Map<number, number>();
  if (dayIds.length === 0) return totals;

  const events = await db.select().from(yakumanEvents);
  const relevant = events.filter((e) => dayIds.includes(e.dayId));
  if (relevant.length === 0) return totals;

  // 登録時点のスナップショット（yakuman_event_targets）から対象者を取得する。
  // day_participantsを後から編集しても、過去に確定した役満のチップ集計は変わらない。
  const eventIds = relevant.map((e) => e.id);
  const targetRows = await db
    .select({ yakumanEventId: yakumanEventTargets.yakumanEventId, playerId: yakumanEventTargets.playerId })
    .from(yakumanEventTargets)
    .where(inArray(yakumanEventTargets.yakumanEventId, eventIds));

  const targetsByEvent = new Map<number, number[]>();
  for (const row of targetRows) {
    const list = targetsByEvent.get(row.yakumanEventId) ?? [];
    list.push(row.playerId);
    targetsByEvent.set(row.yakumanEventId, list);
  }

  for (const event of relevant) {
    const targetIds = targetsByEvent.get(event.id) ?? [];
    const participantIds = [...targetIds, event.winnerPlayerId];
    const chips = computeYakumanChips(participantIds, event.winnerPlayerId, event.chipPerLoser);
    for (const { playerId, chip } of chips) {
      totals.set(playerId, (totals.get(playerId) ?? 0) + chip);
    }
  }

  return totals;
}

/** 指定期間（省略時は全期間）の素点合計・チップ合計をプレイヤーごとに集計する。 */
export async function computeTotals(db: Db, range: DateRange = {}): Promise<PlayerTotal[]> {
  const allPlayers = await db.select().from(players);

  const dayConditions = [];
  if (range.from) dayConditions.push(gte(days.date, range.from));
  if (range.to) dayConditions.push(lt(days.date, range.to));

  const dayRows = await db
    .select({ id: days.id })
    .from(days)
    .where(dayConditions.length ? and(...dayConditions) : undefined);
  const dayIds = dayRows.map((d) => d.id);

  const rawTotals = new Map<number, number>();
  const rankChipTotals = new Map<number, number>();

  if (dayIds.length > 0) {
    const rows = await db
      .select({
        playerId: sessionScores.playerId,
        rawScore: sessionScores.rawScore,
        rankChip: sessionScores.rankChip,
        dayId: gameSessions.dayId,
      })
      .from(sessionScores)
      .innerJoin(gameSessions, eq(sessionScores.gameSessionId, gameSessions.id))
      .where(eq(gameSessions.status, "confirmed"));

    for (const row of rows) {
      if (!dayIds.includes(row.dayId)) continue;
      if (row.rawScore != null) {
        // raw_scoreは既に配給原点からの差分（ポイント）そのものなので、そのまま合計する。
        rawTotals.set(row.playerId, (rawTotals.get(row.playerId) ?? 0) + row.rawScore);
      }
      if (row.rankChip != null) {
        rankChipTotals.set(row.playerId, (rankChipTotals.get(row.playerId) ?? 0) + row.rankChip);
      }
    }
  }

  const yakumanTotals = await yakumanChipsForDays(db, dayIds);

  return allPlayers
    .map((p) => ({
      playerId: p.id,
      name: p.name,
      rawTotal: rawTotals.get(p.id) ?? 0,
      chipTotal: (rankChipTotals.get(p.id) ?? 0) + (yakumanTotals.get(p.id) ?? 0),
    }))
    .sort((a, b) => b.rawTotal - a.rawTotal);
}

export function yearRange(year: number): DateRange {
  return { from: `${year}-01-01`, to: `${year + 1}-01-01` };
}

/** その日1日分の小計（素点差分・チップ）をプレイヤーごとに集計する。 */
export async function computeDaySummary(db: Db, dayId: number): Promise<PlayerTotal[]> {
  const participantRows = await db
    .select({ playerId: dayParticipants.playerId, name: players.name })
    .from(dayParticipants)
    .innerJoin(players, eq(dayParticipants.playerId, players.id))
    .where(eq(dayParticipants.dayId, dayId));

  const rawTotals = new Map<number, number>();
  const rankChipTotals = new Map<number, number>();

  const rows = await db
    .select({
      playerId: sessionScores.playerId,
      rawScore: sessionScores.rawScore,
      rankChip: sessionScores.rankChip,
    })
    .from(sessionScores)
    .innerJoin(gameSessions, eq(sessionScores.gameSessionId, gameSessions.id))
    .where(and(eq(gameSessions.dayId, dayId), eq(gameSessions.status, "confirmed")));

  for (const row of rows) {
    if (row.rawScore != null) {
      rawTotals.set(row.playerId, (rawTotals.get(row.playerId) ?? 0) + row.rawScore);
    }
    if (row.rankChip != null) {
      rankChipTotals.set(row.playerId, (rankChipTotals.get(row.playerId) ?? 0) + row.rankChip);
    }
  }

  const yakumanTotals = await yakumanChipsForDays(db, [dayId]);

  return participantRows
    .map((p) => ({
      playerId: p.playerId,
      name: p.name,
      rawTotal: rawTotals.get(p.playerId) ?? 0,
      chipTotal: (rankChipTotals.get(p.playerId) ?? 0) + (yakumanTotals.get(p.playerId) ?? 0),
    }))
    .sort((a, b) => b.rawTotal - a.rawTotal);
}

export interface PlayerYearlyTotal {
  year: number;
  rawTotal: number;
  chipTotal: number;
}

/** そのプレイヤーが参加したことのある年ごとに、素点合計・チップ合計を返す（古い年→新しい年の順）。 */
export async function computePlayerYearlyBreakdown(db: Db, playerId: number): Promise<PlayerYearlyTotal[]> {
  const rows = await db
    .select({ date: days.date })
    .from(dayParticipants)
    .innerJoin(days, eq(dayParticipants.dayId, days.id))
    .where(eq(dayParticipants.playerId, playerId));

  const years = [...new Set(rows.map((r) => Number(r.date.slice(0, 4))))].sort((a, b) => a - b);

  const results: PlayerYearlyTotal[] = [];
  for (const year of years) {
    const totals = await computeTotals(db, yearRange(year));
    const mine = totals.find((t) => t.playerId === playerId);
    results.push({ year, rawTotal: mine?.rawTotal ?? 0, chipTotal: mine?.chipTotal ?? 0 });
  }
  return results;
}

export interface RankDistribution {
  rank: number;
  count: number;
}

/** 確定済み半荘における、そのプレイヤーの着順（1〜4位）ごとの回数。 */
export async function computeRankDistribution(db: Db, playerId: number): Promise<RankDistribution[]> {
  const rows = await db
    .select({ rank: sessionScores.rank })
    .from(sessionScores)
    .innerJoin(gameSessions, eq(sessionScores.gameSessionId, gameSessions.id))
    .where(and(eq(sessionScores.playerId, playerId), eq(gameSessions.status, "confirmed")));

  const counts = new Map<number, number>();
  for (const r of rows) {
    if (r.rank == null) continue;
    counts.set(r.rank, (counts.get(r.rank) ?? 0) + 1);
  }
  return [1, 2, 3, 4].map((rank) => ({ rank, count: counts.get(rank) ?? 0 }));
}

export interface PlayerYakumanWin {
  dayId: number;
  date: string;
  yakuName: string;
}

/** そのプレイヤーが和了した役満の一覧（新しい順）。 */
export async function computePlayerYakumanWins(db: Db, playerId: number): Promise<PlayerYakumanWin[]> {
  return db
    .select({ dayId: days.id, date: days.date, yakuName: yakumanEvents.yakuName })
    .from(yakumanEvents)
    .innerJoin(days, eq(yakumanEvents.dayId, days.id))
    .where(eq(yakumanEvents.winnerPlayerId, playerId))
    .orderBy(desc(days.date));
}

export interface PlayerRankDistribution {
  playerId: number;
  name: string;
  /** [1位, 2位, 3位, 4位]の回数 */
  counts: [number, number, number, number];
}

/** 指定期間（省略時は全期間）の、プレイヤーごとの着順（1〜4位）回数。年度別・通算タブの表用。 */
export async function computeRankDistributionForAllPlayers(
  db: Db,
  range: DateRange = {},
): Promise<PlayerRankDistribution[]> {
  const allPlayers = await db.select().from(players);

  const dayConditions = [];
  if (range.from) dayConditions.push(gte(days.date, range.from));
  if (range.to) dayConditions.push(lt(days.date, range.to));
  const dayRows = await db
    .select({ id: days.id })
    .from(days)
    .where(dayConditions.length ? and(...dayConditions) : undefined);
  const dayIds = dayRows.map((d) => d.id);

  const countsByPlayer = new Map<number, [number, number, number, number]>();
  if (dayIds.length > 0) {
    const rows = await db
      .select({ playerId: sessionScores.playerId, rank: sessionScores.rank })
      .from(sessionScores)
      .innerJoin(gameSessions, eq(sessionScores.gameSessionId, gameSessions.id))
      .where(and(eq(gameSessions.status, "confirmed"), inArray(gameSessions.dayId, dayIds)));

    for (const row of rows) {
      if (row.rank == null || row.rank < 1 || row.rank > 4) continue;
      const arr = countsByPlayer.get(row.playerId) ?? [0, 0, 0, 0];
      arr[row.rank - 1] = (arr[row.rank - 1] ?? 0) + 1;
      countsByPlayer.set(row.playerId, arr);
    }
  }

  return allPlayers.map((p) => ({
    playerId: p.id,
    name: p.name,
    counts: countsByPlayer.get(p.id) ?? [0, 0, 0, 0],
  }));
}

export interface YakumanHistoryEntry {
  dayId: number;
  date: string;
  winnerName: string;
  yakuName: string;
}

/** 指定期間（省略時は全期間）の役満履歴（新しい順）。年度別・通算タブの表示用。 */
export async function computeYakumanHistory(db: Db, range: DateRange = {}): Promise<YakumanHistoryEntry[]> {
  const dayConditions = [];
  if (range.from) dayConditions.push(gte(days.date, range.from));
  if (range.to) dayConditions.push(lt(days.date, range.to));

  return db
    .select({ dayId: days.id, date: days.date, winnerName: players.name, yakuName: yakumanEvents.yakuName })
    .from(yakumanEvents)
    .innerJoin(days, eq(yakumanEvents.dayId, days.id))
    .innerJoin(players, eq(yakumanEvents.winnerPlayerId, players.id))
    .where(dayConditions.length ? and(...dayConditions) : undefined)
    .orderBy(desc(days.date));
}

export interface PlayerDaySummary {
  dayId: number;
  date: string;
  memo: string | null;
  rawTotal: number;
}

/**
 * そのプレイヤーが参加した対局日ごとの、その日1日分のポイント合計。
 * 個人ページの日別集計テーブル・棒グラフ用。confirmed（確定済み）の半荘があった日のみを対象にする
 * （pending/tiedのまま未確定の半荘しかない日は除外する）。日付昇順（古い順）で返す。
 * チップ合計は含めない（個人ページでは他プレイヤーとのチップの差が見える形での表示はしない方針のため）。
 */
export async function computePlayerDailyBreakdown(
  db: Db,
  playerId: number,
  range: DateRange = {},
): Promise<PlayerDaySummary[]> {
  const dayConditions = [eq(dayParticipants.playerId, playerId)];
  if (range.from) dayConditions.push(gte(days.date, range.from));
  if (range.to) dayConditions.push(lt(days.date, range.to));

  const dayRows = await db
    .select({ id: days.id, date: days.date, memo: days.memo })
    .from(dayParticipants)
    .innerJoin(days, eq(dayParticipants.dayId, days.id))
    .where(and(...dayConditions));

  const dayIds = dayRows.map((d) => d.id);
  if (dayIds.length === 0) return [];

  const scoreRows = await db
    .select({ dayId: gameSessions.dayId, rawScore: sessionScores.rawScore })
    .from(sessionScores)
    .innerJoin(gameSessions, eq(sessionScores.gameSessionId, gameSessions.id))
    .where(
      and(
        eq(sessionScores.playerId, playerId),
        eq(gameSessions.status, "confirmed"),
        inArray(gameSessions.dayId, dayIds),
      ),
    );

  const rawByDay = new Map<number, number>();
  for (const r of scoreRows) {
    if (r.rawScore != null) rawByDay.set(r.dayId, (rawByDay.get(r.dayId) ?? 0) + r.rawScore);
  }

  return dayRows
    .filter((d) => rawByDay.has(d.id))
    .map((d) => ({
      dayId: d.id,
      date: d.date,
      memo: d.memo,
      rawTotal: rawByDay.get(d.id) ?? 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
