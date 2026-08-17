// threads.jsのOAuth連携で使っているAPIバージョンに揃える。
const GRAPH_URL = "https://graph.threads.net/v1.0";

// Threadsはテキストのみの投稿にも対応しているが、Instagramと同じくメディア
// コンテナ作成→公開の2段階API。
// 画像は受け取らない（Instagram専用の画像をここで添付すると、本文中のURLに
// 対するog:imageリンクプレビューが出なくなるため。posts.js参照）。
async function postText({ userId, accessToken }, text) {
  const createParams = new URLSearchParams({ access_token: accessToken, text, media_type: "TEXT" });

  const createRes = await fetch(`${GRAPH_URL}/${userId}/threads?${createParams}`, { method: "POST" });
  const createJson = await createRes.json();
  if (!createRes.ok || createJson.error || !createJson.id) {
    throw new Error(`threads container create failed: ${JSON.stringify(createJson)}`);
  }

  const publishParams = new URLSearchParams({ creation_id: createJson.id, access_token: accessToken });
  const publishRes = await fetch(`${GRAPH_URL}/${userId}/threads_publish?${publishParams}`, { method: "POST" });
  const publishJson = await publishRes.json();
  if (!publishRes.ok || publishJson.error || !publishJson.id) {
    throw new Error(`threads publish failed: ${JSON.stringify(publishJson)}`);
  }
  return { id: publishJson.id };
}

module.exports = { postText };
