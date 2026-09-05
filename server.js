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

// days — кто пришёл, skips — кто обещал и кинул, fails — кто накосячил.
// Мешки устроены одинаково: "ГГГГ-ММ-ДД" -> список имён.
let state = { days: {}, people: [], skips: {}, fails: {} };
let writeChain = Promise.resolve();

async function load() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const bag = (v) => (v && typeof v === "object" ? v : {});
    const count = (b) => Object.values(b).reduce((s, v) => s + v.length, 0);
    state = {
      days: bag(parsed && parsed.days),
      people: Array.isArray(parsed && parsed.people) ? parsed.people : [],
      skips: bag(parsed && parsed.skips), // в старых файлах ключа нет — это нормально
      fails: bag(parsed && parsed.fails),
    };
    console.log(
      `Загружено: ${Object.keys(state.days).length} дней, ${state.people.length} человек, ` +
        `${count(state.skips)} кидков, ${count(state.fails)} косяков`
    );
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

// Приходы (state.days) и кидки (state.skips) устроены одинаково — «дата ->
// список имён», — но правила у них разные, поэтому у каждого вида отметки
// своя пара функций. Общее — только возня с одним мешком, ниже.

// Добавляет имена в мешок, не создавая дублей.
function putNames(bag, date, names) {
  const list = [...(bag[date] || [])];
  for (const name of names) {
    if (!list.some((x) => sameName(x, name))) list.push(name);
  }
  if (list.length) bag[date] = list;
}

// Убирает имена из мешка; опустевший день не держим.
function dropNames(bag, date, names) {
  const rest = (bag[date] || []).filter((x) => !names.some((n) => sameName(x, n)));
  if (rest.length) bag[date] = rest;
  else delete bag[date];
}

// Кого отметили впервые — тот пополняет общий список людей.
function rememberPeople(names) {
  for (const name of names) {
    if (!state.people.some((x) => sameName(x, name))) state.people.push(name);
  }
}

// Пишем всю группу разом: один persist вместо одного на каждое имя.
// Прийти и кинуть в один и тот же день нельзя: приход снимает кидок.
function addAttendees(date, names) {
  putNames(state.days, date, names);
  dropNames(state.skips, date, names);
  rememberPeople(names);
  return persist();
}

// Зеркально приходу: кидок снимает отметку о приходе в этот день.
function addSkips(date, names) {
  putNames(state.skips, date, names);
  dropNames(state.days, date, names);
  rememberPeople(names);
  return persist();
}

function removeAttendee(date, name) {
  dropNames(state.days, date, [name]);
  return persist();
}

function removeSkip(date, name) {
  dropNames(state.skips, date, [name]);
  return persist();
}

// Косяк живёт сам по себе: человек мог прийти и всё равно накосячить,
// поэтому другие отметки эта пара функций не трогает.
function addFails(date, names) {
  putNames(state.fails, date, names);
  rememberPeople(names);
  return persist();
}

function removeFail(date, name) {
  dropNames(state.fails, date, [name]);
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

// Список имён из тела запроса: принимаем и одно имя, и группу —
// {"name":"…"} либо {"names":["…","…"]}. Возвращает { names } либо { error }.
async function readNames(req) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return { error: "Не удалось разобрать запрос" };
  }

  const raw = Array.isArray(body.names) ? body.names : [body.name];
  if (raw.length > MAX_BATCH) {
    return { error: `За раз можно отметить не больше ${MAX_BATCH} человек` };
  }

  const names = [];
  const seen = new Set();
  for (const item of raw) {
    const name = cleanName(item);
    if (!name) return { error: `Имя должно быть непустым, до ${MAX_NAME} символов` };
    const key = name.toLocaleLowerCase("ru");
    if (seen.has(key)) continue; // дубль внутри списка
    seen.add(key);
    names.push(name);
  }
  if (!names.length) return { error: "Не указано ни одного имени" };
  return { names };
}

// ---------- ручки API ----------

// Любая изменяющая ручка отвечает новым состоянием целиком, чтобы клиенту
// не приходилось делать отдельный GET после записи.

// POST /api/days/:date/attendees — пришли
async function postAttendees(req, res, date) {
  if (!validDate(date)) return sendJson(res, 400, { error: BAD_DATE });
  const { names, error } = await readNames(req);
  if (error) return sendJson(res, 400, { error });
  await addAttendees(date, names);
  return sendJson(res, 200, state);
}

// POST /api/days/:date/skips — обещали и кинули
async function postSkips(req, res, date) {
  if (!validDate(date)) return sendJson(res, 400, { error: BAD_DATE });
  const { names, error } = await readNames(req);
  if (error) return sendJson(res, 400, { error });
  await addSkips(date, names);
  return sendJson(res, 200, state);
}

// DELETE /api/days/:date/attendees/:name
async function deleteAttendee(res, date, name) {
  if (!validDate(date)) return sendJson(res, 400, { error: BAD_DATE });
  if (!name) return sendJson(res, 400, { error: "Не указано имя" });
  await removeAttendee(date, name);
  return sendJson(res, 200, state);
}

// DELETE /api/days/:date/skips/:name
async function deleteSkip(res, date, name) {
  if (!validDate(date)) return sendJson(res, 400, { error: BAD_DATE });
  if (!name) return sendJson(res, 400, { error: "Не указано имя" });
  await removeSkip(date, name);
  return sendJson(res, 200, state);
}

// POST /api/days/:date/fails — накосячил
async function postFails(req, res, date) {
  if (!validDate(date)) return sendJson(res, 400, { error: BAD_DATE });
  const { names, error } = await readNames(req);
  if (error) return sendJson(res, 400, { error });
  await addFails(date, names);
  return sendJson(res, 200, state);
}

// DELETE /api/days/:date/fails/:name
async function deleteFail(res, date, name) {
  if (!validDate(date)) return sendJson(res, 400, { error: BAD_DATE });
  if (!name) return sendJson(res, 400, { error: "Не указано имя" });
  await removeFail(date, name);
  return sendJson(res, 200, state);
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
    return sendJson(res, 200, state);
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
