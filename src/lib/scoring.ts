/**
 * アプリ全体で保存・集計する点数の単位は「ポイント」＝配給原点(25000点=25ポイント)からの
 * 増減（差分）。例: 最終所持点32000点なら +7ポイント、21000点なら -4ポイント。
 * 1半荘に参加した4人分のポイントは、麻雀のルール上必ず合計0になる（総得点は不変のため）。
 * このため各プレイヤーの通算ポイントは「毎半荘のポイントをそのまま合計するだけ」でよい
 * （素点から改めて原点を引く必要はない。raw_scoreは既に差分そのものを保存している）。
 */
export const ORIGIN_SCORE = 25;

/**
 * まとめて入力画面で箱割れを自動判定する閾値（ポイント）。この値以下なら自動的に
 * isHakoware: true として保存する。当初は「持ち点が0未満＝配給原点(25)を下回る」を基準に
 * -25としていたが、ユーザーの実運用に合わせて-31に変更（2026-09-16）。
 */
export const HAKOWARE_AUTO_THRESHOLD = -31;

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

export interface LiveHandEntry {
  winType: string;
  /** 和了者の座席(0-3)。ロン・ツモ以外はnull */
  winnerSeat: number | null;
  /** ロン時の対象（放銃者）の座席。ロン以外はnull */
  loserSeat: number | null;
  /** その局の親の座席(0-3)。ツモの配分計算に使う。ronでは無視される */
  dealerSeat: number | null;
  /** その局の点数（ロンは授受額そのまま、ツモは和了者が受け取る合計） */
  points: number | null;
}

/**
 * 対局中ページの「現在のスコア」（この半荘の中だけの暫定合計）を、ここまでの局メモから算出する。
 * 正式なスコアは撮影・確認画面で別途確定するため、これはあくまで対局中の目安表示。
 * - ロン: 和了者+points、対象(放銃者)-pointsのシンプルな授受
 * - ツモ: pointsには和了者が受け取る合計を入力してもらう前提で、親かどうかに応じた比率
 *   （親のツモは3人が均等払い、子のツモは親が半分・残り2人が1/4ずつ）で各家の支払い額を求める
 * - 流局・チョンボ: このスコアには反映しない（正式なノーテン罰符等は確認画面側で扱う）
 */
export function computeLiveScores(hands: LiveHandEntry[]): number[] {
  const scores = [0, 0, 0, 0];

  for (const h of hands) {
    if (h.points == null) continue;

    if (h.winType === "ron" && h.winnerSeat != null && h.loserSeat != null) {
      scores[h.winnerSeat]! += h.points;
      scores[h.loserSeat]! -= h.points;
    } else if (h.winType === "tsumo" && h.winnerSeat != null) {
      const dealerSeat = h.dealerSeat ?? 0;
      scores[h.winnerSeat]! += h.points;
      for (let seat = 0; seat < 4; seat++) {
        if (seat === h.winnerSeat) continue;
        if (h.winnerSeat === dealerSeat) {
          scores[seat]! -= h.points / 3;
        } else if (seat === dealerSeat) {
          scores[seat]! -= h.points / 2;
        } else {
          scores[seat]! -= h.points / 4;
        }
      }
    }
  }

  return scores;
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
