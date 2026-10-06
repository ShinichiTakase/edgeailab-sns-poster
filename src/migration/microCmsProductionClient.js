function createMicroCmsProductionClient({ serviceDomain, apiKey, fetchImpl = global.fetch }) {
  if (!serviceDomain || !apiKey) throw new Error("microCMS credentials are required");
  const base = `https://${serviceDomain}.microcms.io/api/v1`;
  const headers = { "X-MICROCMS-API-KEY": apiKey, "Content-Type": "application/json" };
  async function request(url, options = {}) {
    const response = await fetchImpl(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
    if (!response.ok) throw Object.assign(new Error(`microCMS request failed status=${response.status}`), { code: `MICROCMS_${response.status}` });
    return response.status === 204 ? null : response.json();
  }
  return {
    async listAll(endpoint) {
      const rows = []; let offset = 0;
      for (;;) {
        const page = await request(`${base}/${endpoint}?limit=100&offset=${offset}`);
        rows.push(...page.contents); if (rows.length >= page.totalCount) return rows; offset += page.contents.length;
      }
    },
    put(endpoint, id, row) { const { id: ignored, createdAt, updatedAt, publishedAt, revisedAt, ...body } = row; return request(`${base}/${endpoint}/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }); },
    delete(endpoint, id) { return request(`${base}/${endpoint}/${encodeURIComponent(id)}`, { method: "DELETE" }); },
  };
}
module.exports = { createMicroCmsProductionClient };
