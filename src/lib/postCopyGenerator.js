// 原文（またはURL本文）から各SNS向けに最適化した投稿文をAIで生成する。
// モデルはclaude-opus-5固定。構造化出力（json_schema）で選択したSNSぶんのキーのみを
// 直接JSONとして受け取り、テキストパースの脆さを避ける。
const { getAnthropic } = require("./anthropicClient");

const MODEL = "claude-opus-5";
// 同期HTTPリクエストでユーザーが応答を待っているため、SDKデフォルトの10分は長すぎる。
const REQUEST_TIMEOUT_MS = 30000;

const PLATFORM_GUIDANCE = {
  x: "X（旧Twitter）向け: 280文字以内。簡潔でインパクトのある文章にすること。",
  threads: "Threads向け: 500文字以内。カジュアルで親しみやすいトーンにすること。",
  facebook: "Facebook向け: 簡潔にまとめること。要点を絞った文章にすること。",
  instagram: "Instagram向け: 2200文字を目安に。ハッシュタグを活用し、ビジュアルを想起させる表現にすること。",
};

function buildSystemPrompt(platforms, url) {
  const guidance = platforms.map((p) => `- ${PLATFORM_GUIDANCE[p]}`).join("\n");
  const urlInstruction = url
    ? `\n各プラットフォームの投稿文の末尾に、必ず次のURLをそのまま含めてください: ${url}`
    : "";
  return [
    "あなたはSNS運用代行のプロのコピーライターです。",
    "与えられた原文をもとに、指定された各SNSプラットフォーム向けに最適化された投稿文を作成してください。",
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
      max_tokens: 2048,
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: buildSchema(platforms) },
      },
      system: buildSystemPrompt(platforms, url),
      messages: [{ role: "user", content: `【原文】\n${sourceText}` }],
    },
    { timeout: REQUEST_TIMEOUT_MS }
  );

  if (response.stop_reason === "refusal") {
    throw new Error("ai_refusal");
  }
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) {
    throw new Error("ai_no_output");
  }
  return JSON.parse(textBlock.text);
}

module.exports = { generatePostCopy };
