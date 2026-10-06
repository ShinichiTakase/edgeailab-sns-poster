const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");

let server;
let port;

test.before(async () => {
  const app = express();
  app.get("/query", (req, res) => res.json(req.query));
  app.post("/json", express.json({ limit: "1kb" }), (req, res) => res.json(req.body));
  app.post("/form", express.urlencoded({ extended: false, limit: "1kb" }), (req, res) => res.json(req.body));
  app.get("/forbidden", (req, res) => res.status(403).json({ error: "forbidden" }));
  app.get("/failure", () => { throw new Error("fixture"); });
  app.use((req, res) => res.status(404).json({ error: "not_found" }));
  app.use((err, req, res, next) => { void next; res.status(err.status || 500).json({ error: "internal_error" }); });
  server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  port = server.address().port;
});

test.after(async () => { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }); });

function request(method, route, body, contentType) {
  const payload = body == null ? null : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: route, headers: payload ? {
      "content-type": contentType, "content-length": payload.length,
    } : {} }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("query・JSON・urlencoded bodyを互換解析する", async () => {
  let response = await request("GET", "/query?name=edge&items%5B0%5D=a");
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).name, "edge");
  response = await request("POST", "/json", JSON.stringify({ name: "edge" }), "application/json");
  assert.deepEqual(JSON.parse(response.text), { name: "edge" });
  response = await request("POST", "/form", "name=edge&platform=x", "application/x-www-form-urlencoded");
  assert.deepEqual(JSON.parse(response.text), { name: "edge", platform: "x" });
});

test("400・403・404・500 responseを維持する", async () => {
  assert.equal((await request("POST", "/json", "{", "application/json")).status, 400);
  assert.equal((await request("GET", "/forbidden")).status, 403);
  assert.equal((await request("GET", "/missing")).status, 404);
  assert.equal((await request("GET", "/failure")).status, 500);
});
