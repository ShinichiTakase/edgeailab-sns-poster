// instagram.jsのOAuth連携で使っているgraph.instagram.comホスト・APIバージョンに揃える。
const GRAPH_API_VERSION = "v26.0";
const GRAPH_URL = `https://graph.instagram.com/${GRAPH_API_VERSION}`;

// メディアコンテナ作成後、Instagram側がimage_urlから画像を取得・処理し終える前に
// media_publishを呼ぶと "Media ID is not available"（code 9007）で失敗する。
// status_codeがFINISHEDになるまでポーリングして待つ（Meta公式ドキュメント推奨パターン）。
const CONTAINER_POLL_INTERVAL_MS = 1000;
const CONTAINER_POLL_MAX_ATTEMPTS = 30; // 1秒間隔で最大30秒

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForContainerReady(containerId, accessToken) {
  for (let attempt = 1; attempt <= CONTAINER_POLL_MAX_ATTEMPTS; attempt++) {
    const statusRes = await fetch(
      `${GRAPH_URL}/${containerId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`
    );
    const statusJson = await statusRes.json();
    if (!statusRes.ok || statusJson.error) {
      throw new Error(`instagram container status check failed: ${JSON.stringify(statusJson)}`);
    }

    if (statusJson.status_code === "FINISHED") {
      return attempt * CONTAINER_POLL_INTERVAL_MS;
    }
    if (statusJson.status_code === "ERROR" || statusJson.status_code === "EXPIRED") {
      throw new Error(`instagram container processing failed: status_code=${statusJson.status_code}`);
    }
    // IN_PROGRESS（想定外のstatus_codeが来た場合も含め、ポーリングを継続する）。
    if (attempt < CONTAINER_POLL_MAX_ATTEMPTS) {
      await sleep(CONTAINER_POLL_INTERVAL_MS);
    }
  }
  // タイムアウトは「投稿失敗」全般とは区別できるよう専用のエラーメッセージにする
  // （呼び出し元でこの文言をログに残すことで、Meta側の処理遅延によるものと切り分けられる）。
  throw new Error(
    `instagram_processing_timeout: Instagram側のメディア処理待ちが${(CONTAINER_POLL_MAX_ATTEMPTS * CONTAINER_POLL_INTERVAL_MS) / 1000}秒でタイムアウトしました`
  );
}

// Instagram Graph APIの仕様上テキストのみの投稿はできないため、imageUrl必須。
// メディアコンテナ作成→(処理完了待ち)→公開の3段階。
async function postImage({ igUserId, accessToken }, text, imageUrl) {
  if (!imageUrl) {
    throw new Error("image_required");
  }

  const createRes = await fetch(`${GRAPH_URL}/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_url: imageUrl, caption: text, access_token: accessToken }),
  });
  const createJson = await createRes.json();
  if (!createRes.ok || createJson.error || !createJson.id) {
    throw new Error(`instagram media create failed: ${JSON.stringify(createJson)}`);
  }

  await waitForContainerReady(createJson.id, accessToken);

  const publishRes = await fetch(`${GRAPH_URL}/${igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: createJson.id, access_token: accessToken }),
  });
  const publishJson = await publishRes.json();
  if (!publishRes.ok || publishJson.error || !publishJson.id) {
    throw new Error(`instagram publish failed: ${JSON.stringify(publishJson)}`);
  }
  return { id: publishJson.id };
}

module.exports = { postImage };
