const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const express = require("express");

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "sns-poster-upload-security-"));
process.env.SNS_POSTER_UPLOAD_DIR = uploadDir;
process.env.JWT_SECRET = "upload-security-test-only";

const customerStore = require("../lib/customerStore");
const customer = {
  id: "upload-security-customer",
  email: "upload@example.test",
  status: ["trial"],
  plan: ["Basic"],
  trialEndsAt: "2099-01-01T00:00:00.000Z",
  users: [{ userId: "upload-user", email: "upload@example.test", role: ["管理者"], sessionVersion: 0 }],
};
customerStore.getCustomerById = async (id) => id === customer.id ? customer : null;
const { signSession, COOKIE_NAME } = require("../lib/jwt");
const router = require("./uploads");

let server;
let port;
let cookie;

test.before(async () => {
  const app = express();
  app.use(router);
  server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  port = server.address().port;
  cookie = `${COOKIE_NAME}=${signSession(customer, customer.users[0])}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

function multipart(parts, boundary = `test-${Date.now()}-${Math.random()}`) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.filename) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.type}\r\n\r\n`));
      chunks.push(part.value);
      chunks.push(Buffer.from("\r\n"));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(chunks) };
}

function requestUpload(parts, { authenticated = true } = {}) {
  const { boundary, body } = multipart(parts);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/uploads/image", headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": body.length,
      ...(authenticated ? { cookie } : {}),
    } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const image = (name = "image", size = 16, type = "image/png") => ({ name, filename: "fixture.png", type, value: Buffer.alloc(size, 0x61) });

test("正常画像を1件uploadできる", async () => {
  const response = await requestUpload([image()]);
  assert.equal(response.status, 200);
  assert.match(response.body, /\/uploads\/[0-9a-f-]+\.png/);
});

test("8MBを超える画像を拒否する", async () => {
  const response = await requestUpload([image("image", 8 * 1024 * 1024 + 1)]);
  assert.equal(response.status, 400);
});

test("許可されていないMIME typeを拒否する", async () => {
  const response = await requestUpload([image("image", 16, "image/gif")]);
  assert.equal(response.status, 400);
});

test("不正なfile fieldを拒否する", async () => {
  const response = await requestUpload([image("unexpected")]);
  assert.equal(response.status, 400);
});

test("oversized array indexを含むfield名で停止せず次のrequestも処理できる", async () => {
  const crafted = { name: "meta[999999999999999999999]", value: "x" };
  const response = await requestUpload([crafted, image()]);
  assert.equal(response.status, 200);
  assert.equal((await requestUpload([image()])).status, 200);
});

test("single endpointへの複数fileを拒否する", async () => {
  const response = await requestUpload([image(), image()]);
  assert.equal(response.status, 400);
});

test("aborted upload後もserverが応答し続ける", async () => {
  await new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`POST /api/uploads/image HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${cookie}\r\nContent-Type: multipart/form-data; boundary=abort\r\nContent-Length: 9000000\r\n\r\n--abort\r\nContent-Disposition: form-data; name="image"; filename="x.png"\r\nContent-Type: image/png\r\n\r\npartial`);
      socket.destroy();
      resolve();
    });
    socket.on("error", reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await requestUpload([image()])).status, 200);
});

test("未認証uploadを401で拒否する", async () => {
  const response = await requestUpload([image()], { authenticated: false });
  assert.equal(response.status, 401);
});
