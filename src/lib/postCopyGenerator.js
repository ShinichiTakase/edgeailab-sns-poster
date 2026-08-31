// 原文（またはURL本文）から各SNS向けに最適化した投稿文をAIで生成する。
// モデルはclaude-opus-5固定。構造化出力（json_schema）で選択したSNSぶんのキーのみを
// 直接JSONとして受け取り、テキストパースの脆さを避ける。
const { getAnthropic } = require("./anthropicClient");

// 体感速度改善のためclaude-opus-5からclaude-sonnet-5へ切替（2026-08-20）。
// URL指定生成の品質基準（記事内容を正確に反映すること）を満たすか実測比較の
// うえ採用（劣化する場合はHaikuまでは下げずSonnet 5に留める、が判断基準）。
const MODEL = "claude-sonnet-5";
// 同期HTTPリクエストでユーザーが応答を待っているため、SDKデフォルトの10分は長すぎる。
// 実測でAnthropic APIへの単純な呼び出しでも3〜12秒程度のばらつきが見られたため、
// 30秒では実運用のリクエスト（原文が長い・複数SNS分を一度に生成等）で不足する
// ケースがあり得ると判断し、余裕を持たせている（nginx側のproxy_read_timeoutも
// 70秒に合わせて延長済み）。
const REQUEST_TIMEOUT_MS = 45000;
// generatePostCopyVariations用。1回で10パターン×最大4SNS分を生成するため出力量が
// 単発生成の約10倍になり、応答時間も伸びる。nginx側のproxy_read_timeoutも100秒に
// 合わせて延長している（deploy/xserver-vps/proxy/edgeailab.net.conf参照）。
const VARIATIONS_REQUEST_TIMEOUT_MS = 90000;

const PLATFORM_GUIDANCE = {
  x:
    "X（旧Twitter）向け: 文字数上限280字を厳守。1〜2文の簡潔な文章にまとめること。" +
    "ハッシュタグは必ず1〜2個、文末に含めること（省略しないこと）。" +
    "URLを含める場合、実際の文字数によらず短縮URLとして23文字で計算されるため、それを踏まえて280文字に収めること。",
  threads:
    "Threads向け: 文字数上限は500字だが、実際に最後まで読まれるのは3〜5文・150〜250字程度。それを目安に収めること。" +
    "カジュアルな口語調で書き、結びは質問形式など会話を誘発する一文にすること。" +
    "ハッシュタグは必ず1〜3個、結びの一文のすぐ後に含めること（省略しないこと）。",
  facebook:
    "Facebook向け: 明確な文字数上限はないが、実際に読まれるのは冒頭2〜3文程度で、続きは「…続きを読む」で折りたたまれる。" +
    "最初の1〜2文で要点を伝え、全体は3〜5文程度の簡潔な段落構成にまとめること。",
  instagram:
    "Instagram向け: 文字数上限は2200字だが、モバイルアプリでは冒頭約125字を超えると「…続きを見る」で折りたたまれるため、" +
    "冒頭125字以内に最も伝えたい情報を入れること。全体は3〜5文程度の簡潔な構成にとどめ、原文の詳細を長々と展開しないこと。" +
    "本文中のURLはInstagramの仕様上クリックできないため、URLに言及する場合も「プロフィールのリンクから」程度の案内に留め、" +
    "URL誘導に文字数を割かないこと。ハッシュタグは3〜5個程度を末尾にまとめて付けること。",
  linkedin:
    "LinkedIn向け（個人プロフィール投稿）: ビジネス・キャリアの文脈で読まれることを意識し、丁寧語調の" +
    "「ですます」調で書くこと。文字数上限は3000字だが、実際に読まれるのは冒頭3行（約200字）程度で、" +
    "それ以降は「…続きを見る」で折りたたまれるため、冒頭200字以内に最も伝えたい要点を入れること。" +
    "絵文字や過度に砕けた表現は避け、専門性・実績が伝わる構成にすること。" +
    "ハッシュタグは3〜5個程度を末尾にまとめて付けること。",
};

// スケジュール投稿のInstagramリール動画キャプション専用のガイダンス。動画内に焼き込む
// オンスクリーンテキストを兼ねるため、通常のフィード投稿向け（PLATFORM_GUIDANCE.instagram）
// とは要件が異なる（ハッシュタグは画面表示上不要、URL誘導も動画内では意味をなさない）。
const INSTAGRAM_REEL_GUIDANCE =
  "Instagramリール向け: この文章は動画に焼き込むオンスクリーンテキスト（画面表示用の短いキャプション）です。" +
  "1〜3文程度の簡潔な文章にまとめ、原文の詳細を長々と展開しないこと。" +
  "ハッシュタグは付けないこと（動画内テキストとして画面表示されるため不要）。" +
  "URLへの言及や「プロフィールのリンクから」等の誘導文言も含めないこと。";

function buildSystemPrompt(platforms, url, { reelMode = false } = {}) {
  const guidance = platforms
    .map((p) => `- ${p === "instagram" && reelMode ? INSTAGRAM_REEL_GUIDANCE : PLATFORM_GUIDANCE[p]}`)
    .join("\n");
  const urlInstruction = url && !reelMode
    ? "\n各プラットフォームの投稿文の一番最後（ハッシュタグを付ける場合はハッシュタグより後）に、" +
      "必ず次のURLをそのまま含めてください。これは口調やハッシュタグ数に関する上記の指示より優先される" +
      "必須要件であり、URLを省略することは一切禁止です: " +
      url +
      "\nただしInstagramは例外とし、URLを直接記載せず「プロフィールのリンクから」のような案内文言に留めてください" +
      "（Instagram向けの上記指示を優先してください）。"
    : "";
  return [
    "あなたはSNS運用代行のプロのコピーライターです。",
    "与えられた原文をもとに、指定された各SNSプラットフォーム向けに最適化された投稿文を作成してください。",
    "原文の内容は正確に反映しつつ、一字一句をなぞる言い換えではなく、各SNSで実際に最後まで読まれる長さ・構成になるよう" +
      "要点を絞って再構成してください。原文をそのまま詳細に展開した長文にはしないこと。",
    "冒頭の1〜2文で、読者が最も知りたいポイント（フック）を提示してください。" +
      "特にInstagramとThreadsは冒頭で読者が続きを読むかどうかが決まるため重要です。",
    reelMode ? null : "各プラットフォームの特性を踏まえ、必要に応じてハッシュタグを付与してください。",
    guidance,
    urlInstruction,
    "出力は指定されたJSON形式のみとし、説明文や前置き・後書きは一切含めないでください。",
  ]
    .filter(Boolean)
    .join("\n");
}

// プロンプトで「必ずURLを含める」と指示しても、Threadsだけ結びの質問文・ハッシュタグの
// 指示と競合してAIがURLを丸ごと省略することが実機で確認された（同一生成バッチでも
// x/facebook/linkedinは常にURLを含む一方、threadsのみ約半数で欠落。2026-08-31調査）。
// プロンプト側の指示競合を緩和しても確率的事象は完全には防げないため、生成結果に
// URLが含まれていない場合はここで機械的に追記し、og:imageリンクプレビューが出ない
// 事故を確実に防ぐ（Instagramは本文URLが仕様上クリックできないため対象外）。
function ensureUrlIncluded(text, url) {
  if (!url || typeof text !== "string" || !text || text.includes(url)) return text;
  return `${text}\n${url}`;
}

function buildSchema(platforms) {
  const properties = {};
  for (const platform of platforms) {
    properties[platform] = { type: "string" };
  }
  return {
    type: "object",
    properties,
    required: platforms,
    additionalProperties: false,
  };
}

/**
 * @param {string} sourceText 原文またはURLから取得した本文
 * @param {string[]} platforms "x" | "threads" | "facebook" | "instagram" の配列
 * @param {string} [url] 投稿文に含めるべき元URL（URL指定投稿の場合のみ）
 * @returns {Promise<Record<string,string>>} プラットフォームごとの投稿文
 */
async function generatePostCopy({ sourceText, platforms, url }) {
  const anthropic = getAnthropic();
  if (!anthropic) {
    throw new Error("anthropic_not_configured");
  }

  // 体感速度の遅さの原因切り分け調査用（2026-08-20）。Claude API呼び出し単体の所要時間を計測する。
  const __t0 = Date.now();
  let response;
  try {
    response = await anthropic.messages.create(
      {
        model: MODEL,
        // Instagram単体（2200文字目安）だけでも出力が2000トークン超になり得るため、
        // 4SNS同時選択でも打ち切られない余裕を持たせる（実測でmax_tokens:2048だと
        // 複数SNS選択時にstop_reason:"max_tokens"で出力が途中で切れ、不完全なJSONに
        // なってパースエラーになっていた）。
        max_tokens: 4096,
        thinking: { type: "disabled" },
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: buildSchema(platforms) },
        },
        system: buildSystemPrompt(platforms, url),
        messages: [{ role: "user", content: `【原文】\n${sourceText}` }],
      },
      // ユーザーが同期的に応答を待つ画面のため、SDKデフォルトのリトライ（最大2回）はしない。
      // タイムアウトのたびに約30秒×3回＝最大1〜2分待たせてしまうのを避け、失敗を早く返す。
      { timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 }
    );
  } finally {
    console.log(
      `[timing] postCopyGenerator.generatePostCopy platforms=${platforms.join(",")} durationMs=${Date.now() - __t0}`
    );
  }

  if (response.stop_reason === "refusal") {
    throw new Error("ai_refusal");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("ai_output_truncated");
  }
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) {
    throw new Error("ai_no_output");
  }
  const parsed = JSON.parse(textBlock.text);
  if (url) {
    for (const platform of platforms) {
      if (platform === "instagram") continue;
      parsed[platform] = ensureUrlIncluded(parsed[platform], url);
    }
  }
  return parsed;
}

function buildVariationsSystemPrompt(platforms, url, count, { reelMode = false } = {}) {
  const base = buildSystemPrompt(platforms, url, { reelMode });
  return (
    base +
    `\n各プラットフォームにつき、投稿文を${count}パターン生成してください。` +
    "これらは同一スケジュールで日を分けて順番に投稿されるローテーション用のバリエーションです。" +
    "同じSNSに短期間で似た文面が連続投稿されるとスパムと判定されるリスクがあるため、" +
    `${count}パターンは言い回し・切り口・構成・フックの取り方をそれぞれ明確に変え、単なる同義語の` +
      "置き換えにならないようにしてください。ただし原文の事実関係はどのパターンでも正確に反映すること。"
  );
}

// Anthropic APIのjson_schema出力はarray型のminItems/maxItemsに0/1以外を指定できない
// （実測でcount>1を指定すると400エラーになる）。そのためcount件の配列ではなく、
// v1〜vN固定キーを持つオブジェクトとして出力させ、あとでconvertVariationsToArraysで
// 配列に変換する。
function variationKeys(count) {
  return Array.from({ length: count }, (_, i) => `v${i + 1}`);
}

function buildVariationsSchema(platforms, count) {
  const keys = variationKeys(count);
  const variationProperties = {};
  for (const key of keys) {
    variationProperties[key] = { type: "string" };
  }
  const properties = {};
  for (const platform of platforms) {
    properties[platform] = {
      type: "object",
      properties: variationProperties,
      required: keys,
      additionalProperties: false,
    };
  }
  return {
    type: "object",
    properties,
    required: platforms,
    additionalProperties: false,
  };
}

function convertVariationsToArrays(raw, platforms, count) {
  const keys = variationKeys(count);
  const result = {};
  for (const platform of platforms) {
    result[platform] = keys.map((key) => raw[platform][key]);
  }
  return result;
}

/**
 * 1プラットフォーム分のcount件バリエーションを1回のAI呼び出しで生成する。
 * generatePostCopyVariationsから並列に呼び出される。
 */
async function generateVariationsForPlatform(anthropic, { sourceText, platform, url, count }) {
  // schedule.platformsからInstagramを除いたテキストタブ（x/threads/facebook）は
  // このバリエーション生成を使わない（textPlatforms()参照）。そのためplatform==="instagram"
  // でこの関数が呼ばれるのは、videoGenerationJobStore.jsのリール動画キャプション生成のみ
  // （現状の呼び出し元はここ一箇所）。将来、リール以外の用途でInstagramのバリエーション生成が
  // 必要になった場合はこの前提が崩れるため、その際は呼び出し元からreelMode相当を明示的に
  // 渡す形に変更すること。
  const reelMode = platform === "instagram";
  // 体感速度の遅さの原因切り分け調査用（2026-08-20）。Claude API呼び出し単体の所要時間を計測する。
  // 開始時刻も記録し、並行実行しているはずの他プラットフォーム分と実際に時間帯が重なっているか
  // （＝逐次実行になっていないか）を後からログで確認できるようにする。
  const __t0 = Date.now();
  let response;
  try {
    response = await anthropic.messages.create(
      {
        model: MODEL,
        max_tokens: Math.min(4096 * count, 16000),
        thinking: { type: "disabled" },
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: buildVariationsSchema([platform], count) },
        },
        system: buildVariationsSystemPrompt([platform], url, count, { reelMode }),
        messages: [{ role: "user", content: `【原文】\n${sourceText}` }],
      },
      { timeout: VARIATIONS_REQUEST_TIMEOUT_MS, maxRetries: 0 }
    );
  } finally {
    console.log(
      `[timing] postCopyGenerator.generateVariationsForPlatform platform=${platform} count=${count} ` +
        `startedAtMs=${__t0} durationMs=${Date.now() - __t0}`
    );
  }

  if (response.stop_reason === "refusal") {
    throw new Error("ai_refusal");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("ai_output_truncated");
  }
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) {
    throw new Error("ai_no_output");
  }
  const texts = convertVariationsToArrays(JSON.parse(textBlock.text), [platform], count)[platform];
  if (url && platform !== "instagram") {
    return texts.map((t) => ensureUrlIncluded(t, url));
  }
  return texts;
}

/**
 * generatePostCopyと同様だが、プラットフォームごとにcount件の異なるバリエーションを
 * 生成する（スケジュール投稿のラウンドロビン用）。
 *
 * プラットフォームをまとめて1回のAI呼び出しで生成すると（例: 3SNS×10パターン）出力量が
 * 大きくなり実測で70〜90秒超かかることがあり、サーバー側タイムアウト（VARIATIONS_REQUEST_TIMEOUT_MS）
 * ぎりぎりで失敗するケースが実際にあった。プラットフォームごとに呼び出しを分割しPromise.allで
 * 並列実行することで、1呼び出しあたりの出力量・所要時間を1/プラットフォーム数に抑える
 * （実測: 1SNS×10パターンで約30秒。3SNS並列でも最も遅い1本と同程度で完了する）。
 * @param {string} sourceText 原文またはURLから取得した本文
 * @param {string[]} platforms "x" | "threads" | "facebook" | "instagram" の配列
 * @param {string} [url] 投稿文に含めるべき元URL（URL指定投稿の場合のみ）
 * @param {number} count 生成するバリエーション数
 * @returns {Promise<Record<string,string[]>>} プラットフォームごとのバリエーション配列
 */
async function generatePostCopyVariations({ sourceText, platforms, url, count }) {
  const anthropic = getAnthropic();
  if (!anthropic) {
    throw new Error("anthropic_not_configured");
  }

  const perPlatform = await Promise.all(
    platforms.map((platform) =>
      generateVariationsForPlatform(anthropic, { sourceText, platform, url, count }).then((texts) => [platform, texts])
    )
  );
  return Object.fromEntries(perPlatform);
}

module.exports = { generatePostCopy, generatePostCopyVariations };
