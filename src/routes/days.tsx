import { Hono, type Context } from "hono";
import { eq, and, desc, asc, inArray } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, type Db } from "../db/client";
import {
  players,
  days,
  dayParticipants,
  gameSessions,
  sessionScores,
  yakumanEvents,
  yakumanEventTargets,
  handLogs,
  photoUploads,
} from "../db/schema";
import { Layout } from "../views/layout";
import { Signed, TotalsTable, TabBar } from "../views/components";
import { requireAdmin, isAdmin } from "../lib/auth";
import {
  computeRankAndChips,
  normalizeRawScore,
  sumScores,
  ORIGIN_SCORE,
  HAKOWARE_AUTO_THRESHOLD,
  computeLiveScores,
  computeNextRoundState,
  isDealerContinuing,
  type DisplayMode,
  type LiveHandEntry,
  type RoundProgressEntry,
} from "../lib/scoring";
import { summarizeDayTotals } from "../lib/aggregate";
import { getOpenDayId } from "../lib/dayState";
import { YAKU_GROUPS } from "../lib/yaku";

export const dayRoutes = new Hono<{ Bindings: Env }>();

// seatIndex(0-3)は各半荘の開始時に登録した「起家から見た並び順」を表す固定値。
// 半荘の途中で自風が変わっても座席登録自体は最初の1回だけなので、ここでの表記は
// 常にその半荘における起家(0)・南家(1)・西家(2)・北家(3)を指す。
const WIND_LABELS = ["起家", "南家", "西家", "北家"] as const;
// 半荘一覧の表は幅が狭いスマホでも1段に収まるよう、風は1文字表記にする
const WIND_SHORT_LABELS = ["東", "南", "西", "北"] as const;

// 半荘＝東1〜4局＋南1〜4局の8局。インデックス%4が起家からの席順（＝その局の親）に対応する
// （東1局と南1局はどちらも起家が親、というように東場・南場で同じ並びが繰り返されるため）。
const ROUND_OPTIONS = ["東1局", "東2局", "東3局", "東4局", "南1局", "南2局", "南3局", "南4局"] as const;

// hand_logsの生データ（playerId/roundLabel）を、computeLiveScores（src/lib/scoring.ts）が
// 求める座席インデックス基準の形に変換してから渡す。座標変換とラベル解決はこの画面固有の
// 関心事なのでroutes側に置き、純粋な点数計算ロジックだけをlib側に切り出してテスト可能にしている。
function resolveLiveHandEntries(
  hands: {
    winType: string;
    winnerPlayerId: number | null;
    loserPlayerId: number | null;
    points: number | null;
    roundLabel: string | null;
    honba: number;
    riichiPlayerIds: string | null;
  }[],
  seatPlayerIds: (number | null)[],
): LiveHandEntry[] {
  const seatOfPlayer = new Map<number, number>();
  seatPlayerIds.forEach((pid, seat) => {
    if (pid != null) seatOfPlayer.set(pid, seat);
  });

  return hands.map((h) => {
    const roundIndex = h.roundLabel ? ROUND_OPTIONS.indexOf(h.roundLabel as (typeof ROUND_OPTIONS)[number]) : -1;
    let riichiSeats: number[] = [];
    if (h.riichiPlayerIds) {
      try {
        const ids: number[] = JSON.parse(h.riichiPlayerIds);
        riichiSeats = ids.map((id) => seatOfPlayer.get(id)).filter((s): s is number => s != null);
      } catch {
        // ignore parse errors, treat as no riichi info
      }
    }
    return {
      winType: h.winType,
      winnerSeat: h.winnerPlayerId != null ? (seatOfPlayer.get(h.winnerPlayerId) ?? null) : null,
      loserSeat: h.loserPlayerId != null ? (seatOfPlayer.get(h.loserPlayerId) ?? null) : null,
      dealerSeat: roundIndex >= 0 ? roundIndex % 4 : null,
      points: h.points,
      honba: h.honba,
      riichiSeats,
    };
  });
}

// hand_logsの生データを、computeNextRoundState（src/lib/scoring.ts）が求める座席インデックス基準の
// 形に変換する（resolveLiveHandEntriesの本場・次局提案版）。roundLabelがROUND_OPTIONSと一致しない
// 行（通常は発生しない）は判定対象から除外する。
function resolveRoundProgressEntries(
  hands: {
    winType: string;
    roundLabel: string | null;
    honba: number;
    winnerPlayerId: number | null;
    tenpaiPlayerIds: string | null;
  }[],
  seatPlayerIds: (number | null)[],
): RoundProgressEntry[] {
  const seatOfPlayer = new Map<number, number>();
  seatPlayerIds.forEach((pid, seat) => {
    if (pid != null) seatOfPlayer.set(pid, seat);
  });

  const entries: RoundProgressEntry[] = [];
  for (const h of hands) {
    const roundIndex = h.roundLabel ? ROUND_OPTIONS.indexOf(h.roundLabel as (typeof ROUND_OPTIONS)[number]) : -1;
    if (roundIndex < 0) continue;
    let tenpaiSeats: number[] = [];
    if (h.tenpaiPlayerIds) {
      try {
        const ids: number[] = JSON.parse(h.tenpaiPlayerIds);
        tenpaiSeats = ids.map((id) => seatOfPlayer.get(id)).filter((s): s is number => s != null);
      } catch {
        // ignore parse errors, treat as no tenpai info
      }
    }
    entries.push({
      winType: h.winType,
      roundIndex,
      honba: h.honba,
      dealerSeat: roundIndex % 4,
      winnerSeat: h.winnerPlayerId != null ? (seatOfPlayer.get(h.winnerPlayerId) ?? null) : null,
      tenpaiSeats,
    });
  }
  return entries;
}

// 局メモ一覧表示用: リーチ・鳴き・ドラ枚数を「（リーチ: ○○／鳴き: ○○／ドラ表1・裏1）」のような
// 一つの括弧書きにまとめる。日別ページ・対局中ページの両方の局メモ表示から共通で使う。
function describeHandExtras(
  h: {
    riichiPlayerIds: string | null;
    nakiPlayerIds: string | null;
    omoteDoraCount: number | null;
    uraDoraCount: number | null;
    akaDoraCount: number | null;
  },
  nameOf: (playerId: number) => string,
): string {
  const parts: string[] = [];

  for (const [field, label] of [
    [h.riichiPlayerIds, "リーチ"],
    [h.nakiPlayerIds, "鳴き"],
  ] as const) {
    if (!field) continue;
    try {
      const ids: number[] = JSON.parse(field);
      if (ids.length > 0) parts.push(`${label}: ${ids.map(nameOf).join("、")}`);
    } catch {
      // ignore parse errors
    }
  }

  const doraParts: string[] = [];
  if (h.omoteDoraCount) doraParts.push(`表${h.omoteDoraCount}`);
  if (h.uraDoraCount) doraParts.push(`裏${h.uraDoraCount}`);
  if (h.akaDoraCount) doraParts.push(`赤${h.akaDoraCount}`);
  if (doraParts.length > 0) parts.push(`ドラ${doraParts.join("・")}`);

  return parts.length > 0 ? `（${parts.join("／")}）` : "";
}

// 局メモ入力フォーム（局の自動補完＋親の自動算出、結果に応じた和了者/対象/テンパイ欄の出し分け、
// 役選択モーダル）。対局中ページと、対局日詳細の確定済み半荘の「局メモを追加・修正」の両方で使う共通部品。
// 1ページに複数半荘分（＝複数インスタンス）表示されうるため、DOM idはすべてsessionIdで一意にしている。
function HandLogForm({
  dayId,
  sessionId,
  nameBySeat,
  seatPlayers,
  hands,
}: {
  dayId: number;
  sessionId: number;
  nameBySeat: string[];
  seatPlayers: { playerId: number; seatIndex: number; name: string }[];
  hands: {
    winType: string;
    roundLabel: string | null;
    honba: number;
    winnerPlayerId: number | null;
    tenpaiPlayerIds: string | null;
  }[];
}) {
  const uid = String(sessionId);
  const seatPlayerIds = [0, 1, 2, 3].map((i) => seatPlayers.find((p) => p.seatIndex === i)?.playerId ?? null);
  // 親が和了、または流局で親がテンパイのときは同じ局のまま本場+1、それ以外は次の局に進み本場0に戻る
  // （チョンボはやり直し扱いなので判定対象から除外。computeNextRoundStateが担う）。
  // あくまでフォームの初期値の提案であり、両方とも保存前に手で修正できる。
  const { roundIndex: nextRoundIndex, honba: nextHonba } = computeNextRoundState(
    resolveRoundProgressEntries(hands, seatPlayerIds),
    ROUND_OPTIONS.length - 1,
  );

  return (
    <>
      <form class="stack" method="post" action={`/days/${dayId}/sessions/${sessionId}/hands`}>
        <label for={`round-select-${uid}`}>局</label>
        <div style="display:flex; gap:8px; align-items:center">
          <select name="roundLabel" id={`round-select-${uid}`} style="flex:1">
            {ROUND_OPTIONS.map((label, i) => (
              <option value={label} selected={i === nextRoundIndex}>
                {label}
              </option>
            ))}
          </select>
          <input
            type="number"
            name="honba"
            id={`honba-input-${uid}`}
            min="0"
            step="1"
            value={nextHonba}
            style="width:5em"
            aria-label="本場"
          />
          <span>本場</span>
        </div>
        <p style="margin:0">
          親: <strong id={`dealer-name-${uid}`}>{nameBySeat[nextRoundIndex % 4]}</strong>
        </p>

        <label>結果</label>
        <div class="choice-group" id={`result-group-${uid}`}>
          <label class="choice-btn">
            <input type="radio" name="winType" value="ron" checked /> ロン
          </label>
          <label class="choice-btn">
            <input type="radio" name="winType" value="tsumo" /> ツモ
          </label>
          <label class="choice-btn">
            <input type="radio" name="winType" value="draw" /> 流局
          </label>
          <label class="choice-btn">
            <input type="radio" name="winType" value="chombo" /> チョンボ
          </label>
        </div>

        <div id={`winner-field-${uid}`}>
          <label>和了者</label>
          <div class="choice-group">
            {seatPlayers.map((p) => (
              <label class="choice-btn">
                <input type="radio" name="winnerPlayerId" value={p.playerId} /> {p.name}
              </label>
            ))}
          </div>
        </div>

        <div id={`target-field-${uid}`}>
          <label>対象</label>
          <div class="choice-group">
            {seatPlayers.map((p) => (
              <label class="choice-btn">
                <input type="radio" name="loserPlayerId" value={p.playerId} /> {p.name}
              </label>
            ))}
          </div>
        </div>

        <div id={`tenpai-field-${uid}`} hidden>
          <label>テンパイ</label>
          <div class="choice-group">
            {seatPlayers.map((p) => (
              <label class="choice-btn">
                <input type="checkbox" name="tenpaiPlayerIds" value={p.playerId} /> {p.name}
              </label>
            ))}
          </div>
        </div>

        <label>リーチした人（任意）</label>
        <div class="choice-group">
          {seatPlayers.map((p) => (
            <label class="choice-btn">
              <input type="checkbox" name="riichiPlayerIds" value={p.playerId} /> {p.name}
            </label>
          ))}
        </div>

        <label>鳴いた人（任意）</label>
        <div class="choice-group">
          {seatPlayers.map((p) => (
            <label class="choice-btn">
              <input type="checkbox" name="nakiPlayerIds" value={p.playerId} /> {p.name}
            </label>
          ))}
        </div>

        <label for={`points-input-${uid}`}>点数（任意・役の点数のみ。本場・リーチ棒分は自動計算されます）</label>
        <input type="number" step="100" name="points" id={`points-input-${uid}`} />

        <div id={`dora-field-${uid}`}>
          <label>ドラ（任意）</label>
          <div style="display:flex; gap:12px; flex-wrap:wrap">
            <label style="font-weight:normal; display:flex; align-items:center; gap:4px">
              表<input type="number" name="omoteDoraCount" min="0" step="1" style="width:4em" />枚
            </label>
            <label style="font-weight:normal; display:flex; align-items:center; gap:4px">
              裏<input type="number" name="uraDoraCount" min="0" step="1" style="width:4em" />枚
            </label>
            <label style="font-weight:normal; display:flex; align-items:center; gap:4px">
              赤<input type="number" name="akaDoraCount" min="0" step="1" style="width:4em" />枚
            </label>
          </div>
        </div>

        <label>役（任意）</label>
        <p>
          <button type="button" class="btn btn-secondary" id={`yaku-btn-${uid}`}>
            役を選ぶ
          </button>
        </p>
        <p id={`yaku-summary-${uid}`} style="font-size:0.9rem; color:var(--ink-soft)"></p>
        <input type="hidden" name="yakuText" id={`yaku-text-input-${uid}`} />

        <button class="btn" type="submit">
          この局を記録する
        </button>
      </form>

      <div id={`yaku-modal-${uid}`} class="modal-overlay" hidden>
        <div class="card" style="max-height:82vh; overflow-y:auto; max-width:480px; width:100%; margin:0">
          <h2>役を選ぶ</h2>
          {YAKU_GROUPS.map((g) => (
            <>
              <h3>{g.label}</h3>
              {g.options.map((name) => (
                <label style="display:block; font-weight:normal; padding:4px 0">
                  <input type="checkbox" value={name} /> {name}
                </label>
              ))}
            </>
          ))}
          <p style="display:flex; gap:10px; margin-top:12px">
            <button type="button" class="btn" id={`yaku-confirm-${uid}`}>
              決定
            </button>
            <button type="button" class="btn btn-secondary" id={`yaku-cancel-${uid}`}>
              キャンセル
            </button>
          </p>
        </div>
      </div>

      <script
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{
          __html: `
            (function () {
              const uid = ${JSON.stringify(uid)};
              const seatNames = ${JSON.stringify(nameBySeat)};
              const roundSelect = document.getElementById('round-select-' + uid);
              const dealerName = document.getElementById('dealer-name-' + uid);
              function updateDealer() {
                dealerName.textContent = seatNames[roundSelect.selectedIndex % 4];
              }
              roundSelect.addEventListener('change', updateDealer);

              const winnerField = document.getElementById('winner-field-' + uid);
              const targetField = document.getElementById('target-field-' + uid);
              const tenpaiField = document.getElementById('tenpai-field-' + uid);
              const doraField = document.getElementById('dora-field-' + uid);
              function updateResultFields() {
                const checked = document.querySelector('#result-group-' + uid + ' input[name=winType]:checked');
                const val = checked ? checked.value : 'ron';
                winnerField.hidden = !(val === 'ron' || val === 'tsumo');
                targetField.hidden = !(val === 'ron' || val === 'chombo');
                tenpaiField.hidden = val !== 'draw';
                doraField.hidden = !(val === 'ron' || val === 'tsumo');
              }
              document.querySelectorAll('#result-group-' + uid + ' input[name=winType]').forEach((el) => {
                el.addEventListener('change', updateResultFields);
              });
              updateResultFields();

              const yakuBtn = document.getElementById('yaku-btn-' + uid);
              const yakuModal = document.getElementById('yaku-modal-' + uid);
              const yakuConfirm = document.getElementById('yaku-confirm-' + uid);
              const yakuCancel = document.getElementById('yaku-cancel-' + uid);
              const yakuSummary = document.getElementById('yaku-summary-' + uid);
              const yakuTextInput = document.getElementById('yaku-text-input-' + uid);
              yakuBtn.addEventListener('click', () => { yakuModal.hidden = false; });
              yakuCancel.addEventListener('click', () => { yakuModal.hidden = true; });
              yakuConfirm.addEventListener('click', () => {
                const checked = Array.from(yakuModal.querySelectorAll('input[type=checkbox]:checked')).map((el) => el.value);
                yakuTextInput.value = checked.join('、');
                yakuSummary.textContent = checked.join('、');
                yakuModal.hidden = true;
              });
            })();
          `,
        }}
      />
    </>
  );
}

// ---------- 対局日詳細（当日タブ・履歴ドリルダウン共通のデータ取得＆表示） ----------

async function loadDayDetail(db: Db, dayId: number) {
  const [day] = await db.select().from(days).where(eq(days.id, dayId));
  if (!day) return null;

  const participants = await db
    .select({ playerId: players.id, name: players.name })
    .from(dayParticipants)
    .innerJoin(players, eq(dayParticipants.playerId, players.id))
    .where(eq(dayParticipants.dayId, dayId));

  const sessions = await db
    .select()
    .from(gameSessions)
    .where(eq(gameSessions.dayId, dayId))
    .orderBy(asc(gameSessions.seq));

  const sessionIds = sessions.map((s) => s.id);
  const allScores = sessionIds.length
    ? await db
        .select({
          gameSessionId: sessionScores.gameSessionId,
          seatIndex: sessionScores.seatIndex,
          playerId: sessionScores.playerId,
          name: players.name,
          rawScore: sessionScores.rawScore,
          isHakoware: sessionScores.isHakoware,
          rank: sessionScores.rank,
          rankChip: sessionScores.rankChip,
        })
        .from(sessionScores)
        .innerJoin(players, eq(sessionScores.playerId, players.id))
        .where(inArray(sessionScores.gameSessionId, sessionIds))
    : [];

  const allHands = sessionIds.length
    ? await db.select().from(handLogs).where(inArray(handLogs.gameSessionId, sessionIds))
    : [];

  const events = await db
    .select({
      id: yakumanEvents.id,
      yakuName: yakumanEvents.yakuName,
      chipPerLoser: yakumanEvents.chipPerLoser,
      winnerPlayerId: yakumanEvents.winnerPlayerId,
      winnerName: players.name,
    })
    .from(yakumanEvents)
    .innerJoin(players, eq(yakumanEvents.winnerPlayerId, players.id))
    .where(eq(yakumanEvents.dayId, dayId));

  const eventIds = events.map((e) => e.id);
  const allTargets = eventIds.length
    ? await db
        .select({
          yakumanEventId: yakumanEventTargets.yakumanEventId,
          playerId: yakumanEventTargets.playerId,
          name: players.name,
        })
        .from(yakumanEventTargets)
        .innerJoin(players, eq(yakumanEventTargets.playerId, players.id))
        .where(inArray(yakumanEventTargets.yakumanEventId, eventIds))
    : [];

  // 上で取得済みのparticipants/sessions/allScores/events/allTargetsから直接計算する
  // （以前はcomputeDaySummaryが同じデータをDBから再取得しており、D1往復が余分に3〜4回発生していた）。
  const daySummary = summarizeDayTotals({
    participants,
    confirmedGameSessionIds: sessions.filter((s) => s.status === "confirmed").map((s) => s.id),
    scores: allScores,
    yakumanEvents: events,
    yakumanTargets: allTargets,
  });

  return { day, participants, sessions, allScores, allHands, events, allTargets, daySummary };
}

type DayDetail = NonNullable<Awaited<ReturnType<typeof loadDayDetail>>>;

// 対局中/終了バッジと「編集」リンクを日付見出し(<h1>)の末尾に埋め込んで同じ行に表示するための部品。
// <small>はphrasing contentなのでh1の子として置いてもHTML的に問題ない（<form>は不可のため
// 「終了する」ボタンはここに含めず、DayDetailBody側で見出しの下の小さな行として別途出す）。
const DayHeaderBadge = ({
  dayId,
  admin,
  status,
}: {
  dayId: number;
  admin: boolean;
  status: "open" | "closed";
}) => (
  <small style="font-size:0.5em; margin-left:10px; display:inline-flex; gap:8px; align-items:center; vertical-align:middle">
    <span class={`badge ${status === "open" ? "badge-open" : "badge-closed"}`}>
      {status === "open" ? "対局中" : "終了"}
    </span>
    {admin && <a href={`/days/${dayId}/edit`}>編集</a>}
  </small>
);

const DayDetailBody = ({ dayId, admin, data }: { dayId: number; admin: boolean; data: DayDetail }) => {
  const { day, participants, sessions, allScores, allHands, events, allTargets, daySummary } = data;

  return (
    <>
      {admin && day.status === "open" && (
        <p style="margin:-4px 0 10px">
          <form class="inline-form" method="post" action="/days/close">
            <button class="link-button" type="submit">
              終了する
            </button>
          </form>
        </p>
      )}

      <div class="card">
        <h2>この日の小計</h2>
        <TotalsTable totals={daySummary} showChips={true} />
      </div>

      <h2>半荘一覧</h2>
      {sessions.length === 0 && <p>まだ半荘がありません。</p>}
      {sessions.map((s) => {
        const rows = allScores.filter((r) => r.gameSessionId === s.id).sort((a, b) => a.seatIndex - b.seatIndex);
        const hands = allHands.filter((h) => h.gameSessionId === s.id);
        // 「まとめて入力」の小計ブロックで登録した行は、着順は計算せずチップだけ手入力した値を
        // そのまま保存している（rank===null かつ rankChip!==nullが目印）。通常の半荘確認画面で
        // 編集すると着順・チップが自動計算で上書きされてしまうため、編集リンクは出さない。
        const isSubtotalBlock = rows.length > 0 && rows.every((r) => r.rank == null) && rows.some((r) => r.rankChip != null);
        return (
          <div class="card">
            <h3>
              {isSubtotalBlock ? `小計${s.memo ? `（${s.memo}）` : ""}` : `第${s.seq}半荘`}{" "}
              <span class={`badge ${s.status === "confirmed" ? "badge-confirmed" : "badge-pending"}`}>
                {s.status === "confirmed" ? "確定済み" : "撮影待ち"}
              </span>
            </h3>
            <table class="session-table">
              <thead>
                <tr>
                  <th>風</th>
                  <th>プレイヤー</th>
                  <th>ポイント</th>
                  <th>チップ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr>
                    <td>{WIND_SHORT_LABELS[r.seatIndex] ?? "-"}</td>
                    <td>{r.name}</td>
                    <td>{r.rawScore != null ? <Signed n={r.rawScore} /> : "-"}</td>
                    <td>{r.rankChip != null ? <Signed n={r.rankChip} /> : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {hands.length > 0 && (
              <>
                <h4>局メモ</h4>
                <ul>
                  {hands.map((h) => (
                    <li>
                      {h.roundLabel ? `${h.roundLabel}${h.honba ? ` ${h.honba}本場` : ""}: ` : ""}
                      {(() => {
                        if (h.winType !== "draw") return null;
                        const tenpaiIds: number[] = h.tenpaiPlayerIds ? JSON.parse(h.tenpaiPlayerIds) : [];
                        const tenpaiNames = tenpaiIds.map((id) => rows.find((r) => r.playerId === id)?.name ?? "?");
                        return `流局${tenpaiNames.length > 0 ? `（テンパイ: ${tenpaiNames.join("、")}）` : ""}`;
                      })()}
                      {h.winType === "chombo" &&
                        `チョンボ（${rows.find((r) => r.playerId === h.loserPlayerId)?.name ?? "?"}）`}
                      {h.winType === "tsumo" && `${rows.find((r) => r.playerId === h.winnerPlayerId)?.name ?? "?"}がツモ`}
                      {h.winType === "ron" &&
                        `${rows.find((r) => r.playerId === h.winnerPlayerId)?.name ?? "?"}が${
                          rows.find((r) => r.playerId === h.loserPlayerId)?.name ?? "?"
                        }からロン`}
                      {h.points ? ` ${h.points}点` : ""}
                      {h.yakuText ? `（${h.yakuText}）` : ""}
                      {describeHandExtras(h, (id) => rows.find((r) => r.playerId === id)?.name ?? "?")}
                      {admin && (
                        <form class="inline-form" method="post" action={`/days/${dayId}/hands/${h.id}/delete`}>
                          <button class="link-button" type="submit">
                            [削除]
                          </button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {admin && (
              <p style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
                {isSubtotalBlock ? (
                  <span style="font-size:0.85rem; color:var(--ink-soft)">
                    小計ブロックのため個別編集はできません。修正する場合は削除してから「まとめて入力」の小計欄で入力し直してください。
                  </span>
                ) : s.status === "pending" ? (
                  <>
                    <a class="btn" href={`/days/${dayId}/sessions/${s.id}`}>
                      対局を記録する
                    </a>
                    <a class="btn btn-secondary" href={`/days/${dayId}/sessions/${s.id}/capture`}>
                      点数表示機を撮影する
                    </a>
                  </>
                ) : (
                  <a class="btn btn-secondary" href={`/days/${dayId}/sessions/${s.id}/confirm`}>
                    点数を編集する
                  </a>
                )}
                <form
                  method="post"
                  action={`/days/${dayId}/sessions/${s.id}/delete`}
                  onsubmit="return confirm('この半荘を削除します。よろしいですか？')"
                >
                  <button class="link-button" type="submit" style="color:#c0392b">
                    この半荘を削除
                  </button>
                </form>
              </p>
            )}

            {admin && !isSubtotalBlock && s.status === "confirmed" && (
              <details>
                <summary>局メモを追加・修正</summary>
                <HandLogForm
                  dayId={dayId}
                  sessionId={s.id}
                  nameBySeat={[0, 1, 2, 3].map((i) => rows.find((r) => r.seatIndex === i)?.name ?? "?")}
                  seatPlayers={rows}
                  hands={hands}
                />
              </details>
            )}
          </div>
        );
      })}

      {admin && (
        <p style="display:flex; gap:10px; flex-wrap:wrap">
          <a class="btn" href={`/days/${dayId}/sessions/new`}>
            次の半荘
          </a>
          <a class="btn btn-secondary" href={`/days/${dayId}/sheet`}>
            まとめて入力
          </a>
        </p>
      )}

      <h2>役満</h2>
      {events.length === 0 && <p>まだ役満はありません。</p>}
      <ul>
        {events.map((e) => {
          const targetNames = allTargets.filter((t) => t.yakumanEventId === e.id).map((t) => t.name);
          return (
            <li>
              {e.winnerName} - {e.yakuName}
              {targetNames.length > 0 ? `（${targetNames.join("、")}から各-${e.chipPerLoser}）` : ""}
              {admin && (
                <form class="inline-form" method="post" action={`/days/${dayId}/yakuman/${e.id}/delete`}>
                  <button class="link-button" type="submit">
                    [削除]
                  </button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
      {admin && (
        <details>
          <summary>役満を登録</summary>
          <form class="stack" method="post" action={`/days/${dayId}/yakuman`}>
            <label>和了者</label>
            <select name="winnerPlayerId">
              {participants.map((p) => (
                <option value={p.playerId}>{p.name}</option>
              ))}
            </select>
            <label>役名</label>
            <input type="text" name="yakuName" required />
            <label>チップを払う人（和了者本人は自動的に除外されます）</label>
            {participants.map((p) => (
              <label style="font-weight:normal">
                <input type="checkbox" name="targetPlayerIds" value={p.playerId} checked /> {p.name}
              </label>
            ))}
            <button class="btn" type="submit">
              登録
            </button>
          </form>
        </details>
      )}
    </>
  );
};

// ---------- 当日タブ ----------

dayRoutes.get("/", async (c) => {
  const db = getDb(c.env);
  const admin = await isAdmin(c);

  const [openDay] = await db.select().from(days).where(eq(days.status, "open"));
  // 進行中の対局日が無ければ、直近（最新）の対局日を代わりに表示する。
  const [targetDay] = openDay
    ? [openDay]
    : await db.select().from(days).orderBy(desc(days.date), desc(days.id)).limit(1);

  if (!targetDay) {
    return c.html(
      <Layout title="直近の成績" isAdmin={admin} openDayId={openDay?.id ?? null}>
        <TabBar active="today" />
        <h1>直近の成績</h1>
        <div class="card">
          <p>まだ対局日がありません。</p>
          {admin && (
            <p>
              <a class="btn" href="/days/new">
                対局日を開始
              </a>
            </p>
          )}
        </div>
      </Layout>,
    );
  }

  const data = await loadDayDetail(db, targetDay.id);
  if (!data) return c.notFound();

  return c.html(
    <Layout title="直近の成績" isAdmin={admin} openDayId={openDay?.id ?? null}>
      <TabBar active="today" />
      <h1>
        直近の成績{" "}
        <small style="font-size:0.6em; color:var(--felt-soft)">
          （{data.day.date}
          {data.day.memo ? ` ${data.day.memo}` : ""}）
        </small>
        <DayHeaderBadge dayId={targetDay.id} admin={admin} status={data.day.status} />
      </h1>
      <DayDetailBody dayId={targetDay.id} admin={admin} data={data} />
    </Layout>,
  );
});

// ---------- 対局日 ----------

dayRoutes.get("/days/new", requireAdmin, async (c) => {
  const db = getDb(c.env);

  const [openDay] = await db.select().from(days).where(eq(days.status, "open"));
  const activePlayers = await db.select().from(players).where(eq(players.active, true));
  const today = new Date().toISOString().slice(0, 10);

  return c.html(
    <Layout title="対局日を開始・登録" isAdmin={true} openDayId={openDay?.id ?? null}>
      <h1>対局日を開始・登録</h1>
      {openDay && (
        <p class="warning">
          現在進行中の対局日があります（
          <a href={`/days/${openDay.id}`}>{openDay.date}</a>
          ）。<strong>今日の日付</strong>で開始する場合は先に終了してください。過去の日付を追加登録する場合はそのまま下のフォームで登録できます。
        </p>
      )}
      <div class="card">
        <form class="stack" method="post" action="/days">
          <label for="date">日付</label>
          <input type="date" id="date" name="date" value={today} required />

          <label for="memo">メモ（任意）</label>
          <input type="text" id="memo" name="memo" />

          <label>参加者</label>
          {activePlayers.map((p) => (
            <label style="font-weight:normal">
              <input type="checkbox" name="playerIds" value={p.id} /> {p.name}
            </label>
          ))}

          <button class="btn" type="submit">
            登録する
          </button>
        </form>
      </div>
    </Layout>,
  );
});

dayRoutes.post("/days", requireAdmin, async (c) => {
  const db = getDb(c.env);

  const body = await c.req.parseBody({ all: true });
  const date = String(body.date ?? "").trim();
  const memo = body.memo ? String(body.memo) : null;
  const playerIdsRaw = body.playerIds;
  const playerIds = (Array.isArray(playerIdsRaw) ? playerIdsRaw : playerIdsRaw ? [playerIdsRaw] : []).map(Number);

  if (!date || playerIds.length === 0) {
    return c.redirect("/days/new");
  }

  // 今日の日付で作成する場合のみ「進行中の対局日は1つまで」を強制する。
  // 過去日の追加登録（バックフィル）は進行中の対局日があっても常に許可し、closed状態で作成する。
  const today = new Date().toISOString().slice(0, 10);
  const isToday = date === today;

  if (isToday) {
    const [openDay] = await db.select().from(days).where(eq(days.status, "open"));
    if (openDay) return c.redirect(`/days/${openDay.id}`);
  }

  // 同じ日付の対局日が既にあれば、重複作成せずそちらへ誘導する
  // （「まとめて入力」で行を追加したいだけなのに誤って新規作成してしまうケースを防ぐ）。
  const [existingSameDate] = await db.select().from(days).where(eq(days.date, date));
  if (existingSameDate) {
    return c.redirect(`/days/${existingSameDate.id}/sheet`);
  }

  const [day] = await db
    .insert(days)
    .values({ date, memo, status: isToday ? "open" : "closed" })
    .returning({ id: days.id });
  if (day) {
    await db.insert(dayParticipants).values(playerIds.map((playerId) => ({ dayId: day.id, playerId })));
  }

  return c.redirect(`/days/${day?.id}`);
});

dayRoutes.post("/days/close", requireAdmin, async (c) => {
  const db = getDb(c.env);
  const [openDay] = await db.select().from(days).where(eq(days.status, "open"));

  if (openDay) {
    await db.update(days).set({ status: "closed" }).where(eq(days.id, openDay.id));
    return c.redirect(`/days/${openDay.id}`);
  }

  return c.redirect("/");
});

dayRoutes.get("/days/:id", async (c) => {
  const dayId = Number(c.req.param("id"));
  const db = getDb(c.env);
  const admin = await isAdmin(c);

  const [data, openDayId] = await Promise.all([loadDayDetail(db, dayId), admin ? getOpenDayId(db) : Promise.resolve(null)]);
  if (!data) return c.notFound();

  const year = Number(data.day.date.slice(0, 4));

  return c.html(
    <Layout title={`${data.day.date} の対局`} isAdmin={admin} openDayId={openDayId}>
      <p>
        <a href={`/years/${year}`}>← {year}年の一覧に戻る</a>
      </p>
      <h1>
        {data.day.date} {data.day.memo ? `(${data.day.memo})` : ""}
        <DayHeaderBadge dayId={dayId} admin={admin} status={data.day.status} />
      </h1>
      <DayDetailBody dayId={dayId} admin={admin} data={data} />
    </Layout>,
  );
});

// ---------- 半荘（座席登録） ----------

dayRoutes.get("/days/:id/sessions/new", requireAdmin, async (c) => {
  const dayId = Number(c.req.param("id"));
  const db = getDb(c.env);

  const [day] = await db.select().from(days).where(eq(days.id, dayId));
  if (!day) return c.notFound();

  const participants = await db
    .select({ playerId: players.id, name: players.name })
    .from(dayParticipants)
    .innerJoin(players, eq(dayParticipants.playerId, players.id))
    .where(eq(dayParticipants.dayId, dayId));

  const [existingSessions, openDayId] = await Promise.all([
    db.select().from(gameSessions).where(eq(gameSessions.dayId, dayId)),
    getOpenDayId(db),
  ]);
  const nextSeq = existingSessions.length + 1;

  return c.html(
    <Layout title="半荘を登録" isAdmin={true} openDayId={openDayId}>
      <h1>第{nextSeq}半荘: 座席を登録</h1>
      <p>起家から順にプレイヤーを選んでください。</p>
      <div class="card">
        <form class="stack" method="post" action={`/days/${dayId}/sessions`}>
          {[0, 1, 2, 3].map((seat) => (
            <div class="seat-row">
              <span class="seat-label">{WIND_LABELS[seat]}</span>
              <div class="choice-group">
                {participants.map((p) => (
                  <label class="choice-btn">
                    <input type="radio" name={`seat${seat}`} value={p.playerId} required />
                    {p.name}
                  </label>
                ))}
              </div>
            </div>
          ))}

          <button class="btn" type="submit">
            登録する
          </button>
        </form>
      </div>
    </Layout>,
  );
});

dayRoutes.post("/days/:id/sessions", requireAdmin, async (c) => {
  const dayId = Number(c.req.param("id"));
  const db = getDb(c.env);
  const body = await c.req.parseBody();

  // 表示形式（素点そのまま／配給原点からの差分）は、対局が終わって点数表示機を実際に
  // 見るまでどちらなのか分からないため、座席登録の時点では聞かない。撮影・確認画面側で選ぶ。
  const displayMode: DisplayMode = "raw";
  const seatPlayerIds = [0, 1, 2, 3].map((seat) => Number(body[`seat${seat}`]));

  const existingSessions = await db.select().from(gameSessions).where(eq(gameSessions.dayId, dayId));
  const seq = existingSessions.length + 1;

  const [session] = await db
    .insert(gameSessions)
    .values({ dayId, seq, status: "pending", displayMode })
    .returning({ id: gameSessions.id });

  if (session) {
    await db.insert(sessionScores).values(
      seatPlayerIds.map((playerId, seatIndex) => ({
        gameSessionId: session.id,
        seatIndex,
        playerId,
      })),
    );
  }

  return c.redirect(`/days/${dayId}/sessions/${session?.id}`);
});

// ---------- 対局中（局メモのライブ入力） ----------

dayRoutes.get("/days/:id/sessions/:sid", requireAdmin, async (c) => {
  const dayId = Number(c.req.param("id"));
  const sessionId = Number(c.req.param("sid"));
  const db = getDb(c.env);

  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
  if (!session) return c.notFound();

  const [seatRows, hands, openDayId] = await Promise.all([
    db
      .select({ seatIndex: sessionScores.seatIndex, playerId: sessionScores.playerId, name: players.name })
      .from(sessionScores)
      .innerJoin(players, eq(sessionScores.playerId, players.id))
      .where(eq(sessionScores.gameSessionId, sessionId))
      .orderBy(asc(sessionScores.seatIndex)),
    db.select().from(handLogs).where(eq(handLogs.gameSessionId, sessionId)).orderBy(asc(handLogs.id)),
    getOpenDayId(db),
  ]);

  const nameBySeat = [0, 1, 2, 3].map((i) => seatRows.find((s) => s.seatIndex === i)?.name ?? "?");
  const nameByPlayerId = new Map(seatRows.map((s) => [s.playerId, s.name]));

  const seatPlayerIds = [0, 1, 2, 3].map((i) => seatRows.find((s) => s.seatIndex === i)?.playerId ?? null);
  const liveScores = computeLiveScores(resolveLiveHandEntries(hands, seatPlayerIds));

  // 親の連荘（本場+1で同じ局が続く）を考慮した「次の局」の親を現在の親として表示する
  // （次に入力する局・本場自体の算出はHandLogForm内で行う）。
  const roundProgress = resolveRoundProgressEntries(hands, seatPlayerIds);
  const nextRoundState = computeNextRoundState(roundProgress, ROUND_OPTIONS.length - 1);
  const currentDealerSeat = nextRoundState.roundIndex % 4;
  // 南4局が親の連荘ではなく決着（親交代、または流局で親が非テンパイ）で終わったら、
  // その半荘は終了とみなす。
  const relevantProgress = roundProgress.filter((h) => h.winType !== "chombo");
  const lastProgress = relevantProgress[relevantProgress.length - 1];
  const isDone =
    !!lastProgress && lastProgress.roundIndex === ROUND_OPTIONS.length - 1 && !isDealerContinuing(lastProgress);

  return c.html(
    <Layout title={`第${session.seq}半荘: 対局中`} isAdmin={true} openDayId={openDayId}>
      <p>
        <a href={`/days/${dayId}`}>← 対局日の詳細に戻る</a>
      </p>
      <h1>第{session.seq}半荘: 対局中</h1>

      <div class="card">
        <h2>現在のスコア</h2>
        <p style="font-size:0.8rem; color:var(--ink-soft); margin:0 0 10px">
          この半荘の中だけの暫定合計です（正式なスコアは撮影・確認画面で確定します）。起家を上、そこから時計回りに南家・西家・北家です。
        </p>
        <div class="score-cross">
          {(["top", "right", "bottom", "left"] as const).map((pos, i) => (
            <div class={`score-cross-cell score-cross-${pos}`}>
              <div class="score-cross-wind">
                {WIND_LABELS[i]}
                {currentDealerSeat === i && <span class="badge badge-open score-cross-dealer">親</span>}
              </div>
              <div class="score-cross-name">{nameBySeat[i]}</div>
              <div class="score-cross-score">
                <Signed n={liveScores[i] ?? 0} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div class="card">
        <h2>局メモ</h2>
        {hands.length === 0 && <p>まだ記録がありません。</p>}
        {hands.length > 0 && (
          <ul>
            {hands.map((h) => {
              const winnerName = h.winnerPlayerId != null ? (nameByPlayerId.get(h.winnerPlayerId) ?? "?") : null;
              const targetName = h.loserPlayerId != null ? (nameByPlayerId.get(h.loserPlayerId) ?? "?") : null;
              const tenpaiNames: string[] = h.tenpaiPlayerIds
                ? (JSON.parse(h.tenpaiPlayerIds) as number[]).map((id) => nameByPlayerId.get(id) ?? "?")
                : [];
              return (
                <li>
                  {h.roundLabel ? `${h.roundLabel}${h.honba ? ` ${h.honba}本場` : ""}: ` : ""}
                  {h.winType === "draw" && `流局${tenpaiNames.length > 0 ? `（テンパイ: ${tenpaiNames.join("、")}）` : ""}`}
                  {h.winType === "chombo" && `チョンボ（${targetName ?? "?"}）`}
                  {h.winType === "tsumo" && `${winnerName}がツモ`}
                  {h.winType === "ron" && `${winnerName}が${targetName}からロン`}
                  {h.points ? ` ${h.points}点` : ""}
                  {h.yakuText ? `（${h.yakuText}）` : ""}
                  {describeHandExtras(h, (id) => nameByPlayerId.get(id) ?? "?")}
                  <form class="inline-form" method="post" action={`/days/${dayId}/hands/${h.id}/delete`}>
                    <button class="link-button" type="submit">
                      [削除]
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}

        <h3>局メモを追加</h3>
        <HandLogForm dayId={dayId} sessionId={sessionId} nameBySeat={nameBySeat} seatPlayers={seatRows} hands={hands} />
      </div>

      {isDone && (
        <div class="card">
          <h2>南4局まで終了しました</h2>
          <p style="display:flex; gap:10px; flex-wrap:wrap">
            <a class="btn" href={`/days/${dayId}/sessions/${sessionId}/capture`}>
              点数表示機を撮影する
            </a>
            <a class="btn btn-secondary" href={`/days/${dayId}/sessions/${sessionId}/confirm`}>
              撮影せずに手入力する
            </a>
          </p>
        </div>
      )}
    </Layout>,
  );
});

// ---------- 撮影 ----------

dayRoutes.get("/days/:id/sessions/:sid/capture", requireAdmin, async (c) => {
  const dayId = Number(c.req.param("id"));
  const sessionId = Number(c.req.param("sid"));
  const admin = true;
  const openDayId = await getOpenDayId(getDb(c.env));

  return c.html(
    <Layout title="点数表示機を撮影" isAdmin={admin} openDayId={openDayId}>
      <h1>第{sessionId}半荘: 点数表示機を撮影</h1>
      <div class="card">
        <input type="file" id="photo-input" accept="image/*" capture="environment" />
        <p id="status"></p>
      </div>
      <p>
        <a href={`/days/${dayId}/sessions/${sessionId}/confirm`}>撮影せずに手入力する →</a>
      </p>
      <script
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{
          __html: `
            const MAX_DIMENSION = 1600;
            const JPEG_QUALITY = 0.85;

            async function resizeImage(file) {
              const bitmap = await createImageBitmap(file);
              let { width, height } = bitmap;
              if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
                const scale = MAX_DIMENSION / Math.max(width, height);
                width = Math.round(width * scale);
                height = Math.round(height * scale);
              }
              const canvas = document.createElement('canvas');
              canvas.width = width;
              canvas.height = height;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(bitmap, 0, 0, width, height);
              return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
            }

            const input = document.getElementById('photo-input');
            const status = document.getElementById('status');
            input.addEventListener('change', async () => {
              const file = input.files[0];
              if (!file) return;

              status.textContent = '画像を縮小中...';
              let uploadBlob = file;
              try {
                const resized = await resizeImage(file);
                if (resized) uploadBlob = resized;
              } catch (e) {
                // 縮小に失敗しても元画像でアップロードを試みる
              }

              status.textContent = '解析中...';
              const fd = new FormData();
              fd.append('photo', uploadBlob, 'photo.jpg');
              fd.append('gameSessionId', '${sessionId}');
              try {
                const res = await fetch('/api/ocr', { method: 'POST', body: fd });
                if (!res.ok) throw new Error('failed');
                window.location.href = '/days/${dayId}/sessions/${sessionId}/confirm';
              } catch (e) {
                status.textContent = '解析に失敗しました。手入力してください。';
              }
            });
          `,
        }}
      />
    </Layout>,
  );
});

// ---------- 確認・確定 ----------

dayRoutes.get("/days/:id/sessions/:sid/confirm", requireAdmin, async (c) => {
  const dayId = Number(c.req.param("id"));
  const sessionId = Number(c.req.param("sid"));
  const db = getDb(c.env);

  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
  if (!session) return c.notFound();

  const [rows, dayParticipantOptions, latestPhotoRows, openDayId] = await Promise.all([
    db
      .select({
        seatIndex: sessionScores.seatIndex,
        playerId: sessionScores.playerId,
        name: players.name,
        rawScore: sessionScores.rawScore,
        isHakoware: sessionScores.isHakoware,
      })
      .from(sessionScores)
      .innerJoin(players, eq(sessionScores.playerId, players.id))
      .where(eq(sessionScores.gameSessionId, sessionId))
      .orderBy(asc(sessionScores.seatIndex)),
    db
      .select({ playerId: players.id, name: players.name })
      .from(dayParticipants)
      .innerJoin(players, eq(dayParticipants.playerId, players.id))
      .where(eq(dayParticipants.dayId, dayId)),
    // imageData（写真BLOB本体）はこの画面では使わない（表示用リンクは/api/photos/:idが別途取得する）ので、
    // 使うカラムだけ選択して毎回の無駄なBLOB読み込みを避ける。
    db
      .select({ id: photoUploads.id, ocrRawJson: photoUploads.ocrRawJson })
      .from(photoUploads)
      .where(eq(photoUploads.gameSessionId, sessionId))
      .orderBy(desc(photoUploads.id))
      .limit(1),
    getOpenDayId(db),
  ]);
  const [latestPhoto] = latestPhotoRows;

  let ocrValues: (number | null)[] = [null, null, null, null];
  if (latestPhoto?.ocrRawJson) {
    try {
      ocrValues = JSON.parse(latestPhoto.ocrRawJson).values ?? ocrValues;
    } catch {
      // ignore parse errors, keep nulls
    }
  }

  // 表示形式（素点そのまま／配給原点からの差分）は座席登録時には決めず、点数表示機を実際に見た
  // ここ（確認画面）で選んでもらう。?modeクエリで切り替えると、OCRの生の読み取り値からの
  // プリフィル計算だけがその場でやり直される（すでに入力・保存済みの値はそのまま優先される）。
  const modeQuery = c.req.query("mode");
  const displayMode: DisplayMode =
    modeQuery === "diff" || modeQuery === "raw" ? modeQuery : (session.displayMode as DisplayMode);
  const tieWarning = c.req.query("tie") === "1";
  const badSumWarning = c.req.query("badsum") === "1";

  return c.html(
    <Layout title="点数を確認" isAdmin={true} openDayId={openDayId}>
      <h1>第{session.seq}半荘: 点数を確認</h1>
      {badSumWarning && (
        <p class="warning">4人分のポイントの合計が0になっていません。入力ミスがないか確認してください。</p>
      )}
      {tieWarning && (
        <p class="warning">
          同点です。ポイントを調整して同点を解消するか、各座席の「同点時の順位」でどちらが上位かを選び、下のチェックを入れて確定してください。
        </p>
      )}
      <p>
        点数表示機の表示形式:{" "}
        <a href={`/days/${dayId}/sessions/${sessionId}/confirm?mode=raw`} style={displayMode === "raw" ? "font-weight:900; text-decoration:underline" : ""}>
          素点をそのまま表示
        </a>
        {" ／ "}
        <a href={`/days/${dayId}/sessions/${sessionId}/confirm?mode=diff`} style={displayMode === "diff" ? "font-weight:900; text-decoration:underline" : ""}>
          配給原点({ORIGIN_SCORE})からの±差分表示
        </a>
        <br />
        （実際に表示機を見て、どちらの形式で数字が出ているかを選んでください。下の入力欄にはその形式に合わせて配給原点からの増減が自動計算されて入ります。4人の合計は必ず0になります）
        {latestPhoto && (
          <>
            {" ／ "}
            <a href={`/api/photos/${latestPhoto.id}`} target="_blank" rel="noreferrer">
              撮影した写真を見る
            </a>
          </>
        )}
      </p>
      <div class="card">
      <form class="stack" method="post" action={`/days/${dayId}/sessions/${sessionId}/confirm`}>
        {rows.map((r) => {
          const ocrRaw = ocrValues[r.seatIndex];
          const prefill =
            r.rawScore ?? (ocrRaw != null ? normalizeRawScore(ocrRaw, displayMode) : "");
          return (
            <div class="seat-block">
              <div class="seat-row">
                <span class="seat-label">{WIND_LABELS[r.seatIndex]}</span>
                <div class="choice-group">
                  {dayParticipantOptions.map((p) => (
                    <label class="choice-btn">
                      <input
                        type="radio"
                        name={`player_${r.seatIndex}`}
                        value={p.playerId}
                        checked={p.playerId === r.playerId}
                      />
                      {p.name}
                    </label>
                  ))}
                </div>
              </div>
              <div class="seat-row">
                <input type="number" step="0.1" name={`score_${r.seatIndex}`} value={String(prefill)} required />
                <label style="font-weight:normal">
                  <input type="checkbox" name={`hakoware_${r.seatIndex}`} checked={r.isHakoware} /> 箱割れ
                </label>
              </div>
              {tieWarning && (
                <div class="seat-row">
                  <label style="font-weight:normal">
                    同点時の順位:{" "}
                    <select name={`tiebreak_${r.seatIndex}`}>
                      {[1, 2, 3, 4].map((n) => (
                        <option value={n} selected={n === r.seatIndex + 1}>
                          {n}位
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </div>
          );
        })}
        {tieWarning && (
          <label style="font-weight:normal">
            <input type="checkbox" name="acceptTie" value="1" /> 同点のまま上で選んだ順位で確定する
          </label>
        )}
        <button class="btn" type="submit">
          確定
        </button>
      </form>
      </div>
    </Layout>,
  );
});

dayRoutes.post("/days/:id/sessions/:sid/confirm", requireAdmin, async (c) => {
  const dayId = Number(c.req.param("id"));
  const sessionId = Number(c.req.param("sid"));
  const db = getDb(c.env);
  const body = await c.req.parseBody();

  const seatInputs = [0, 1, 2, 3].map((seatIndex) => ({
    seatIndex,
    playerId: Number(body[`player_${seatIndex}`]),
    rawScore: Number(body[`score_${seatIndex}`]),
    isHakoware: body[`hakoware_${seatIndex}`] === "on",
    tieBreakPriority: body[`tiebreak_${seatIndex}`] != null ? Number(body[`tiebreak_${seatIndex}`]) : undefined,
  }));

  const acceptTie = body.acceptTie === "1";

  // 4人分のポイント（配給原点からの差分）は必ず合計0になるはず。ずれていたら入力ミスなので確定させない。
  if (Math.abs(sumScores(seatInputs.map(({ playerId, rawScore }) => ({ playerId, rawScore })))) > 0.05) {
    for (const s of seatInputs) {
      await db
        .update(sessionScores)
        .set({ playerId: s.playerId, rawScore: s.rawScore, isHakoware: s.isHakoware })
        .where(and(eq(sessionScores.gameSessionId, sessionId), eq(sessionScores.seatIndex, s.seatIndex)));
    }
    return c.redirect(`/days/${dayId}/sessions/${sessionId}/confirm?badsum=1`);
  }

  const { ranked, hasTie } = computeRankAndChips(
    seatInputs.map(({ playerId, rawScore, tieBreakPriority }) => ({ playerId, rawScore, tieBreakPriority })),
  );

  if (hasTie && !acceptTie) {
    // 一旦入力値だけ保存し、確認画面に戻して警告を出す（着順・チップは未確定のまま）
    for (const s of seatInputs) {
      await db
        .update(sessionScores)
        .set({ playerId: s.playerId, rawScore: s.rawScore, isHakoware: s.isHakoware })
        .where(and(eq(sessionScores.gameSessionId, sessionId), eq(sessionScores.seatIndex, s.seatIndex)));
    }
    return c.redirect(`/days/${dayId}/sessions/${sessionId}/confirm?tie=1`);
  }

  for (const s of seatInputs) {
    const r = ranked.find((x) => x.playerId === s.playerId);
    await db
      .update(sessionScores)
      .set({
        playerId: s.playerId,
        rawScore: s.rawScore,
        rank: r?.rank ?? null,
        rankChip: r?.rankChip ?? null,
        isHakoware: s.isHakoware,
      })
      .where(and(eq(sessionScores.gameSessionId, sessionId), eq(sessionScores.seatIndex, s.seatIndex)));
  }

  await db
    .update(gameSessions)
    .set({ status: "confirmed", playedAt: new Date().toISOString() })
    .where(eq(gameSessions.id, sessionId));

  return c.redirect(`/days/${dayId}`);
});

// ---------- 役満 ----------

dayRoutes.post("/days/:id/yakuman", requireAdmin, async (c) => {
  const dayId = Number(c.req.param("id"));
  const db = getDb(c.env);
  const body = await c.req.parseBody({ all: true });

  const winnerPlayerId = Number(body.winnerPlayerId);
  const yakuName = String(body.yakuName ?? "").trim();
  const targetIdsRaw = body.targetPlayerIds;
  const targetIds = (Array.isArray(targetIdsRaw) ? targetIdsRaw : targetIdsRaw ? [targetIdsRaw] : [])
    .map(Number)
    .filter((id) => id !== winnerPlayerId);

  if (winnerPlayerId && yakuName) {
    const [event] = await db
      .insert(yakumanEvents)
      .values({ dayId, winnerPlayerId, yakuName })
      .returning({ id: yakumanEvents.id });

    if (event && targetIds.length > 0) {
      await db.insert(yakumanEventTargets).values(targetIds.map((playerId) => ({ yakumanEventId: event.id, playerId })));
    }
  }

  return c.redirect(`/days/${dayId}`);
});

// ---------- 局メモ ----------

dayRoutes.post("/days/:id/sessions/:sid/hands", requireAdmin, async (c) => {
  const dayId = Number(c.req.param("id"));
  const sessionId = Number(c.req.param("sid"));
  const db = getDb(c.env);
  const body = await c.req.parseBody({ all: true });

  const winType = String(body.winType ?? "ron") as "ron" | "tsumo" | "draw" | "chombo";
  const winnerPlayerId = body.winnerPlayerId ? Number(body.winnerPlayerId) : null;
  const loserPlayerId = body.loserPlayerId ? Number(body.loserPlayerId) : null;
  const roundLabel = body.roundLabel ? String(body.roundLabel) : null;
  const honbaRaw = body.honba != null ? Number(body.honba) : 0;
  const honba = Number.isFinite(honbaRaw) && honbaRaw >= 0 ? Math.trunc(honbaRaw) : 0;
  const yakuText = body.yakuText ? String(body.yakuText) : null;
  const points = body.points ? Number(body.points) : null;

  const tenpaiRaw = body.tenpaiPlayerIds;
  const tenpaiPlayerIds = Array.isArray(tenpaiRaw) ? tenpaiRaw : tenpaiRaw ? [tenpaiRaw] : [];

  // リーチ・鳴きは結果に関わらず（勝敗を問わず）記録する。
  const riichiRaw = body.riichiPlayerIds;
  const riichiPlayerIds = Array.isArray(riichiRaw) ? riichiRaw : riichiRaw ? [riichiRaw] : [];
  const nakiRaw = body.nakiPlayerIds;
  const nakiPlayerIds = Array.isArray(nakiRaw) ? nakiRaw : nakiRaw ? [nakiRaw] : [];

  const omoteDoraCount = body.omoteDoraCount ? Number(body.omoteDoraCount) : null;
  const uraDoraCount = body.uraDoraCount ? Number(body.uraDoraCount) : null;
  const akaDoraCount = body.akaDoraCount ? Number(body.akaDoraCount) : null;

  await db.insert(handLogs).values({
    gameSessionId: sessionId,
    winType,
    winnerPlayerId: winType === "ron" || winType === "tsumo" ? winnerPlayerId : null,
    // ロン時は放銃者、チョンボ時はチョンボした対象プレイヤーとしてloserPlayerIdを使い回す
    loserPlayerId: winType === "ron" || winType === "chombo" ? loserPlayerId : null,
    roundLabel,
    honba,
    yakuText,
    points: Number.isFinite(points) ? points : null,
    tenpaiPlayerIds: winType === "draw" && tenpaiPlayerIds.length > 0 ? JSON.stringify(tenpaiPlayerIds.map(Number)) : null,
    riichiPlayerIds: riichiPlayerIds.length > 0 ? JSON.stringify(riichiPlayerIds.map(Number)) : null,
    nakiPlayerIds: nakiPlayerIds.length > 0 ? JSON.stringify(nakiPlayerIds.map(Number)) : null,
    omoteDoraCount: winType === "ron" || winType === "tsumo" ? (Number.isFinite(omoteDoraCount) ? omoteDoraCount : null) : null,
    uraDoraCount: winType === "ron" || winType === "tsumo" ? (Number.isFinite(uraDoraCount) ? uraDoraCount : null) : null,
    akaDoraCount: winType === "ron" || winType === "tsumo" ? (Number.isFinite(akaDoraCount) ? akaDoraCount : null) : null,
  });

  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
  if (session?.status === "pending") {
    return c.redirect(`/days/${dayId}/sessions/${sessionId}`);
  }
  return c.redirect(`/days/${dayId}`);
});

dayRoutes.post("/days/:id/hands/:hid/delete", requireAdmin, async (c) => {
  const dayId = Number(c.req.param("id"));
  const handId = Number(c.req.param("hid"));
  const db = getDb(c.env);

  await db.delete(handLogs).where(eq(handLogs.id, handId));

  return c.redirect(`/days/${dayId}`);
});

dayRoutes.post("/days/:id/yakuman/:yid/delete", requireAdmin, async (c) => {
  const dayId = Number(c.req.param("id"));
  const yakumanId = Number(c.req.param("yid"));
  const db = getDb(c.env);

  await db.delete(yakumanEventTargets).where(eq(yakumanEventTargets.yakumanEventId, yakumanId));
  await db.delete(yakumanEvents).where(eq(yakumanEvents.id, yakumanId));

  return c.redirect(`/days/${dayId}`);
});

// ---------- 半荘の削除 ----------

dayRoutes.post("/days/:id/sessions/:sid/delete", requireAdmin, async (c) => {
  const dayId = Number(c.req.param("id"));
  const sessionId = Number(c.req.param("sid"));
  const db = getDb(c.env);

  // 関連レコードを先に削除・切り離してから半荘本体を削除する
  await db.delete(sessionScores).where(eq(sessionScores.gameSessionId, sessionId));
  await db.delete(handLogs).where(eq(handLogs.gameSessionId, sessionId));
  await db.delete(photoUploads).where(eq(photoUploads.gameSessionId, sessionId));
  await db
    .update(yakumanEvents)
    .set({ gameSessionId: null })
    .where(eq(yakumanEvents.gameSessionId, sessionId));
  await db.delete(gameSessions).where(eq(gameSessions.id, sessionId));

  return c.redirect(`/days/${dayId}`);
});

// ---------- 対局日の編集 ----------

dayRoutes.get("/days/:id/edit", requireAdmin, async (c) => {
  const dayId = Number(c.req.param("id"));
  const db = getDb(c.env);

  const [day] = await db.select().from(days).where(eq(days.id, dayId));
  if (!day) return c.notFound();

  const [allPlayers, currentParticipants, openDayId] = await Promise.all([
    db.select().from(players).orderBy(players.id),
    db.select({ playerId: dayParticipants.playerId }).from(dayParticipants).where(eq(dayParticipants.dayId, dayId)),
    getOpenDayId(db),
  ]);
  const currentIds = new Set(currentParticipants.map((p) => p.playerId));

  return c.html(
    <Layout title="対局日を編集" isAdmin={true} openDayId={openDayId}>
      <h1>対局日を編集</h1>
      <div class="card">
        <form class="stack" method="post" action={`/days/${dayId}/edit`}>
          <label for="date">日付</label>
          <input type="date" id="date" name="date" value={day.date} required />

          <label for="memo">メモ（任意）</label>
          <input type="text" id="memo" name="memo" value={day.memo ?? ""} />

          <label>参加者</label>
          {allPlayers.map((p) => (
            <label style="font-weight:normal">
              <input type="checkbox" name="playerIds" value={p.id} checked={currentIds.has(p.id)} /> {p.name}
              {!p.active ? "（無効化済み）" : ""}
            </label>
          ))}

          <button class="btn" type="submit">
            保存
          </button>
        </form>
      </div>
      <div class="card">
        <h2>対局日の削除</h2>
        <p>この対局日の半荘・スコア・役満・局メモ・写真をすべて削除します。登録を間違えた対局日を消す場合に使ってください。この操作は取り消せません。</p>
        <form
          method="post"
          action={`/days/${dayId}/delete`}
          onsubmit="return confirm('この対局日のデータをすべて削除します。よろしいですか？（元に戻せません）')"
        >
          <button class="btn btn-danger" type="submit">
            この対局日を削除する
          </button>
        </form>
      </div>
    </Layout>,
  );
});

dayRoutes.post("/days/:id/delete", requireAdmin, async (c) => {
  const dayId = Number(c.req.param("id"));
  const db = getDb(c.env);

  const [day] = await db.select().from(days).where(eq(days.id, dayId));
  if (!day) return c.notFound();

  const sessions = await db.select({ id: gameSessions.id }).from(gameSessions).where(eq(gameSessions.dayId, dayId));
  const sessionIds = sessions.map((s) => s.id);

  if (sessionIds.length > 0) {
    await db.delete(sessionScores).where(inArray(sessionScores.gameSessionId, sessionIds));
    await db.delete(handLogs).where(inArray(handLogs.gameSessionId, sessionIds));
    await db.delete(photoUploads).where(inArray(photoUploads.gameSessionId, sessionIds));
  }

  const yakumanRows = await db.select({ id: yakumanEvents.id }).from(yakumanEvents).where(eq(yakumanEvents.dayId, dayId));
  const yakumanIds = yakumanRows.map((y) => y.id);
  if (yakumanIds.length > 0) {
    await db.delete(yakumanEventTargets).where(inArray(yakumanEventTargets.yakumanEventId, yakumanIds));
  }
  await db.delete(yakumanEvents).where(eq(yakumanEvents.dayId, dayId));

  await db.delete(gameSessions).where(eq(gameSessions.dayId, dayId));
  await db.delete(dayParticipants).where(eq(dayParticipants.dayId, dayId));
  await db.delete(days).where(eq(days.id, dayId));

  return c.redirect("/");
});

dayRoutes.post("/days/:id/edit", requireAdmin, async (c) => {
  const dayId = Number(c.req.param("id"));
  const db = getDb(c.env);
  const body = await c.req.parseBody({ all: true });

  const date = String(body.date ?? "").trim();
  const memo = body.memo ? String(body.memo) : null;
  const playerIdsRaw = body.playerIds;
  const playerIds = (Array.isArray(playerIdsRaw) ? playerIdsRaw : playerIdsRaw ? [playerIdsRaw] : []).map(Number);

  if (date) {
    await db.update(days).set({ date, memo }).where(eq(days.id, dayId));
  }

  const currentParticipants = await db
    .select({ playerId: dayParticipants.playerId })
    .from(dayParticipants)
    .where(eq(dayParticipants.dayId, dayId));
  const currentIds = new Set(currentParticipants.map((p) => p.playerId));
  const nextIds = new Set(playerIds);

  const toAdd = playerIds.filter((id) => !currentIds.has(id));
  const toRemove = [...currentIds].filter((id) => !nextIds.has(id));

  if (toAdd.length > 0) {
    await db.insert(dayParticipants).values(toAdd.map((playerId) => ({ dayId, playerId })));
  }
  for (const playerId of toRemove) {
    await db
      .delete(dayParticipants)
      .where(and(eq(dayParticipants.dayId, dayId), eq(dayParticipants.playerId, playerId)));
  }

  return c.redirect(`/days/${dayId}`);
});

// ---------- まとめて入力（スプレッドシート風の一括登録・過去履歴のバックフィル向け） ----------
// 半荘ごとの座席登録→撮影→確認、という通常フローとは別に、
// 「行＝半荘、列＝参加者」の表に直接ポイント（素点÷1000）を入力して一括保存できる画面。
// 箱割れ・役満・局メモはここでは扱わず、通常の対局日詳細ページから編集する。

const SHEET_EXTRA_BLANK_ROWS = 8;

// GET（初回表示）とPOST（保存後の再表示）で共通利用する描画関数。
// POST側は保存の成否に関わらずリダイレクトせずこの関数で直接HTMLを返すことで、
// 合計不一致・入力不足などで保存されなかった行についても「今まさに入力した値」を
// そのまま画面に残せるようにしている（overridesが指定された値を優先する）。
async function renderSheetPage(
  c: Context<{ Bindings: Env }>,
  dayId: number,
  opts: {
    overrides?: Map<string, string>;
    totalRows?: number;
    partialSeqs?: number[];
    tiedSeqs?: number[];
    badSumSeqs?: number[];
    subtotalOverrides?: Map<string, string>;
    subtotalBlockCount?: number;
    subtotalWarnings?: string[];
  } = {},
) {
  const db = getDb(c.env);

  const [day] = await db.select().from(days).where(eq(days.id, dayId));
  if (!day) return c.notFound();

  const openDayId = await getOpenDayId(db);

  const participants = await db
    .select({ playerId: players.id, name: players.name })
    .from(dayParticipants)
    .innerJoin(players, eq(dayParticipants.playerId, players.id))
    .where(eq(dayParticipants.dayId, dayId))
    .orderBy(dayParticipants.id);

  const sessions = await db
    .select()
    .from(gameSessions)
    .where(eq(gameSessions.dayId, dayId))
    .orderBy(asc(gameSessions.seq));
  const sessionBySeq = new Map(sessions.map((s) => [s.seq, s]));

  const sessionIds = sessions.map((s) => s.id);
  const scoreRows = sessionIds.length
    ? await db.select().from(sessionScores).where(inArray(sessionScores.gameSessionId, sessionIds))
    : [];

  const maxExistingSeq = sessions.reduce((m, s) => Math.max(m, s.seq), 0);
  const totalRows = opts.totalRows ?? maxExistingSeq + SHEET_EXTRA_BLANK_ROWS;
  const partialSeqs = opts.partialSeqs ?? [];
  const tiedSeqs = opts.tiedSeqs ?? [];
  const badSumSeqs = opts.badSumSeqs ?? [];
  const overrides = opts.overrides;
  const subtotalOverrides = opts.subtotalOverrides;
  const subtotalBlockCount = opts.subtotalBlockCount ?? 1;
  const subtotalWarnings = opts.subtotalWarnings ?? [];

  return c.html(
    <Layout title="まとめて入力" isAdmin={true} openDayId={openDayId}>
      <h1>{day.date}: まとめて入力</h1>
      {partialSeqs.length > 0 && (
        <p class="warning">
          第{partialSeqs.join("・")}回は4人分そろっていないため保存されませんでした。確認して入力し直してください。
        </p>
      )}
      {badSumSeqs.length > 0 && (
        <p class="warning">
          第{badSumSeqs.join("・")}回は4人分の合計が0になっていないため保存されませんでした。入力ミスがないか確認してください。
        </p>
      )}
      {tiedSeqs.length > 0 && (
        <p class="warning">
          第{tiedSeqs.join("・")}回はポイントが同点のため、着順・チップは未確定のまま保存しました。
          下のチェックを入れて再度保存すると、入力した順（左の列ほど上位）で仮の着順を確定します。数値を直して同点を解消しても構いません。
        </p>
      )}
      <div style="overflow-x:auto">
        <form method="post" action={`/days/${dayId}/sheet`}>
          <table class="sheet-table" id="sheet-table">
            <thead>
              <tr>
                <th>回</th>
                {participants.map((p) => (
                  <th>{p.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: totalRows }).map((_, i) => {
                const seq = i + 1;
                const session = sessionBySeq.get(seq);
                return (
                  <tr>
                    <td>{seq}</td>
                    {participants.map((p) => {
                      const overrideKey = `${seq}_${p.playerId}`;
                      let value: string;
                      if (overrides?.has(overrideKey)) {
                        value = overrides.get(overrideKey)!;
                      } else {
                        const existing = session
                          ? scoreRows.find((r) => r.gameSessionId === session.id && r.playerId === p.playerId)
                          : undefined;
                        value = existing?.rawScore != null ? String(existing.rawScore) : "";
                      }
                      return (
                        <td>
                          <input type="number" step="0.1" name={`score_${seq}_${p.playerId}`} value={value} />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p>
            <button type="button" id="add-row-btn" class="btn btn-secondary">
              ＋ 行を追加
            </button>
          </p>

          <div class="card" style="background:transparent; border-style:dashed">
            <h2>小計をまとめて入力</h2>
            <p style="font-size:0.85rem; color:var(--ink-soft)">
              半荘ごとの内訳が分からない期間（複数半荘分をまとめた小計しか残っていない場合）はこちら。
              ポイントとチップを両方とも直接入力します（着順の自動計算はしません）。「前半は小計・後半は上の表で半荘ごと」のように混在させても構いません。
            </p>
            {subtotalWarnings.map((w) => (
              <p class="warning">{w}</p>
            ))}
            <div id="subtotal-blocks">
              {Array.from({ length: subtotalBlockCount }).map((_, i) => {
                const idx = i + 1;
                const labelValue = subtotalOverrides?.get(`label_${idx}`) ?? "";
                return (
                  <div class="subtotal-block" data-idx={idx} style="border:1px solid var(--tile-edge); border-radius:10px; padding:10px; margin-bottom:10px">
                    <div class="seat-row">
                      <input
                        type="text"
                        name={`subtotal_label_${idx}`}
                        placeholder="ラベル（任意、例: 前半）"
                        value={labelValue}
                        style="max-width:14em"
                      />
                    </div>
                    {participants.map((p) => {
                      const pointValue = subtotalOverrides?.get(`point_${idx}_${p.playerId}`) ?? "";
                      const chipValue = subtotalOverrides?.get(`chip_${idx}_${p.playerId}`) ?? "";
                      return (
                        <div class="seat-row">
                          <span class="seat-label">{p.name}</span>
                          <input
                            type="number"
                            step="0.1"
                            name={`subtotal_point_${idx}_${p.playerId}`}
                            placeholder="ポイント"
                            value={pointValue}
                          />
                          <input
                            type="number"
                            step="1"
                            name={`subtotal_chip_${idx}_${p.playerId}`}
                            placeholder="チップ"
                            value={chipValue}
                          />
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <p>
              <button type="button" id="add-subtotal-btn" class="btn btn-secondary">
                ＋ 小計ブロックを追加
              </button>
            </p>
          </div>

          {tiedSeqs.length > 0 && (
            <label style="font-weight:normal; display:block; margin-bottom:10px">
              <input type="checkbox" name="acceptTies" value="1" /> 同点の回を入力順で仮に確定する
            </label>
          )}
          <p>
            <button class="btn" type="submit">
              まとめて保存
            </button>
          </p>
        </form>
      </div>
      <p>
        <a href={`/days/${dayId}`}>← 対局日の詳細に戻る</a>
      </p>
      <script
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{
          __html: `
            const sheetTbody = document.querySelector('#sheet-table tbody');

            document.getElementById('add-row-btn').addEventListener('click', () => {
              const rows = sheetTbody.querySelectorAll('tr');
              const lastRow = rows[rows.length - 1];
              const lastSeq = Number(lastRow.firstElementChild.textContent);
              const newSeq = lastSeq + 1;
              const newRow = lastRow.cloneNode(true);
              newRow.firstElementChild.textContent = String(newSeq);
              newRow.querySelectorAll('input[type=number]').forEach((input) => {
                input.value = '';
                input.name = input.name.replace(/^score_\\d+_/, 'score_' + newSeq + '_');
              });
              sheetTbody.appendChild(newRow);
            });

            const subtotalBlocks = document.getElementById('subtotal-blocks');
            document.getElementById('add-subtotal-btn').addEventListener('click', () => {
              const blocks = subtotalBlocks.querySelectorAll('.subtotal-block');
              const lastBlock = blocks[blocks.length - 1];
              const lastIdx = Number(lastBlock.dataset.idx);
              const newIdx = lastIdx + 1;
              const newBlock = lastBlock.cloneNode(true);
              newBlock.dataset.idx = String(newIdx);
              newBlock.querySelectorAll('input').forEach((input) => {
                input.value = '';
                input.name = input.name.replace(/^(subtotal_(?:label|point|chip)_)\\d+/, '$1' + newIdx);
              });
              subtotalBlocks.appendChild(newBlock);
            });

            // 数字入力欄では上下キーで値が増減してしまうデフォルト挙動を止め、
            // 上下左右キーでセル（隣の入力欄）へ移動するようにする（表計算ソフトの操作感に寄せる）。
            sheetTbody.addEventListener('keydown', (e) => {
              if (e.target.tagName !== 'INPUT') return;
              if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
              e.preventDefault();

              const td = e.target.closest('td');
              const tr = td.closest('tr');
              const rows = Array.from(sheetTbody.querySelectorAll('tr'));
              const cells = Array.from(tr.querySelectorAll('td'));
              let rowIndex = rows.indexOf(tr);
              let colIndex = cells.indexOf(td);

              if (e.key === 'ArrowUp') rowIndex -= 1;
              if (e.key === 'ArrowDown') rowIndex += 1;
              if (e.key === 'ArrowLeft') colIndex -= 1;
              if (e.key === 'ArrowRight') colIndex += 1;

              const targetRow = rows[rowIndex];
              if (!targetRow) return;
              const targetCell = targetRow.querySelectorAll('td')[colIndex];
              const targetInput = targetCell && targetCell.querySelector('input[type=number]');
              if (targetInput) targetInput.focus();
            });
          `,
        }}
      />
    </Layout>,
  );
}

dayRoutes.get("/days/:id/sheet", requireAdmin, async (c) => {
  const dayId = Number(c.req.param("id"));
  return renderSheetPage(c, dayId);
});

dayRoutes.post("/days/:id/sheet", requireAdmin, async (c) => {
  const dayId = Number(c.req.param("id"));
  const db = getDb(c.env);

  const participants = await db
    .select({ playerId: dayParticipants.playerId })
    .from(dayParticipants)
    .where(eq(dayParticipants.dayId, dayId))
    .orderBy(dayParticipants.id);
  const participantIds = participants.map((p) => p.playerId);

  const existingSessions = await db
    .select()
    .from(gameSessions)
    .where(eq(gameSessions.dayId, dayId))
    .orderBy(asc(gameSessions.seq));
  const sessionBySeq = new Map(existingSessions.map((s) => [s.seq, s]));

  // 小計ブロックとして既に登録済みのセッションは、通常の半荘行の処理（4人固定・自動着順計算）を
  // 一切適用してはいけない（人数が4人と限らず、チップも手入力値をそのまま使うため）。
  // 「rank===null かつ rankChip!==null」の組み合わせが小計ブロックの目印。
  const existingSessionIds = existingSessions.map((s) => s.id);
  const existingScores = existingSessionIds.length
    ? await db.select().from(sessionScores).where(inArray(sessionScores.gameSessionId, existingSessionIds))
    : [];
  const subtotalSessionIds = new Set(
    existingSessions
      .filter((s) => {
        const rows = existingScores.filter((r) => r.gameSessionId === s.id);
        return rows.length > 0 && rows.every((r) => r.rank == null) && rows.some((r) => r.rankChip != null);
      })
      .map((s) => s.id),
  );
  // 小計ブロックの新規追加分は、表示用の空行(SHEET_EXTRA_BLANK_ROWS)を含まない
  // 「実際に登録済みの最後の回」の直後に採番する（末尾の空行の後ろに付けてしまうと、
  // 空行がどんどん後ろへ伸び続けてしまうため）。通常行の処理中にも更新する。
  let highestRealSeq = existingSessions.reduce((m, s) => Math.max(m, s.seq), 0);

  const body = await c.req.parseBody();
  const acceptTies = body.acceptTies === "1";

  // クライアント側の「＋行を追加」で行が増えている場合があるため、送信されたフィールドから最大回数を求める。
  let maxSeq = existingSessions.length + SHEET_EXTRA_BLANK_ROWS;
  for (const key of Object.keys(body)) {
    const m = key.match(/^score_(\d+)_\d+$/);
    if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
  }

  // 合計不一致・入力不足などで保存されなかった行も含め、送信された入力値をそのまま
  // 再表示できるように保持しておく（保存の成否に関わらず今回の入力値を優先表示する）。
  const submittedOverrides = new Map<string, string>();
  for (const playerId of participantIds) {
    for (let seq = 1; seq <= maxSeq; seq++) {
      const key = `score_${seq}_${playerId}`;
      const raw = body[key];
      if (typeof raw === "string") submittedOverrides.set(`${seq}_${playerId}`, raw);
    }
  }

  const partialSeqs: number[] = [];
  const tiedSeqs: number[] = [];
  const badSumSeqs: number[] = [];

  for (let seq = 1; seq <= maxSeq; seq++) {
    const existingSessionForSeq = sessionBySeq.get(seq);
    if (existingSessionForSeq && subtotalSessionIds.has(existingSessionForSeq.id)) {
      // 小計ブロックの行はまとめて入力の表にも数値がプリフィルされて表示されるが、
      // ここで通常の半荘行として再処理（4人固定・自動着順計算）してしまうと、
      // 5人以上の小計が「4人分そろっていない」エラー扱いになったり、手入力した
      // チップ値が自動計算で上書きされたりする。既存の小計ブロックはここでは一切触らない。
      highestRealSeq = Math.max(highestRealSeq, seq);
      continue;
    }

    const entries: { playerId: number; rawScore: number }[] = [];
    for (const playerId of participantIds) {
      const raw = body[`score_${seq}_${playerId}`];
      if (raw === undefined || raw === "") continue;
      const n = Number(raw);
      if (Number.isFinite(n)) entries.push({ playerId, rawScore: n });
    }

    if (entries.length === 0) continue; // 未入力の行はスキップ

    if (entries.length !== 4) {
      partialSeqs.push(seq);
      continue;
    }

    // 4人分のポイント（配給原点からの差分）は必ず合計0になるはず。ずれていたら入力ミスとして保存しない。
    if (Math.abs(sumScores(entries)) > 0.05) {
      badSumSeqs.push(seq);
      continue;
    }

    const { ranked, hasTie } = computeRankAndChips(entries);
    const existingSession = sessionBySeq.get(seq);

    if (hasTie && !acceptTies) {
      tiedSeqs.push(seq);
      highestRealSeq = Math.max(highestRealSeq, seq);
      // 着順・チップは確定しないが、入力値は失わないよう pending として保存しておく
      let session = existingSession;
      if (!session) {
        const [inserted] = await db
          .insert(gameSessions)
          .values({ dayId, seq, status: "pending", displayMode: "raw" })
          .returning();
        session = inserted;
      }
      if (!session) continue;
      await db.delete(sessionScores).where(eq(sessionScores.gameSessionId, session.id));
      await db.insert(sessionScores).values(
        entries.map((e, seatIndex) => ({
          gameSessionId: session!.id,
          seatIndex,
          playerId: e.playerId,
          rawScore: e.rawScore,
          isHakoware: e.rawScore <= HAKOWARE_AUTO_THRESHOLD,
        })),
      );
      continue;
    }

    highestRealSeq = Math.max(highestRealSeq, seq);

    let session = existingSession;
    if (!session) {
      const [inserted] = await db
        .insert(gameSessions)
        .values({ dayId, seq, status: "confirmed", displayMode: "raw", playedAt: new Date().toISOString() })
        .returning();
      session = inserted;
    } else {
      await db
        .update(gameSessions)
        .set({ status: "confirmed", playedAt: session.playedAt ?? new Date().toISOString() })
        .where(eq(gameSessions.id, session.id));
    }

    if (!session) continue;

    // 列（プレイヤー）の並び順をそのまま座席順として保存し直す
    await db.delete(sessionScores).where(eq(sessionScores.gameSessionId, session.id));
    await db.insert(sessionScores).values(
      ranked.map((r, seatIndex) => ({
        gameSessionId: session!.id,
        seatIndex,
        playerId: r.playerId,
        rawScore: r.rawScore,
        rank: r.rank,
        rankChip: r.rankChip,
        isHakoware: r.rawScore <= HAKOWARE_AUTO_THRESHOLD,
      })),
    );
  }

  // ---------- 小計ブロック（半荘ごとの内訳が分からない期間のポイント・チップを直接入力する） ----------
  // 通常行と違い着順・チップは自動計算せず、入力されたチップ値をそのまま rankChip に保存する
  // （rankは常にnull。「rank===null かつ rankChip!==null」がこの小計ブロックの目印になる）。
  // seqは「実際に登録済みの最後の回」(highestRealSeq)の直後に採番する（末尾の空行8つの
  // 後ろに付けてしまうと、次回以降の表示でその分だけ空行が伸び続けてしまうため）。
  let maxBlockIdx = 0;
  for (const key of Object.keys(body)) {
    const m = key.match(/^subtotal_(?:label|point|chip)_(\d+)/);
    if (m) maxBlockIdx = Math.max(maxBlockIdx, Number(m[1]));
  }
  maxBlockIdx = Math.max(maxBlockIdx, 1);

  const subtotalOverrides = new Map<string, string>();
  const subtotalWarnings: string[] = [];
  let nextSeq = highestRealSeq + 1;

  for (let idx = 1; idx <= maxBlockIdx; idx++) {
    const labelRaw = body[`subtotal_label_${idx}`];
    const label = typeof labelRaw === "string" ? labelRaw.trim() : "";
    if (typeof labelRaw === "string") subtotalOverrides.set(`label_${idx}`, labelRaw);

    const pointEntries: { playerId: number; rawScore: number }[] = [];
    const chipEntries: { playerId: number; rawScore: number }[] = [];
    let incomplete = false;
    let anyInput = label.length > 0;

    for (const playerId of participantIds) {
      const rawPoint = body[`subtotal_point_${idx}_${playerId}`];
      const rawChip = body[`subtotal_chip_${idx}_${playerId}`];
      if (typeof rawPoint === "string") subtotalOverrides.set(`point_${idx}_${playerId}`, rawPoint);
      if (typeof rawChip === "string") subtotalOverrides.set(`chip_${idx}_${playerId}`, rawChip);

      const hasPoint = typeof rawPoint === "string" && rawPoint !== "";
      const hasChip = typeof rawChip === "string" && rawChip !== "";
      if (!hasPoint && !hasChip) continue;
      anyInput = true;

      const p = hasPoint ? Number(rawPoint) : NaN;
      const ch = hasChip ? Number(rawChip) : NaN;
      if (hasPoint && hasChip && Number.isFinite(p) && Number.isFinite(ch)) {
        pointEntries.push({ playerId, rawScore: p });
        chipEntries.push({ playerId, rawScore: ch });
      } else {
        incomplete = true;
      }
    }

    if (!anyInput) continue; // 未使用のブロックはスキップ

    const blockName = label || `${idx}番目の小計ブロック`;

    // 小計ブロックは半荘ごとの座席（常に4人）とは違い、その期間に実際に参加した人数分
    // （日の参加者のうち何人でも）を対象にできる。入力した人は全員ポイント・チップの
    // 両方が必要（片方だけの入力を防ぐ）だが、人数そのものは4人固定にしない。
    if (incomplete) {
      subtotalWarnings.push(
        `「${blockName}」はポイント・チップの片方だけ入力された参加者がいるため保存されませんでした。両方とも入力してください。`,
      );
      continue;
    }

    if (Math.abs(sumScores(pointEntries)) > 0.05) {
      subtotalWarnings.push(`「${blockName}」はポイント合計が0になっていないため保存されませんでした。`);
      continue;
    }
    if (Math.abs(sumScores(chipEntries)) > 0.5) {
      subtotalWarnings.push(`「${blockName}」はチップ合計が0になっていないため保存されませんでした。`);
      continue;
    }

    const seq = nextSeq++;
    const [session] = await db
      .insert(gameSessions)
      .values({
        dayId,
        seq,
        status: "confirmed",
        displayMode: "raw",
        playedAt: new Date().toISOString(),
        memo: label || null,
      })
      .returning();
    if (!session) continue;

    await db.insert(sessionScores).values(
      pointEntries.map((pe, seatIndex) => ({
        gameSessionId: session.id,
        seatIndex,
        playerId: pe.playerId,
        rawScore: pe.rawScore,
        rank: null,
        rankChip: chipEntries.find((ce) => ce.playerId === pe.playerId)!.rawScore,
        isHakoware: pe.rawScore <= HAKOWARE_AUTO_THRESHOLD,
      })),
    );

    // 保存できたブロックは入力欄をクリアして再表示する
    subtotalOverrides.delete(`label_${idx}`);
    for (const playerId of participantIds) {
      subtotalOverrides.delete(`point_${idx}_${playerId}`);
      subtotalOverrides.delete(`chip_${idx}_${playerId}`);
    }
  }

  // 全行・全ブロックが成功した場合のみリダイレクト（二重送信防止のPost-Redirect-Getパターン）。
  // 1つでも保存されなかったものがあれば、リダイレクトせずこの場で描画し、
  // 送信された入力値をそのまま表示して入力し直しやすくする。
  if (
    partialSeqs.length === 0 &&
    tiedSeqs.length === 0 &&
    badSumSeqs.length === 0 &&
    subtotalWarnings.length === 0
  ) {
    return c.redirect(`/days/${dayId}/sheet`);
  }

  return renderSheetPage(c, dayId, {
    overrides: submittedOverrides,
    totalRows: maxSeq,
    partialSeqs,
    tiedSeqs,
    badSumSeqs,
    subtotalOverrides,
    subtotalBlockCount: maxBlockIdx,
    subtotalWarnings,
  });
});
