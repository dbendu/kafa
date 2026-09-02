"use strict";

const http = require("http");
const fs = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY = 8 * 1024;
const MAX_NAME = 40;
const MAX_BATCH = 50; // сколько имён принимаем за один запрос

// Логин и пароль берём из окружения (см. .env). Если не заданы — проверки нет
// и правит кто угодно. Сравнение обычной строкой: это домашний счётчик кофе.
const AUTH_USER = process.env.AUTH_USER || "";
const AUTH_PASS = process.env.AUTH_PASS || "";
const authOn = Boolean(AUTH_USER && AUTH_PASS);

// ---------- хранилище ----------

let state = { days: {}, people: [] };
let writeChain = Promise.resolve();

async function load() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    state = {
      days: parsed && typeof parsed.days === "object" && parsed.days ? parsed.days : {},
      people: Array.isArray(parsed && parsed.people) ? parsed.people : [],
    };
    console.log(`Загружено: ${Object.keys(state.days).length} дней, ${state.people.length} человек`);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log(`Файл ${DATA_FILE} не найден, создаю пустой`);
      await persist();
    } else {
      throw new Error(`Не удалось прочитать ${DATA_FILE}: ${err.message}`);
    }
  }
}

// Пишем через временный файл + rename, чтобы падение посреди записи
// не оставило обрезанный JSON. Цепочка промисов сериализует записи.
function persist() {
  const snapshot = JSON.stringify(state, null, 2);
  writeChain = writeChain.then(async () => {
    const tmp = `${DATA_FILE}.tmp`;
    await fs.writeFile(tmp, snapshot, "utf8");
    await fs.rename(tmp, DATA_FILE);
  });
  return writeChain;
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

const sameName = (a, b) => a.toLocaleLowerCase("ru") === b.toLocaleLowerCase("ru");

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

// Пишем всю группу разом: один persist вместо одного на каждое имя.
function addAttendees(date, names) {
  const list = [...(state.days[date] || [])];
  for (const name of names) {
    if (!list.some((x) => sameName(x, name))) list.push(name);
    if (!state.people.some((x) => sameName(x, name))) state.people.push(name);
  }
  if (list.length) state.days[date] = list;
  return persist();
}

function removeAttendee(date, name) {
  const list = (state.days[date] || []).filter((x) => !sameName(x, name));
  if (list.length) state.days[date] = list;
  else delete state.days[date];
  return persist();
}

function forgetPerson(name) {
  const days = {};
  for (const [date, list] of Object.entries(state.days)) {
    const kept = list.filter((x) => !sameName(x, name));
    if (kept.length) days[date] = kept;
  }
  state.days = days;
  state.people = state.people.filter((x) => !sameName(x, name));
  return persist();
}

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

async function handleApi(req, res, url) {
  const seg = url.pathname.split("/").filter(Boolean); // ["api", ...]

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
    return sendJson(res, 200, state);
  }

  // POST /api/days/:date/attendees
  if (req.method === "POST" && seg.length === 4 && seg[1] === "days" && seg[3] === "attendees") {
    const date = decodeURIComponent(seg[2]);
    if (!validDate(date)) return sendJson(res, 400, { error: "Дата должна быть в формате ГГГГ-ММ-ДД" });
    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: "Не удалось разобрать запрос" });
    }
    // принимаем и одно имя, и группу: {"name":"…"} либо {"names":["…","…"]}
    const raw = Array.isArray(body.names) ? body.names : [body.name];
    if (raw.length > MAX_BATCH) {
      return sendJson(res, 400, { error: `За раз можно отметить не больше ${MAX_BATCH} человек` });
    }
    const names = [];
    const seen = new Set();
    for (const item of raw) {
      const name = cleanName(item);
      if (!name) return sendJson(res, 400, { error: `Имя должно быть непустым, до ${MAX_NAME} символов` });
      const key = name.toLocaleLowerCase("ru");
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
    if (!names.length) return sendJson(res, 400, { error: "Не указано ни одного имени" });
    await addAttendees(date, names);
    return sendJson(res, 200, state);
  }

  // DELETE /api/days/:date/attendees/:name
  if (req.method === "DELETE" && seg.length === 5 && seg[1] === "days" && seg[3] === "attendees") {
    const date = decodeURIComponent(seg[2]);
    const name = cleanName(decodeURIComponent(seg[4]));
    if (!validDate(date)) return sendJson(res, 400, { error: "Дата должна быть в формате ГГГГ-ММ-ДД" });
    if (!name) return sendJson(res, 400, { error: "Не указано имя" });
    await removeAttendee(date, name);
    return sendJson(res, 200, state);
  }

  // DELETE /api/people/:name
  if (req.method === "DELETE" && seg.length === 3 && seg[1] === "people") {
    const name = cleanName(decodeURIComponent(seg[2]));
    if (!name) return sendJson(res, 400, { error: "Не указано имя" });
    await forgetPerson(name);
    return sendJson(res, 200, state);
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
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: "Сервер не смог обработать запрос" });
  }
});

// Контейнер останавливают через SIGTERM. Без обработчика процесс умрёт сразу
// и незавершённая запись потеряется (испортить файл она не может — спасает
// rename, — но последняя отметка не доедет до диска).
function shutdown(sig) {
  console.log(`${sig}: останавливаюсь`);
  server.close();
  server.closeIdleConnections(); // иначе keep-alive от открытых вкладок держит нас
  writeChain.then(
    () => process.exit(0),
    (err) => { console.error(err); process.exit(1); }
  );
  setTimeout(() => process.exit(0), 5000).unref(); // страховка от зависшей записи
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
