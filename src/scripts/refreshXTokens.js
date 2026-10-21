const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { loadStore, savePlatformTokens } = require("../lib/tokenStore");
const { notifyFailure } = require("../lib/mailer");

const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const REFRESH_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 3; // ネットワークエラー時の1回の実行内の試行回数
const RETRY_DELAY_MS = 5000;
const NOTIFY_AFTER_CONSECUTIVE_FAILURES = 3; // 15分cron×3回≒約45分
const BODY_EXCERPT_LEN = 200;

// 顧客単位の連続失敗回数。リフレッシュは15分ごとに別プロセスで走るためファイルに保持する。
function statePath() {
  return process.env.X_REFRESH_STATE_PATH || path.join(__dirname, "..", "..", "data", "x-refresh-failures.json");
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath(), "utf-8")) || {}; } catch { return {}; }
}
function saveState(state) {
  const tmp = `${statePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, statePath());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 本文はトークン値を含み得るため、access_token/refresh_tokenの値をマスクして先頭のみ使う。
function excerpt(text) {
  return String(text ?? "").replace(/("?(?:access_token|refresh_token)"?\s*[:=]\s*"?)[^"&,\s}]+/gi, "$1***").slice(0, BODY_EXCERPT_LEN);
}
function isNetworkError(err) {
  return err.status === undefined;
}
function describeError(err) {
  const parts = [`エラー: ${err.message}`];
  const code = err.cause?.code;
  if (code) parts.push(`cause.code: ${code}`);
  if (err.status !== undefined) parts.push(`HTTPステータス: ${err.status}`);
  if (err.body) parts.push(`本文(先頭${BODY_EXCERPT_LEN}文字): ${err.body}`);
  return parts.join("\n");
}
// 400/401は、invalid_grantかどうかに関わらずrefresh_token失効（または認証情報不正）の可能性が高いため
// 即時に再認可を案内する。429/5xx/ネットワークエラーは一時的な問題として扱う。
function isLikelyRevoked(err) {
  return err.status === 400 || err.status === 401;
}


function basicAuthHeader() {
  const raw = `${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

function basicAuthHeader() {
  const raw = `${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

async function requestToken(xData) {
  // fetchが投げる例外は応答なし（DNS/接続/タイムアウト等）。status/bodyは付かない=ネットワークエラー。
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: xData.refresh_token,
      client_id: process.env.X_CLIENT_ID,
    }),
  });
  const text = typeof res.text === "function" ? await res.text() : JSON.stringify(await res.json());
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非JSON */ }
  if (!res.ok || !json || json.error || !json.access_token) {
    const err = new Error(`refresh failed: HTTP ${res.status}${json?.error ? ` ${json.error}` : ""}`);
    err.status = res.status;
    err.errorCode = json?.error;
    err.body = excerpt(text);
    throw err;
  }
  return json;
}

async function refreshOne(slug, xData, { sleepFn = sleep } = {}) {
  let json;
  for (let attempt = 1; ; attempt++) {
    try {
      json = await requestToken(xData);
      break;
    } catch (err) {
      if (!isNetworkError(err) || attempt >= MAX_ATTEMPTS) {
        err.attempts = attempt;
        throw err;
      }
      console.warn(`[x-refresh] slug=${slug} network error (cause.code=${err.cause?.code}) attempt ${attempt}/${MAX_ATTEMPTS}, retrying`);
      await sleepFn(RETRY_DELAY_MS);
    }
  }

  // Xはリフレッシュ時にrefresh_tokenをローテーションし旧トークンは無効になるため、
  // 応答を受けた直後（他の処理より前）に保存する。
  const now = new Date();
  const expiresAt = new Date(now.getTime() + json.expires_in * 1000);
  savePlatformTokens(slug, "x", {
    ...xData,
    access_token: json.access_token,
    refresh_token: json.refresh_token || xData.refresh_token,
    token_expires_at: expiresAt.toISOString(),
    updated_at: now.toISOString(),
  });
  console.info(`[x-refresh] refreshed slug=${slug} expires_at=${expiresAt.toISOString()}`);
}

async function handleFailure(slug, err, state) {
  const entry = state[slug] || { consecutiveFailures: 0, reauthNotified: false };
  entry.consecutiveFailures += 1;
  entry.lastFailureAt = new Date().toISOString();
  entry.lastCause = err.cause?.code || (err.status !== undefined ? `HTTP ${err.status}` : "unknown");
  state[slug] = entry;
  console.error(
    `[x-refresh] slug=${slug} failed (consecutive=${entry.consecutiveFailures}, attempts=${err.attempts || 1}) ` +
    `message=${err.message} cause.code=${err.cause?.code ?? "-"} status=${err.status ?? "-"} body=${err.body ?? "-"}`
  );
  if (err.cause && !err.cause.code) console.error(err.cause);

  if (isLikelyRevoked(err)) {
    if (entry.reauthNotified) return; // 毎回(15分ごと)の再送を避ける。成功時にリセット。
    entry.reauthNotified = true;
    await notifyFailure(
      `[edgeailab] Xの再認可が必要です (slug=${slug})`,
      [
        `slug: ${slug}`,
        describeError(err),
        "",
        "refresh_tokenが失効している可能性が高いです（HTTP 400/401）。対象の契約でログインした状態で、以下にアクセスして再認可してください:",
        `https://edgeailab.net/oauth/x/authorize?slug=${encodeURIComponent(slug)}`,
      ].join("\n")
    );
    return;
  }

  if (entry.consecutiveFailures === NOTIFY_AFTER_CONSECUTIVE_FAILURES) {
    await notifyFailure(
      `[edgeailab] Xトークンのリフレッシュが一時的に失敗しています (slug=${slug})`,
      [
        `slug: ${slug}`,
        `連続失敗回数: ${entry.consecutiveFailures}回（約45分）`,
        describeError(err),
        "",
        "通信エラー等の一時的な問題の可能性があります。再認可は不要な場合が多いため、まず状況を確認してください（自動で再試行を続けます）。",
      ].join("\n")
    );
  }
}

async function main(deps = {}) {
  const store = loadStore();
  const now = Date.now();
  const seen = new Set();
  const targets = Object.entries(store).filter(([, data]) => {
    const x = data.x;
    if (!x || !x.refresh_token || !x.token_expires_at) return false;
    if (new Date(x.token_expires_at).getTime() - now > REFRESH_WINDOW_MS) return false;
    const accountKey = String(x.user_id || x.username || x.refresh_token);
    if (seen.has(accountKey)) return false;
    seen.add(accountKey);
    return true;
  });

  if (targets.length === 0) {
    console.info("[x-refresh] no tokens due for refresh");
    return;
  }

  const state = loadState();
  for (const [slug, data] of targets) {
    try {
      await refreshOne(slug, data.x, deps);
      if (state[slug]) delete state[slug]; // 成功でカウンタ・通知済みフラグをリセット
    } catch (err) {
      await handleFailure(slug, err, state);
    }
  }
  saveState(state);
}

if (require.main === module) main().catch((err) => {
  console.error("[x-refresh] unexpected failure:", err);
  process.exit(1);
});

module.exports = { main, refreshOne, handleFailure };
