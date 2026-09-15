import { describe, it, expect } from "vitest";
import { computeScoreTable } from "../src/lib/scoreTable";

// 麻雀の点数早見表でよく知られた基準値との突き合わせ（誤りがあると実際の対局で誤解を招くため厳密に検証する）。
describe("computeScoreTable", () => {
  const table = computeScoreTable();

  const findNonDealer = (fu: number, han: number) => {
    const fuIndex = table.fuRows.indexOf(fu as any);
    const hanIndex = table.hanCols.indexOf(han as any);
    return table.nonDealer[fuIndex]![hanIndex]!;
  };
  const findDealer = (fu: number, han: number) => {
    const fuIndex = table.fuRows.indexOf(fu as any);
    const hanIndex = table.hanCols.indexOf(han as any);
    return table.dealer[fuIndex]![hanIndex]!;
  };

  it("子のロン: 30符1〜4翻", () => {
    expect(findNonDealer(30, 1).ron).toBe(1000);
    expect(findNonDealer(30, 2).ron).toBe(2000);
    expect(findNonDealer(30, 3).ron).toBe(3900);
    expect(findNonDealer(30, 4).ron).toBe(7700);
  });

  it("子のロン: 40符・50符・切り上げ満貫", () => {
    expect(findNonDealer(40, 1).ron).toBe(1300);
    expect(findNonDealer(40, 2).ron).toBe(2600);
    expect(findNonDealer(40, 3).ron).toBe(5200);
    expect(findNonDealer(40, 4).ron).toBe(8000); // 切り上げ満貫
    expect(findNonDealer(50, 1).ron).toBe(1600);
    expect(findNonDealer(50, 3).ron).toBe(6400);
  });

  it("子のツモ: 30符2翻は2000オールではなく500/1000", () => {
    const cell = findNonDealer(30, 2);
    expect(cell.tsumoOther).toBe(500);
    expect(cell.tsumoDealer).toBe(1000);
  });

  it("子のツモ: 切り上げ満貫は2000/4000", () => {
    const cell = findNonDealer(40, 4);
    expect(cell.tsumoOther).toBe(2000);
    expect(cell.tsumoDealer).toBe(4000);
  });

  it("親のロン: 30符4翻は11600、40符4翻は切り上げ満貫12000", () => {
    expect(findDealer(30, 4).ron).toBe(11600);
    expect(findDealer(40, 4).ron).toBe(12000);
  });

  it("親のツモ: 40符4翻は4000オール（切り上げ満貫）", () => {
    expect(findDealer(40, 4).tsumoEach).toBe(4000);
  });

  it("親のツモ: 30符3翻は2000オール", () => {
    expect(findDealer(30, 3).tsumoEach).toBe(2000);
  });

  it("20符はロンでは発生しないためron=null、ツモは発生するため数値", () => {
    const cell = findNonDealer(20, 1);
    expect(cell.ron).toBeNull();
    expect(cell.tsumoOther).toBe(200);
    expect(cell.tsumoDealer).toBe(400);
  });

  it("25符1翻（七対子未満の組み合わせ）は発生しないためツモ・ロンともnull、2翻は数値", () => {
    const invalid = findNonDealer(25, 1);
    expect(invalid.tsumoOther).toBeNull();
    expect(invalid.tsumoDealer).toBeNull();
    const valid = findNonDealer(25, 2);
    expect(valid.ron).not.toBeNull();
  });
});
