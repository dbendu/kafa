"use strict";

const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { Storage } = require("./storage");

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.sqlite");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY = 8 * 1024;
const MAX_NAME = 40;

// Логин и пароль берём из окружения (см. .env). Если не заданы — проверки нет
// и правит кто угодно. Сравнение обычной строкой: это домашний счётчик кофе.
const AUTH_USER = process.env.AUTH_USER || "";
const AUTH_PASS = process.env.AUTH_PASS || "";
const authOn = Boolean(AUTH_USER && AUTH_PASS);

// ---------- хранилище ----------

let storage;

async function load() {
  storage = new Storage(DATA_FILE);
  const state = storage.read();
  console.log(`Загружено: ${Object.keys(state.days).length} дней, ${state.people.length} человек`);
}

// ---------- валидация ----------

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function cleanName(raw) {
  if (typeof raw !== "string") return null;
  const n = raw.trim().replace(/\s+/g, " ");
  if (!n || n.length > MAX_NAME) return null;
  return n;
}

// Заголовок X-Auth: "логин:пароль", обе половины в encodeURIComponent —
// в заголовки нельзя класть кириллицу как есть.
function allowed(req) {
  if (!authOn) return true;
  const raw = req.headers["x-auth"];
  if (typeof raw !== "string") return false;
  const i = raw.indexOf(":");
  if (i < 0) return false;
  try {
    const user = decodeURIComponent(raw.slice(0, i));
    const pass = decodeURIComponent(raw.slice(i + 1));
    return user === AUTH_USER && pass === AUTH_PASS;
  } catch {
    return false; // кривое кодирование — считаем, что не подошло
  }
}

// ---------- операции ----------

const addAttendees = (date, name) => storage.change("days", date, name);
const addSkips = (date, name) => storage.change("skips", date, name);
const addFails = (date, name, reasonId) => storage.change("fails", date, name, false, reasonId);
const removeAttendee = (date, name) => storage.change("days", date, name, true);
const removeSkip = (date, name) => storage.change("skips", date, name, true);
const removeFail = (date, name) => storage.change("fails", date, name, true);

// ---------- http ----------

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

async function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const target = path.join(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: "Доступ запрещён" });
  }
  try {
    const file = await fs.readFile(target);
    res.writeHead(200, { "Content-Type": MIME[path.extname(target)] || "application/octet-stream" });
    res.end(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Страница не найдена");
  }
}

// ---------- разбор запроса ----------

const BAD_DATE = "Дата должна быть в формате ГГГГ-ММ-ДД";

// Один запрос — один человек: {"name":"…"}.
async function readName(req) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return { error: "Не удалось разобрать запрос" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || "names" in body) {
    return { error: "Укажите одного человека в поле name" };
  }
  const name = cleanName(body.name);
  if (!name) return { error: `Имя должно быть непустым, до ${MAX_NAME} символов` };
  return { name, reasonId: body.reason_id };
}

// ---------- ручки API ----------

// Любая изменяющая ручка отвечает новым состоянием целиком, чтобы клиенту
// не приходилось делать отдельный GET после записи.

// POST /api/days/:date/attendees — пришли
async function postAttendees(req, res, date) {
  if (!validDate(date)) return sendJson(res, 400, { error: BAD_DATE });
  const { name, error } = await readName(req);
  if (error) return sendJson(res, 400, { error });
  await addAttendees(date, name);
  return sendJson(res, 200, storage.read());
}

// POST /api/days/:date/skips — обещали и кинули
async function postSkips(req, res, date) {
  if (!validDate(date)) return sendJson(res, 400, { error: BAD_DATE });
  const { name, error } = await readName(req);
  if (error) return sendJson(res, 400, { error });
  await addSkips(date, name);
  return sendJson(res, 200, storage.read());
}

// DELETE /api/days/:date/attendees/:name
async function deleteAttendee(res, date, name) {
  if (!validDate(date)) return sendJson(res, 400, { error: BAD_DATE });
  if (!name) return sendJson(res, 400, { error: "Не указано имя" });
  await removeAttendee(date, name);
  return sendJson(res, 200, storage.read());
}

// DELETE /api/days/:date/skips/:name
async function deleteSkip(res, date, name) {
  if (!validDate(date)) return sendJson(res, 400, { error: BAD_DATE });
  if (!name) return sendJson(res, 400, { error: "Не указано имя" });
  await removeSkip(date, name);
  return sendJson(res, 200, storage.read());
}

// POST /api/days/:date/fails — накосячил
async function postFails(req, res, date) {
  if (!validDate(date)) return sendJson(res, 400, { error: BAD_DATE });
  const { name, reasonId, error } = await readName(req);
  if (error) return sendJson(res, 400, { error });
  await addFails(date, name, reasonId);
  return sendJson(res, 200, storage.read());
}

// DELETE /api/days/:date/fails/:name
async function deleteFail(res, date, name) {
  if (!validDate(date)) return sendJson(res, 400, { error: BAD_DATE });
  if (!name) return sendJson(res, 400, { error: "Не указано имя" });
  await removeFail(date, name);
  return sendJson(res, 200, storage.read());
}

// ---------- маршруты ----------

async function handleApi(req, res, url) {
  const seg = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const isDay = (len) => seg.length === len && seg[1] === "days";

  // всё, кроме чтения, требует пароля
  if (req.method !== "GET" && !allowed(req)) {
    return sendJson(res, 401, { error: "Нужен пароль, чтобы менять историю" });
  }

  // POST /api/auth/check — форма входа проверяет пароль, ничего не меняя
  if (req.method === "POST" && seg.length === 3 && seg[1] === "auth" && seg[2] === "check") {
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/log
  if (req.method === "GET" && seg.length === 2 && seg[1] === "log") {
    return sendJson(res, 200, storage.read());
  }

  if (req.method === "POST" && isDay(4) && seg[3] === "attendees") {
    return postAttendees(req, res, decodeURIComponent(seg[2]));
  }

  if (req.method === "POST" && isDay(4) && seg[3] === "skips") {
    return postSkips(req, res, decodeURIComponent(seg[2]));
  }

  if (req.method === "POST" && isDay(4) && seg[3] === "fails") {
    return postFails(req, res, decodeURIComponent(seg[2]));
  }

  if (req.method === "DELETE" && isDay(5) && seg[3] === "attendees") {
    return deleteAttendee(res, decodeURIComponent(seg[2]), cleanName(decodeURIComponent(seg[4])));
  }

  if (req.method === "DELETE" && isDay(5) && seg[3] === "skips") {
    return deleteSkip(res, decodeURIComponent(seg[2]), cleanName(decodeURIComponent(seg[4])));
  }

  if (req.method === "DELETE" && isDay(5) && seg[3] === "fails") {
    return deleteFail(res, decodeURIComponent(seg[2]), cleanName(decodeURIComponent(seg[4])));
  }

  return sendJson(res, 404, { error: "Неизвестный метод API" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else if (req.method === "GET") {
      await serveStatic(res, url.pathname);
    } else {
      sendJson(res, 405, { error: "Метод не поддерживается" });
    }
  } catch (err) {
    if (err.statusCode !== 400) console.error(err);
    if (!res.headersSent) sendJson(res, err.statusCode === 400 ? 400 : 500, {
      error: err.statusCode === 400 ? err.message : "Сервер не смог обработать запрос",
    });
  }
});

// Дожидаемся активных HTTP-запросов перед закрытием базы.
let stopping = false;
function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  console.log(`${sig}: останавливаюсь`);
  server.close(() => {
    storage.close();
    process.exit(0);
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

load()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Кофейный календарь: http://localhost:${PORT}`);
      console.log(`Данные: ${DATA_FILE}`);
      console.log(authOn
        ? `Правки под паролем, логин: ${AUTH_USER}`
        : "AUTH_USER/AUTH_PASS не заданы — править может кто угодно");
    });
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
