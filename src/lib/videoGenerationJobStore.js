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
const { classifyFetchError, classifyGenerationError } = require("./generationErrors");
const { getDocsNumber } = require("./generationConfig");

const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");
const VIDEO_RENDER_CONCURRENCY = 2;
const PUBLIC_UPLOAD_PREFIX = "https://edgeailab.net/uploads/";

const jobs = new Map();

function publicUrlFor(filename) {
  return `${PUBLIC_UPLOAD_PREFIX}${filename}`;
}

// 背景画像アップロード（POST /api/uploads/image、既存の画像アップロード用エンドポイントを
// 流用）は公開URLを返すが、動画レンダリングは同じコンテナ内で直接ファイルシステムに
// アクセスできるため、URLをそのままlocalに解決してネットワーク往復を避ける。UPLOAD_DIR
// 配下のファイル名以外（パストラバーサル・他ホストのURL等）は無視してAI自動生成にフォールバックする。
function resolveBackgroundImagePath(backgroundImageUrl) {
  if (typeof backgroundImageUrl !== "string" || !backgroundImageUrl.startsWith(PUBLIC_UPLOAD_PREFIX)) {
    return null;
  }
  const filename = backgroundImageUrl.slice(PUBLIC_UPLOAD_PREFIX.length);
  if (!filename || filename.includes("/") || filename.includes("..")) {
    return null;
  }
  return path.join(UPLOAD_DIR, filename);
}

function createJob() {
  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    status: "running", // running | done | canceled | error
    error: null,
    slots: Array.from({ length: getDocsNumber() }, (_, index) => ({
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
function startVideoGenerationJob({ sourceText, url, backgroundImageUrl }) {
  const job = createJob();
  const { signal } = job.abortController;
  const backgroundImagePath = resolveBackgroundImagePath(backgroundImageUrl);

  // 体感速度の遅さの原因切り分け調査用（2026-08-20）。ジョブ全体の各フェーズの所要時間を記録する。
  const __jobT0 = Date.now();

  (async () => {
    // URL指定の場合、URL文字列だけをAIプロンプトに渡して「読んだふり」の生成を
    // させないため、ここで必ず実際のページ本文をfetchしてからAI生成に渡す
    // （urlTextFetcher.jsのコメント参照。以前は未fetchのままurlを渡すだけになっており、
    // 動画の内容が記事本文と無関係になる不具合があった）。
    let resolvedSourceText = sourceText;
    if (url) {
      const __fetchT0 = Date.now();
      try {
        resolvedSourceText = await fetchUrlText(url);
      } catch (err) {
        console.log(`[timing] videoGenerationJobStore fetch FAILED afterMs=${Date.now() - __fetchT0}`);
        if (job.status !== "canceled") {
          job.status = "error";
          job.error = classifyFetchError(err).code;
        }
        return;
      }
      console.log(`[timing] videoGenerationJobStore fetch durationMs=${Date.now() - __fetchT0}`);
    }

    if (signal.aborted) return;

    let captions;
    const __captionT0 = Date.now();
    try {
      const variations = await generatePostCopyVariations({
        sourceText: resolvedSourceText,
        platforms: ["instagram"],
        url,
        count: getDocsNumber(),
      });
      captions = variations.instagram;
    } catch (err) {
      console.log(`[timing] videoGenerationJobStore caption-gen FAILED afterMs=${Date.now() - __captionT0}`);
      if (job.status !== "canceled") {
        job.status = "error";
        job.error = classifyGenerationError(err).code;
      }
      return;
    }
    console.log(`[timing] videoGenerationJobStore caption-gen durationMs=${Date.now() - __captionT0}`);

    if (signal.aborted) return;

    const __renderPhaseT0 = Date.now();
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
        const __slotT0 = Date.now();
        try {
          const style = await renderVideo({ captionText: slot.caption, outPath, signal, backgroundImagePath });
          console.log(
            `[timing] videoGenerationJobStore slot=${slot.index} startedAtMs=${__slotT0 - __jobT0} ` +
              `durationMs=${Date.now() - __slotT0}`
          );
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
      console.log(
        `[timing] videoGenerationJobStore ALL_SLOTS renderPhaseMs=${Date.now() - __renderPhaseT0} ` +
          `jobTotalMs=${Date.now() - __jobT0}`
      );
      if (job.status === "running") {
        job.status = "done";
      }
    }
  })();

  return job;
}

/** 完了済みの1スロットだけを差し替える（[再作成]ボタン用）。同期的に1本だけレンダリングする。 */
async function regenerateSingleVideo({ caption, backgroundImageUrl }) {
  const filename = `${crypto.randomUUID()}.mp4`;
  const outPath = path.join(UPLOAD_DIR, filename);
  const backgroundImagePath = resolveBackgroundImagePath(backgroundImageUrl);
  const style = await renderVideo({ captionText: caption, outPath, backgroundImagePath });
  return { url: publicUrlFor(filename), style };
}

module.exports = { startVideoGenerationJob, getJob, serializeJob, cancelJob, regenerateSingleVideo };
