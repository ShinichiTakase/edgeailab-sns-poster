// instagram.jsのOAuth連携で使っているgraph.instagram.comホスト・APIバージョンに揃える。
const GRAPH_API_VERSION = "v26.0";
const GRAPH_URL = `https://graph.instagram.com/${GRAPH_API_VERSION}`;

// メディアコンテナ作成後、Instagram側がimage_urlから画像を取得・処理し終える前に
// media_publishを呼ぶと "Media ID is not available"（code 9007）で失敗する。
// status_codeがFINISHEDになるまでポーリングして待つ（Meta公式ドキュメント推奨パターン）。
const CONTAINER_POLL_INTERVAL_MS = 1000;
const CONTAINER_POLL_MAX_ATTEMPTS = 30; // 1秒間隔で最大30秒（画像用）
// 動画（リール）はMeta側のエンコード・処理に画像より時間がかかるため、
// 2秒間隔で最大4分まで待つ。
const VIDEO_CONTAINER_POLL_INTERVAL_MS = 2000;
const VIDEO_CONTAINER_POLL_MAX_ATTEMPTS = 120;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForContainerReady(
  containerId,
  accessToken,
  { intervalMs = CONTAINER_POLL_INTERVAL_MS, maxAttempts = CONTAINER_POLL_MAX_ATTEMPTS } = {}
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const statusRes = await fetch(
      `${GRAPH_URL}/${containerId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`
    );
    const statusJson = await statusRes.json();
    if (!statusRes.ok || statusJson.error) {
      throw new Error(`instagram container status check failed: ${JSON.stringify(statusJson)}`);
    }

    if (statusJson.status_code === "FINISHED") {
      return attempt * intervalMs;
    }
    if (statusJson.status_code === "ERROR" || statusJson.status_code === "EXPIRED") {
      throw new Error(`instagram container processing failed: status_code=${statusJson.status_code}`);
    }
    // IN_PROGRESS（想定外のstatus_codeが来た場合も含め、ポーリングを継続する）。
    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }
  // タイムアウトは「投稿失敗」全般とは区別できるよう専用のエラーメッセージにする
  // （呼び出し元でこの文言をログに残すことで、Meta側の処理遅延によるものと切り分けられる）。
  throw new Error(
    `instagram_processing_timeout: Instagram側のメディア処理待ちが${(maxAttempts * intervalMs) / 1000}秒でタイムアウトしました`
  );
}

// Instagram Graph APIの仕様上テキストのみの投稿はできないため、imageUrl必須。
// メディアコンテナ作成→(処理完了待ち)→公開の3段階。
async function postImage({ igUserId, accessToken }, text, imageUrl, { existingContainerId = null, onContainerCreated } = {}) {
  if (!imageUrl) {
    throw new Error("image_required");
  }

  let containerId = existingContainerId;
  if (!containerId) { const createRes = await fetch(`${GRAPH_URL}/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_url: imageUrl, caption: text, access_token: accessToken }),
  });
  const createJson = await createRes.json();
  if (!createRes.ok || createJson.error || !createJson.id) {
    throw new Error(`instagram media create failed: ${JSON.stringify(createJson)}`);
  }

  containerId = createJson.id;
  if (onContainerCreated) await onContainerCreated(containerId);
  }

  await waitForContainerReady(containerId, accessToken);

  const publishRes = await fetch(`${GRAPH_URL}/${igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: containerId, access_token: accessToken }),
  });
  const publishJson = await publishRes.json();
  if (!publishRes.ok || publishJson.error || !publishJson.id) {
    throw new Error(`instagram publish failed: ${JSON.stringify(publishJson)}`);
  }
  return { id: publishJson.id, containerId };
}

// Instagramリール（動画）投稿。media_type: "REELS"でコンテナ作成→処理完了待ち→公開の3段階。
// 画像と異なりMeta側の動画エンコード処理に数十秒〜数分かかりうるため、専用のポーリング設定を使う。
async function postReel({ igUserId, accessToken }, text, videoUrl, { existingContainerId = null, onContainerCreated } = {}) {
  if (!videoUrl) {
    throw new Error("video_required");
  }

  let containerId = existingContainerId;
  if (!containerId) { const createRes = await fetch(`${GRAPH_URL}/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      media_type: "REELS",
      video_url: videoUrl,
      caption: text || "",
      // share_to_feedを省略するとMeta側デフォルトのtrue扱いになり、リールタブに加えて
      // プロフィールのグリッド（フィード）にも自動的に二重掲載されてしまう。
      // リールのみに投稿するため明示的にfalseを指定する。
      share_to_feed: false,
      access_token: accessToken,
    }),
  });
  const createJson = await createRes.json();
  if (!createRes.ok || createJson.error || !createJson.id) {
    throw new Error(`instagram reel media create failed: ${JSON.stringify(createJson)}`);
  }

  containerId = createJson.id;
  if (onContainerCreated) await onContainerCreated(containerId);
  }

  await waitForContainerReady(containerId, accessToken, {
    intervalMs: VIDEO_CONTAINER_POLL_INTERVAL_MS,
    maxAttempts: VIDEO_CONTAINER_POLL_MAX_ATTEMPTS,
  });

  const publishRes = await fetch(`${GRAPH_URL}/${igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: containerId, access_token: accessToken }),
  });
  const publishJson = await publishRes.json();
  if (!publishRes.ok || publishJson.error || !publishJson.id) {
    throw new Error(`instagram reel publish failed: ${JSON.stringify(publishJson)}`);
  }
  return { id: publishJson.id, containerId };
}

module.exports = { postImage, postReel };
