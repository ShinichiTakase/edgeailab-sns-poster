// 原文（またはURL本文）から各SNS向けに最適化した投稿文をAIで生成する。
// モデルはclaude-opus-5固定。構造化出力（json_schema）で選択したSNSぶんのキーのみを
// 直接JSONとして受け取り、テキストパースの脆さを避ける。
const { getAnthropic } = require("./anthropicClient");

const MODEL = "claude-opus-5";
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
    "X（旧Twitter）向け: 文字数上限280字を厳守。1〜2文の簡潔な文章＋ハッシュタグ1〜2個に絞ること。" +
    "URLを含める場合、実際の文字数によらず短縮URLとして23文字で計算されるため、それを踏まえて280文字に収めること。",
  threads:
    "Threads向け: 文字数上限は500字だが、実際に最後まで読まれるのは3〜5文・150〜250字程度。それを目安に収めること。" +
    "カジュアルな口語調で書き、文末は質問形式など会話を誘発する結びにすること。",
  facebook:
    "Facebook向け: 明確な文字数上限はないが、実際に読まれるのは冒頭2〜3文程度で、続きは「…続きを読む」で折りたたまれる。" +
    "最初の1〜2文で要点を伝え、全体は3〜5文程度の簡潔な段落構成にまとめること。",
  instagram:
    "Instagram向け: 文字数上限は2200字だが、モバイルアプリでは冒頭約125字を超えると「…続きを見る」で折りたたまれるため、" +
    "冒頭125字以内に最も伝えたい情報を入れること。全体は3〜5文程度の簡潔な構成にとどめ、原文の詳細を長々と展開しないこと。" +
    "本文中のURLはInstagramの仕様上クリックできないため、URLに言及する場合も「プロフィールのリンクから」程度の案内に留め、" +
    "URL誘導に文字数を割かないこと。ハッシュタグは3〜5個程度を末尾にまとめて付けること。",
};

function buildSystemPrompt(platforms, url) {
  const guidance = platforms.map((p) => `- ${PLATFORM_GUIDANCE[p]}`).join("\n");
  const urlInstruction = url
    ? "\n各プラットフォームの投稿文の末尾に、必ず次のURLをそのまま含めてください: " +
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
    "各プラットフォームの特性を踏まえ、必要に応じてハッシュタグを付与してください。",
    guidance,
    urlInstruction,
    "出力は指定されたJSON形式のみとし、説明文や前置き・後書きは一切含めないでください。",
  ]
    .filter(Boolean)
    .join("\n");
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

  const response = await anthropic.messages.create(
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
  return JSON.parse(textBlock.text);
}

function buildVariationsSystemPrompt(platforms, url, count) {
  const base = buildSystemPrompt(platforms, url);
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
 * generatePostCopyと同様だが、プラットフォームごとにcount件の異なるバリエーションを
 * 1回のAI呼び出しでまとめて生成する（スケジュール投稿のラウンドロビン用）。
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

  const response = await anthropic.messages.create(
    {
      model: MODEL,
      // 単発生成時のmax_tokens:4096の根拠（プラットフォームあたり最大2000トークン超）に
      // count倍の余裕を持たせる。4SNS×10パターンでも打ち切られないようにするため。
      max_tokens: Math.min(4096 * count, 32000),
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: buildVariationsSchema(platforms, count) },
      },
      system: buildVariationsSystemPrompt(platforms, url, count),
      messages: [{ role: "user", content: `【原文】\n${sourceText}` }],
    },
    { timeout: VARIATIONS_REQUEST_TIMEOUT_MS, maxRetries: 0 }
  );

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
  return convertVariationsToArrays(JSON.parse(textBlock.text), platforms, count);
}

module.exports = { generatePostCopy, generatePostCopyVariations };
