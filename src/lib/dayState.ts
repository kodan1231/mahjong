import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { days } from "../db/schema";

/**
 * 現在進行中(open)の対局日のid（無ければnull）。同時にopenな日は1つまでの運用なので高々1件。
 * ナビの「対局日を開始」/「対局日を終了」の出し分けに使う。
 */
export async function getOpenDayId(db: Db): Promise<number | null> {
  const [row] = await db.select({ id: days.id }).from(days).where(eq(days.status, "open"));
  return row?.id ?? null;
}
