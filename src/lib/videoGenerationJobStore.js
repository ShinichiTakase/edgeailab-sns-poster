// Instagram動画の一括生成ジョブをプロセス内メモリで管理する。
// sns-posterはdocker-compose上で単一コンテナ・単一プロセス構成のため、Redis等の外部
// キューは導入せず、この方式で十分（デプロイ・再起動でジョブ状態が失われる点は許容——
// 生成は数分で終わる短命な処理であり、失敗時はユーザーが再度「AI動画生成」を押す想定）。
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { renderVideo } = require("./videoGenerator");
const { generatePostCopyVariations } = require("./postCopyGenerator");
const { fetchUrlText } = require("./urlTextFetcher");

const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");
const VIDEO_RENDER_CONCURRENCY = 2;
const SLOT_COUNT = 10;

const jobs = new Map();

function publicUrlFor(filename) {
  return `https://edgeailab.net/uploads/${filename}`;
}

function createJob() {
  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    status: "running", // running | done | canceled | error
    error: null,
    slots: Array.from({ length: SLOT_COUNT }, (_, index) => ({
      index,
      status: "pending", // pending | rendering | done | canceled | error
      url: null,
      caption: null,
      style: null,
    })),
    abortController: new AbortController(),
  };
  jobs.set(jobId, job);
  return job;
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

function serializeJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    error: job.error,
    slots: job.slots.map(({ index, status, url, caption, style }) => ({ index, status, url, caption, style })),
  };
}

function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (job.status === "running") {
    job.status = "canceled";
    job.abortController.abort();
  }
  return true;
}

async function runWithConcurrency(items, limit, worker) {
  let cursor = 0;
  async function next() {
    const i = cursor++;
    if (i >= items.length) return;
    await worker(items[i], i);
    await next();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
}

/**
 * バックグラウンドで10本の動画生成を進める。呼び出し元は戻り値(job)のidをすぐ
 * クライアントへ返し、GET側はgetJob(jobId)をポーリングする想定。
 */
function startVideoGenerationJob({ sourceText, url }) {
  const job = createJob();
  const { signal } = job.abortController;

  (async () => {
    // URL指定の場合、URL文字列だけをAIプロンプトに渡して「読んだふり」の生成を
    // させないため、ここで必ず実際のページ本文をfetchしてからAI生成に渡す
    // （urlTextFetcher.jsのコメント参照。以前は未fetchのままurlを渡すだけになっており、
    // 動画の内容が記事本文と無関係になる不具合があった）。
    let resolvedSourceText = sourceText;
    if (url) {
      try {
        resolvedSourceText = await fetchUrlText(url);
      } catch (err) {
        if (job.status !== "canceled") {
          job.status = "error";
          job.error = "url_fetch_failed";
        }
        return;
      }
    }

    if (signal.aborted) return;

    let captions;
    try {
      const variations = await generatePostCopyVariations({
        sourceText: resolvedSourceText,
        platforms: ["instagram"],
        url,
        count: SLOT_COUNT,
      });
      captions = variations.instagram;
    } catch (err) {
      if (job.status !== "canceled") {
        job.status = "error";
        job.error = err.message || "caption_generation_failed";
      }
      return;
    }

    if (signal.aborted) return;

    try {
      await runWithConcurrency(job.slots, VIDEO_RENDER_CONCURRENCY, async (slot) => {
        if (signal.aborted) {
          slot.status = "canceled";
          return;
        }
        slot.status = "rendering";
        slot.caption = captions[slot.index];
        const filename = `${crypto.randomUUID()}.mp4`;
        const outPath = path.join(UPLOAD_DIR, filename);
        try {
          const style = await renderVideo({ captionText: slot.caption, outPath, signal });
          if (signal.aborted) {
            slot.status = "canceled";
            return;
          }
          slot.status = "done";
          slot.url = publicUrlFor(filename);
          slot.style = style;
        } catch (err) {
          if (err.name === "AbortError" || signal.aborted) {
            slot.status = "canceled";
            fs.promises.unlink(outPath).catch(() => {});
            return;
          }
          slot.status = "error";
          console.error(`[videoGenerationJobStore] slot ${slot.index} failed:`, err);
        }
      });
    } finally {
      if (job.status === "running") {
        job.status = "done";
      }
    }
  })();

  return job;
}

/** 完了済みの1スロットだけを差し替える（[再作成]ボタン用）。同期的に1本だけレンダリングする。 */
async function regenerateSingleVideo({ caption }) {
  const filename = `${crypto.randomUUID()}.mp4`;
  const outPath = path.join(UPLOAD_DIR, filename);
  const style = await renderVideo({ captionText: caption, outPath });
  return { url: publicUrlFor(filename), style };
}

module.exports = { startVideoGenerationJob, getJob, serializeJob, cancelJob, regenerateSingleVideo, SLOT_COUNT };
