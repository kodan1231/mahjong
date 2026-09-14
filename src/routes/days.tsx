import { Hono } from "hono";
import { eq, and, desc, asc, inArray } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  players,
  days,
  dayParticipants,
  gameSessions,
  sessionScores,
  yakumanEvents,
  handLogs,
  photoUploads,
} from "../db/schema";
import { Layout } from "../views/layout";
import { requireAdmin, isAdmin } from "../lib/auth";
import { computeRankAndChips, normalizeRawScore, ORIGIN_SCORE, type DisplayMode } from "../lib/scoring";
import { computeTotals, computeDaySummary, yearRange } from "../lib/aggregate";

export const dayRoutes = new Hono<{ Bindings: Env }>();

const Signed = ({ n, unit = "" }: { n: number; unit?: string }) => (
  <span class={n >= 0 ? "plus" : "minus"}>
    {n >= 0 ? "+" : ""}
    {n}
    {unit}
  </span>
);

// ---------- ダッシュボード ----------

dayRoutes.get("/", async (c) => {
  const db = getDb(c.env);
  const admin = await isAdmin(c);
  const year = new Date().getFullYear();

  const [yearTotals, overallTotals, recentDays] = await Promise.all([
    computeTotals(db, yearRange(year)),
    computeTotals(db),
    db.select().from(days).orderBy(desc(days.date)).limit(10),
  ]);

  return c.html(
    <Layout title="ホーム" isAdmin={admin}>
      <h1>麻雀スコア集計</h1>

      <div class="card">
        <h2 style="margin-top:0">{year}年 合計</h2>
        <TotalsTable totals={yearTotals} />
        <p>
          <a href={`/stats/${year}`}>年間集計ページを見る →</a>
        </p>
      </div>

      <div class="card">
        <h2 style="margin-top:0">通算合計</h2>
        <TotalsTable totals={overallTotals} />
      </div>

      <div class="card">
        <h2 style="margin-top:0">直近の対局日</h2>
        {recentDays.length === 0 && <p>まだ対局日がありません。</p>}
        <ul>
          {recentDays.map((d) => (
            <li>
              <a href={`/days/${d.id}`}>
                {d.date} {d.memo ? `(${d.memo})` : ""}
              </a>
            </li>
          ))}
        </ul>
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
});

const TotalsTable = ({ totals }: { totals: { name: string; rawTotal: number; chipTotal: number }[] }) => (
  <table>
    <thead>
      <tr>
        <th>プレイヤー</th>
        <th>素点合計</th>
        <th>チップ合計</th>
      </tr>
    </thead>
    <tbody>
      {totals.map((t) => (
        <tr>
          <td>{t.name}</td>
          <td>
            <Signed n={t.rawTotal} />
          </td>
          <td>
            <Signed n={t.chipTotal} />
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

// ---------- 対局日 ----------

dayRoutes.get("/days/new", requireAdmin, async (c) => {
  const db = getDb(c.env);
  const activePlayers = await db.select().from(players).where(eq(players.active, true));
  const today = new Date().toISOString().slice(0, 10);

  return c.html(
    <Layout title="対局日を開始" isAdmin={true}>
      <h1>対局日を開始</h1>
      <form class="stack" method="post" action="/days">
        <label for="date">日付</label>
        <input type="text" id="date" name="date" value={today} required />

        <label for="memo">メモ（任意）</label>
        <input type="text" id="memo" name="memo" />

        <label>今日の参加者</label>
        {activePlayers.map((p) => (
          <label style="font-weight:normal">
            <input type="checkbox" name="playerIds" value={p.id} /> {p.name}
          </label>
        ))}

        <button class="btn" type="submit">
          開始する
        </button>
      </form>
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

  const [day] = await db.insert(days).values({ date, memo }).returning({ id: days.id });
  if (day) {
    await db.insert(dayParticipants).values(playerIds.map((playerId) => ({ dayId: day.id, playerId })));
  }

  return c.redirect(`/days/${day?.id}`);
});

dayRoutes.get("/days/:id", async (c) => {
  const dayId = Number(c.req.param("id"));
  const db = getDb(c.env);
  const admin = await isAdmin(c);

  const [day] = await db.select().from(days).where(eq(days.id, dayId));
  if (!day) return c.notFound();

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

  const daySummary = await computeDaySummary(db, dayId);

  return c.html(
    <Layout title={`${day.date} の対局`} isAdmin={admin}>
      <h1>
        {day.date} {day.memo ? `(${day.memo})` : ""}
      </h1>
      <p>参加者: {participants.map((p) => p.name).join(" / ")}</p>
      {admin && (
        <p>
          <a href={`/days/${dayId}/edit`}>この対局日を編集する →</a>
        </p>
      )}

      <div class="card">
        <h2 style="margin-top:0">この日の小計</h2>
        <TotalsTable totals={daySummary} />
      </div>

      <h2>半荘一覧</h2>
      {sessions.length === 0 && <p>まだ半荘がありません。</p>}
      {sessions.map((s) => {
        const rows = allScores
          .filter((r) => r.gameSessionId === s.id)
          .sort((a, b) => a.seatIndex - b.seatIndex);
        const hands = allHands.filter((h) => h.gameSessionId === s.id);
        return (
          <div class="card">
            <h3 style="margin-top:0">
              第{s.seq}半荘{" "}
              <span class={`badge ${s.status === "confirmed" ? "badge-confirmed" : "badge-pending"}`}>
                {s.status === "confirmed" ? "確定済み" : "撮影待ち"}
              </span>
            </h3>
            <table>
              <thead>
                <tr>
                  <th>プレイヤー</th>
                  <th>素点</th>
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
                  <button class="link-button" type="submit" style="color:#b91c1c">
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
        <p>
          <a class="btn" href={`/days/${dayId}/sessions/new`}>
            次の半荘を登録
          </a>
        </p>
      )}

      <h2>役満</h2>
      {events.length === 0 && <p>まだ役満はありません。</p>}
      <ul>
        {events.map((e) => (
          <li>
            {e.winnerName} - {e.yakuName}（他全員 -{e.chipPerLoser}）
            {admin && (
              <form class="inline-form" method="post" action={`/days/${dayId}/yakuman/${e.id}/delete`}>
                <button class="link-button" type="submit">
                  [削除]
                </button>
              </form>
            )}
          </li>
        ))}
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
            <button class="btn" type="submit">
              登録
            </button>
          </form>
        </details>
      )}
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
      <form class="stack" method="post" action={`/days/${dayId}/sessions`}>
        {[0, 1, 2, 3].map((seat) => (
          <div class="seat-row">
            <span class="seat-label">座席{seat + 1}</span>
            <select name={`seat${seat}`} required>
              {participants.map((p) => (
                <option value={p.playerId}>{p.name}</option>
              ))}
            </select>
          </div>
        ))}

        <label>表示形式</label>
        <label style="font-weight:normal">
          <input type="radio" name="displayMode" value="raw" checked={lastMode === "raw"} /> 素点をそのまま表示
        </label>
        <label style="font-weight:normal">
          <input type="radio" name="displayMode" value="diff" checked={lastMode === "diff"} /> 配給原点({ORIGIN_SCORE}
          )からの±差分表示
        </label>

        <button class="btn" type="submit">
          登録して撮影へ
        </button>
      </form>
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

  return c.html(
    <Layout title="点数を確認" isAdmin={true}>
      <h1>第{session.seq}半荘: 点数を確認</h1>
      {tieWarning && <p class="warning">同点です。順位を確認してください（素点を調整するか、そのまま確定できます）。</p>}
      <p>
        表示形式:{" "}
        {displayMode === "diff" ? `配給原点(${ORIGIN_SCORE})からの±差分` : "素点そのまま"}
      </p>
      <form class="stack" method="post" action={`/days/${dayId}/sessions/${sessionId}/confirm`}>
        {rows.map((r) => {
          const ocrRaw = ocrValues[r.seatIndex];
          const prefill =
            r.rawScore ?? (ocrRaw != null ? normalizeRawScore(ocrRaw, displayMode) : "");
          return (
            <div class="seat-row">
              <span class="seat-label">座席{r.seatIndex + 1}</span>
              <select name={`player_${r.seatIndex}`}>
                {dayParticipantOptions.map((p) => (
                  <option value={p.playerId} selected={p.playerId === r.playerId}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input type="number" name={`score_${r.seatIndex}`} value={String(prefill)} required />
              <label style="font-weight:normal">
                <input type="checkbox" name={`hakoware_${r.seatIndex}`} checked={r.isHakoware} /> 箱割れ
              </label>
            </div>
          );
        })}
        <button class="btn" type="submit">
          確定
        </button>
      </form>
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
  }));

  const { ranked, hasTie } = computeRankAndChips(
    seatInputs.map(({ playerId, rawScore }) => ({ playerId, rawScore })),
  );

  if (hasTie) {
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
  const body = await c.req.parseBody();

  const winnerPlayerId = Number(body.winnerPlayerId);
  const yakuName = String(body.yakuName ?? "").trim();

  if (winnerPlayerId && yakuName) {
    await db.insert(yakumanEvents).values({ dayId, winnerPlayerId, yakuName });
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
      <form class="stack" method="post" action={`/days/${dayId}/edit`}>
        <label for="date">日付</label>
        <input type="text" id="date" name="date" value={day.date} required />

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
    </Layout>,
  );
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
