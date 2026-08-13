// 単発実行の投稿テストスクリプト。refreshXTokens.js と同様、常駐サービスではなく
// `docker compose run --rm sns-poster node src/scripts/testInstagramPost.js <slug>` で都度起動する想定。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { loadStore } = require("../lib/tokenStore");
const { logInfo, logWarn, logError } = require("../lib/logger").createLogger("instagram.log");

// routes/instagram.js の GRAPH_API_VERSION と揃える。
const GRAPH_API_VERSION = "v26.0";
const GRAPH_URL = `https://graph.instagram.com/${GRAPH_API_VERSION}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// error.code === 10 は Graph API の一般的な「権限不足」コード。
// instagram_business_content_publish がアプリのユースケースで有効化されていない場合に
// 起こりうるため、メッセージにも該当しそうなキーワードがあれば合わせてヒントを出す。
function isPermissionError(json) {
  const err = json && json.error;
  if (!err) return false;
  return err.code === 10 || /permission/i.test(err.message || "") || /content_publish/i.test(err.message || "");
}

function failWithApiError(context, json) {
  logError(`[instagram-test-post] ${context} failed: ${JSON.stringify(json)}`);
  if (isPermissionError(json)) {
    logError(
      "[instagram-test-post] instagram_business_content_publish 権限が有効になっていない可能性があります。" +
        "Meta App DashboardのInstagram Business Loginユースケース設定を確認してください。"
    );
  }
  process.exit(1);
}

async function createMediaContainer(igUserId, accessToken, imageUrl, caption) {
  const params = new URLSearchParams({
    image_url: imageUrl,
    caption,
    access_token: accessToken,
  });

  const res = await fetch(`${GRAPH_URL}/${igUserId}/media`, {
    method: "POST",
    body: params,
  });
  const json = await res.json();
  if (!res.ok || json.error || !json.id) {
    failWithApiError("media container creation", json);
  }
  return json.id;
}

// ステータス確認は推奨であり必須ではないため、呼び出し自体の失敗（ネットワークエラー等）は
// 致命的に扱わない。ただしAPIが正常応答した上でstatus_code=ERRORを返した場合は
// コンテナ自体の処理失敗を意味するため、呼び出し元で中断する。
async function checkContainerStatus(creationId, accessToken) {
  const url = new URL(`${GRAPH_URL}/${creationId}`);
  url.searchParams.set("fields", "status_code");
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url.toString());
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(`status check failed: ${JSON.stringify(json)}`);
  }
  return json.status_code;
}

async function publishMedia(igUserId, accessToken, creationId) {
  const params = new URLSearchParams({
    creation_id: creationId,
    access_token: accessToken,
  });

  const res = await fetch(`${GRAPH_URL}/${igUserId}/media_publish`, {
    method: "POST",
    body: params,
  });
  const json = await res.json();
  if (!res.ok || json.error || !json.id) {
    failWithApiError("media publish", json);
  }
  return json.id;
}

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    logError("[instagram-test-post] usage: node src/scripts/testInstagramPost.js <slug>");
    process.exit(1);
  }

  // Instagram Graph APIのimage_urlは「インターネットから取得可能な公開URL」を要求するため、
  // ローカルファイルは直接使えない。固定のテスト画像URLを環境変数で指定する。
  const imageUrl = process.env.INSTAGRAM_TEST_IMAGE_URL;
  if (!imageUrl) {
    logError("[instagram-test-post] INSTAGRAM_TEST_IMAGE_URL is not set");
    process.exit(1);
  }

  const store = loadStore();
  const ig = store[slug] && store[slug].instagram;
  if (!ig || !ig.access_token || !ig.user_id) {
    logError(`[instagram-test-post] no instagram tokens found for slug=${slug}`);
    process.exit(1);
  }

  const caption = `sns-poster テスト投稿 ${new Date().toISOString()}`;

  logInfo(`[instagram-test-post] creating media container slug=${slug}`);
  const creationId = await createMediaContainer(ig.user_id, ig.access_token, imageUrl, caption);
  logInfo(`[instagram-test-post] container created creation_id=${creationId}`);

  await sleep(2500);

  let statusCode;
  try {
    statusCode = await checkContainerStatus(creationId, ig.access_token);
    logInfo(`[instagram-test-post] container status=${statusCode}`);
  } catch (err) {
    logWarn("[instagram-test-post] status check failed, continuing without it:", err);
  }
  if (statusCode === "ERROR") {
    logError(`[instagram-test-post] media container entered ERROR state creation_id=${creationId}`);
    process.exit(1);
  }

  const postId = await publishMedia(ig.user_id, ig.access_token, creationId);
  logInfo(`[instagram-test-post] published slug=${slug} post_id=${postId}`);
  console.info(`投稿成功: post_id=${postId}`);
}

main().catch((err) => {
  logError("[instagram-test-post] unexpected failure:", err);
  process.exit(1);
});
