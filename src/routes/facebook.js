const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { savePlatformTokens, deletePlatformTokensByUserId, findDuplicateOwner } = require("../lib/tokenStore");
const pkceStore = require("../lib/pkceStore");
const { requireAuth, blockExpiredTrial, blockViewerRoleRedirect, blockEditorRoleRedirect, blockApproverRoleRedirect } = require("../middleware/requireAuth");
const { requireSnsConnectionAvailable } = require("../middleware/snsConnectionGuard");

const router = express.Router();

// x-refresh.log と同様、json/ 配下（volumeマウントでコンテナ再ビルド後も残る）に
// 標準出力とは別で永続化する。docker logsのローテーションで消える前の記録用。
const LOG_FILE = path.join(__dirname, "..", "..", "json", "facebook.log");

function writeLogFile(level, args) {
  const message = args
    .map((a) => (a instanceof Error ? a.stack : typeof a === "object" ? JSON.stringify(a) : a))
    .join(" ");
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    console.error("[facebook] failed to write log file:", err);
  }
}

function logInfo(...args) {
  console.info(...args);
  writeLogFile("info", args);
}

function logWarn(...args) {
  console.warn(...args);
  writeLogFile("warn", args);
}

function logError(...args) {
  console.error(...args);
  writeLogFile("error", args);
}

const SUCCESS_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>連携完了</title>
<style>
  body { display: flex; justify-content: center; margin: 0; padding-top: 15vh; font-family: sans-serif; }
  .box { border: 2px solid #333; border-radius: 8px; padding: 2rem 3rem; text-align: center; }
</style>
</head>
<body><div class="box">
  <p id="msg">Facebookページの連携が完了しました。連携設定ページに戻ります…</p>
  <p><a id="fallback-link" href="/onboarding.html?connected=facebook">戻らない場合はこちら</a></p>
</div>
<script>
  (function () {
    var backUrl = "/onboarding.html?connected=facebook";
    if (window.opener && window.opener !== window) {
      document.getElementById("msg").textContent = "Facebookページの連携が完了しました。このタブを閉じてダッシュボードにお戻りください。";
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

const GRAPH_API_VERSION = "v26.0";
const AUTHORIZE_URL = `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`;
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// 動作確認・実運用の両方でこのエンドポイントから開始する。
// state を発行してslug（クライアント識別子）と紐付け、Xの実装と同じ方式でコールバックへ受け渡す。
router.get("/oauth/facebook/start", requireAuth, blockExpiredTrial, blockViewerRoleRedirect, blockEditorRoleRedirect, blockApproverRoleRedirect, requireSnsConnectionAvailable("facebook"), (req, res) => {
  const slug = req.customer.id;

  const state = crypto.randomBytes(24).toString("hex");
  pkceStore.put(state, { slug });

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", process.env.FACEBOOK_APP_ID);
  url.searchParams.set("redirect_uri", process.env.FACEBOOK_REDIRECT_URI);
  url.searchParams.set("config_id", process.env.FACEBOOK_CONFIG_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);

  res.redirect(url.toString());
});

router.get("/oauth/facebook/callback", async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  if (error) {
    logError(`[facebook/callback] provider returned error: ${error} ${errorDescription || ""}`);
    return res.status(400).send(ERROR_HTML);
  }
  if (!code || !state) {
    logError("[facebook/callback] missing code or state query param");
    return res.status(400).send(ERROR_HTML);
  }

  const entry = pkceStore.take(state);
  if (!entry) {
    logError("[facebook/callback] state mismatch or expired");
    return res.status(400).send(ERROR_HTML);
  }
  const { slug } = entry;

  try {
    const shortLived = await exchangeShortLivedToken(code);
    const longLived = await exchangeLongLivedToken(shortLived.access_token);
    const userId = await fetchUserId(longLived.access_token);
    const pages = await fetchManagedPages(longLived.access_token);

    if (pages.length === 0) {
      logError(`[facebook/callback] no managed pages for slug=${slug}`);
      return res.status(400).send(ERROR_HTML);
    }

    const verifiedPages = await verifyPages(pages);
    if (verifiedPages.length === 0) {
      logError(`[facebook/callback] no pages passed verification for slug=${slug}`);
      return res.status(400).send(ERROR_HTML);
    }

    const duplicate = findDuplicateOwner(
      "facebook",
      verifiedPages.map((p) => p.pageId),
      slug
    );
    if (duplicate) {
      logWarn(
        `[facebook/callback] duplicate page: slug=${slug} pageId=${duplicate.identifier} already linked to slug=${duplicate.slug}`
      );
      return res.redirect("/upgrade.html?reason=duplicate_account");
    }

    const now = new Date();
    savePlatformTokens(slug, "facebook", {
      user_id: userId,
      pages: verifiedPages,
      updated_at: now.toISOString(),
    });

    logInfo(
      `[facebook/callback] linked slug=${slug} pages=${verifiedPages.map((p) => p.pageName).join(", ")}`
    );
    return res.send(SUCCESS_HTML);
  } catch (err) {
    logError("[facebook/callback] failed:", err);
    return res.status(500).send(ERROR_HTML);
  }
});

router.post(
  "/api/facebook/data-deletion-callback",
  express.urlencoded({ extended: false }),
  (req, res) => {
    try {
      const { signed_request: signedRequest } = req.body;
      if (!signedRequest) {
        return res.status(400).json({ error: "signed_request is missing" });
      }

      const payload = parseSignedRequest(signedRequest, process.env.FACEBOOK_APP_SECRET);
      const userId = payload.user_id;

      const affectedSlugs = deletePlatformTokensByUserId("facebook", userId);
      logInfo(
        `[facebook/data-deletion] user_id=${userId} removed from slugs=[${affectedSlugs.join(", ")}]`
      );

      const confirmationCode = crypto.randomBytes(8).toString("hex");
      res.json({
        url: `https://edgeailab.net/facebook/data-deletion?id=${confirmationCode}`,
        confirmation_code: confirmationCode,
      });
    } catch (err) {
      logError("[facebook/data-deletion] failed:", err);
      res.status(400).json({ error: "signed_request verification failed" });
    }
  }
);

function parseSignedRequest(signedRequest, appSecret) {
  const [encodedSig, encodedPayload] = signedRequest.split(".");
  if (!encodedSig || !encodedPayload) {
    throw new Error("malformed signed_request");
  }

  const sig = Buffer.from(encodedSig.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const expectedSig = crypto.createHmac("sha256", appSecret).update(encodedPayload).digest();

  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(sig, expectedSig)) {
    throw new Error("signed_request signature mismatch");
  }

  const decoded = Buffer.from(encodedPayload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
    "utf-8"
  );
  return JSON.parse(decoded);
}

async function exchangeShortLivedToken(code) {
  const url = new URL(`${GRAPH_URL}/oauth/access_token`);
  url.searchParams.set("client_id", process.env.FACEBOOK_APP_ID);
  url.searchParams.set("client_secret", process.env.FACEBOOK_APP_SECRET);
  url.searchParams.set("redirect_uri", process.env.FACEBOOK_REDIRECT_URI);
  url.searchParams.set("code", code);

  const res = await fetch(url.toString());
  const json = await res.json();
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(`short-lived token exchange failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function exchangeLongLivedToken(shortLivedToken) {
  const url = new URL(`${GRAPH_URL}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", process.env.FACEBOOK_APP_ID);
  url.searchParams.set("client_secret", process.env.FACEBOOK_APP_SECRET);
  url.searchParams.set("fb_exchange_token", shortLivedToken);

  const res = await fetch(url.toString());
  const json = await res.json();
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(`long-lived token exchange failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function fetchUserId(accessToken) {
  const url = new URL(`${GRAPH_URL}/me`);
  url.searchParams.set("fields", "id");
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url.toString());
  const json = await res.json();
  if (!res.ok || json.error || !json.id) {
    throw new Error(`user id fetch failed: ${JSON.stringify(json)}`);
  }
  return json.id;
}

async function fetchManagedPages(accessToken) {
  const url = new URL(`${GRAPH_URL}/me/accounts`);
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url.toString());
  const json = await res.json();
  if (!res.ok || json.error || !json.data) {
    throw new Error(`managed pages fetch failed: ${JSON.stringify(json)}`);
  }
  return json.data;
}

// 投稿前の運用標準（Threads/Xと同様）：取得したトークンで読み取り専用API呼び出しを行い、
// 検証に失敗したページは保存対象から除外する。
async function verifyPages(pages) {
  const verified = [];
  for (const page of pages) {
    const url = new URL(`${GRAPH_URL}/${page.id}`);
    url.searchParams.set("fields", "name");
    url.searchParams.set("access_token", page.access_token);

    const res = await fetch(url.toString());
    const json = await res.json();

    if (res.ok && !json.error && json.name) {
      verified.push({
        pageId: page.id,
        pageName: json.name,
        pageAccessToken: page.access_token,
      });
    } else {
      logWarn(`[facebook/callback] page verification failed for ${page.id}:`, json);
    }
  }
  return verified;
}

module.exports = router;
