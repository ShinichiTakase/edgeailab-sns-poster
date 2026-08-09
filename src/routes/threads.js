const express = require("express");
const crypto = require("crypto");
const { savePlatformTokens } = require("../lib/tokenStore");

const router = express.Router();

const SUCCESS_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>連携完了</title></head>
<body><p>連携が完了しました。このページを閉じてください。</p></body></html>`;

const ERROR_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>エラー</title></head>
<body><p>エラーが発生しました。担当者にご連絡ください。</p></body></html>`;

router.get("/threads/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) {
    console.error("[threads/callback] missing code query param");
    return res.status(400).send(ERROR_HTML);
  }

  try {
    const shortLived = await exchangeShortLivedToken(code);
    const longLived = await exchangeLongLivedToken(shortLived.access_token);
    const profile = await fetchProfile(longLived.access_token);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + longLived.expires_in * 1000);

    savePlatformTokens(profile.username, "threads", {
      user_id: profile.id,
      access_token: longLived.access_token,
      token_expires_at: expiresAt.toISOString(),
      updated_at: now.toISOString(),
    });

    console.info(`[threads/callback] linked username=${profile.username} expires_at=${expiresAt.toISOString()}`);
    return res.send(SUCCESS_HTML);
  } catch (err) {
    console.error("[threads/callback] failed:", err);
    return res.status(500).send(ERROR_HTML);
  }
});

router.post("/threads/deauthorize", express.urlencoded({ extended: false }), (req, res) => {
  console.info("[threads/deauthorize] received:", req.body);
  res.sendStatus(200);
});

router.post("/threads/data-deletion", express.urlencoded({ extended: false }), (req, res) => {
  console.info("[threads/data-deletion] received:", req.body);
  const confirmationCode = crypto.randomBytes(8).toString("hex");
  res.json({
    url: `https://edgeailab.net/threads/data-deletion?id=${confirmationCode}`,
    confirmation_code: confirmationCode,
  });
});

async function exchangeShortLivedToken(code) {
  const params = new URLSearchParams({
    client_id: process.env.THREADS_APP_ID,
    client_secret: process.env.THREADS_APP_SECRET,
    grant_type: "authorization_code",
    redirect_uri: process.env.THREADS_REDIRECT_URI,
    code,
  });

  const res = await fetch("https://graph.threads.net/oauth/access_token", {
    method: "POST",
    body: params,
  });
  const json = await res.json();
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(`short-lived token exchange failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function exchangeLongLivedToken(shortLivedToken) {
  const url = new URL("https://graph.threads.net/access_token");
  url.searchParams.set("grant_type", "th_exchange_token");
  url.searchParams.set("client_secret", process.env.THREADS_APP_SECRET);
  url.searchParams.set("access_token", shortLivedToken);

  const res = await fetch(url.toString());
  const json = await res.json();
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(`long-lived token exchange failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function fetchProfile(accessToken) {
  const url = new URL("https://graph.threads.net/v1.0/me");
  url.searchParams.set("fields", "id,username");
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url.toString());
  const json = await res.json();
  if (!res.ok || json.error || !json.username) {
    throw new Error(`profile fetch failed: ${JSON.stringify(json)}`);
  }
  return json;
}

module.exports = router;
