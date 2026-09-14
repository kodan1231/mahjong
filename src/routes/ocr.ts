import { Hono } from "hono";
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
  const r2Key = `sessions/${gameSessionId ?? "unknown"}/${Date.now()}-${crypto.randomUUID()}.jpg`;
  await c.env.PHOTOS.put(r2Key, bytes, {
    httpMetadata: { contentType: file.type || "image/jpeg" },
  });

  const result = await analyzeScoreDisplay(c.env, bytes);

  const db = getDb(c.env);
  const [inserted] = await db
    .insert(photoUploads)
    .values({
      gameSessionId,
      r2Key,
      ocrRawJson: JSON.stringify(result),
    })
    .returning({ id: photoUploads.id });

  return c.json({ photoUploadId: inserted?.id, values: result.values, r2Key });
});
