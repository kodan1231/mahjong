export const ORIGIN_SCORE = 25000;

// 着順ごとの固定チップ (1位+3 / 2位0 / 3位-1 / 4位-2)
const RANK_CHIP_TABLE: Record<number, number> = { 1: 3, 2: 0, 3: -1, 4: -2 };

export type DisplayMode = "raw" | "diff";

/**
 * 点数表示機のOCR値を素点に正規化する。
 * diffモード（配給原点からの±差分表示）の場合、表示されている数値は1000点単位
 * （麻雀の慣習で「25000点」を「25」と表すのと同じ）なので、1000倍してから
 * originに加算する。例: 表示が"+18"なら 25000 + 18*1000 = 43000。
 */
export function normalizeRawScore(
  ocrValue: number,
  displayMode: DisplayMode,
  origin: number = ORIGIN_SCORE,
): number {
  return displayMode === "diff" ? origin + ocrValue * 1000 : ocrValue;
}

export interface PlayerScore {
  playerId: number;
  rawScore: number;
}

export interface RankedScore extends PlayerScore {
  rank: number;
  rankChip: number;
}

export interface RankAndChipsResult {
  ranked: RankedScore[];
  hasTie: boolean;
}

/**
 * 素点降順で順位付けし、固定チップ表からチップを算出する。
 * 同点がある場合は hasTie=true を返し、順位はスコア降順・安定ソートで暫定的に割り振る
 * (呼び出し側で「同点です。順位を確認してください」等の警告を出す想定)。
 */
export function computeRankAndChips(scores: PlayerScore[]): RankAndChipsResult {
  if (scores.length === 0) {
    return { ranked: [], hasTie: false };
  }

  const sorted = [...scores].sort((a, b) => b.rawScore - a.rawScore);
  const hasTie = sorted.some((s, i) => i > 0 && s.rawScore === sorted[i - 1]!.rawScore);

  const ranked: RankedScore[] = sorted.map((s, i) => {
    const rank = i + 1;
    const rankChip = RANK_CHIP_TABLE[rank] ?? 0;
    return { ...s, rank, rankChip };
  });

  return { ranked, hasTie };
}

export interface YakumanChipResult {
  playerId: number;
  chip: number;
}

/**
 * 役満ボーナス: 和了者以外の「その日の参加者全員」が -perLoser、和了者が総取り。
 */
export function computeYakumanChips(
  dayParticipantIds: number[],
  winnerId: number,
  perLoser: number = 5,
): YakumanChipResult[] {
  const others = dayParticipantIds.filter((id) => id !== winnerId);
  const winnerChip = perLoser * others.length;

  return [
    { playerId: winnerId, chip: winnerChip },
    ...others.map((id) => ({ playerId: id, chip: -perLoser })),
  ];
}
