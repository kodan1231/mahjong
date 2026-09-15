/**
 * 麻雀の点数早見表（符・翻→点数）を計算するロジック。
 * 公式ルール: 基本点 = 符 × 2^(2+翻)。基本点が2000を超える場合は2000に切り上げる（切り上げ満貫）。
 * 支払いは基本点の倍数（下記）を100点単位で切り上げる。
 * - 子のロン: 基本点×4
 * - 子のツモ: 子から基本点×1、親から基本点×2（それぞれ別に切り上げ）
 * - 親のロン: 基本点×6
 * - 親のツモ: 子3人がそれぞれ基本点×2（切り上げ）を支払う（＝オール）
 * このモジュールはこの計算式のみを扱い、役の判定などは行わない（点数早見表の表示専用）。
 */

// 60符まで（それ以上は実際の対局でほぼ出ないため「60符まであればいい」というフィードバックで削減）。
// 25符（七対子固定）も同様に「不要」というフィードバックで削除した。
const FU_ROWS = [20, 30, 40, 50, 60] as const;
const HAN_COLS = [1, 2, 3, 4] as const;

function roundUp100(n: number): number {
  return Math.ceil(n / 100) * 100;
}

function basePoints(fu: number, han: number): number {
  const base = fu * Math.pow(2, 2 + han);
  return Math.min(base, 2000); // 切り上げ満貫
}

// 20符はロンでは実質発生しない（門前ロンの10符加算で必ず30符以上になるため）。
function ronValid(fu: number): boolean {
  return fu !== 20;
}
function tsumoValid(_fu: number, _han: number): boolean {
  return true;
}

export interface DealerCell {
  fu: number;
  han: number;
  /** ロンの点数。発生し得ない組み合わせ（20符など）ではnull */
  ron: number | null;
  /** ツモ時、子3人がそれぞれ支払う額（オール）。発生し得ない組み合わせではnull */
  tsumoEach: number | null;
}

export interface NonDealerCell {
  fu: number;
  han: number;
  ron: number | null;
  /** ツモ時、他の子2人がそれぞれ支払う額。発生し得ない組み合わせではnull */
  tsumoOther: number | null;
  /** ツモ時、親が支払う額。発生し得ない組み合わせではnull */
  tsumoDealer: number | null;
}

export interface ScoreTable {
  fuRows: readonly number[];
  hanCols: readonly number[];
  dealer: DealerCell[][]; // [fuIndex][hanIndex]
  nonDealer: NonDealerCell[][];
}

export function computeScoreTable(): ScoreTable {
  const dealer: DealerCell[][] = FU_ROWS.map((fu) =>
    HAN_COLS.map((han) => {
      const base = basePoints(fu, han);
      return {
        fu,
        han,
        ron: ronValid(fu) ? roundUp100(base * 6) : null,
        tsumoEach: tsumoValid(fu, han) ? roundUp100(base * 2) : null,
      };
    }),
  );

  const nonDealer: NonDealerCell[][] = FU_ROWS.map((fu) =>
    HAN_COLS.map((han) => {
      const base = basePoints(fu, han);
      return {
        fu,
        han,
        ron: ronValid(fu) ? roundUp100(base * 4) : null,
        tsumoOther: tsumoValid(fu, han) ? roundUp100(base * 1) : null,
        tsumoDealer: tsumoValid(fu, han) ? roundUp100(base * 2) : null,
      };
    }),
  );

  return { fuRows: FU_ROWS, hanCols: HAN_COLS, dealer, nonDealer };
}

export interface FixedTier {
  label: string;
  hanRange: string;
  dealerRon: number;
  dealerTsumoEach: number;
  nonDealerRon: number;
  nonDealerTsumoOther: number;
  nonDealerTsumoDealer: number;
}

// 5翻以上は符に関係なく翻数だけで決まる固定点数（満貫〜役満）
export const FIXED_TIERS: FixedTier[] = [
  {
    label: "満貫",
    hanRange: "5翻",
    dealerRon: 12000,
    dealerTsumoEach: 4000,
    nonDealerRon: 8000,
    nonDealerTsumoOther: 2000,
    nonDealerTsumoDealer: 4000,
  },
  {
    label: "跳満",
    hanRange: "6〜7翻",
    dealerRon: 18000,
    dealerTsumoEach: 6000,
    nonDealerRon: 12000,
    nonDealerTsumoOther: 3000,
    nonDealerTsumoDealer: 6000,
  },
  {
    label: "倍満",
    hanRange: "8〜10翻",
    dealerRon: 24000,
    dealerTsumoEach: 8000,
    nonDealerRon: 16000,
    nonDealerTsumoOther: 4000,
    nonDealerTsumoDealer: 8000,
  },
  {
    label: "三倍満",
    hanRange: "11〜12翻",
    dealerRon: 36000,
    dealerTsumoEach: 12000,
    nonDealerRon: 24000,
    nonDealerTsumoOther: 6000,
    nonDealerTsumoDealer: 12000,
  },
  {
    label: "役満",
    hanRange: "13翻〜",
    dealerRon: 48000,
    dealerTsumoEach: 16000,
    nonDealerRon: 32000,
    nonDealerTsumoOther: 8000,
    nonDealerTsumoDealer: 16000,
  },
];

export interface FuCalcGroup {
  category: string;
  rows: { item: string; fu: string }[];
}

/**
 * 符の算出表（手牌の形から符を積み上げるための早見表）。上のfu×han表は「符が分かっている前提」の
 * 点数早見表なので、符そのものの数え方が分かる別表として用意した（「符の算出表も欲しい」という要望）。
 * 合計後は10符単位で切り上げる（例: 22符→30符）。七対子・平和は例外として符が固定される。
 */
export const FU_CALC_TABLE: FuCalcGroup[] = [
  {
    category: "基本",
    rows: [
      { item: "副底（基本点）", fu: "20符" },
      { item: "門前加符（門前でロン和了）", fu: "+10符" },
      { item: "自摸符（ツモ和了。平和ツモを除く）", fu: "+2符" },
    ],
  },
  {
    category: "待ち",
    rows: [
      { item: "両面・シャンポン待ち", fu: "+0符" },
      { item: "カンチャン・ペンチャン・単騎待ち", fu: "+2符" },
    ],
  },
  {
    category: "雀頭",
    rows: [
      { item: "数牌・客風牌", fu: "+0符" },
      { item: "役牌（三元牌・自風・場風）", fu: "+2符" },
    ],
  },
  {
    category: "面子（1組ごとに加算）",
    rows: [
      { item: "順子", fu: "+0符" },
      { item: "明刻（中張牌）", fu: "+2符" },
      { item: "明刻（幺九牌）", fu: "+4符" },
      { item: "暗刻（中張牌）", fu: "+4符" },
      { item: "暗刻（幺九牌）", fu: "+8符" },
      { item: "明槓（中張牌）", fu: "+8符" },
      { item: "明槓（幺九牌）", fu: "+16符" },
      { item: "暗槓（中張牌）", fu: "+16符" },
      { item: "暗槓（幺九牌）", fu: "+32符" },
    ],
  },
  {
    category: "特殊な符（例外・固定）",
    rows: [
      { item: "七対子", fu: "25符固定" },
      { item: "平和・ロン", fu: "30符固定" },
      { item: "平和・ツモ", fu: "20符固定" },
    ],
  },
];
