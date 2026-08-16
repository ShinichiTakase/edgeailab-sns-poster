// microCMS の scheduled_posts スキーマ（予約投稿）への読み取り専用アクセス。
// 今回のスコープは「予定件数・請求予測の表示」のみで、予約投稿の作成・実行
// （scheduled_postsへの書き込み・cronでの実投稿）は別タスク。
// postingLogStore.jsと同様、selectフィールドは配列で返る前提でArray.isArrayで防御的に読む。
const { microcmsFetch } = require("./microcms");

const PLATFORM_LABELS = { x: "X", threads: "Threads", facebook: "Facebook", instagram: "Instagram" };

function monthRange(year, month) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function listPendingScheduledPosts(customerCode, year, month) {
  const { start, end } = monthRange(year, month);
  const filters = [
    `customer_code[equals]${encodeURIComponent(customerCode)}`,
    `status[equals]pending`,
    `scheduled_at[greater_than]${encodeURIComponent(start)}`,
    `scheduled_at[less_than]${encodeURIComponent(end)}`,
  ].join("[and]");

  const all = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    const res = await microcmsFetch(`/scheduled_posts?filters=${filters}&limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[scheduledPostStore] listPendingScheduledPosts failed ${res.status} ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const contents = Array.isArray(json.contents) ? json.contents : [];
    all.push(...contents);
    if (contents.length < limit) break;
    offset += limit;
  }
  return all;
}

/**
 * 指定顧客・指定月のpending予約投稿を集計する。
 * @returns {{ counts: {x:number,threads:number,facebook:number,instagram:number}, xUrlCount: number, totalCount: number }}
 */
async function getScheduledPostsSummary(customerCode, year, month) {
  const posts = await listPendingScheduledPosts(customerCode, year, month);
  const counts = { x: 0, threads: 0, facebook: 0, instagram: 0 };
  let xUrlCount = 0;

  for (const post of posts) {
    const label = Array.isArray(post.platform) ? post.platform[0] : post.platform;
    const key = Object.keys(PLATFORM_LABELS).find((k) => PLATFORM_LABELS[k] === label);
    if (!key) continue;
    counts[key] += 1;
    if (key === "x" && post.contains_url) xUrlCount += 1;
  }

  const totalCount = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { counts, xUrlCount, totalCount };
}

module.exports = { PLATFORM_LABELS, listPendingScheduledPosts, getScheduledPostsSummary };
