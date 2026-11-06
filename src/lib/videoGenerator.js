// Instagramリール用の縦型（9:16）テキスト動画を生成する。
// ヘッドレスChromeを使うRemotion等は`node:20-alpine`（musl libc）で公式非サポートのため、
// システム依存のない@napi-rs/canvas（Skiaバインディング、linux-x64-musl向けプリビルドあり）で
// フレームを直接描画し、Alpineに同梱したffmpegでBGMと合成する方式を採る。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PassThrough } = require("stream");
const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const ffmpeg = require("fluent-ffmpeg");
const { getAnthropic } = require("./anthropicClient");

const BGM_ROOT = path.join(__dirname, "..", "..", "bgm");
const BGM_FOLDERS = ["warm", "bright", "cyber", "digital", "fun", "intense"];
const ANIMATIONS = ["typewriter", "endroll", "slidein"];
const FOOTER_TEXT = "詳細は、コメントのURLをご覧ください";

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
// Conservative common limit from the retrieved Meta official sample (2026-10-15).
const MAX_DURATION_SEC = 60;
const HOLD_SEC = 2;
const HOLD_FRAMES = FPS * HOLD_SEC;
const FREEZE_SEC = 4;
const FREEZE_FRAMES = FPS * FREEZE_SEC;

const FONT_FAMILY = "NotoSansCJK";
let fontRegistered = false;
function ensureFontRegistered() {
  if (fontRegistered) return;
  const candidates = [
    "/usr/share/fonts/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
  ];
  const fontPath = candidates.find((p) => fs.existsSync(p));
  if (!fontPath) {
    throw new Error(`font_not_found: none of ${candidates.join(", ")} exist`);
  }
  GlobalFonts.registerFromPath(fontPath, FONT_FAMILY);
  fontRegistered = true;
}

// リール用キャプション生成プロンプト（INSTAGRAM_REEL_GUIDANCE、postCopyGenerator.js）は
// 絵文字を使わないよう明示していないため、AIが確率的に絵文字を混ぜることがある。
// NotoSansCJK単体には絵文字グリフが存在せず、そのまま描画すると□（tofu box）になる
// （2026-09-01、実機で確認）。ensureUrlIncluded（postCopyGenerator.js）と同様、プロンプト
// 指示だけに頼らずレンダリング直前に機械的に取り除く。
const EMOJI_PATTERN =
  /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}\u{20E3}]/gu;
function stripEmoji(text) {
  return typeof text === "string" ? text.replace(EMOJI_PATTERN, "") : text;
}

// AIが生成したキャプションから絵文字を取り除き、取り除いた跡の余分な空白を整える。
// AIはプロンプトで禁止していても確率的に絵文字を混ぜるため、生成物は「はじく」のでなく
// 取り除いて使う（はじくと、URL指定の動画生成が全スロット失敗する。2026-11-06、本番で発生）。
// 人が手で入力した文章は従来どおり validateReelCaption が絵文字を拒否する。
function stripEmojiFromCaption(text) {
  if (typeof text !== "string") return text;
  return stripEmoji(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// ---------- Claude APIによる配色・BGM判定 ----------

async function pickVideoStyle({ captionText }) {
  const anthropic = getAnthropic();
  if (!anthropic) {
    throw new Error("anthropic_not_configured");
  }
  const response = await anthropic.messages.create(
    {
      // アクセントカラー1つ・BGMフォルダ1つを選ぶだけの軽いタスクのため、postCopyGenerator.js
      // の本文生成と同じclaude-sonnet-5を使う（従来claude-opus-5を使っていたが、この程度の
      // タスクには不釣り合いに重く、Opus特有の混雑で529 Overloadedが頻発する一因になっていた。
      // 2026-08-26改修）。
      model: "claude-sonnet-5",
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

// Claude APIが（SDKのmaxRetries消化後も）529 Overloaded等で応答しない場合のフォールバック。
// 配色・BGM選定は動画の見た目を整える付加的な要素であり、これが取得できないという理由だけで
// 動画生成そのものを失敗させるのは本末転倒なため、ランダムに1つ選んで処理を続行する
// （実機で確認: Anthropic側の混雑により再生成を繰り返しても同じ理由で失敗し続ける事例、
// 2026-08-26）。
const FALLBACK_ACCENT_COLORS = ["#0ea5e9", "#f97316", "#8b5cf6", "#22c55e", "#ef4444", "#eab308", "#ec4899", "#14b8a6"];
function pickFallbackStyle() {
  const accentColorHex = FALLBACK_ACCENT_COLORS[Math.floor(Math.random() * FALLBACK_ACCENT_COLORS.length)];
  const bgmFolder = BGM_FOLDERS[Math.floor(Math.random() * BGM_FOLDERS.length)];
  return { accentColorHex, bgmFolder };
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
  const paragraphs = text.split(/\r?\n/);
  const lines = [];
  for (const para of paragraphs) {
    if (!para) { lines.push(""); continue; }
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

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

// ---------- タイトル（開始直後HOLD_SEC秒間、プロフィールグリッドのサムネイルに表示される
// 0フレーム目を含む区間）----------
// キャプション本文とは別のタイトルフィールドはデータモデルに存在しないため、本文の
// 先頭段落（改行区切りの最初のまとまり）を抜き出してタイトルとして使う。
const TITLE_MAX_LINES = 3;

function extractTitleSource(captionText) {
  const firstParagraph = (captionText || "").split(/\n+/).find((p) => p.trim().length > 0) || "";
  return firstParagraph.trim();
}

// 本文用のwrapCaption/fitCaptionと同じ縮小ロジックだが、1〜3行に収まるまで縮小する点が
// 異なる（タイトルは短い見出しとして表示するため、本文より大きいフォントサイズから始める）。
// 最小サイズでも3行に収まらない場合は、末尾を省略記号で切り詰める。
// フォントサイズは小さく読みにくいという指摘のため、初期・最小サイズとも一回り
// 大きくした（108→120, 56→64、2026-09-18）。
function fitTitle(ctx, text, maxWidth) {
  let fontSize = 72;
  const minSize = 64;
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
// でフェードアウトし、本文アニメーションが始まる時点では完全に透明になっているようにする。
function drawTitle(ctx, { lines, fontSize, lineHeight, textColor, holdT }) {
  ctx.save();
  const fadeStart = 0.72;
  ctx.globalAlpha = holdT <= fadeStart ? 1 : Math.max(0, 1 - (holdT - fadeStart) / (1 - fadeStart));
  ctx.font = `bold ${fontSize}px ${FONT_FAMILY}`;
  ctx.fillStyle = textColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const blockHeight = lines.length * lineHeight;
  const startY = (CAPTION_AREA.top + CAPTION_AREA.bottom) / 2 - blockHeight / 2 + lineHeight / 2;
  lines.forEach((line, idx) => {
    fillOutlinedText(ctx, line, 510, startY + idx * lineHeight);
  });
  ctx.restore();
}

// ---------- フレーム描画 ----------

// タイトルは冒頭だけ表示して本文開始時に消えるため、本文はその後に中央の広い領域を使える。
// フッターとの間隔は維持する。
const CAPTION_AREA = { top: 320, bottom: 1400, left: 120, right: 900 };
const FOOTER_Y = 1490;

// CSSのbackground-size: coverと同じ考え方で、フレーム全体を隙間なく覆うよう画像を
// 拡大・中央クロップする描画パラメータを1回だけ計算する（毎フレーム同じ静止画のため）。
function computeCoverDraw(img, targetWidth, targetHeight) {
  const scale = Math.max(targetWidth / img.width, targetHeight / img.height);
  const drawWidth = img.width * scale;
  const drawHeight = img.height * scale;
  return { dx: (targetWidth - drawWidth) / 2, dy: (targetHeight - drawHeight) / 2, drawWidth, drawHeight };
}

// ユーザー指定の背景画像は任意の写真のため、AI生成の単色背景と違いWCAGコントラスト計算が
// できない。そのため常に白文字＋半透明の黒スクリムを重ねる方式にして、どんな画像でも
// テキストが読める状態を保証する（テキスト色自体はrenderVideo側で固定する）。
function drawBackgroundImage(ctx, image, draw) {
  ctx.drawImage(image, draw.dx, draw.dy, draw.drawWidth, draw.drawHeight);
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

// 背景が透過のため、文字色と逆の色で細い縁取りを付けて、写真や単色背景の上でも読めるようにする。
function fillOutlinedText(ctx, text, x, y) {
  const fill = ctx.fillStyle;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineWidth = 8;
  ctx.strokeStyle = fill === "#ffffff" ? "rgba(0, 0, 0, 0.55)" : "rgba(255, 255, 255, 0.7)";
  ctx.strokeText(text, x, y);
  ctx.restore();
  ctx.fillText(text, x, y);
}

function drawFooter(ctx, footerText) {
  // コメントに書くURLが無い動画では、「コメントのURLをご覧ください」を出さない（空文字で非表示）。
  if (!footerText) return;
  ctx.save(); ctx.globalAlpha = 1;
  ctx.fillStyle = "#111827"; ctx.fillRect(100, 1430, 820, 120);
  ctx.font = `bold 50px ${FONT_FAMILY}`; ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(footerText, 510, FOOTER_Y);
  ctx.restore();
}

function drawTypewriter(ctx, { lines, fontSize, lineHeight, textColor, activeT }) {
  const totalChars = lines.reduce((n, l) => n + l.length, 0);
  // 文字送りが早すぎて読めないという指摘のため、全体の70%→85%の時間をかけて
  // 出現させるよう緩めた（2026-08-31）。
  const revealT = Math.min(1, activeT);
  const revealCount = Math.round(totalChars * revealT);
  let opacity = 1;


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
    fillOutlinedText(ctx, shown, 510, startY + idx * lineHeight);
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
    fillOutlinedText(ctx, line, 510, startY + idx * lineHeight);
  });
  ctx.restore();
}

function drawEndroll(ctx, { lines, fontSize, lineHeight, textColor, activeT }) {
  const startY = CAPTION_AREA.bottom + lineHeight / 2;
  const endY = Math.min(CAPTION_AREA.top + lineHeight / 2, CAPTION_AREA.bottom - lineHeight / 2 - (lines.length - 1) * lineHeight);
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
    fillOutlinedText(ctx, line, 510, y + idx * lineHeight);
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
 * @param {string} [params.backgroundImagePath] ユーザー指定の背景画像（絶対パス）。
 *   未指定の場合は従来通りAIが選んだアクセントカラーの単色背景になる。
 * @returns {Promise<{accentColorHex: string, textColor: string, contrastRatio: number|null, animation: string, bgmFolder: string, bgmFile: string}>}
 */
async function renderVideo({ captionText, outPath, signal, backgroundImagePath, animation: animationOverride, style: styleOverride, frameDirectory, footerText = FOOTER_TEXT }) {
  ensureFontRegistered();
  let plan = validateReelCaption(captionText, animationOverride);
  if (!animationOverride) {
    const choices = ANIMATIONS.flatMap(a => { try { return [validateReelCaption(captionText,a)]; } catch { return []; } });
    plan = choices[Math.floor(Math.random()*choices.length)];
  }
  const { lines, fontSize, lineHeight, animation, activeSeconds } = plan;
  const ACTIVE_FRAMES = Math.ceil(activeSeconds * FPS);
  const TOTAL_FRAMES = HOLD_FRAMES + ACTIVE_FRAMES;
  const DURATION_SEC = TOTAL_FRAMES / FPS;
  const OUTPUT_DURATION_SEC = DURATION_SEC + FREEZE_SEC;

  // 体感速度の遅さの原因切り分け調査用（2026-08-20）。Claude API呼び出し（配色・BGM判定）と
  // 実際のffmpeg/canvasレンダリングの所要時間を分けて記録する。
  const __styleT0 = Date.now();
  let style;
  try {
    style = styleOverride || await pickVideoStyle({ captionText });
  } catch (err) {
    console.error(`[videoGenerator] pickVideoStyle failed, using fallback style:`, err.message);
    style = pickFallbackStyle();
  }
  const __styleMs = Date.now() - __styleT0;
  if (signal?.aborted) throw new DOMExceptionLike("canceled");

  // 背景画像が指定された場合、アクセントカラーは単色背景の代わりには使わない（BGM選定は
  // 引き続きAI判定のstyle.bgmFolderを使う）。任意の写真に対するWCAGコントラスト計算は
  // できないため、白文字＋drawBackgroundImageの黒スクリムで可読性を保証する。
  const { textColor, contrastRatio: ratio } = backgroundImagePath
    ? { textColor: "#ffffff", contrastRatio: null }
    : pickTextColor(style.accentColorHex);

  const bgmFilePath = pickBgmFile(style.bgmFolder);
  const backgroundImage = backgroundImagePath ? await loadImage(backgroundImagePath) : null;
  const backgroundDraw = backgroundImage ? computeCoverDraw(backgroundImage, WIDTH, HEIGHT) : null;
  if (signal?.aborted) throw new DOMExceptionLike("canceled");

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  const drawCaption = DRAWERS[animation];
  const titleFit = fitTitle(ctx, extractTitleSource(captionText), CAPTION_AREA.right - CAPTION_AREA.left);
  titleFit.fontSize = Math.min(titleFit.fontSize, 72); titleFit.lineHeight = 90;

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
        "-threads", "2",
        "-c:a", "aac",
        "-b:a", "128k",
        "-af", `loudnorm=I=-16:TP=-1.5:LRA=7:linear=true,afade=t=in:st=0:d=1,afade=t=out:st=${DURATION_SEC - 1}:d=1`,
        "-t", String(OUTPUT_DURATION_SEC),
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
        // ctx.getImageData()も同期・CPUバウンドな処理のため（PNGエンコードよりは
        // 大幅に軽いが依然として同期処理）、backpressureが発生しない（＝毎フレーム
        // awaitで止まらない）場合、このループがイベントループを占有し続け、他のHTTP
        // リクエスト（動画生成キャンセルAPI等）が処理されなくなる。1フレームごとに
        // イベントループへ制御を返し、他のI/Oが割り込めるようにする。
        const writeFrame = async (buf) => {
          const canWrite = frameStream.write(buf);
          if (!canWrite) {
            await new Promise((r) => frameStream.once("drain", r));
          } else {
            await new Promise((r) => setImmediate(r));
          }
        };

        let lastBuf;
        for (let frame = 0; frame < TOTAL_FRAMES; frame++) {
          if (signal?.aborted) return;
          if (backgroundImage) {
            drawBackgroundImage(ctx, backgroundImage, backgroundDraw);
          } else {
            ctx.fillStyle = style.accentColorHex;
            ctx.fillRect(0, 0, WIDTH, HEIGHT);
          }

          // 本文エリアの背景は透過。文字色は背景に合わせた textColor（写真は白＋暗い膜、
          // 単色背景はコントラスト比が高いほうの白/黒）を使い、縁取りで可読性を補う。
          if (frame < HOLD_FRAMES) {
            const holdT = frame / Math.max(1, HOLD_FRAMES - 1);
            drawTitle(ctx, { ...titleFit, textColor, holdT });
          } else {
            const activeT = Math.min(1, (frame - HOLD_FRAMES) / Math.max(1, ACTIVE_FRAMES - 1));
            drawCaption(ctx, { lines, fontSize, lineHeight, textColor, activeT });
          }
          drawFooter(ctx, footerText);
          if (frameDirectory && [0, HOLD_FRAMES, Math.floor(TOTAL_FRAMES/2), TOTAL_FRAMES-1].includes(frame)) {
            fs.mkdirSync(frameDirectory, { recursive: true });
            fs.writeFileSync(path.join(frameDirectory, `${animation}-${frame}.png`), canvas.toBuffer("image/png"));
          }
          if (frame === 0) fs.writeFileSync(outPath.replace(/\.mp4$/, ".cover.jpg"), canvas.toBuffer("image/jpeg"));

          const imageData = ctx.getImageData(0, 0, WIDTH, HEIGHT);
          lastBuf = Buffer.from(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength);
          await writeFrame(lastBuf);
        }
        // 動画終了時点（最終フレーム）の状態をFREEZE_SEC秒分そのまま保持してから
        // 出力を終える。ctxへの再描画は行わず、最終フレームのバッファをそのまま
        // 再送するだけでよい。
        for (let i = 0; i < FREEZE_FRAMES; i++) {
          if (signal?.aborted) return;
          await writeFrame(lastBuf);
        }
        frameStream.end();
      } catch (err) {
        frameStream.destroy(err);
      }
    })();
  });

  console.log(
    `[timing] videoGenerator.renderVideo styleMs=${__styleMs} renderMs=${Date.now() - __renderT0} ` +
      `totalFrames=${TOTAL_FRAMES + FREEZE_FRAMES}`
  );

  if (signal?.aborted) {
    fs.promises.unlink(outPath).catch(() => {});
    throw new DOMExceptionLike("canceled");
  }

  return {
    accentColorHex: style.accentColorHex,
    textColor,
    contrastRatio: ratio,
    animation, durationSeconds: OUTPUT_DURATION_SEC,
    bgmFolder: style.bgmFolder,
    bgmFile: path.basename(bgmFilePath),
  };
}

function validateReelCaption(text, requestedAnimation) {
  function fail(code) { throw Object.assign(new Error(code), { code }); }
  if (typeof text !== "string" || !text.trim()) fail("reel_caption_required");
  if (text.length > 2200) fail("reel_caption_too_long");
  EMOJI_PATTERN.lastIndex = 0;
  if (EMOJI_PATTERN.test(text)) fail("reel_emoji_unsupported");
  ensureFontRegistered();
  const ctx = createCanvas(WIDTH, HEIGHT).getContext("2d");
  const fontSize = 60, lineHeight = 84;
  const lines = wrapCaption(ctx, text, CAPTION_AREA.right - CAPTION_AREA.left, fontSize);
  const fits = lines.length * lineHeight <= CAPTION_AREA.bottom - CAPTION_AREA.top;
  const animation = requestedAnimation || "endroll";
  if (!ANIMATIONS.includes(animation)) fail("reel_animation_invalid");
  if (!fits && animation !== "endroll") fail("reel_use_endroll_or_shorten");
  const startY = CAPTION_AREA.bottom + lineHeight/2;
  const endY = Math.min(CAPTION_AREA.top+lineHeight/2, CAPTION_AREA.bottom-lineHeight/2-(lines.length-1)*lineHeight);
  const chars = Array.from(text).length;
  const activeSeconds = animation === "endroll" ? Math.max(6,(startY-endY)/50,chars/8) : animation === "typewriter" ? Math.max(6,chars/8) : Math.max(6,chars/6+2);
  if (HOLD_SEC + activeSeconds + FREEZE_SEC > MAX_DURATION_SEC) fail("reel_caption_too_long");
  return { lines, fontSize, lineHeight, animation, activeSeconds, durationSeconds: HOLD_SEC+activeSeconds+FREEZE_SEC };
}

class DOMExceptionLike extends Error {
  constructor(message) {
    super(message);
    this.name = "AbortError";
  }
}

module.exports = { validateReelCaption, renderVideo, pickVideoStyle, pickTextColor, contrastRatio, stripEmojiFromCaption };
