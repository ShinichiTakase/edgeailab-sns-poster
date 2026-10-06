const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const { requireAuth, blockExpiredTrialJson, blockViewerRole, blockApproverRole } = require("../middleware/requireAuth");

const router = express.Router();

const UPLOAD_DIR = process.env.SNS_POSTER_UPLOAD_DIR || path.join(__dirname, "..", "..", "uploads");
const MAX_SIZE = 8 * 1024 * 1024;
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];
const EXT_BY_MIME = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    cb(null, `${crypto.randomUUID()}${EXT_BY_MIME[file.mimetype] || ""}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    cb(null, ALLOWED_MIME.includes(file.mimetype));
  },
});

// Instagram/Facebookの画像付き投稿はGraph APIの仕様上、外部から取得可能な公開URLを
// 渡す必要があるため、アップロードした画像を/uploadsで静的公開する（src/index.js参照）。
// メール認証未完了でも画像選択自体は試せるようにする（ブロックするのは実際の投稿・予約のみ）。
router.post("/api/uploads/image", requireAuth, blockExpiredTrialJson, blockViewerRole, blockApproverRole, (req, res) => {
  upload.single("image")(req, res, (err) => {
    if (err) {
      console.error("[uploads/image] upload failed:", err);
      return res.status(400).json({ error: "upload_failed" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "image_required_or_invalid" });
    }
    res.json({ url: `https://edgeailab.net/uploads/${req.file.filename}` });
  });
});

module.exports = router;
