import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { photoUploads } from "../db/schema";
import { requireAdmin } from "../lib/auth";
import { analyzeScoreDisplay } from "../lib/ocr";

export const ocrRoutes = new Hono<{ Bindings: Env }>();

ocrRoutes.post("/api/ocr", requireAdmin, async (c) => {
  const body = await c.req.parseBody();
  const file = body.photo;
  const gameSessionId = body.gameSessionId ? Number(body.gameSessionId) : null;

  if (!(file instanceof File)) {
    return c.json({ error: "写真が見つかりません" }, 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = file.type || "image/jpeg";

  const result = await analyzeScoreDisplay(c.env, bytes);

  const db = getDb(c.env);
  const [inserted] = await db
    .insert(photoUploads)
    .values({
      gameSessionId,
      imageData: bytes,
      contentType,
      ocrRawJson: JSON.stringify(result),
    })
    .returning({ id: photoUploads.id });

  return c.json({ photoUploadId: inserted?.id, values: result.values });
});

// 撮影した元写真を見返すための表示用エンドポイント（管理者専用）。
ocrRoutes.get("/api/photos/:id", requireAdmin, async (c) => {
  const id = Number(c.req.param("id"));
  const db = getDb(c.env);

  const [photo] = await db.select().from(photoUploads).where(eq(photoUploads.id, id));
  if (!photo) return c.notFound();

  return new Response(new Uint8Array(photo.imageData), {
    headers: { "Content-Type": photo.contentType, "Cache-Control": "private, max-age=31536000" },
  });
});
