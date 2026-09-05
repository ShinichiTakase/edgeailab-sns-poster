// 管理者ダッシュボード「サーバーのリソース状況」専用API。認証はnginx側のBasic認証
// のみに委ねる（他のadmin系APIと同じ方針）。
//
// コンテナはホストとカーネル・cgroupを共有しており、/proc（CPU数・load average・
// メモリ）・overlay filesystem（ディスク使用量、実体はホストの/dev/vda1）とも
// ホストの実値と一致することを実機で確認済み（2026-09-05）。ホスト側に別途
// 常駐スクリプトを用意する必要はなく、このコンテナ内から直接読める。
// 外部API呼び出しが無く軽量なので、管理者統計（adminStats.js）とは異なり
// バッチキャッシュ化はせず、リクエストのたびにその場で計算する。
const express = require("express");
const os = require("os");
const { execSync } = require("child_process");

const router = express.Router();

function getDiskUsage() {
  try {
    const lines = execSync("df -k /").toString().trim().split("\n");
    const parts = lines[1].split(/\s+/);
    const totalBytes = parseInt(parts[1], 10) * 1024;
    const usedBytes = parseInt(parts[2], 10) * 1024;
    const availableBytes = parseInt(parts[3], 10) * 1024;
    return { totalBytes, usedBytes, availableBytes, usePercent: parts[4] };
  } catch (err) {
    console.error("[admin/server-resources] df failed:", err);
    return null;
  }
}

router.get("/api/admin/server-resources", (req, res) => {
  try {
    const cpus = os.cpus();
    const [load1, load5, load15] = os.loadavg();
    const totalMemBytes = os.totalmem();
    const freeMemBytes = os.freemem();

    res.json({
      cpu: { cores: cpus.length, model: (cpus[0] && cpus[0].model) || "" },
      loadAverage: { "1m": load1, "5m": load5, "15m": load15 },
      memory: { totalBytes: totalMemBytes, usedBytes: totalMemBytes - freeMemBytes, freeBytes: freeMemBytes },
      disk: getDiskUsage(),
    });
  } catch (err) {
    console.error("[admin/server-resources] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

module.exports = router;
