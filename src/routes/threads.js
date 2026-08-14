const express = require("express");
const crypto = require("crypto");
const { savePlatformTokens } = require("../lib/tokenStore");
const pkceStore = require("../lib/pkceStore");
const { requireAuth } = require("../middleware/requireAuth");

const router = express.Router();

const SUCCESS_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>連携完了</title></head>
<body>
  <p id="msg">Threadsアカウントの連携が完了しました。連携設定ページに戻ります…</p>
  <p><a id="fallback-link" href="/onboarding.html?connected=threads">戻らない場合はこちら</a></p>
  <script>
    (function () {
      var backUrl = "/onboarding.html?connected=threads";
      if (window.opener && window.opener !== window) {
        document.getElementById("msg").textContent = "Threadsアカウントの連携が完了しました。このタブを閉じてダッシュボードにお戻りください。";
        document.getElementById("fallback-link").style.display = "none";
      } else {
        setTimeout(function () { location.href = backUrl; }, 1200);
      }
    })();
  </script>
</body></html>`;

const ERROR_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>エラー</title></head>
<body><p>エラーが発生しました。担当者にご連絡ください。</p></body></html>`;

const AUTHORIZE_URL = "https://threads.net/oauth/authorize";
const SCOPE = "threads_basic,threads_content_publish";

// requireAuthでログイン中の顧客のみ開始でき、req.customer.id（microCMSの顧客レコードid）を
// slug（json/client_tokens.jsonのキー）としてstateに紐付ける。Facebook/Instagramと同じ方式。
router.get("/oauth/threads/start", requireAuth, (req, res) => {
  const slug = req.customer.id;
  const state = crypto.randomBytes(24).toString("hex");
  pkceStore.put(state, { slug });

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", process.env.THREADS_APP_ID);
  url.searchParams.set("redirect_uri", process.env.THREADS_REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);

  res.redirect(url.toString());
});

router.get("/threads/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    console.error(`[threads/callback] provider returned error: ${error}`);
    return res.status(400).send(ERROR_HTML);
  }
  if (!code || !state) {
    console.error("[threads/callback] missing code or state query param");
    return res.status(400).send(ERROR_HTML);
  }

  const entry = pkceStore.take(state);
  if (!entry) {
    console.error("[threads/callback] state mismatch or expired");
    return res.status(400).send(ERROR_HTML);
  }
  const { slug } = entry;

  try {
    const shortLived = await exchangeShortLivedToken(code);
    const longLived = await exchangeLongLivedToken(shortLived.access_token);
    const profile = await fetchProfile(longLived.access_token);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + longLived.expires_in * 1000);

    savePlatformTokens(slug, "threads", {
      user_id: profile.id,
      username: profile.username,
      access_token: longLived.access_token,
      token_expires_at: expiresAt.toISOString(),
      updated_at: now.toISOString(),
    });

    console.info(`[threads/callback] linked slug=${slug} username=${profile.username} expires_at=${expiresAt.toISOString()}`);
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
