/**
 * アプリ全体で保存・集計する点数の単位は「ポイント」＝配給原点(25000点=25ポイント)からの
 * 増減（差分）。例: 最終所持点32000点なら +7ポイント、21000点なら -4ポイント。
 * 1半荘に参加した4人分のポイントは、麻雀のルール上必ず合計0になる（総得点は不変のため）。
 * このため各プレイヤーの通算ポイントは「毎半荘のポイントをそのまま合計するだけ」でよい
 * （素点から改めて原点を引く必要はない。raw_scoreは既に差分そのものを保存している）。
 */
export const ORIGIN_SCORE = 25;

// 着順ごとの固定チップ (1位+3 / 2位0 / 3位-1 / 4位-2)
const RANK_CHIP_TABLE: Record<number, number> = { 1: 3, 2: 0, 3: -1, 4: -2 };

export type DisplayMode = "raw" | "diff";

/**
 * 点数表示機のOCR値を「配給原点からの差分（ポイント）」に正規化する。
 * - rawモード（素点そのまま表示）: 表示されている数値は素点の絶対値（例: 32000）なので、
 *   1000で割ってポイント化してから配給原点(origin)を引き、差分に変換する
 *   （32000 → 32ポイント → 32-25 = +7）。麻雀の素点は100点単位で丸められるため
 *   小数第1位までに丸める。
 * - diffモード（配給原点からの±差分表示）: 表示されている数値（例: "+7"）が既に
 *   差分そのものなので、変換は不要でそのまま使う。
 */
export function normalizeRawScore(
  ocrValue: number,
  displayMode: DisplayMode,
  origin: number = ORIGIN_SCORE,
): number {
  return displayMode === "diff" ? ocrValue : Math.round(ocrValue / 100) / 10 - origin;
}

export interface PlayerScore {
  playerId: number;
  rawScore: number;
  // 同点時の順位を明示的に指定するための優先度（小さいほど上位）。省略時は配列内の並び順で決まる。
  tieBreakPriority?: number;
}

/**
 * 1半荘の参加者全員分の差分ポイントを合計する。麻雀のルール上、必ず0になる
 * （持ち点の総量は不変のため）。0からずれている場合は入力ミスの可能性が高い。
 */
export function sumScores(scores: PlayerScore[]): number {
  return scores.reduce((sum, s) => sum + s.rawScore, 0);
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
 * 同点の場合は tieBreakPriority（小さいほど上位）で順序を決める。指定がなければ配列内の並び順
 * （安定ソート）で暫定的に割り振る。同点があった場合は常に hasTie=true を返す
 * (呼び出し側で「同点です。順位を確認してください」等の警告を出す想定。tieBreakPriorityを
 * 明示的に指定していても、同点であること自体は変わらないため警告と確定操作は必要)。
 */
export function computeRankAndChips(scores: PlayerScore[]): RankAndChipsResult {
  if (scores.length === 0) {
    return { ranked: [], hasTie: false };
  }

  const indexed = scores.map((s, i) => ({ ...s, _i: i }));
  const sorted = indexed.sort((a, b) => {
    if (b.rawScore !== a.rawScore) return b.rawScore - a.rawScore;
    return (a.tieBreakPriority ?? a._i) - (b.tieBreakPriority ?? b._i);
  });
  const hasTie = sorted.some((s, i) => i > 0 && s.rawScore === sorted[i - 1]!.rawScore);

  const ranked: RankedScore[] = sorted.map((s, i) => {
    const rank = i + 1;
    const rankChip = RANK_CHIP_TABLE[rank] ?? 0;
    return { playerId: s.playerId, rawScore: s.rawScore, rank, rankChip };
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
