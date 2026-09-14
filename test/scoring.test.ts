import { describe, it, expect } from "vitest";
import {
  normalizeRawScore,
  computeRankAndChips,
  computeYakumanChips,
} from "../src/lib/scoring";

// アプリ全体の点数単位は「ポイント」（実際の素点÷1000。例: 素点32000点 → 32ポイント）。

describe("normalizeRawScore", () => {
  it("rawモード: 素点（画面表示そのまま）を1000で割ってポイントに変換する", () => {
    expect(normalizeRawScore(32000, "raw")).toBe(32);
    expect(normalizeRawScore(24700, "raw")).toBe(24.7); // 100点単位の端数もそのまま反映される
  });

  it("diffモード: 表示値は既にポイント単位の差分なので、originにそのまま加算する", () => {
    expect(normalizeRawScore(7, "diff")).toBe(32);
    expect(normalizeRawScore(-3.5, "diff")).toBe(21.5);
  });

  it("supports a custom origin", () => {
    expect(normalizeRawScore(5, "diff", 30)).toBe(35);
  });
});

describe("computeRankAndChips", () => {
  it("ranks by point score descending and assigns fixed chips", () => {
    const { ranked, hasTie } = computeRankAndChips([
      { playerId: 1, rawScore: 25 },
      { playerId: 2, rawScore: 40 },
      { playerId: 3, rawScore: 15 },
      { playerId: 4, rawScore: 20 },
    ]);

    expect(hasTie).toBe(false);
    expect(ranked.map((r) => r.playerId)).toEqual([2, 1, 4, 3]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    expect(ranked.map((r) => r.rankChip)).toEqual([3, 0, -1, -2]);
  });

  it("sums to zero across the four fixed chip values", () => {
    const { ranked } = computeRankAndChips([
      { playerId: 1, rawScore: 10 },
      { playerId: 2, rawScore: 20 },
      { playerId: 3, rawScore: 30 },
      { playerId: 4, rawScore: 40 },
    ]);
    expect(ranked.reduce((sum, r) => sum + r.rankChip, 0)).toBe(0);
  });

  it("flags ties without crashing", () => {
    const { hasTie, ranked } = computeRankAndChips([
      { playerId: 1, rawScore: 25 },
      { playerId: 2, rawScore: 25 },
      { playerId: 3, rawScore: 20 },
      { playerId: 4, rawScore: 30 },
    ]);
    expect(hasTie).toBe(true);
    expect(ranked).toHaveLength(4);
  });

  it("returns an empty result for no scores", () => {
    expect(computeRankAndChips([])).toEqual({ ranked: [], hasTie: false });
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
