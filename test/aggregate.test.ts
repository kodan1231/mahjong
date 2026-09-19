import { describe, it, expect } from "vitest";
import { summarizeDayTotals, normalizeYakuName } from "../src/lib/aggregate";

// summarizeDayTotalsは対局日詳細（loadDayDetail）が既に取得済みのparticipants/sessions/scores/
// yakuman情報から、DBに再度問い合わせずにその日の小計を計算する純粋関数（旧computeDaySummaryの置き換え）。

describe("summarizeDayTotals", () => {
  it("confirmed済みの半荘のみを合計し、pending/tiedの半荘は無視する", () => {
    const result = summarizeDayTotals({
      participants: [
        { playerId: 1, name: "わかさん" },
        { playerId: 2, name: "もつさん" },
        { playerId: 3, name: "支店長" },
        { playerId: 4, name: "たーふる" },
      ],
      confirmedGameSessionIds: [10],
      scores: [
        // 半荘10（confirmed）
        { gameSessionId: 10, playerId: 1, rawScore: 7, rankChip: 3 },
        { gameSessionId: 10, playerId: 2, rawScore: 0, rankChip: 0 },
        { gameSessionId: 10, playerId: 3, rawScore: -3, rankChip: -1 },
        { gameSessionId: 10, playerId: 4, rawScore: -4, rankChip: -2 },
        // 半荘11（pendingなので集計対象外）
        { gameSessionId: 11, playerId: 1, rawScore: 100, rankChip: 100 },
      ],
      yakumanEvents: [],
      yakumanTargets: [],
    });

    const byId = new Map(result.map((r) => [r.playerId, r]));
    expect(byId.get(1)).toMatchObject({ rawTotal: 7, chipTotal: 3 });
    expect(byId.get(2)).toMatchObject({ rawTotal: 0, chipTotal: 0 });
    expect(byId.get(3)).toMatchObject({ rawTotal: -3, chipTotal: -1 });
    expect(byId.get(4)).toMatchObject({ rawTotal: -4, chipTotal: -2 });
  });

  it("役満チップを着順チップに加算する（対象者スナップショット込み）", () => {
    const result = summarizeDayTotals({
      participants: [
        { playerId: 1, name: "わかさん" },
        { playerId: 2, name: "もつさん" },
        { playerId: 3, name: "支店長" },
      ],
      confirmedGameSessionIds: [],
      scores: [],
      yakumanEvents: [{ id: 100, winnerPlayerId: 1, chipPerLoser: 5 }],
      // 対象者はplayerId2,3（当時の日参加者スナップショット）。和了者1は含まれない。
      yakumanTargets: [
        { yakumanEventId: 100, playerId: 2 },
        { yakumanEventId: 100, playerId: 3 },
      ],
    });

    const byId = new Map(result.map((r) => [r.playerId, r]));
    expect(byId.get(1)?.chipTotal).toBe(10); // 5 x 2人分を総取り
    expect(byId.get(2)?.chipTotal).toBe(-5);
    expect(byId.get(3)?.chipTotal).toBe(-5);
  });

  it("参加者がいてもスコア・役満が無ければ0で返す", () => {
    const result = summarizeDayTotals({
      participants: [{ playerId: 1, name: "わかさん" }],
      confirmedGameSessionIds: [],
      scores: [],
      yakumanEvents: [],
      yakumanTargets: [],
    });
    expect(result).toEqual([{ playerId: 1, name: "わかさん", rawTotal: 0, chipTotal: 0 }]);
  });

  it("rawTotalの降順でソートする", () => {
    const result = summarizeDayTotals({
      participants: [
        { playerId: 1, name: "A" },
        { playerId: 2, name: "B" },
      ],
      confirmedGameSessionIds: [1],
      scores: [
        { gameSessionId: 1, playerId: 1, rawScore: -5, rankChip: 0 },
        { gameSessionId: 1, playerId: 2, rawScore: 5, rankChip: 0 },
      ],
      yakumanEvents: [],
      yakumanTargets: [],
    });
    expect(result.map((r) => r.playerId)).toEqual([2, 1]);
  });
});

describe("normalizeYakuName", () => {
  it("鳴きあり/鳴きなしの注記を取り除き、同じ役名にまとめる", () => {
    expect(normalizeYakuName("混一色（鳴きあり）")).toBe("混一色");
    expect(normalizeYakuName("混一色（鳴きなし）")).toBe("混一色");
    expect(normalizeYakuName("三色同順（鳴きあり）")).toBe("三色同順");
  });

  it("鳴きの注記が無い役名はそのまま返す", () => {
    expect(normalizeYakuName("役牌")).toBe("役牌");
    expect(normalizeYakuName("断幺九")).toBe("断幺九");
  });
});
