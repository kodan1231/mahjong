import { describe, it, expect } from "vitest";
import {
  normalizeRawScore,
  computeRankAndChips,
  computeYakumanChips,
  sumScores,
  computeLiveScores,
  computeNextRoundState,
} from "../src/lib/scoring";

// アプリ全体で保存・集計する点数の単位は「ポイント」＝配給原点(25000点=25ポイント)からの
// 増減（差分）。例: 最終所持点32000点なら+7ポイント。1半荘の4人分は必ず合計0になる。

describe("normalizeRawScore", () => {
  it("rawモード: 素点（画面に表示された絶対値）を1000で割ってから配給原点を引き、差分に変換する", () => {
    expect(normalizeRawScore(32000, "raw")).toBe(7); // 32000/1000 - 25 = 7
    expect(normalizeRawScore(24700, "raw")).toBeCloseTo(-0.3, 5); // 24.7 - 25
  });

  it("diffモード: 表示値は既に配給原点からの差分そのものなので、変換不要でそのまま使う", () => {
    expect(normalizeRawScore(7, "diff")).toBe(7);
    expect(normalizeRawScore(-3.5, "diff")).toBe(-3.5);
  });

  it("supports a custom origin for raw mode", () => {
    expect(normalizeRawScore(35000, "raw", 30)).toBe(5); // 35 - 30
  });
});

describe("sumScores", () => {
  it("1半荘の4人分の差分ポイントは合計0になる（麻雀のルール上、総得点は不変のため）", () => {
    const sum = sumScores([
      { playerId: 1, rawScore: 7 },
      { playerId: 2, rawScore: 0 },
      { playerId: 3, rawScore: -3 },
      { playerId: 4, rawScore: -4 },
    ]);
    expect(sum).toBe(0);
  });

  it("returns 0 for an empty list", () => {
    expect(sumScores([])).toBe(0);
  });
});

describe("computeRankAndChips", () => {
  it("ranks by point score descending and assigns fixed chips", () => {
    const { ranked, hasTie } = computeRankAndChips([
      { playerId: 1, rawScore: 0 },
      { playerId: 2, rawScore: 15 },
      { playerId: 3, rawScore: -10 },
      { playerId: 4, rawScore: -5 },
    ]);

    expect(hasTie).toBe(false);
    expect(ranked.map((r) => r.playerId)).toEqual([2, 1, 4, 3]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    expect(ranked.map((r) => r.rankChip)).toEqual([3, 0, -1, -2]);
  });

  it("sums to zero across the four fixed chip values", () => {
    const { ranked } = computeRankAndChips([
      { playerId: 1, rawScore: -15 },
      { playerId: 2, rawScore: -5 },
      { playerId: 3, rawScore: 5 },
      { playerId: 4, rawScore: 15 },
    ]);
    expect(ranked.reduce((sum, r) => sum + r.rankChip, 0)).toBe(0);
  });

  it("flags ties without crashing", () => {
    const { hasTie, ranked } = computeRankAndChips([
      { playerId: 1, rawScore: 5 },
      { playerId: 2, rawScore: 5 },
      { playerId: 3, rawScore: -20 },
      { playerId: 4, rawScore: 10 },
    ]);
    expect(hasTie).toBe(true);
    expect(ranked).toHaveLength(4);
  });

  it("returns an empty result for no scores", () => {
    expect(computeRankAndChips([])).toEqual({ ranked: [], hasTie: false });
  });

  it("同点時、tieBreakPriorityが小さいプレイヤーを上位にする（管理者が明示的に選べるUI用）", () => {
    const { ranked, hasTie } = computeRankAndChips([
      { playerId: 1, rawScore: 5, tieBreakPriority: 2 },
      { playerId: 2, rawScore: 5, tieBreakPriority: 1 },
      { playerId: 3, rawScore: -20 },
      { playerId: 4, rawScore: 10 },
    ]);
    expect(hasTie).toBe(true); // 同点であること自体は変わらないため、確定には引き続き警告・確認操作が必要
    expect(ranked.map((r) => r.playerId)).toEqual([4, 2, 1, 3]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });
});

describe("computeYakumanChips", () => {
  it("gives the winner the pooled chips and deducts from every other day participant", () => {
    const result = computeYakumanChips([1, 2, 3, 4, 5], 1, 5);
    expect(result).toEqual([
      { playerId: 1, chip: 20 },
      { playerId: 2, chip: -5 },
      { playerId: 3, chip: -5 },
      { playerId: 4, chip: -5 },
      { playerId: 5, chip: -5 },
    ]);
  });

  it("applies to players not seated at the winning hanchan too", () => {
    // dayParticipantIds can be larger than the 4 seated at the table
    const result = computeYakumanChips([10, 11, 12, 13, 14, 15], 15, 5);
    const winner = result.find((r) => r.playerId === 15);
    expect(winner?.chip).toBe(25); // 5 others * 5
    expect(result.filter((r) => r.playerId !== 15).every((r) => r.chip === -5)).toBe(true);
  });

  it("defaults perLoser to 5", () => {
    const result = computeYakumanChips([1, 2, 3, 4], 1);
    expect(result.find((r) => r.playerId === 1)?.chip).toBe(15);
  });
});

describe("computeLiveScores", () => {
  it("ロン: 和了者+points、対象-pointsのシンプルな授受", () => {
    const scores = computeLiveScores([
      { winType: "ron", winnerSeat: 0, loserSeat: 2, dealerSeat: 0, points: 3900 },
    ]);
    expect(scores).toEqual([3900, 0, -3900, 0]);
  });

  it("親のツモ: 3人が均等にpoints/3ずつ支払う", () => {
    const scores = computeLiveScores([
      { winType: "tsumo", winnerSeat: 1, loserSeat: null, dealerSeat: 1, points: 6000 },
    ]);
    expect(scores).toEqual([-2000, 6000, -2000, -2000]);
  });

  it("子のツモ: 親がpoints/2、残り2人の子がpoints/4ずつ支払う", () => {
    const scores = computeLiveScores([
      { winType: "tsumo", winnerSeat: 3, loserSeat: null, dealerSeat: 2, points: 5200 },
    ]);
    expect(scores).toEqual([-1300, -1300, -2600, 5200]);
  });

  it("流局・チョンボはスコアに反映しない", () => {
    const scores = computeLiveScores([
      { winType: "draw", winnerSeat: null, loserSeat: null, dealerSeat: 0, points: null },
      { winType: "chombo", winnerSeat: null, loserSeat: 1, dealerSeat: 0, points: null },
    ]);
    expect(scores).toEqual([0, 0, 0, 0]);
  });

  it("複数局を積み上げた合計（実機E2Eで確認した組み合わせと同じシナリオ）", () => {
    // 東1局: 起家(0)が西家(2)からロン3900
    // 東2局: 親=南家(1)がツモ、合計6000（2000オール）
    // 東3局: 親=西家(2)、子の北家(3)がツモ、合計5200（1300/2600）
    const scores = computeLiveScores([
      { winType: "ron", winnerSeat: 0, loserSeat: 2, dealerSeat: 0, points: 3900 },
      { winType: "tsumo", winnerSeat: 1, loserSeat: null, dealerSeat: 1, points: 6000 },
      { winType: "tsumo", winnerSeat: 3, loserSeat: null, dealerSeat: 2, points: 5200 },
    ]);
    expect(scores).toEqual([600, 4700, -8500, 3200]);
  });

  it("dealerSeatが分からない場合は起家(0)にフォールバックする", () => {
    const scores = computeLiveScores([
      { winType: "tsumo", winnerSeat: 1, loserSeat: null, dealerSeat: null, points: 6000 },
    ]);
    // フォールバックで親=0(起家)扱いになるため、非親のツモ配分（親1/2・子1/4ずつ）になる
    expect(scores).toEqual([-3000, 6000, -1500, -1500]);
  });
});

describe("computeNextRoundState", () => {
  it("履歴が無ければ東1局(index0)・0本場から開始する", () => {
    expect(computeNextRoundState([], 7)).toEqual({ roundIndex: 0, honba: 0 });
  });

  it("親（座席0）が和了すると、同じ局のまま本場が+1になる", () => {
    const state = computeNextRoundState(
      [{ winType: "tsumo", roundIndex: 0, honba: 0, dealerSeat: 0, winnerSeat: 0, tenpaiSeats: [] }],
      7,
    );
    expect(state).toEqual({ roundIndex: 0, honba: 1 });
  });

  it("親以外が和了すると、次の局に進み本場は0に戻る", () => {
    const state = computeNextRoundState(
      [{ winType: "ron", roundIndex: 0, honba: 2, dealerSeat: 0, winnerSeat: 2, tenpaiSeats: [] }],
      7,
    );
    expect(state).toEqual({ roundIndex: 1, honba: 0 });
  });

  it("流局で親（座席0）がテンパイなら、同じ局のまま本場が+1になる", () => {
    const state = computeNextRoundState(
      [{ winType: "draw", roundIndex: 3, honba: 1, dealerSeat: 0, winnerSeat: null, tenpaiSeats: [0, 2] }],
      7,
    );
    expect(state).toEqual({ roundIndex: 3, honba: 2 });
  });

  it("流局で親が非テンパイなら、次の局に進み本場は0に戻る", () => {
    const state = computeNextRoundState(
      [{ winType: "draw", roundIndex: 3, honba: 1, dealerSeat: 0, winnerSeat: null, tenpaiSeats: [1, 2] }],
      7,
    );
    expect(state).toEqual({ roundIndex: 4, honba: 0 });
  });

  it("チョンボは同じ局をやり直す扱いなので判定対象から除外し、その前の局の結果を引き継ぐ", () => {
    const state = computeNextRoundState(
      [
        { winType: "ron", roundIndex: 0, honba: 0, dealerSeat: 0, winnerSeat: 2, tenpaiSeats: [] },
        { winType: "chombo", roundIndex: 1, honba: 0, dealerSeat: 1, winnerSeat: null, tenpaiSeats: [] },
      ],
      7,
    );
    expect(state).toEqual({ roundIndex: 1, honba: 0 });
  });

  it("最終局（南4局）を超えて進めない", () => {
    const state = computeNextRoundState(
      [{ winType: "ron", roundIndex: 7, honba: 0, dealerSeat: 3, winnerSeat: 1, tenpaiSeats: [] }],
      7,
    );
    expect(state).toEqual({ roundIndex: 7, honba: 0 });
  });
});
