/**
 * アプリ全体で使う点数の単位は「ポイント」（実際の素点÷1000。例: 素点32000点 → 32ポイント）。
 * 配給原点は素点25000点 = 25ポイント。
 */
export const ORIGIN_SCORE = 25;

// 着順ごとの固定チップ (1位+3 / 2位0 / 3位-1 / 4位-2)
const RANK_CHIP_TABLE: Record<number, number> = { 1: 3, 2: 0, 3: -1, 4: -2 };

export type DisplayMode = "raw" | "diff";

/**
 * 点数表示機のOCR値をポイント単位に正規化する。
 * - rawモード（素点そのまま表示）: 表示されている数値は「素点」（例: 32000）なので、
 *   1000で割ってポイントに変換する（32000 → 32）。麻雀の素点は100点単位で丸められるため
 *   小数第1位までに丸める。
 * - diffモード（配給原点からの±差分表示）: 表示されている数値は既に「ポイント」単位の
 *   差分（例: "+7"は+7ポイント=+7000点）なので、そのままoriginに加算するだけでよい。
 */
export function normalizeRawScore(
  ocrValue: number,
  displayMode: DisplayMode,
  origin: number = ORIGIN_SCORE,
): number {
  return displayMode === "diff" ? origin + ocrValue : Math.round(ocrValue / 100) / 10;
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
