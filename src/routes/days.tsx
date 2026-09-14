import { Hono } from "hono";
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
import { computeRankAndChips, normalizeRawScore, sumScores, ORIGIN_SCORE, type DisplayMode } from "../lib/scoring";
import { computeDaySummary } from "../lib/aggregate";

export const dayRoutes = new Hono<{ Bindings: Env }>();

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
      winnerName: players.name,
    })
    .from(yakumanEvents)
    .innerJoin(players, eq(yakumanEvents.winnerPlayerId, players.id))
    .where(eq(yakumanEvents.dayId, dayId));

  const eventIds = events.map((e) => e.id);
  const allTargets = eventIds.length
    ? await db
        .select({ yakumanEventId: yakumanEventTargets.yakumanEventId, name: players.name })
        .from(yakumanEventTargets)
        .innerJoin(players, eq(yakumanEventTargets.playerId, players.id))
        .where(inArray(yakumanEventTargets.yakumanEventId, eventIds))
    : [];

  const daySummary = await computeDaySummary(db, dayId);

  return { day, participants, sessions, allScores, allHands, events, allTargets, daySummary };
}

type DayDetail = NonNullable<Awaited<ReturnType<typeof loadDayDetail>>>;

const DayDetailBody = ({ dayId, admin, data }: { dayId: number; admin: boolean; data: DayDetail }) => {
  const { day, participants, sessions, allScores, allHands, events, allTargets, daySummary } = data;

  return (
    <>
      <p>
        参加者: {participants.map((p) => p.name).join(" / ")}{" "}
        <span class={`badge ${day.status === "open" ? "badge-open" : "badge-closed"}`}>
          {day.status === "open" ? "対局中" : "終了"}
        </span>
      </p>
      {admin && (
        <p>
          <a href={`/days/${dayId}/edit`}>この対局日を編集する</a>
          {day.status === "open" && (
            <>
              {" / "}
              <form class="inline-form" method="post" action="/days/close">
                <button class="link-button" type="submit">
                  この対局日を終了する
                </button>
              </form>
            </>
          )}
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
        return (
          <div class="card">
            <h3>
              第{s.seq}半荘{" "}
              <span class={`badge ${s.status === "confirmed" ? "badge-confirmed" : "badge-pending"}`}>
                {s.status === "confirmed" ? "確定済み" : "撮影待ち"}
              </span>
            </h3>
            <table>
              <thead>
                <tr>
                  <th>プレイヤー</th>
                  <th>ポイント</th>
                  <th>着順</th>
                  <th>チップ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr>
                    <td>
                      {r.name}
                      {r.isHakoware ? " (箱割れ)" : ""}
                    </td>
                    <td>{r.rawScore ?? "-"}</td>
                    <td>{r.rank ?? "-"}</td>
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
                      {h.roundLabel ? `${h.roundLabel}: ` : ""}
                      {h.winType === "draw"
                        ? "流局"
                        : `${rows.find((r) => r.playerId === h.winnerPlayerId)?.name ?? "?"} が${
                            h.winType === "tsumo"
                              ? "ツモ"
                              : `${rows.find((r) => r.playerId === h.loserPlayerId)?.name ?? "?"}から ロン`
                          }`}
                      {h.yakuText ? `（${h.yakuText}）` : ""}
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
                {s.status === "pending" ? (
                  <a class="btn" href={`/days/${dayId}/sessions/${s.id}/capture`}>
                    点数表示機を撮影する
                  </a>
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

            {admin && (
              <details>
                <summary>局メモを追加</summary>
                <form class="stack" method="post" action={`/days/${dayId}/sessions/${s.id}/hands`}>
                  <label>種別</label>
                  <select name="winType">
                    <option value="ron">ロン</option>
                    <option value="tsumo">ツモ</option>
                    <option value="draw">流局</option>
                  </select>
                  <label>和了者（流局時は不要）</label>
                  <select name="winnerPlayerId">
                    <option value="">-</option>
                    {participants.map((p) => (
                      <option value={p.playerId}>{p.name}</option>
                    ))}
                  </select>
                  <label>放銃者（ロンの時のみ）</label>
                  <select name="loserPlayerId">
                    <option value="">-</option>
                    {participants.map((p) => (
                      <option value={p.playerId}>{p.name}</option>
                    ))}
                  </select>
                  <label>局（任意、例: 東1局）</label>
                  <input type="text" name="roundLabel" />
                  <label>役・メモ</label>
                  <input type="text" name="yakuText" />
                  <button class="btn" type="submit">
                    追加
                  </button>
                </form>
              </details>
            )}
          </div>
        );
      })}

      {admin && (
        <p style="display:flex; gap:10px; flex-wrap:wrap">
          <a class="btn" href={`/days/${dayId}/sessions/new`}>
            次の半荘を登録
          </a>
          <a class="btn btn-secondary" href={`/days/${dayId}/sheet`}>
            まとめて入力する
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
      <Layout title="直近の成績" isAdmin={admin}>
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
    <Layout title="直近の成績" isAdmin={admin}>
      <TabBar active="today" />
      <h1>
        直近の成績{" "}
        <small style="font-size:0.6em; color:var(--ink-soft)">
          （{data.day.date}
          {data.day.memo ? ` ${data.day.memo}` : ""}）
        </small>
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
    <Layout title="対局日を開始・登録" isAdmin={true}>
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

  const data = await loadDayDetail(db, dayId);
  if (!data) return c.notFound();

  const year = Number(data.day.date.slice(0, 4));

  return c.html(
    <Layout title={`${data.day.date} の対局`} isAdmin={admin}>
      <p>
        <a href={`/years/${year}`}>← {year}年の一覧に戻る</a>
      </p>
      <h1>
        {data.day.date} {data.day.memo ? `(${data.day.memo})` : ""}
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

  const existingSessions = await db.select().from(gameSessions).where(eq(gameSessions.dayId, dayId));
  const nextSeq = existingSessions.length + 1;
  const lastMode: DisplayMode =
    (existingSessions[existingSessions.length - 1]?.displayMode as DisplayMode | undefined) ?? "raw";

  return c.html(
    <Layout title="半荘を登録" isAdmin={true}>
      <h1>第{nextSeq}半荘: 座席を登録</h1>
      <p>管理者から見た座席順（点数表示機に数字が並ぶ順序）でプレイヤーを選んでください。</p>
      <div class="card">
        <form class="stack" method="post" action={`/days/${dayId}/sessions`}>
          {[0, 1, 2, 3].map((seat) => (
            <div class="seat-row">
              <span class="seat-label">座席{seat + 1}</span>
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

          <label>表示形式</label>
          <label style="font-weight:normal">
            <input type="radio" name="displayMode" value="raw" checked={lastMode === "raw"} /> 素点をそのまま表示
          </label>
          <label style="font-weight:normal">
            <input type="radio" name="displayMode" value="diff" checked={lastMode === "diff"} /> 配給原点(
            {ORIGIN_SCORE})からの±差分表示
          </label>

          <button class="btn" type="submit">
            登録して撮影へ
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

  const displayMode = (body.displayMode === "diff" ? "diff" : "raw") as DisplayMode;
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

  return c.redirect(`/days/${dayId}/sessions/${session?.id}/capture`);
});

// ---------- 撮影 ----------

dayRoutes.get("/days/:id/sessions/:sid/capture", requireAdmin, async (c) => {
  const dayId = Number(c.req.param("id"));
  const sessionId = Number(c.req.param("sid"));
  const admin = true;

  return c.html(
    <Layout title="点数表示機を撮影" isAdmin={admin}>
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

  const rows = await db
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
    .orderBy(asc(sessionScores.seatIndex));

  const dayParticipantOptions = await db
    .select({ playerId: players.id, name: players.name })
    .from(dayParticipants)
    .innerJoin(players, eq(dayParticipants.playerId, players.id))
    .where(eq(dayParticipants.dayId, dayId));

  const [latestPhoto] = await db
    .select()
    .from(photoUploads)
    .where(eq(photoUploads.gameSessionId, sessionId))
    .orderBy(desc(photoUploads.id))
    .limit(1);

  let ocrValues: (number | null)[] = [null, null, null, null];
  if (latestPhoto?.ocrRawJson) {
    try {
      ocrValues = JSON.parse(latestPhoto.ocrRawJson).values ?? ocrValues;
    } catch {
      // ignore parse errors, keep nulls
    }
  }

  const displayMode = session.displayMode as DisplayMode;
  const tieWarning = c.req.query("tie") === "1";
  const badSumWarning = c.req.query("badsum") === "1";

  return c.html(
    <Layout title="点数を確認" isAdmin={true}>
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
        {displayMode === "diff" ? `配給原点(${ORIGIN_SCORE}ポイント)からの±差分` : "素点をそのまま表示"}
        （入力欄には配給原点からの増減が自動計算されて入ります。4人の合計は必ず0になります）
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
                <span class="seat-label">座席{r.seatIndex + 1}</span>
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
  const body = await c.req.parseBody();

  const winType = String(body.winType ?? "ron") as "ron" | "tsumo" | "draw";
  const winnerPlayerId = body.winnerPlayerId ? Number(body.winnerPlayerId) : null;
  const loserPlayerId = body.loserPlayerId ? Number(body.loserPlayerId) : null;
  const roundLabel = body.roundLabel ? String(body.roundLabel) : null;
  const yakuText = body.yakuText ? String(body.yakuText) : null;

  await db.insert(handLogs).values({
    gameSessionId: sessionId,
    winType,
    winnerPlayerId: winType === "draw" ? null : winnerPlayerId,
    loserPlayerId: winType === "ron" ? loserPlayerId : null,
    roundLabel,
    yakuText,
  });

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

  const allPlayers = await db.select().from(players).orderBy(players.id);
  const currentParticipants = await db
    .select({ playerId: dayParticipants.playerId })
    .from(dayParticipants)
    .where(eq(dayParticipants.dayId, dayId));
  const currentIds = new Set(currentParticipants.map((p) => p.playerId));

  return c.html(
    <Layout title="対局日を編集" isAdmin={true}>
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

dayRoutes.get("/days/:id/sheet", requireAdmin, async (c) => {
  const dayId = Number(c.req.param("id"));
  const db = getDb(c.env);

  const [day] = await db.select().from(days).where(eq(days.id, dayId));
  if (!day) return c.notFound();

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

  const sessionIds = sessions.map((s) => s.id);
  const scoreRows = sessionIds.length
    ? await db.select().from(sessionScores).where(inArray(sessionScores.gameSessionId, sessionIds))
    : [];

  const totalRows = Math.max(sessions.length, 0) + SHEET_EXTRA_BLANK_ROWS;
  const partialParam = c.req.query("partial");
  const partialSeqs = partialParam ? partialParam.split(",").map(Number) : [];
  const tiedParam = c.req.query("tied");
  const tiedSeqs = tiedParam ? tiedParam.split(",").map(Number) : [];
  const badSumParam = c.req.query("badsum");
  const badSumSeqs = badSumParam ? badSumParam.split(",").map(Number) : [];

  return c.html(
    <Layout title="まとめて入力" isAdmin={true}>
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
                const session = sessions[i];
                return (
                  <tr>
                    <td>{seq}</td>
                    {participants.map((p) => {
                      const existing = session
                        ? scoreRows.find((r) => r.gameSessionId === session.id && r.playerId === p.playerId)
                        : undefined;
                      return (
                        <td>
                          <input
                            type="number"
                            step="0.1"
                            name={`score_${seq}_${p.playerId}`}
                            value={existing?.rawScore != null ? String(existing.rawScore) : ""}
                          />
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

  const body = await c.req.parseBody();
  const acceptTies = body.acceptTies === "1";

  // クライアント側の「＋行を追加」で行が増えている場合があるため、送信されたフィールドから最大回数を求める。
  let maxSeq = existingSessions.length + SHEET_EXTRA_BLANK_ROWS;
  for (const key of Object.keys(body)) {
    const m = key.match(/^score_(\d+)_\d+$/);
    if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
  }

  const partialSeqs: number[] = [];
  const tiedSeqs: number[] = [];
  const badSumSeqs: number[] = [];

  for (let seq = 1; seq <= maxSeq; seq++) {
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
          isHakoware: e.rawScore < -ORIGIN_SCORE,
        })),
      );
      continue;
    }

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
        isHakoware: r.rawScore < -ORIGIN_SCORE,
      })),
    );
  }

  const params = new URLSearchParams();
  if (partialSeqs.length) params.set("partial", partialSeqs.join(","));
  if (tiedSeqs.length) params.set("tied", tiedSeqs.join(","));
  if (badSumSeqs.length) params.set("badsum", badSumSeqs.join(","));
  const query = params.toString() ? `?${params.toString()}` : "";
  return c.redirect(`/days/${dayId}/sheet${query}`);
});
