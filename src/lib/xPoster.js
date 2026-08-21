const { fetchOgImage } = require("./ogImageFetcher");

const TWEETS_URL = "https://api.x.com/2/tweets";
const MEDIA_UPLOAD_URL = "https://api.x.com/2/media/upload";

// リンクカードの小さいアイコン表示問題（X側がog:imageのフォールバックを確実に行わないため。
// ogImageFetcher.js参照）を避けるため、記事のog:image自体をツイートに画像添付する。
// v2の画像アップロードはINIT/APPEND/FINALIZEの3段階（v1.1メディアアップロードと同じ手順）。
// このエンドポイントの利用には media.write スコープが必須（x.jsのSCOPE参照。既存連携済み
// アカウントは追加スコップ取得のため再連携が必要）。
async function uploadImage(accessToken, imageBuffer, mimeType) {
  const authHeader = { Authorization: `Bearer ${accessToken}` };

  const initRes = await fetch(MEDIA_UPLOAD_URL, {
    method: "POST",
    headers: { ...authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      command: "INIT",
      total_bytes: imageBuffer.length,
      media_type: mimeType,
      media_category: "tweet_image",
    }),
  });
  const initJson = await initRes.json();
  if (!initRes.ok || initJson.errors) {
    throw new Error(`x media init failed: ${JSON.stringify(initJson)}`);
  }
  const mediaId = initJson.data.id;

  const form = new FormData();
  form.append("command", "APPEND");
  form.append("media_id", mediaId);
  form.append("segment_index", "0");
  form.append("media", new Blob([imageBuffer], { type: mimeType }), "image");
  const appendRes = await fetch(MEDIA_UPLOAD_URL, {
    method: "POST",
    headers: authHeader,
    body: form,
  });
  if (!appendRes.ok && appendRes.status !== 204) {
    const text = await appendRes.text().catch(() => "");
    throw new Error(`x media append failed: ${appendRes.status} ${text.slice(0, 300)}`);
  }

  const finalizeRes = await fetch(MEDIA_UPLOAD_URL, {
    method: "POST",
    headers: { ...authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({ command: "FINALIZE", media_id: mediaId }),
  });
  const finalizeJson = await finalizeRes.json();
  if (!finalizeRes.ok || finalizeJson.errors) {
    throw new Error(`x media finalize failed: ${JSON.stringify(finalizeJson)}`);
  }

  return mediaId;
}

async function postText(accessToken, text, mediaId) {
  const body = { text };
  if (mediaId) body.media = { media_ids: [mediaId] };
  const res = await fetch(TWEETS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`tweet post failed: ${JSON.stringify(json)}`);
  }
  return { id: json.data.id };
}

// 本文中のリンク先ページのog:imageを画像添付して投稿する（呼び出し側postToPlatformの共通処理）。
// og:image取得（fetchOgImage、失敗時null）・アップロード（media.writeスコープ未取得時など失敗しうる）
// のどちらが失敗しても、テキストのみのツイートにフォールバックする（失敗しても投稿自体は続行する）。
async function postTextWithLinkImage(accessToken, text, url, onImageAttachFailed) {
  let mediaId = null;
  if (url) {
    try {
      const image = await fetchOgImage(url);
      if (image) mediaId = await uploadImage(accessToken, image.buffer, image.mimeType);
    } catch (err) {
      if (onImageAttachFailed) onImageAttachFailed(err);
    }
  }
  return postText(accessToken, text, mediaId);
}

module.exports = { postText, uploadImage, postTextWithLinkImage };
