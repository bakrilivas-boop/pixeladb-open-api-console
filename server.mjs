import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

await loadDotEnv();

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const API_BASE_URL = (process.env.PIXEL_API_BASE_URL || "https://okey188.com/api/v1/open").replace(/\/+$/, "");
const DEFAULT_CDK = process.env.PIXEL_CDK || "";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/health" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        apiBaseUrl: API_BASE_URL,
        hasDefaultCdk: Boolean(DEFAULT_CDK),
        docsUrl: "https://okey188.com/api-docs",
      });
    }

    if (url.pathname === "/api/tasks" && req.method === "POST") {
      const body = await readJson(req);
      const cdk = getCdk(req, body, url);
      if (!cdk) return sendJson(res, 400, { code: "MISSING_CDK", message: "Provide X-Pixel-CDK, cdk in body, ?cdk=, or PIXEL_CDK." });

      const payload = buildSubmitPayload(body);
      if (payload.error) return sendJson(res, 400, payload.error);

      const upstream = await callPixelApi("POST", "/tasks", cdk, payload.value);
      return sendJson(res, upstream.status, upstream.data);
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([0-9]+)(?:\/(cancel|retry))?$/);
    if (taskMatch) {
      const [, taskId, action] = taskMatch;
      if (req.method === "GET" && !action) {
        const cdk = getCdk(req, null, url);
        if (!cdk) return sendJson(res, 400, { code: "MISSING_CDK", message: "Provide X-Pixel-CDK, ?cdk=, or PIXEL_CDK." });

        const upstream = await callPixelApi("GET", `/tasks/${taskId}`, cdk);
        return sendJson(res, upstream.status, upstream.data);
      }

      if (req.method === "POST" && (action === "cancel" || action === "retry")) {
        const body = await readOptionalJson(req);
        const cdk = getCdk(req, body, url);
        if (!cdk) return sendJson(res, 400, { code: "MISSING_CDK", message: "Provide X-Pixel-CDK, cdk in body, ?cdk=, or PIXEL_CDK." });

        const upstream = await callPixelApi("POST", `/tasks/${taskId}/${action}`, cdk);
        return sendJson(res, upstream.status, upstream.data);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return sendJson(res, 404, { code: "NOT_FOUND", message: "Unknown local API route." });
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    return sendJson(res, status, {
      code: status === 500 ? "SERVER_ERROR" : "BAD_REQUEST",
      message: error.message || "Unexpected server error.",
    });
  }
});

server.listen(PORT, () => {
  console.log(`PixelADB Open API Console: http://localhost:${PORT}`);
  console.log(`Proxy target: ${API_BASE_URL}`);
});

async function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  let content = "";
  try {
    content = await readFile(envPath, "utf8");
  } catch {
    return;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsAt = line.indexOf("=");
    if (equalsAt === -1) continue;

    const key = line.slice(0, equalsAt).trim();
    let value = line.slice(equalsAt + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function serveStatic(requestPath, res) {
  const cleanPath = requestPath === "/" ? "/index.html" : requestPath;
  const decodedPath = decodeURIComponent(cleanPath);
  const filePath = path.resolve(publicDir, `.${decodedPath}`);
  const publicRoot = path.resolve(publicDir);

  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${path.sep}`)) {
    return sendJson(res, 403, { code: "FORBIDDEN", message: "Invalid static file path." });
  }

  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes.get(ext) || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { code: "NOT_FOUND", message: "File not found." });
  }
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};

  try {
    return JSON.parse(text);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

async function readOptionalJson(req) {
  if ((req.headers["content-length"] || "0") === "0") return {};
  return readJson(req);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error("Request body is too large.");
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function getCdk(req, body, url) {
  const headerValue = req.headers["x-pixel-cdk"];
  if (typeof headerValue === "string" && headerValue.trim()) return headerValue.trim();
  if (Array.isArray(headerValue) && headerValue[0]?.trim()) return headerValue[0].trim();
  if (body?.cdk && String(body.cdk).trim()) return String(body.cdk).trim();
  if (url.searchParams.get("cdk")?.trim()) return url.searchParams.get("cdk").trim();
  return DEFAULT_CDK.trim();
}

function buildSubmitPayload(body) {
  const type = body?.type || "full_subscribe";
  const accounts = body?.accounts;
  const allowedTypes = new Set(["full_subscribe", "full_subscribe_24m", "extract_link"]);

  if (!allowedTypes.has(type)) {
    return {
      error: {
        code: "INVALID_TYPE",
        message: "type must be full_subscribe, full_subscribe_24m, or extract_link.",
      },
    };
  }

  if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > 500) {
    return {
      error: {
        code: "INVALID_ACCOUNTS",
        message: "accounts must be an array containing 1 to 500 account objects.",
      },
    };
  }

  const cleanedAccounts = [];
  for (const [index, account] of accounts.entries()) {
    const cleaned = {
      email: String(account?.email || "").trim(),
      password: String(account?.password || ""),
      totp: String(account?.totp || "").replace(/[\s-]+/g, "").toUpperCase(),
      recovery: String(account?.recovery || ""),
    };

    if (!cleaned.email || !cleaned.password || !cleaned.totp) {
      return {
        error: {
          code: "INVALID_ACCOUNT",
          message: `Account at index ${index} must include email, password, and totp.`,
        },
      };
    }

    cleanedAccounts.push(cleaned);
  }

  return { value: { type, accounts: cleanedAccounts } };
}

async function callPixelApi(method, route, cdk, body) {
  const headers = {
    Accept: "application/json",
    "X-Pixel-CDK": cdk,
  };

  const options = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(`${API_BASE_URL}${route}`, options);
    const text = await response.text();
    const data = parseJsonOrText(text);
    return { status: response.status, data };
  } catch (error) {
    return {
      status: 502,
      data: {
        code: "UPSTREAM_UNAVAILABLE",
        message: error.message || "Could not reach PixelADB API.",
      },
    };
  }
}

function parseJsonOrText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}
