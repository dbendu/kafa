"use strict";

const WEEKS = 53;
const POLL_MS = 15000;
const MAX_NAME = 40; // столько же, сколько принимает сервер

const M_SHORT = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];
const M_GEN = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const DOW = ["понедельник","вторник","среда","четверг","пятница","суббота","воскресенье"];

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const dowMon = (d) => (d.getDay() + 6) % 7;
const lower = (s) => s.toLocaleLowerCase("ru");

const today = new Date();
today.setHours(0, 0, 0, 0);

let state = { days: {}, people: [] };
let selected = iso(today);
// отмеченные галочками, но ещё не сохранённые (ключ — имя в нижнем регистре)
const picked = new Set();
const cells = new Map(); // "ГГГГ-ММ-ДД" -> кнопка

const $ = (id) => document.getElementById(id);

// ---------- пропуск на запись ----------

// Логин и пароль сервер сверяет со значениями из .env. Здесь держим готовое
// значение заголовка X-Auth, чтобы не спрашивать пароль на каждое действие.
const AUTH_KEY = "kafa-auth";
let authHeader = "";

try {
  authHeader = localStorage.getItem(AUTH_KEY) || "";
} catch {
  // приватное окно или запрет на хранилище — просто спросим пароль заново
}

function rememberAuth(value) {
  authHeader = value;
  try {
    if (value) localStorage.setItem(AUTH_KEY, value);
    else localStorage.removeItem(AUTH_KEY);
  } catch {
    // не сохранилось — пропуск проживёт до перезагрузки страницы
  }
  renderAuth();
}

// В заголовки нельзя класть кириллицу как есть — кодируем обе половины
function pack(user, pass) {
  return `${encodeURIComponent(user)}:${encodeURIComponent(pass)}`;
}

// Имена для выпадающего списка: сначала ростер из public/names.js,
// затем те, кого отмечали раньше, но в ростере уже нет.
function knownPeople() {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const name = String(raw == null ? "" : raw).trim().replace(/\s+/g, " ");
    if (!name || name.length > MAX_NAME) return;
    const key = lower(name);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };
  requiredNames().forEach(push);
  (Array.isArray(window.ROSTER) ? window.ROSTER : []).forEach(push);
  state.people.forEach(push);
  return out.sort((a, b) => a.localeCompare(b, "ru"));
}

// Корона перед именем «отца-кафахлёба». Возвращает null для обычных людей,
// чтобы вызывающий код просто не вставлял ничего.
function crown(name) {
  if (!requiredNames().some((r) => lower(r) === lower(name))) return null;
  const img = document.createElement("img");
  img.className = "crown";
  img.src = "/crown.webp";
  img.alt = ""; // украшение, имя и так рядом
  img.title = "отец-основатель кафахлёбства";
  return img;
}

// «отцы-кафахлёбы» из public/names.js: без кого день не засчитывается
function requiredNames() {
  return (Array.isArray(window.REQUIRED) ? window.REQUIRED : [])
    .map((r) => String(r == null ? "" : r).trim())
    .filter(Boolean);
}

// ---------- сеть ----------

async function api(method, url, body) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (authHeader) headers["X-Auth"] = authHeader;

  const res = await fetch(url, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    rememberAuth("");
    openAuth();
    setPickNote("Нужен пароль, чтобы менять историю");
    const err = new Error("нет пропуска");
    err.handled = true; // сообщение уже показано рядом с кнопкой
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Сервер ответил ${res.status}`);
  return data;
}

// Предупреждение внутри карточки дня, рядом с галочками. Элемент статичный,
// renderDay его не перерисовывает, поэтому опрос сервера сообщение не сотрёт.
function setPickNote(text) {
  const el = $("pick-note");
  el.textContent = text;
  el.hidden = !text;
}

function showNote(text) {
  const el = $("note");
  el.textContent = text;
  el.hidden = !text;
}

async function run(fn) {
  try {
    state = await fn();
    showNote("");
  } catch (err) {
    // handled — про ошибку уже сказано в карточке дня, верхний баннер не нужен
    if (err.handled) showNote("");
    else showNote(err.message === "Failed to fetch" ? "Нет связи с сервером. Проверьте, что он запущен." : err.message);
  }
  render();
}

// ---------- сетка ----------

function buildGrid() {
  const end = addDays(today, 6 - dowMon(today));
  const start = addDays(end, -(WEEKS * 7 - 1));
  const weeks = $("weeks");
  const months = $("months");
  const cellStep = 18; // var(--cell) + var(--gap)
  let lastMonth = -1;
  let lastLabelCol = -9;

  for (let w = 0; w < WEEKS; w++) {
    const col = document.createElement("div");
    col.className = "week";

    const monday = addDays(start, w * 7);
    if (monday.getMonth() !== lastMonth) {
      if (w - lastLabelCol >= 3) {
        const label = document.createElement("span");
        label.textContent = M_SHORT[monday.getMonth()];
        label.style.left = `${w * cellStep}px`;
        months.appendChild(label);
        lastLabelCol = w;
      }
      lastMonth = monday.getMonth();
    }

    for (let r = 0; r < 7; r++) {
      const date = addDays(start, w * 7 + r);
      const key = iso(date);
      const btn = document.createElement("button");
      btn.className = "cell";
      btn.dataset.date = key;
      if (date > today) {
        btn.classList.add("future");
        btn.disabled = true;
      } else {
        btn.addEventListener("click", () => {
          selected = key;
          picked.clear();
          setPickNote("");
          render();
        });
        cells.set(key, btn);
      }
      col.appendChild(btn);
    }
    weeks.appendChild(col);
  }

  $("scroll").scrollLeft = $("scroll").scrollWidth;
}

// ---------- отрисовка ----------

function paintGrid() {
  const counts = Object.values(state.days).map((v) => v.length);
  const max = Math.max(1, ...counts);
  for (const [key, btn] of cells) {
    const n = (state.days[key] || []).length;
    const level = n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4));
    btn.className = `cell l${level}${key === selected ? " sel" : ""}`;
    btn.title = `${key} — ${n}`;
    btn.setAttribute("aria-label", `${key}, пришло ${n}`);
  }
}

function prettyDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return `${d} ${M_GEN[m - 1]}, ${DOW[dowMon(new Date(y, m - 1, d))]}`;
}

function renderDay() {
  const list = state.days[selected] || [];
  $("day-title").textContent = prettyDate(selected);
  $("day-count").textContent = list.length ? `Пришло: ${list.length}` : "Пока никто не отмечен";

  const box = $("attendees");
  box.textContent = "";
  for (const person of list) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const mark = crown(person);
    if (mark) chip.appendChild(mark);
    chip.append(person);
    const x = document.createElement("button");
    x.textContent = "×";
    x.setAttribute("aria-label", `Убрать ${person}`);
    x.addEventListener("click", () =>
      run(() => api("DELETE", `/api/days/${selected}/attendees/${encodeURIComponent(person)}`))
    );
    chip.appendChild(x);
    box.appendChild(chip);
  }

  // выпадающий список: только те, кого сегодня ещё не отметили
  // галочки: только те, кого в этот день ещё не отметили
  const all = knownPeople();
  const free = all.filter((p) => !list.some((x) => lower(x) === lower(p)));
  // кого-то могли отметить в соседней вкладке — снимаем повисшие галочки
  for (const key of [...picked]) {
    if (!free.some((p) => lower(p) === key)) picked.delete(key);
  }

  const picker = $("picker");
  picker.textContent = "";
  for (const p of free) {
    const label = document.createElement("label");
    label.className = "pick";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = picked.has(lower(p));
    box.addEventListener("change", () => {
      if (box.checked) picked.add(lower(p));
      else picked.delete(lower(p));
      setPickNote("");
      label.classList.toggle("on", box.checked);
      syncAddButton();
    });
    const text = document.createElement("span");
    text.textContent = p;
    label.classList.toggle("on", box.checked);
    const mark = crown(p);
    label.append(box, ...(mark ? [mark] : []), text);
    picker.appendChild(label);
  }
  if (!free.length) {
    const empty = document.createElement("p");
    empty.className = "sub";
    empty.textContent = all.length ? "Все уже отмечены" : "Список пуст — заполните public/names.js";
    picker.appendChild(empty);
  }
  syncAddButton();
}

function syncAddButton() {
  const btn = $("add");
  btn.disabled = picked.size === 0;
  btn.textContent = picked.size > 1 ? `Отметить (${picked.size})` : "Отметить";
}

function renderTop() {
  const tally = new Map();
  for (const list of Object.values(state.days)) {
    for (const p of list) tally.set(p, (tally.get(p) || 0) + 1);
  }
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  $("top-card").hidden = top.length === 0;

  const ranks = Array.isArray(window.RANKS) ? window.RANKS : [];
  const box = $("top");
  box.textContent = "";
  let rank = 0;
  let prevCount = null;

  for (const [person, n] of top) {
    // приходов поровну — ранг тот же; иначе следующий по счёту
    if (n !== prevCount) {
      rank += 1;
      prevCount = n;
    }

    const row = document.createElement("div");
    row.className = "bar-row";

    const who = document.createElement("span");
    who.className = "who";
    const badge = ranks[rank - 1];
    if (badge) {
      const img = document.createElement("img");
      img.className = "rank";
      img.src = badge;
      img.alt = "";
      img.title = `${rank} ранг`;
      who.appendChild(img);
    }
    who.append(person);

    const bar = document.createElement("span");
    bar.className = "bar";
    const fill = document.createElement("i");
    fill.style.width = `${(n / top[0][1]) * 100}%`;
    bar.appendChild(fill);

    const num = document.createElement("span");
    num.className = "n";
    num.textContent = n;

    const drop = document.createElement("button");
    drop.className = "drop";
    drop.textContent = "×";
    drop.setAttribute("aria-label", `Удалить ${person} из всех дней`);
    drop.addEventListener("click", () => {
      if (confirm(`Удалить ${person} из всех дней?`)) {
        run(() => api("DELETE", `/api/people/${encodeURIComponent(person)}`));
      }
    });

    row.append(who, bar, num, drop);
    box.appendChild(row);
  }
}

function renderSummary() {
  const days = Object.keys(state.days).length;
  const visits = Object.values(state.days).reduce((s, v) => s + v.length, 0);
  $("summary").textContent = days
    ? `${visits} приходов за ${days} дней.`
    : "Пока пусто. Отметьте первого — и день окрасится.";
}

function render() {
  paintGrid();
  renderDay();
  renderTop();
  renderSummary();
}

// ---------- вход ----------

function renderAuth() {
  const inside = Boolean(authHeader);
  const formOpen = !$("auth-form").hidden;
  $("auth-in").hidden = !inside;
  $("auth-open").hidden = inside || formOpen;
}

function openAuth() {
  $("auth-form").hidden = false;
  $("auth-open").hidden = true;
  ($("auth-user").value ? $("auth-pass") : $("auth-user")).focus();
}

function closeAuth() {
  $("auth-form").hidden = true;
  $("auth-pass").value = "";
  renderAuth();
}

$("auth-open").addEventListener("click", openAuth);
$("auth-cancel").addEventListener("click", closeAuth);
$("auth-out").addEventListener("click", () => {
  rememberAuth("");
  setPickNote("");
});

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const user = $("auth-user").value.trim();
  const pass = $("auth-pass").value;
  if (!user || !pass) return;

  const candidate = pack(user, pass);
  const btn = $("auth-form").querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const res = await fetch("/api/auth/check", {
      method: "POST",
      headers: { "X-Auth": candidate },
    });
    if (res.status === 401) {
      setPickNote("Логин или пароль не подошли");
      $("auth-pass").select();
      return;
    }
    if (!res.ok) {
      setPickNote(`Проверка не прошла: сервер ответил ${res.status}`);
      return;
    }
    rememberAuth(candidate);
    closeAuth();
    setPickNote("");
  } catch {
    setPickNote("Нет связи с сервером");
  } finally {
    btn.disabled = false;
  }
});

// ---------- действия ----------

function addPicked() {
  const names = knownPeople().filter((p) => picked.has(lower(p)));
  if (!names.length) return;

  // Проверяем день целиком, а не только галочки: если кто-то из обязательных
  // уже отмечен раньше, добавлять к нему остальных можно свободно.
  const required = requiredNames();
  if (required.length) {
    const after = [...(state.days[selected] || []), ...names];
    const ok = required.some((r) => after.some((p) => lower(p) === lower(r)));
    if (!ok) {
      setPickNote(window.REQUIRED_NOTE || "Нужен кто-то из обязательных участников");
      return; // галочки не сбрасываем — можно добить нужным именем и нажать снова
    }
  }

  run(async () => {
    const fresh = await api("POST", `/api/days/${selected}/attendees`, { names });
    picked.clear(); // чистим только после успеха, иначе выбор пропадёт зря
    setPickNote("");
    return fresh;
  });
}

$("add").addEventListener("click", addPicked);
$("jump-today").addEventListener("click", () => {
  selected = iso(today);
  picked.clear();
  setPickNote("");
  $("scroll").scrollLeft = $("scroll").scrollWidth;
  render();
});

// ---------- старт ----------

buildGrid();
renderAuth();
run(() => api("GET", "/api/log"));

// подтягиваем чужие отметки, пока страница открыта
setInterval(() => {
  if (document.hidden) return;
  api("GET", "/api/log").then((fresh) => { state = fresh; render(); }).catch(() => {});
}, POLL_MS);
