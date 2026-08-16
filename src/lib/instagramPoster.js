// instagram.jsのOAuth連携で使っているgraph.instagram.comホスト・APIバージョンに揃える。
const GRAPH_API_VERSION = "v26.0";
const GRAPH_URL = `https://graph.instagram.com/${GRAPH_API_VERSION}`;

// Instagram Graph APIの仕様上テキストのみの投稿はできないため、imageUrl必須。
// メディアコンテナ作成→公開の2段階API。
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
