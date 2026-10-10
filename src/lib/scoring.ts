import { resolveTsumoPayment } from "./scoreTable";

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

// 半荘＝東1〜4局＋南1〜4局の8局。インデックス%4が起家からの席順（＝その局の親）に対応する
// （東1局と南1局はどちらも起家が親、というように東場・南場で同じ並びが繰り返されるため）。
// hand_logs.roundLabelはこの配列の値と完全一致している前提で扱う（days.tsx・aggregate.tsで共用）。
export const ROUND_OPTIONS = ["東1局", "東2局", "東3局", "東4局", "南1局", "南2局", "南3局", "南4局"] as const;

// 着順ごとの固定チップ (1位+3 / 2位0 / 3位-1 / 4位-2)
const RANK_CHIP_TABLE: Record<number, number> = { 1: 3, 2: 0, 3: -1, 4: -2 };

// 最終集計は「25000点持ち・30000点返し」。2〜4位は素点を丸めて30000点を引き、
// 1位は2〜4位の合計の符号を反転した値（オカ＝(30000-25000)×4人分を総取り）にする。
export const RETURN_SCORE = 30000;
// 1半荘の4人分の素点の合計（25000点×4人）。確認画面ではこれと一致しないと確定させない。
export const TOTAL_SOTEN = 100000;

/**
 * 素点を1000点単位に「五捨六入」する。数直線上で1つ下の1000点に切り捨て、その余りが
 * 600以上なら切り上げる（500以下は切り捨て）。マイナスの素点（箱下）も同じ数直線ルールで扱う。
 * 例: 26500→26000 / 26600→27000 / -3500→-4000 / -3400→-3000 / -3600→-4000。
 */
export function roundSotenGosha(soten: number): number {
  const floor = Math.floor(soten / 1000) * 1000;
  return soten - floor >= 600 ? floor + 1000 : floor;
}

export interface FinalPointInput {
  playerId: number;
  soten: number;
  /** computeRankAndChipsで決めた着順（1〜4） */
  rank: number;
}

/**
 * 半荘確定時の集計用ポイント（30000点返し）を求める。
 * 2〜4位: roundSotenGosha(素点) / 1000 - 30。1位: 2〜4位の合計の符号を反転した値。
 * このため4人分の合計は常に0になる（丸め誤差の手修正は不要）。
 * 例: 41300/30600/18500/9600 → 2位+1・3位-12・4位-20、1位は+31。
 */
export function computeFinalPoints(entries: FinalPointInput[]): Map<number, number> {
  const result = new Map<number, number>();
  let othersSum = 0;
  for (const e of entries) {
    if (e.rank === 1) continue;
    const point = (roundSotenGosha(e.soten) - RETURN_SCORE) / 1000;
    result.set(e.playerId, point);
    othersSum += point;
  }
  const top = entries.find((e) => e.rank === 1);
  if (top) result.set(top.playerId, -othersSum + 0);
  return result;
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
  /** その局の点数。上がった役由来の点数のみ（本場・リーチ棒分は含まない。自動加算するため） */
  points: number | null;
  /** この局の本場。ロンは+300×本場を対象が全額負担、ツモは+100×本場を3人均等負担で自動加算する */
  honba: number;
  /** この局でリーチした人の座席一覧。宣言した時点で即座に-1000し、場のリーチ棒として積み立てる */
  riichiSeats: number[];
  /** 流局時のテンパイ者の座席一覧。流局以外では無視される */
  tenpaiSeats: number[];
}

/**
 * 対局中ページの「現在のスコア」（この半荘の中だけの暫定合計）を、ここまでの局メモから算出する。
 * 正式なスコアは撮影・確認画面で別途確定するため、これはあくまで対局中の目安表示。
 * - リーチ棒: 宣言した時点で結果に関わらず-1000し、場に積み立てる（供託）。和了（ロン・ツモ）が
 *   出たら場の積み立てを丸ごと和了者が回収する（pointsの有無に関わらず回収は行う）。流局・チョンボでは
 *   積み立ては場に残ったまま次の局に持ち越す。
 * - 本場: ロンは対象(放銃者)が+300×本場を全額負担、ツモは3人が+100×本場ずつ均等負担する
 *   （ツモの本場分は親子の配分比とは無関係に常に均等）。pointsが無い（役の点数を未入力の）局では
 *   本場分も含めて加算しない。
 * - ロン: 和了者+ (points+本場分)、対象(放銃者)- (points+本場分) のシンプルな授受
 * - ツモ: pointsには和了者が受け取る「役由来の合計」を入力してもらう前提で、点数表
 *   （resolveTsumoPayment）から各家の支払い額を求め（例: 子の1100点ツモ＝子300・親500）、
 *   本場分（3人均等）を上乗せする。表にない合計は計算式で近似する
 * - 流局: リーチ供託に加え、テンパイ料（ノーテン罰符）合計3000点をテンパイ者に均等分配し、
 *   ノーテン者から均等に徴収する（テンパイ1人:+3000/他-1000ずつ、2人:各+1500/各-1500、
 *   3人:各+1000/-3000、0人・4人:授受なし）
 * - チョンボ: 同じ局をやり直す扱いのため、リーチ供託も含めこのスコアには一切反映しない
 */
export function computeLiveScores(hands: LiveHandEntry[]): number[] {
  const scores = [0, 0, 0, 0];
  let stickPool = 0; // 場に出ている未回収のリーチ棒の本数（1本=1000点）

  for (const h of hands) {
    if (h.winType === "chombo") continue;

    for (const seat of h.riichiSeats) {
      scores[seat]! -= 1000;
      stickPool += 1;
    }

    const isWin = (h.winType === "ron" || h.winType === "tsumo") && h.winnerSeat != null;
    if (isWin) {
      scores[h.winnerSeat!]! += stickPool * 1000;
      stickPool = 0;
    }

    if (h.winType === "draw") {
      const tenpaiCount = h.tenpaiSeats.length;
      if (tenpaiCount > 0 && tenpaiCount < 4) {
        const perTenpai = 3000 / tenpaiCount;
        const perNoten = 3000 / (4 - tenpaiCount);
        for (let seat = 0; seat < 4; seat++) {
          scores[seat]! += h.tenpaiSeats.includes(seat) ? perTenpai : -perNoten;
        }
      }
      continue;
    }

    if (h.points == null) continue;
    const honbaBonus = 300 * h.honba;

    if (h.winType === "ron" && h.winnerSeat != null && h.loserSeat != null) {
      scores[h.winnerSeat]! += h.points + honbaBonus;
      scores[h.loserSeat]! -= h.points + honbaBonus;
    } else if (h.winType === "tsumo" && h.winnerSeat != null) {
      const dealerSeat = h.dealerSeat ?? 0;
      const honbaShare = 100 * h.honba;
      const payment = resolveTsumoPayment(h.points, h.winnerSeat === dealerSeat);
      for (let seat = 0; seat < 4; seat++) {
        if (seat === h.winnerSeat) continue;
        const pays =
          (seat === dealerSeat && payment.dealerPays != null ? payment.dealerPays : payment.nonDealerPays) +
          honbaShare;
        scores[seat]! -= pays;
        // 和了者は実際に支払われた額を受け取る（表にない合計を近似した場合も4人の合計を0に保つため）
        scores[h.winnerSeat]! += pays;
      }
    }
  }

  return scores;
}

export interface RoundProgressEntry {
  winType: string;
  /** この局が行われたROUND_OPTIONS上のインデックス(0-7) */
  roundIndex: number;
  /** この局に記録されている本場 */
  honba: number;
  /** この局の親の座席(0-3) */
  dealerSeat: number;
  /** 和了者の座席。ロン・ツモ以外はnull */
  winnerSeat: number | null;
  /** 流局時のテンパイ者の座席一覧 */
  tenpaiSeats: number[];
}

/**
 * その局の結果から、親が続投する（連荘＝次も同じ局になる）かどうかを判定する。
 * 親が和了、または流局で親がテンパイのときに続投。それ以外（親以外の和了、流局で親が非テンパイ）は
 * 親が交代する。
 */
export function isDealerContinuing(hand: RoundProgressEntry): boolean {
  return (
    ((hand.winType === "ron" || hand.winType === "tsumo") && hand.winnerSeat === hand.dealerSeat) ||
    (hand.winType === "draw" && hand.tenpaiSeats.includes(hand.dealerSeat))
  );
}

/**
 * 局メモの入力フォームに出す「次の局・本場」の初期値を、直近の履歴から提案する。
 * チョンボは同じ局をやり直す扱いなので判定対象から除外する。履歴が無ければ東1局0本場から開始する。
 * あくまでフォームの初期値の提案であり、実際に保存される値は入力時点の手修正を反映したものになる。
 * 本場は「親が続投」または「流局」なら+1で継続し、それ以外（親以外の和了）で0に戻る。
 * 親が交代するかどうか（流局で親が非テンパイの場合を含む）とは独立に判定する点に注意
 * （流局は親交代の有無に関わらず本場が必ず+1で継続するため）。
 */
export function computeNextRoundState(
  hands: RoundProgressEntry[],
  maxRoundIndex: number,
): { roundIndex: number; honba: number } {
  const relevant = hands.filter((h) => h.winType !== "chombo");
  const last = relevant[relevant.length - 1];
  if (!last) return { roundIndex: 0, honba: 0 };

  const roundIndex = isDealerContinuing(last) ? last.roundIndex : Math.min(last.roundIndex + 1, maxRoundIndex);
  const honba = last.winType === "draw" || isDealerContinuing(last) ? last.honba + 1 : 0;
  return { roundIndex, honba };
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
