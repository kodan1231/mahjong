import type { Env } from "../types";

export interface OcrResult {
  values: (number | null)[];
}

const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

const PROMPT = `この画像は麻雀の電子点数表示機です。表示されている数値を、画面に並んでいる順番のまま最大4つ読み取ってください。
マイナスを表す記号（-）やプラスの符号（+）が見えたら、その符号も数値に反映してください（例: -1500, 5200）。
読み取れなかった箇所は null にしてください。
必ず次のJSON形式のみで回答してください。説明文は不要です。
{"values": [数値または null, 数値または null, 数値または null, 数値または null]}`;

/**
 * 点数表示機の写真をWorkers AIのVisionモデルに渡し、表示順のまま数値配列を抽出する。
 * 解析に失敗した場合は values をすべて null にして返す（UI側で手入力させる）。
 */
export async function analyzeScoreDisplay(env: Env, imageBytes: Uint8Array): Promise<OcrResult> {
  try {
    const response = await env.AI.run(VISION_MODEL, {
      prompt: PROMPT,
      image: Array.from(imageBytes),
      max_tokens: 512,
    });

    const text = typeof response === "string" ? response : (response as { response?: string }).response ?? "";
    return parseOcrResponse(text);
  } catch (err) {
    console.error("OCR analysis failed", err);
    return { values: [null, null, null, null] };
  }
}

export function parseOcrResponse(text: string): OcrResult {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { values: [null, null, null, null] };

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { values?: unknown[] };
    if (!Array.isArray(parsed.values)) return { values: [null, null, null, null] };

    const values = parsed.values.slice(0, 4).map((v) => {
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
      return Number.isFinite(n) ? n : null;
    });
    while (values.length < 4) values.push(null);
    return { values };
  } catch {
    return { values: [null, null, null, null] };
  }
}
