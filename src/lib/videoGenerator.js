// Instagramリール用の縦型（9:16）テキスト動画を生成する。
// ヘッドレスChromeを使うRemotion等は`node:20-alpine`（musl libc）で公式非サポートのため、
// システム依存のない@napi-rs/canvas（Skiaバインディング、linux-x64-musl向けプリビルドあり）で
// フレームを直接描画し、Alpineに同梱したffmpegでBGMと合成する方式を採る。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PassThrough } = require("stream");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const ffmpeg = require("fluent-ffmpeg");
const { getAnthropic } = require("./anthropicClient");

const BGM_ROOT = path.join(__dirname, "..", "..", "bgm");
const BGM_FOLDERS = ["warm", "bright", "cyber", "digital", "fun", "intense"];
const ANIMATIONS = ["typewriter", "endroll", "slidein"];
const FOOTER_TEXT = "Webはプロフィールから";

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const DURATION_SEC = 16;
const TOTAL_FRAMES = FPS * DURATION_SEC;
// ループ再生時に不自然な切り替わりが目立たないよう、開始・終了付近はテキストなしの
// 背景のみにする（フッターは常時表示のまま）。
const HOLD_SEC = 0.5;
const HOLD_FRAMES = Math.round(HOLD_SEC * FPS);
const ACTIVE_FRAMES = TOTAL_FRAMES - HOLD_FRAMES * 2;

const FONT_FAMILY = "NotoSansCJK";
let fontRegistered = false;
function ensureFontRegistered() {
  if (fontRegistered) return;
  const candidates = [
    "/usr/share/fonts/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
  ];
  const fontPath = candidates.find((p) => fs.existsSync(p));
  if (!fontPath) {
    throw new Error(`font_not_found: none of ${candidates.join(", ")} exist`);
  }
  GlobalFonts.registerFromPath(fontPath, FONT_FAMILY);
  fontRegistered = true;
}

// ---------- Claude APIによる配色・BGM判定 ----------

async function pickVideoStyle({ captionText }) {
  const anthropic = getAnthropic();
  if (!anthropic) {
    throw new Error("anthropic_not_configured");
  }
  const response = await anthropic.messages.create(
    {
      model: "claude-opus-5",
      max_tokens: 256,
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              accentColorHex: {
                type: "string",
                pattern: "^#[0-9a-fA-F]{6}$",
              },
              bgmFolder: { type: "string", enum: BGM_FOLDERS },
            },
            required: ["accentColorHex", "bgmFolder"],
            additionalProperties: false,
          },
        },
      },
      system:
        "あなたはSNS動画のアートディレクターです。与えられたInstagram投稿文の雰囲気を判定し、" +
        "背景に使うアクセントカラー（HEXコード1つ）と、最も合うBGMのジャンルフォルダを1つ選んでください。" +
        `BGMフォルダの意味: warm=温かみ・親しみ, bright=明るい・爽やか, cyber=先進的・テック, ` +
        `digital=デジタル・都会的, fun=楽しい・ポップ, intense=情熱的・力強い。` +
        "出力は指定されたJSON形式のみとし、説明文は含めないでください。",
      messages: [{ role: "user", content: `【投稿文】\n${captionText}` }],
    },
    // 動画生成はバックグラウンドジョブで実行され、同期HTTPレスポンスをブロックしないため、
    // postCopyGenerator.js（ユーザーが応答を待つ同期API）とは異なりSDKデフォルトの
    // リトライを有効にする（実測で同時実行時に一時的なAPI接続エラーが発生したため）。
    { timeout: 30000, maxRetries: 2 }
  );
  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
    throw new Error("ai_style_generation_failed");
  }
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) {
    throw new Error("ai_no_output");
  }
  return JSON.parse(textBlock.text);
}

// ---------- WCAG コントラスト比 ----------

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(hexA, hexB) {
  const lumA = relativeLuminance(hexA) + 0.05;
  const lumB = relativeLuminance(hexB) + 0.05;
  return lumA > lumB ? lumA / lumB : lumB / lumA;
}

function pickTextColor(accentColorHex) {
  const whiteRatio = contrastRatio(accentColorHex, "#ffffff");
  const blackRatio = contrastRatio(accentColorHex, "#000000");
  return whiteRatio >= blackRatio
    ? { textColor: "#ffffff", contrastRatio: whiteRatio }
    : { textColor: "#000000", contrastRatio: blackRatio };
}

// ---------- BGM選定 ----------

function pickBgmFile(bgmFolder) {
  const dir = path.join(BGM_ROOT, bgmFolder);
  const files = fs.readdirSync(dir).filter((f) => /\.mp3$/i.test(f));
  if (files.length === 0) {
    throw new Error(`bgm_folder_empty: ${bgmFolder}`);
  }
  const file = files[Math.floor(Math.random() * files.length)];
  return path.join(dir, file);
}

// ---------- テキスト折り返し・サイズ調整 ----------

function wrapCaption(ctx, text, maxWidth, fontSize) {
  ctx.font = `bold ${fontSize}px ${FONT_FAMILY}`;
  const paragraphs = text.split(/\n+/).filter(Boolean);
  const lines = [];
  for (const para of paragraphs) {
    let current = "";
    for (const ch of para) {
      const test = current + ch;
      if (current.length > 0 && ctx.measureText(test).width > maxWidth) {
        lines.push(current);
        current = ch;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function fitCaption(ctx, text, maxWidth, maxHeight) {
  // キャプション文字が小さすぎるとの指摘のため、初期サイズ・最小サイズとも約1.5倍にした
  // （68→102, 32→48）。CAPTION_AREAの高さ（HEIGHT-840=1080px）には十分な余裕があるため、
  // 収まらない場合の縮小ロジック（このループ）はそのまま機能する。
  let fontSize = 102;
  const minSize = 48;
  let lines = wrapCaption(ctx, text, maxWidth, fontSize);
  // 行間は1.45倍だったが、やや長めのキャプションでminSizeに張り付いたまま
  // 文字が小さいまま表示される事例があったため1.3倍に詰め、同じ高さでより
  // 多くの行数を許容できるようにした（CAPTION_AREA拡張とあわせての対応）。
  let lineHeight = Math.round(fontSize * 1.3);
  while (fontSize > minSize && lines.length * lineHeight > maxHeight) {
    fontSize -= 6;
    lines = wrapCaption(ctx, text, maxWidth, fontSize);
    lineHeight = Math.round(fontSize * 1.3);
  }
  // 極端に長い文章は表示しきれないため、収まる行数までで打ち切る（保存前にプレビューできるため許容）。
  const maxLines = Math.max(1, Math.floor(maxHeight / lineHeight));
  return { lines: lines.slice(0, maxLines), fontSize, lineHeight };
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

// ---------- タイトル（開始直後0.5秒間、プロフィールグリッドのサムネイルに表示される
// 0フレーム目を含む区間）----------
// キャプション本文とは別のタイトルフィールドはデータモデルに存在しないため、本文の
// 先頭段落（改行区切りの最初のまとまり）を抜き出してタイトルとして使う。
const TITLE_MAX_LINES = 2;

function extractTitleSource(captionText) {
  const firstParagraph = (captionText || "").split(/\n+/).find((p) => p.trim().length > 0) || "";
  return firstParagraph.trim();
}

// 本文用のwrapCaption/fitCaptionと同じ縮小ロジックだが、1〜2行に収まるまで縮小する点が
// 異なる（タイトルは短い見出しとして表示するため、本文より大きいフォントサイズから始める）。
// 最小サイズでも2行に収まらない場合は、末尾を省略記号で切り詰める。
function fitTitle(ctx, text, maxWidth) {
  let fontSize = 108;
  const minSize = 56;
  let lines = wrapCaption(ctx, text, maxWidth, fontSize);
  let lineHeight = Math.round(fontSize * 1.3);
  while (fontSize > minSize && lines.length > TITLE_MAX_LINES) {
    fontSize -= 6;
    lines = wrapCaption(ctx, text, maxWidth, fontSize);
    lineHeight = Math.round(fontSize * 1.3);
  }
  if (lines.length > TITLE_MAX_LINES) {
    lines = lines.slice(0, TITLE_MAX_LINES);
    const last = lines[TITLE_MAX_LINES - 1];
    lines[TITLE_MAX_LINES - 1] = last.length > 1 ? `${last.slice(0, -1)}…` : last;
  }
  return { lines, fontSize, lineHeight };
}

// holdT: 0（開始）→1（ホールド区間の終端＝本文アニメーション開始点）。終盤30%
// （0.5秒中の約0.15秒）でフェードアウトし、本文アニメーションが始まる時点では
// 完全に透明になっているようにする。
function drawTitle(ctx, { lines, fontSize, lineHeight, textColor, holdT }) {
  const fadeStart = 0.7;
  const opacity = holdT < fadeStart ? 1 : Math.max(0, 1 - (holdT - fadeStart) / (1 - fadeStart));

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.font = `bold ${fontSize}px ${FONT_FAMILY}`;
  ctx.fillStyle = textColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const blockHeight = lines.length * lineHeight;
  // 「画面の中央」という要件のため、本文用のCAPTION_AREA（フッター分だけ下マージンを
  // 広く取った領域）ではなく、フレーム全体の中央（HEIGHT/2）を基準にする。
  const startY = HEIGHT / 2 - blockHeight / 2 + lineHeight / 2;
  lines.forEach((line, idx) => {
    ctx.fillText(line, WIDTH / 2, startY + idx * lineHeight);
  });
  ctx.restore();
}

// ---------- フレーム描画 ----------

// 上下マージンを420→320/360に詰め、キャプションが使える高さを1080→1240pxに拡張した
// （フォントが最小サイズに張り付いたまま表示される事例の対策。フッター(FOOTER_Y=1790)
// との間隔は十分確保できている）。
const CAPTION_AREA = { top: 320, bottom: HEIGHT - 360, left: 90, right: WIDTH - 90 };
const FOOTER_Y = HEIGHT - 130;

function drawFooter(ctx, textColor) {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.font = `bold 52px ${FONT_FAMILY}`;
  ctx.fillStyle = textColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(FOOTER_TEXT, WIDTH / 2, FOOTER_Y);
  ctx.restore();
}

function drawTypewriter(ctx, { lines, fontSize, lineHeight, textColor, activeT }) {
  const totalChars = lines.reduce((n, l) => n + l.length, 0);
  const revealT = Math.min(1, activeT / 0.7);
  const revealCount = Math.round(totalChars * revealT);
  let opacity = 1;
  if (activeT > 0.9) opacity = Math.max(0, 1 - (activeT - 0.9) / 0.1);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.font = `bold ${fontSize}px ${FONT_FAMILY}`;
  ctx.fillStyle = textColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const blockHeight = lines.length * lineHeight;
  const startY = (CAPTION_AREA.top + CAPTION_AREA.bottom) / 2 - blockHeight / 2 + lineHeight / 2;
  let remaining = revealCount;
  lines.forEach((line, idx) => {
    if (remaining <= 0) return;
    const shown = line.slice(0, Math.max(0, remaining));
    ctx.fillText(shown, WIDTH / 2, startY + idx * lineHeight);
    remaining -= line.length;
  });
  ctx.restore();
}

function drawSlideIn(ctx, { lines, fontSize, lineHeight, textColor, activeT }) {
  let opacity = 1;
  let offsetY = 0;
  if (activeT < 0.15) {
    const t = easeOutCubic(activeT / 0.15);
    opacity = t;
    offsetY = (1 - t) * 70;
  } else if (activeT > 0.85) {
    const t = (activeT - 0.85) / 0.15;
    opacity = Math.max(0, 1 - t);
    offsetY = -t * 40;
  } else {
    // フェードイン・アウトの間（全体の70%）は完全に静止して見えていたため
    // （シークバーを動かしても変化がないという指摘の実体）、ごく緩やかな
    // 上下の揺れを常時加えて静止画に見えないようにする。
    const driftT = (activeT - 0.15) / 0.7;
    offsetY = Math.sin(driftT * Math.PI * 2) * 8;
  }

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.font = `bold ${fontSize}px ${FONT_FAMILY}`;
  ctx.fillStyle = textColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const blockHeight = lines.length * lineHeight;
  const startY = (CAPTION_AREA.top + CAPTION_AREA.bottom) / 2 - blockHeight / 2 + lineHeight / 2 + offsetY;
  lines.forEach((line, idx) => {
    ctx.fillText(line, WIDTH / 2, startY + idx * lineHeight);
  });
  ctx.restore();
}

function drawEndroll(ctx, { lines, fontSize, lineHeight, textColor, activeT }) {
  const blockHeight = lines.length * lineHeight;
  const startY = CAPTION_AREA.bottom + blockHeight / 2;
  const endY = CAPTION_AREA.top - blockHeight / 2;
  const y = startY + (endY - startY) * activeT;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, CAPTION_AREA.top, WIDTH, CAPTION_AREA.bottom - CAPTION_AREA.top);
  ctx.clip();
  ctx.globalAlpha = 1;
  ctx.font = `bold ${fontSize}px ${FONT_FAMILY}`;
  ctx.fillStyle = textColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((line, idx) => {
    ctx.fillText(line, WIDTH / 2, y + idx * lineHeight);
  });
  ctx.restore();
}

const DRAWERS = { typewriter: drawTypewriter, endroll: drawEndroll, slidein: drawSlideIn };

// ---------- メイン: 1本の動画をレンダリングする ----------

/**
 * @param {object} params
 * @param {string} params.captionText 動画に表示するキャプション文
 * @param {string} params.outPath 出力先mp4パス（絶対パス）
 * @param {AbortSignal} [params.signal] キャンセル用
 * @returns {Promise<{accentColorHex: string, textColor: string, contrastRatio: number, animation: string, bgmFolder: string, bgmFile: string}>}
 */
async function renderVideo({ captionText, outPath, signal }) {
  ensureFontRegistered();

  // 体感速度の遅さの原因切り分け調査用（2026-08-20）。Claude API呼び出し（配色・BGM判定）と
  // 実際のffmpeg/canvasレンダリングの所要時間を分けて記録する。
  const __styleT0 = Date.now();
  const style = await pickVideoStyle({ captionText });
  const __styleMs = Date.now() - __styleT0;
  if (signal?.aborted) throw new DOMExceptionLike("canceled");

  const { textColor, contrastRatio: ratio } = pickTextColor(style.accentColorHex);
  const animation = ANIMATIONS[Math.floor(Math.random() * ANIMATIONS.length)];
  const bgmFilePath = pickBgmFile(style.bgmFolder);

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  const { lines, fontSize, lineHeight } = fitCaption(
    ctx,
    captionText,
    CAPTION_AREA.right - CAPTION_AREA.left,
    CAPTION_AREA.bottom - CAPTION_AREA.top
  );
  const drawCaption = DRAWERS[animation];
  const titleFit = fitTitle(ctx, extractTitleSource(captionText), CAPTION_AREA.right - CAPTION_AREA.left);

  const __renderT0 = Date.now();
  await new Promise((resolve, reject) => {
    const frameStream = new PassThrough();
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      command.kill("SIGKILL");
      frameStream.destroy();
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const command = ffmpeg()
      .input(frameStream)
      // 以前はPNGへ毎フレームエンコードしてimage2pipeで渡していたが、実測で
      // canvas.toBuffer("image/png")が1フレームあたり平均80ms超（480フレームで
      // 合計38秒超）かかっていた。ffmpeg側もH.264エンコード時にPNGを一度
      // デコードし直す二度手間になっていたため、getImageData()で取得した
      // 生RGBAピクセルをrawvideoとしてそのまま渡す方式に変更した
      // （getImageDataは実測で1フレームあたり平均1.2ms程度）。
      .inputOptions(["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${WIDTH}x${HEIGHT}`, "-framerate", String(FPS)])
      .input(bgmFilePath)
      .inputOptions(["-stream_loop", "-1"])
      .outputOptions([
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-profile:v", "main",
        "-c:a", "aac",
        "-b:a", "128k",
        "-af", `afade=t=in:st=0:d=1,afade=t=out:st=${DURATION_SEC - 1}:d=1`,
        "-t", String(DURATION_SEC),
        "-movflags", "+faststart",
        "-y",
      ])
      .on("error", (err) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        if (aborted) return reject(new DOMExceptionLike("canceled"));
        reject(err);
      })
      .on("end", () => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      })
      .save(outPath);

    (async () => {
      try {
        for (let frame = 0; frame < TOTAL_FRAMES; frame++) {
          if (signal?.aborted) return;
          ctx.fillStyle = style.accentColorHex;
          ctx.fillRect(0, 0, WIDTH, HEIGHT);

          if (frame < HOLD_FRAMES) {
            // 開始直後0.5秒間（0フレーム目＝プロフィールグリッドのサムネイルを含む）は
            // タイトルを画面中央に静止表示し、区間の終盤でフェードアウトする。
            const holdT = frame / HOLD_FRAMES;
            drawTitle(ctx, { ...titleFit, textColor, holdT });
          } else if (frame < TOTAL_FRAMES - HOLD_FRAMES) {
            const activeT = (frame - HOLD_FRAMES) / ACTIVE_FRAMES;
            drawCaption(ctx, { lines, fontSize, lineHeight, textColor, activeT });
          }
          drawFooter(ctx, textColor);

          const imageData = ctx.getImageData(0, 0, WIDTH, HEIGHT);
          const buf = Buffer.from(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength);
          const canWrite = frameStream.write(buf);
          if (!canWrite) {
            await new Promise((r) => frameStream.once("drain", r));
          } else {
            // ctx.getImageData()も同期・CPUバウンドな処理のため（PNGエンコードよりは
            // 大幅に軽いが依然として同期処理）、backpressureが発生しない（＝毎フレーム
            // awaitで止まらない）場合、このループがイベントループを占有し続け、他のHTTP
            // リクエスト（動画生成キャンセルAPI等）が処理されなくなる。1フレームごとに
            // イベントループへ制御を返し、他のI/Oが割り込めるようにする。
            await new Promise((r) => setImmediate(r));
          }
        }
        frameStream.end();
      } catch (err) {
        frameStream.destroy(err);
      }
    })();
  });

  console.log(
    `[timing] videoGenerator.renderVideo styleMs=${__styleMs} renderMs=${Date.now() - __renderT0} ` +
      `totalFrames=${TOTAL_FRAMES}`
  );

  if (signal?.aborted) {
    fs.promises.unlink(outPath).catch(() => {});
    throw new DOMExceptionLike("canceled");
  }

  return {
    accentColorHex: style.accentColorHex,
    textColor,
    contrastRatio: Number(ratio.toFixed(2)),
    animation,
    bgmFolder: style.bgmFolder,
    bgmFile: path.basename(bgmFilePath),
  };
}

class DOMExceptionLike extends Error {
  constructor(message) {
    super(message);
    this.name = "AbortError";
  }
}

module.exports = { renderVideo, pickVideoStyle, pickTextColor, contrastRatio };
