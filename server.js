const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PUBLIC_DIR = path.join(__dirname, "public");
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 4173);
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("图片过大，请压缩后再试。"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("请求内容不是有效的 JSON。"));
      }
    });

    request.on("error", reject);
  });
}

function toNonNegativeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeBaseUrl(value) {
  const raw = String(value || OPENAI_BASE_URL).trim();
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("API Base URL 只支持 http 或 https。");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function extractJson(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const chunks = [];
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n");
}

function sanitizeAnalysis(raw) {
  const sourceItems = Array.isArray(raw?.items) ? raw.items.slice(0, 30) : [];
  const items = sourceItems.map((item) => {
    const kcal = round(toNonNegativeNumber(item?.kcal));
    const protein = round(toNonNegativeNumber(item?.protein));
    const carbs = round(toNonNegativeNumber(item?.carbs));
    const fat = round(toNonNegativeNumber(item?.fat));
    return {
      name: String(item?.name || "未命名食物").slice(0, 80),
      portion: String(item?.portion || "份量未知").slice(0, 80),
      kcal,
      protein,
      carbs,
      fat,
    };
  });

  const totals = items.reduce(
    (sum, item) => ({
      kcal: sum.kcal + item.kcal,
      protein: sum.protein + item.protein,
      carbs: sum.carbs + item.carbs,
      fat: sum.fat + item.fat,
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  );

  return {
    items,
    totals: {
      kcal: round(totals.kcal),
      protein: round(totals.protein),
      carbs: round(totals.carbs),
      fat: round(totals.fat),
    },
    confidence: ["低", "中", "高"].includes(raw?.confidence) ? raw.confidence : "中",
    notes: String(raw?.notes || "请按实际份量修正估算值。").slice(0, 400),
  };
}

function buildPrompt(note) {
  return [
    "你是饮食照片估算助手。识别图片中的食物与饮料，并估算可食用份量。",
    "使用中国家庭常用份量描述，例如半碗、一拳、100克、1杯。",
    "热量单位为 kcal，蛋白质/碳水/脂肪单位为克。只给出数值，不要写范围。",
    "如果无法辨认或份量遮挡严重，降低 confidence，并在 notes 说明原因。",
    "不要把餐具、包装、桌面或背景算成食物。",
    note ? `用户补充说明：${String(note).slice(0, 300)}` : "",
    "只返回 JSON，不要 Markdown。",
    'JSON 格式：{"items":[{"name":"米饭","portion":"1碗","kcal":230,"protein":4,"carbs":50,"fat":0.5}],"confidence":"中","notes":"估算说明"}',
  ]
    .filter(Boolean)
    .join("\n");
}

async function requestFoodAnalysis({ apiKey, image, note, model, baseUrl }) {
  const prompt = buildPrompt(note);
  const selectedModel = String(model || DEFAULT_MODEL).slice(0, 80);
  const selectedBaseUrl = normalizeBaseUrl(baseUrl);

  const responsesPayload = {
    model: selectedModel,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: image, detail: "low" },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "food_analysis",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: { type: "string" },
                  portion: { type: "string" },
                  kcal: { type: "number" },
                  protein: { type: "number" },
                  carbs: { type: "number" },
                  fat: { type: "number" },
                },
                required: ["name", "portion", "kcal", "protein", "carbs", "fat"],
              },
            },
            confidence: { type: "string", enum: ["低", "中", "高"] },
            notes: { type: "string" },
          },
          required: ["items", "confidence", "notes"],
        },
      },
    },
  };

  let response = await fetch(`${selectedBaseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(responsesPayload),
  });

  let payload = await response.json().catch(() => ({}));
  let parsed = extractJson(extractResponseText(payload));

  if (!response.ok && [401, 403, 429].includes(response.status)) {
    const error = new Error(
      payload?.error?.message || `AI 服务拒绝了请求（HTTP ${response.status}）。`,
    );
    error.status = response.status;
    throw error;
  }

  // Keep a compatible fallback for gateways that expose Chat Completions only.
  if (!response.ok || !parsed) {
    response = await fetch(`${selectedBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: image, detail: "low" } },
            ],
          },
        ],
      }),
    });
    payload = await response.json().catch(() => ({}));
    parsed = extractJson(payload.choices?.[0]?.message?.content);
  }

  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      `AI 服务返回错误（HTTP ${response.status}）。`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  if (!parsed) {
    throw new Error("AI 返回结果无法解析，请换一张更清晰的照片。");
  }

  return sanitizeAnalysis(parsed);
}

async function handleApi(request, response, pathname) {
  if (pathname === "/api/health" && request.method === "GET") {
    sendJson(response, 200, {
      ok: true,
      aiConfigured: Boolean(process.env.OPENAI_API_KEY),
      defaultModel: DEFAULT_MODEL,
      defaultBaseUrl: OPENAI_BASE_URL,
    });
    return true;
  }

  if (pathname === "/api/analyze" && request.method === "POST") {
    try {
      const body = await readJson(request);
      const apiKey = process.env.OPENAI_API_KEY || request.headers["x-user-openai-key"];

      if (!apiKey) {
        sendJson(response, 503, {
          error: "AI_NOT_CONFIGURED",
          message: "尚未配置视觉模型接口。请在设置中填写 API Base URL、API Key 和支持图片的模型名。",
        });
        return true;
      }

      if (typeof body.image !== "string" || !body.image.startsWith("data:image/")) {
        sendJson(response, 400, { message: "请上传有效的图片。" });
        return true;
      }

      if (body.image.length > MAX_BODY_BYTES) {
        sendJson(response, 413, { message: "图片过大，请重新选择或压缩。" });
        return true;
      }

      const analysis = await requestFoodAnalysis({
        apiKey,
        image: body.image,
        note: body.note,
        model: body.model,
        baseUrl: body.baseUrl,
      });
      sendJson(response, 200, analysis);
    } catch (error) {
      sendJson(response, error.status || 500, {
        message: error.message || "图像分析失败，请稍后重试。",
      });
    }
    return true;
  }

  return false;
}

function serveStatic(request, response, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  let decodedPath;

  try {
    decodedPath = decodeURIComponent(requestedPath);
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }

  const filePath = path.resolve(PUBLIC_DIR, `.${path.normalize(decodedPath)}`);
  const relativePath = path.relative(PUBLIC_DIR, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || "application/octet-stream";
    const cacheControl = extension === ".html" ? "no-cache" : "public, max-age=3600";
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (await handleApi(request, response, url.pathname)) return;
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { message: "Method not allowed" });
    return;
  }
  serveStatic(request, response, url.pathname);
});

function getLanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry?.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254."))
    .map((entry) => entry.address);
}

server.listen(PORT, HOST, () => {
  console.log(`FitDay is running at http://localhost:${PORT}`);
  console.log("Open one of these addresses on a phone connected to the same Wi-Fi:");
  getLanAddresses().forEach((address) => console.log(`  http://${address}:${PORT}`));
  console.log(`AI image analysis: ${process.env.OPENAI_API_KEY ? "server key configured" : "key can be entered in app settings"}`);
});
