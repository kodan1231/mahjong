import { eq, and, gte, lt, inArray, desc, asc, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  players,
  days,
  dayParticipants,
  gameSessions,
  sessionScores,
  yakumanEvents,
  yakumanEventTargets,
  handLogs,
} from "../db/schema";
import { computeYakumanChips, ROUND_OPTIONS } from "./scoring";

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

interface YakumanEventLite {
  id: number;
  winnerPlayerId: number;
  chipPerLoser: number;
}

interface YakumanTargetLite {
  yakumanEventId: number;
  playerId: number;
}

/**
 * 役満イベント（登録時点の対象者スナップショット込み）から、プレイヤーごとのチップ増減を集計する。
 * DBアクセスを含まない純粋関数。yakumanChipsForDays（DBから取得して呼ぶ）と
 * summarizeDayTotals（呼び出し側が既に持っているデータから呼ぶ）の両方から共有する。
 */
function computeYakumanChipTotals(events: YakumanEventLite[], targets: YakumanTargetLite[]): Map<number, number> {
  const targetsByEvent = new Map<number, number[]>();
  for (const row of targets) {
    const list = targetsByEvent.get(row.yakumanEventId) ?? [];
    list.push(row.playerId);
    targetsByEvent.set(row.yakumanEventId, list);
  }

  const totals = new Map<number, number>();
  for (const event of events) {
    const targetIds = targetsByEvent.get(event.id) ?? [];
    const participantIds = [...targetIds, event.winnerPlayerId];
    const chips = computeYakumanChips(participantIds, event.winnerPlayerId, event.chipPerLoser);
    for (const { playerId, chip } of chips) {
      totals.set(playerId, (totals.get(playerId) ?? 0) + chip);
    }
  }
  return totals;
}

/**
 * 指定した日付範囲（省略時は全期間）に対応する役満チップ増減をプレイヤーごとに集計する。
 * 以前は対象のdays.idを一旦JSの配列にしてinArray(yakumanEvents.dayId, dayIds)へ渡していたが、
 * 対局日数が増えるほどSQL側のバインド変数がD1の上限（1クエリ100個）を超えて
 * 「D1_ERROR: too many SQL variables」になる（computePlayerTraitsで実データにより発覚・修正済みの
 * 問題と同じ構造）。ここではdaysを直接JOINして日付範囲そのものでSQL側を絞り込み、
 * IDの配列をバインド変数として渡さないようにしている。
 */
async function yakumanChipsForDays(db: Db, dayFilter: ReturnType<typeof and>): Promise<Map<number, number>> {
  const events = await db
    .select({ id: yakumanEvents.id, winnerPlayerId: yakumanEvents.winnerPlayerId, chipPerLoser: yakumanEvents.chipPerLoser })
    .from(yakumanEvents)
    .innerJoin(days, eq(yakumanEvents.dayId, days.id))
    .where(dayFilter);
  if (events.length === 0) return new Map();

  // 登録時点のスナップショット（yakuman_event_targets）から対象者を取得する。
  // day_participantsを後から編集しても、過去に確定した役満のチップ集計は変わらない。
  // yakuman_eventsの件数は現実的にSQL変数の上限に達する心配は無いが（役満は稀な出来事のため）、
  // 念のためこちらもIDの配列を直接渡さずサブクエリで絞り込む。
  const targetRows = await db
    .select({ yakumanEventId: yakumanEventTargets.yakumanEventId, playerId: yakumanEventTargets.playerId })
    .from(yakumanEventTargets)
    .where(
      inArray(
        yakumanEventTargets.yakumanEventId,
        db.select({ id: yakumanEvents.id }).from(yakumanEvents).innerJoin(days, eq(yakumanEvents.dayId, days.id)).where(dayFilter),
      ),
    );

  return computeYakumanChipTotals(events, targetRows);
}

/** 指定期間（省略時は全期間）の素点合計・チップ合計をプレイヤーごとに集計する。 */
export async function computeTotals(db: Db, range: DateRange = {}): Promise<PlayerTotal[]> {
  const allPlayers = await db.select().from(players);

  const dayConditions = [];
  if (range.from) dayConditions.push(gte(days.date, range.from));
  if (range.to) dayConditions.push(lt(days.date, range.to));
  const dayFilter = dayConditions.length ? and(...dayConditions) : undefined;

  const rawTotals = new Map<number, number>();
  const rankChipTotals = new Map<number, number>();

  // dayIdsの配列をinArrayへ渡す代わりに、gameSessions側からdaysを直接JOINして日付範囲で絞り込む
  // （理由はyakumanChipsForDaysのコメント参照。対局日数が100件を超えると同じ構造で壊れるため）。
  const rows = await db
    .select({
      playerId: sessionScores.playerId,
      rawScore: sessionScores.rawScore,
      rankChip: sessionScores.rankChip,
    })
    .from(sessionScores)
    .innerJoin(gameSessions, eq(sessionScores.gameSessionId, gameSessions.id))
    .innerJoin(days, eq(gameSessions.dayId, days.id))
    .where(and(eq(gameSessions.status, "confirmed"), dayFilter));

  for (const row of rows) {
    if (row.rawScore != null) {
      // raw_scoreは既に配給原点からの差分（ポイント）そのものなので、そのまま合計する。
      rawTotals.set(row.playerId, (rawTotals.get(row.playerId) ?? 0) + row.rawScore);
    }
    if (row.rankChip != null) {
      rankChipTotals.set(row.playerId, (rankChipTotals.get(row.playerId) ?? 0) + row.rankChip);
    }
  }

  const yakumanTotals = await yakumanChipsForDays(db, dayFilter);

  return allPlayers
    .map((p) => ({
      playerId: p.id,
      name: p.name,
      rawTotal: rawTotals.get(p.id) ?? 0,
      chipTotal: (rankChipTotals.get(p.id) ?? 0) + (yakumanTotals.get(p.id) ?? 0),
    }))
    .sort((a, b) => b.rawTotal - a.rawTotal);
}

/**
 * そのプレイヤー1人分の、全期間の素点差分（ポイント）合計。個人ページの「通算」表示専用。
 * 以前はここでも全プレイヤー・全期間を集計するcomputeTotalsを呼んで1人分だけ取り出しており、
 * 個人ページを開くたびに履歴全体をスキャンしていた。SQL側のSUMで対象プレイヤーの行だけ集計する。
 */
export async function computePlayerRawTotal(db: Db, playerId: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${sessionScores.rawScore}), 0)` })
    .from(sessionScores)
    .innerJoin(gameSessions, eq(sessionScores.gameSessionId, gameSessions.id))
    .where(and(eq(sessionScores.playerId, playerId), eq(gameSessions.status, "confirmed")));
  return row?.total ?? 0;
}

export function yearRange(year: number): DateRange {
  return { from: `${year}-01-01`, to: `${year + 1}-01-01` };
}

export interface DaySummaryInput {
  participants: { playerId: number; name: string }[];
  /** confirmed状態のgame_sessions.idのみ（pending/tiedの行は集計に含めない） */
  confirmedGameSessionIds: number[];
  scores: { gameSessionId: number; playerId: number; rawScore: number | null; rankChip: number | null }[];
  yakumanEvents: YakumanEventLite[];
  yakumanTargets: YakumanTargetLite[];
}

/**
 * その日1日分の小計（素点差分・チップ）をプレイヤーごとに集計する。DBアクセスを含まない純粋関数。
 * 対局日詳細（loadDayDetail）は表示のために participants/sessions/scores/yakuman情報を
 * どのみち全件取得済みなので、ここで改めてDBに問い合わせず、そのデータから直接計算する
 * （以前はcomputeDaySummaryという別関数が同じデータをDBから再取得しており、対局日詳細1回の表示で
 * D1往復が余分に3〜4回発生していた）。
 */
export function summarizeDayTotals(input: DaySummaryInput): PlayerTotal[] {
  const confirmedIds = new Set(input.confirmedGameSessionIds);
  const rawTotals = new Map<number, number>();
  const rankChipTotals = new Map<number, number>();

  for (const row of input.scores) {
    if (!confirmedIds.has(row.gameSessionId)) continue;
    if (row.rawScore != null) {
      rawTotals.set(row.playerId, (rawTotals.get(row.playerId) ?? 0) + row.rawScore);
    }
    if (row.rankChip != null) {
      rankChipTotals.set(row.playerId, (rankChipTotals.get(row.playerId) ?? 0) + row.rankChip);
    }
  }

  const yakumanTotals = computeYakumanChipTotals(input.yakumanEvents, input.yakumanTargets);

  return input.participants
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

/**
 * そのプレイヤーが参加したことのある年ごとに、素点合計・チップ合計を返す（古い年→新しい年の順）。
 * 以前は年ごとに重いcomputeTotals（全プレイヤー分の全件集計）をループ呼び出ししており、
 * 参加年数分だけD1往復が倍増していた（例: 3年参加なら3セット分のフルスキャン）。
 * ここでは参加している年の範囲をまとめて1回だけ問い合わせ、年数に関わらず固定回数のクエリで完結させる。
 */
export async function computePlayerYearlyBreakdown(db: Db, playerId: number): Promise<PlayerYearlyTotal[]> {
  const participantDayRows = await db
    .select({ date: days.date })
    .from(dayParticipants)
    .innerJoin(days, eq(dayParticipants.dayId, days.id))
    .where(eq(dayParticipants.playerId, playerId));

  const years = [...new Set(participantDayRows.map((r) => Number(r.date.slice(0, 4))))].sort((a, b) => a - b);
  if (years.length === 0) return [];

  const yearSet = new Set(years);
  const rangeFrom = `${years[0]}-01-01`;
  const rangeTo = `${years[years.length - 1]! + 1}-01-01`;

  const rawTotalsByYear = new Map<number, number>();
  const rankChipTotalsByYear = new Map<number, number>();

  // 以前はdays.idの配列をinArray(gameSessions.dayId, dayIdsInRange)へ渡していたが、
  // 対局日数が増えるほどD1のSQL変数上限（1クエリ100個）に引っかかる
  // （もつさん・支店長で実データにより発覚・修正済みの問題と同じ構造。古参プレイヤーほど早く
  // この上限に達しうる）。gameSessions側からdaysを直接JOINし、日付範囲そのもので絞り込む。
  const scoreRows = await db
    .select({ date: days.date, rawScore: sessionScores.rawScore, rankChip: sessionScores.rankChip })
    .from(sessionScores)
    .innerJoin(gameSessions, eq(sessionScores.gameSessionId, gameSessions.id))
    .innerJoin(days, eq(gameSessions.dayId, days.id))
    .where(
      and(
        eq(sessionScores.playerId, playerId),
        eq(gameSessions.status, "confirmed"),
        gte(days.date, rangeFrom),
        lt(days.date, rangeTo),
      ),
    );

  for (const row of scoreRows) {
    const year = Number(row.date.slice(0, 4));
    if (!yearSet.has(year)) continue;
    if (row.rawScore != null) rawTotalsByYear.set(year, (rawTotalsByYear.get(year) ?? 0) + row.rawScore);
    if (row.rankChip != null) rankChipTotalsByYear.set(year, (rankChipTotalsByYear.get(year) ?? 0) + row.rankChip);
  }

  const yakumanTotalsByYear = await yakumanChipsByYearForPlayer(db, rangeFrom, rangeTo, yearSet, playerId);

  return years.map((year) => ({
    year,
    rawTotal: rawTotalsByYear.get(year) ?? 0,
    chipTotal: (rankChipTotalsByYear.get(year) ?? 0) + (yakumanTotalsByYear.get(year) ?? 0),
  }));
}

/** 指定した日付範囲の中で、そのプレイヤーに関わる役満チップ増減を年ごとに集計する。 */
async function yakumanChipsByYearForPlayer(
  db: Db,
  rangeFrom: string,
  rangeTo: string,
  yearSet: Set<number>,
  playerId: number,
): Promise<Map<number, number>> {
  const totalsByYear = new Map<number, number>();

  // computePlayerYearlyBreakdown側のコメントと同じ理由で、days.idの配列をinArrayへ渡さず
  // 日付範囲そのもので直接JOIN・絞り込みする。
  const events = await db
    .select({
      id: yakumanEvents.id,
      date: days.date,
      winnerPlayerId: yakumanEvents.winnerPlayerId,
      chipPerLoser: yakumanEvents.chipPerLoser,
    })
    .from(yakumanEvents)
    .innerJoin(days, eq(yakumanEvents.dayId, days.id))
    .where(and(gte(days.date, rangeFrom), lt(days.date, rangeTo)));
  if (events.length === 0) return totalsByYear;

  // yakuman_eventsの件数は現実的にSQL変数の上限に達する心配は無いが（役満は稀な出来事のため）、
  // 念のためこちらもIDの配列を直接渡さずサブクエリで絞り込む。
  const targetRows = await db
    .select({ yakumanEventId: yakumanEventTargets.yakumanEventId, playerId: yakumanEventTargets.playerId })
    .from(yakumanEventTargets)
    .where(
      inArray(
        yakumanEventTargets.yakumanEventId,
        db
          .select({ id: yakumanEvents.id })
          .from(yakumanEvents)
          .innerJoin(days, eq(yakumanEvents.dayId, days.id))
          .where(and(gte(days.date, rangeFrom), lt(days.date, rangeTo))),
      ),
    );

  const targetsByEvent = new Map<number, number[]>();
  for (const row of targetRows) {
    const list = targetsByEvent.get(row.yakumanEventId) ?? [];
    list.push(row.playerId);
    targetsByEvent.set(row.yakumanEventId, list);
  }

  for (const event of events) {
    const targetIds = targetsByEvent.get(event.id) ?? [];
    const participantIds = [...targetIds, event.winnerPlayerId];
    if (!participantIds.includes(playerId)) continue;
    const chips = computeYakumanChips(participantIds, event.winnerPlayerId, event.chipPerLoser);
    const mine = chips.find((c) => c.playerId === playerId);
    if (!mine || mine.chip === 0) continue;
    const year = Number(event.date.slice(0, 4));
    if (!yearSet.has(year)) continue;
    totalsByYear.set(year, (totalsByYear.get(year) ?? 0) + mine.chip);
  }

  return totalsByYear;
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
  const dayFilter = dayConditions.length ? and(...dayConditions) : undefined;

  // inArray(gameSessions.dayId, dayIds)のようにdays.idの配列をバインド変数として渡すと
  // 対局日数が増えるほどD1のSQL変数上限（1クエリ100個）に引っかかるため
  // （computePlayerTraitsで実データにより発覚・修正済みの問題と同じ構造）、
  // gameSessions側からdaysを直接JOINして日付範囲で絞り込む。
  const countsByPlayer = new Map<number, [number, number, number, number]>();
  const rows = await db
    .select({ playerId: sessionScores.playerId, rank: sessionScores.rank })
    .from(sessionScores)
    .innerJoin(gameSessions, eq(sessionScores.gameSessionId, gameSessions.id))
    .innerJoin(days, eq(gameSessions.dayId, days.id))
    .where(and(eq(gameSessions.status, "confirmed"), dayFilter));

  for (const row of rows) {
    if (row.rank == null || row.rank < 1 || row.rank > 4) continue;
    const arr = countsByPlayer.get(row.playerId) ?? [0, 0, 0, 0];
    arr[row.rank - 1] = (arr[row.rank - 1] ?? 0) + 1;
    countsByPlayer.set(row.playerId, arr);
  }

  return allPlayers
    .map((p) => ({
      playerId: p.id,
      name: p.name,
      counts: countsByPlayer.get(p.id) ?? ([0, 0, 0, 0] as [number, number, number, number]),
    }))
    .sort((a, b) => {
      // 1着回数の多い順、同数なら2着、3着、4着の回数で降順に比較する
      for (let i = 0; i < 4; i++) {
        const diff = (b.counts[i] ?? 0) - (a.counts[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });
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

export interface YakuBreakdownEntry {
  yaku: string;
  count: number;
  /** 和了数（winCount）に対する比率(0-1)。役の入力漏れがあると合計が1未満になりうる */
  rate: number;
}

export interface PlayerTraits {
  /** 参加局数（チョンボを除く）。各種比率の分母 */
  handCount: number;
  winCount: number;
  winRate: number;
  riichiCount: number;
  riichiRate: number;
  nakiCount: number;
  nakiRate: number;
  dealInCount: number;
  dealInRate: number;
  /** 自摸和了数。自摸率は和了数（winCount）に対する比率 */
  tsumoCount: number;
  tsumoRate: number;
  /** 立直後、一発で和了した回数。一発率は立直回数（riichiCount）に対する比率 */
  ippatsuCount: number;
  ippatsuRate: number;
  /** 平均上がり点数（役の点数のみ。本場・リーチ棒分は含まない）。点数未入力の和了は除いて平均する */
  avgWinPoints: number | null;
  yakuBreakdown: YakuBreakdownEntry[];
  /** 出現数が最大の役（同数なら複数）。1件も役が記録されていなければ空配列 */
  favoriteYaku: string[];
  avgOmoteDora: number | null;
  avgUraDora: number | null;
  avgAkaDora: number | null;
  /** 親を務めた回（連荘した本場も含めた一続きの親番）ごとの連荘回数（0=即流れ）の平均。
   * 親番が一度も無ければnull */
  avgDealerRenchan: number | null;
  /** 平均の分母となった親番の回数 */
  dealerTurnCount: number;
}

function parsePlayerIdList(json: string | null): number[] {
  if (!json) return [];
  try {
    const ids: unknown = JSON.parse(json);
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * 役選択モーダル（src/lib/yaku.ts）では鳴きの有無で翻数が変わる役を「役名（鳴きあり）」
 * 「役名（鳴きなし）」の別項目として登録しているが、上がり役別比率・得意役では
 * 同じ役として扱いたいため、この「（鳴きあり）」「（鳴きなし）」の注記を取り除いて集計する。
 */
export function normalizeYakuName(name: string): string {
  return name.replace(/（鳴き(あり|なし)）/, "");
}

/**
 * 個人ページ「特性」タブ用の各種指標（上がり率・リーチ率・鳴き率・振り込み率・自摸率・一発率・
 * 平均上がり点数・得意役・上がり役別比率・表/裏/赤ドラ平均数・親での平均連荘回数）。分母となる
 * 「参加局数」はこのプレイヤーが座席に入っていた半荘のhand_logs件数（チョンボは同じ局のやり直し
 * 扱いのため除く）。リーチ・鳴き・ドラ・役はいずれも任意入力項目のため、入力されていない局は
 * 「無かった」として分母に含めたまま扱う（＝運用初期は入力漏れの分だけ控えめな数字になりうる）。
 * 自摸率は和了数に対する自摸和了の比率、一発率は立直回数に対する一発和了の比率
 * （tenhou等の集計サイトに倣った定義。門前ロン/ツモ回数を分母にしているわけではない）。
 * 親での平均連荘回数はhand_logsのroundLabelをROUND_OPTIONS（src/lib/scoring.ts）と突き合わせて
 * その局の親の座席を求め、session_scoresの座席からこのプレイヤーが親だった一続きの親番
 * （roundLabelが変わらない間＝連荘中）を特定し、その親番が終わった時点の本場数（=連荘した回数、
 * 0なら即流れ）を親番ごとに平均したもの。roundLabelがROUND_OPTIONSと一致しない行（通常発生しない）
 * は判定対象から除く。
 */
export async function computePlayerTraits(db: Db, playerId: number): Promise<PlayerTraits> {
  const empty: PlayerTraits = {
    handCount: 0,
    winCount: 0,
    winRate: 0,
    riichiCount: 0,
    riichiRate: 0,
    nakiCount: 0,
    nakiRate: 0,
    dealInCount: 0,
    dealInRate: 0,
    tsumoCount: 0,
    tsumoRate: 0,
    ippatsuCount: 0,
    ippatsuRate: 0,
    avgWinPoints: null,
    yakuBreakdown: [],
    favoriteYaku: [],
    avgOmoteDora: null,
    avgUraDora: null,
    avgAkaDora: null,
    avgDealerRenchan: null,
    dealerTurnCount: 0,
  };

  const seatedSessions = await db
    .select({ gameSessionId: sessionScores.gameSessionId })
    .from(sessionScores)
    .where(eq(sessionScores.playerId, playerId));
  const sessionIds = [...new Set(seatedSessions.map((s) => s.gameSessionId))];
  if (sessionIds.length === 0) return empty;

  // inArray(column, sessionIds)のようにJSの配列をそのまま渡すと、対局数が多いプレイヤーでは
  // バインド変数の数がD1のSQL変数上限を超え「D1_ERROR: too many SQL variables」になる
  // （もつさん・支店長は対局数が100件超で発生。2026-09-19に実データで発覚・修正）。
  // サブクエリを渡す形にするとバインド変数は1個で済み、対局数に関わらず安全になる。
  const seatedSessionIdSubquery = () =>
    db.select({ id: sessionScores.gameSessionId }).from(sessionScores).where(eq(sessionScores.playerId, playerId));

  const handRows = await db
    .select()
    .from(handLogs)
    .where(inArray(handLogs.gameSessionId, seatedSessionIdSubquery()))
    .orderBy(asc(handLogs.gameSessionId), asc(handLogs.id));
  // チョンボは同じ局をやり直す扱いなので、参加局数・各種比率の対象から除く。
  const countedHands = handRows.filter((h) => h.winType !== "chombo");
  const handCount = countedHands.length;

  const winHands = countedHands.filter(
    (h) => h.winnerPlayerId === playerId && (h.winType === "ron" || h.winType === "tsumo"),
  );
  const winCount = winHands.length;

  const riichiCount = countedHands.filter((h) => parsePlayerIdList(h.riichiPlayerIds).includes(playerId)).length;
  const nakiCount = countedHands.filter((h) => parsePlayerIdList(h.nakiPlayerIds).includes(playerId)).length;
  const dealInCount = countedHands.filter((h) => h.winType === "ron" && h.loserPlayerId === playerId).length;
  const tsumoCount = winHands.filter((h) => h.winType === "tsumo").length;
  // 一発率はtenhou等の集計サイトに倣い「立直した回数」を分母にする（門前でロン/ツモした回数ではない）。
  // このプレイヤーが立直した局のうち、そのまま自身が「一発」役付きで和了した回数を数える。
  const ippatsuCount = countedHands.filter(
    (h) =>
      h.winnerPlayerId === playerId &&
      parsePlayerIdList(h.riichiPlayerIds).includes(playerId) &&
      (h.yakuText ?? "").split("、").some((name) => name.trim() === "一発"),
  ).length;

  const seatRows = await db
    .select({
      gameSessionId: sessionScores.gameSessionId,
      seatIndex: sessionScores.seatIndex,
      playerId: sessionScores.playerId,
    })
    .from(sessionScores)
    .where(inArray(sessionScores.gameSessionId, seatedSessionIdSubquery()));
  const seatMapBySession = new Map<number, Map<number, number>>();
  for (const row of seatRows) {
    if (!seatMapBySession.has(row.gameSessionId)) seatMapBySession.set(row.gameSessionId, new Map());
    seatMapBySession.get(row.gameSessionId)!.set(row.seatIndex, row.playerId);
  }

  // 親番ごとの連荘回数（本場が0に戻らず続いた回数）を集計する。roundLabelが変わらない
  // （＝親が続投した）限り同じ親番として扱い、続投が終わった時点の本場数をその親番の
  // 連荘回数として確定する。roundLabelがROUND_OPTIONSと一致しない行は判定対象から除く。
  const dealerRenchanCounts: number[] = [];
  let currentSessionId: number | null = null;
  let currentRoundLabel: string | null = null;
  let currentDealerPlayerId: number | null = null;
  let currentMaxHonba = 0;

  const closeDealerTurn = () => {
    if (currentDealerPlayerId === playerId) dealerRenchanCounts.push(currentMaxHonba);
  };

  for (const h of countedHands) {
    const roundIndex = h.roundLabel ? ROUND_OPTIONS.indexOf(h.roundLabel as (typeof ROUND_OPTIONS)[number]) : -1;
    if (roundIndex < 0) continue;
    const isSameTurn = h.gameSessionId === currentSessionId && h.roundLabel === currentRoundLabel;
    if (!isSameTurn) {
      if (currentSessionId != null) closeDealerTurn();
      currentSessionId = h.gameSessionId;
      currentRoundLabel = h.roundLabel;
      currentDealerPlayerId = seatMapBySession.get(h.gameSessionId)?.get(roundIndex % 4) ?? null;
      currentMaxHonba = h.honba;
    } else {
      currentMaxHonba = Math.max(currentMaxHonba, h.honba);
    }
  }
  if (currentSessionId != null) closeDealerTurn();

  const avgWinPoints = average(winHands.filter((h) => h.points != null).map((h) => h.points!));
  // ドラ枚数は未入力（null）の和了を分母から除外せず、0枚として平均に含める
  // （「入力がない場合は0枚として計算する」というフィードバックへの対応）。
  const avgOmoteDora = average(winHands.map((h) => h.omoteDoraCount ?? 0));
  const avgUraDora = average(winHands.map((h) => h.uraDoraCount ?? 0));
  const avgAkaDora = average(winHands.map((h) => h.akaDoraCount ?? 0));

  const yakuCounts = new Map<string, number>();
  for (const h of winHands) {
    if (!h.yakuText) continue;
    for (const name of h.yakuText.split("、")) {
      const trimmed = normalizeYakuName(name.trim());
      if (!trimmed) continue;
      yakuCounts.set(trimmed, (yakuCounts.get(trimmed) ?? 0) + 1);
    }
  }
  const yakuBreakdown: YakuBreakdownEntry[] = [...yakuCounts.entries()]
    .map(([yaku, count]) => ({ yaku, count, rate: winCount > 0 ? count / winCount : 0 }))
    .sort((a, b) => b.count - a.count);
  const maxYakuCount = yakuBreakdown.length > 0 ? yakuBreakdown[0]!.count : 0;
  const favoriteYaku = yakuBreakdown.filter((y) => y.count === maxYakuCount).map((y) => y.yaku);

  return {
    handCount,
    winCount,
    winRate: handCount > 0 ? winCount / handCount : 0,
    riichiCount,
    riichiRate: handCount > 0 ? riichiCount / handCount : 0,
    nakiCount,
    nakiRate: handCount > 0 ? nakiCount / handCount : 0,
    dealInCount,
    dealInRate: handCount > 0 ? dealInCount / handCount : 0,
    tsumoCount,
    tsumoRate: winCount > 0 ? tsumoCount / winCount : 0,
    ippatsuCount,
    ippatsuRate: riichiCount > 0 ? ippatsuCount / riichiCount : 0,
    avgWinPoints,
    yakuBreakdown,
    favoriteYaku,
    avgOmoteDora,
    avgUraDora,
    avgAkaDora,
    avgDealerRenchan: average(dealerRenchanCounts),
    dealerTurnCount: dealerRenchanCounts.length,
  };
}
