import { eq, and, gte, lt, inArray } from "drizzle-orm";
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
import { ORIGIN_SCORE, computeYakumanChips } from "./scoring";

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
        rawTotals.set(row.playerId, (rawTotals.get(row.playerId) ?? 0) + (row.rawScore - ORIGIN_SCORE));
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
      rawTotals.set(row.playerId, (rawTotals.get(row.playerId) ?? 0) + (row.rawScore - ORIGIN_SCORE));
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
