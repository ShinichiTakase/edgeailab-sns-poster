// GET /api/posts/scheduled・GET /api/billing/upcoming共通の "YYYY-MM" クエリパラメータ検証。
// クライアント側の月選択（当月以降のみ）を信用せず、サーバー側でも過去月を拒否する。
function parseMonthParam(value) {
  const match = typeof value === "string" && value.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

function isPastMonth(year, month) {
  const now = new Date();
  const currentKey = now.getFullYear() * 12 + now.getMonth();
  const targetKey = year * 12 + (month - 1);
  return targetKey < currentKey;
}

module.exports = { parseMonthParam, isPastMonth };
