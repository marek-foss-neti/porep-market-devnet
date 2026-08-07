import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ScenarioContext } from "../runtime.js";
import { envNumber, envValue } from "../runtime.js";

export type RetrievalMode = "cold" | "hot";

export type HttpRetrievalResult = {
  mode: RetrievalMode;
  url: string;
  status: number;
  contentType: string;
  etag: string;
  bytes: number;
  ttfbMs: number;
  totalMs: number;
  throughputBytesPerSecond: number;
  sha256: string;
  outputPath: string;
};

export async function retrievePieceByHttp(
  context: ScenarioContext,
  pieceCid: string,
  mode: RetrievalMode,
): Promise<HttpRetrievalResult> {
  const baseUrl = envValue(context, "CURIO_RETRIEVAL_BASE_URL", "http://127.0.0.1:22310")
    .replace(/\/+$/g, "");
  const timeoutMs = envNumber(context, "CURIO_RETRIEVAL_TIMEOUT_MS", 2 * 60 * 60_000);
  const url = `${baseUrl}/piece/${encodeURIComponent(pieceCid)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();

  try {
    const response = await fetch(url, { signal: controller.signal });
    const ttfbMs = performance.now() - started;
    const body = Buffer.from(await response.arrayBuffer());
    const totalMs = performance.now() - started;
    const outputPath = join(context.runDir, `retrieved-${mode}.car`);
    writeFileSync(outputPath, body);

    if (!response.ok) {
      const diagnostic = body.toString("utf8", 0, Math.min(body.length, 1_000));
      throw new Error(
        `Curio retrieval ${url} failed with HTTP ${response.status}${diagnostic ? `: ${diagnostic}` : ""}`,
      );
    }

    return {
      mode,
      url,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      etag: response.headers.get("etag") ?? "",
      bytes: body.length,
      ttfbMs,
      totalMs,
      throughputBytesPerSecond: totalMs <= 0 ? 0 : body.length / (totalMs / 1_000),
      sha256: createHash("sha256").update(body).digest("hex"),
      outputPath,
    };
  } finally {
    clearTimeout(timeout);
  }
}
