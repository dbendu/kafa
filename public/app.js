"use strict";

const WEEKS = 53;
const POLL_MS = 5000;
const MAX_NAME = 40; // столько же, сколько принимает сервер

const M_SHORT = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];
const M_GEN = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const DOW = ["понедельник","вторник","среда","четверг","пятница","суббота","воскресенье"];

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const dowMon = (d) => (d.getDay() + 6) % 7;
const lower = (s) => s.toLocaleLowerCase("ru");
const visitTotal = (rows) => rows.reduce((total, row) => total + row.count, 0);
const visitsFor = (date, name) => (state.days[date] || []).reduce((total, row) => total + (lower(row.name) === lower(name) ? row.count : 0), 0);

const today = new Date();
today.setHours(0, 0, 0, 0);

// days — кто пришёл, skips — кто обещал и кинул, fails — кто накосячил
let state = { days: {}, people: [], skips: {}, fails: {} };
let selected = iso(today);
let markPending = false;
let loaded = false;
let revision = 0;
let renderedDay = "";
let failChoice = null;
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

// Имена для списка участников: сначала ростер из public/names.js,
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
    $("reason-dialog").close();
    failChoice = null;
    openAuth();
    setDayNote("Нужен пароль, чтобы менять историю");
    const err = new Error("нет пропуска");
    err.handled = true; // сообщение уже показано рядом с кнопкой
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Сервер ответил ${res.status}`);
  return data;
}

// Предупреждение внутри карточки дня, рядом с участниками. Элемент статичный,
// renderDay его не перерисовывает, поэтому опрос сервера сообщение не сотрёт.
function setDayNote(text) {
  const el = $("day-note");
  el.textContent = text;
  el.hidden = !text;
}

function showNote(text) {
  const el = $("note");
  el.textContent = text;
  el.hidden = !text;
}

// Страница может оказаться новее сервера — например, контейнер не пересобрали.
// Тогда в ответе не окажется мешка fails, и отрисовка упала бы на пустом месте.
function adopt(fresh) {
  return {
    days: fresh.days || {},
    people: fresh.people || [],
    skips: fresh.skips || {},
    fails: fresh.fails || {},
    reasons: Array.isArray(fresh.reasons) ? fresh.reasons : [],
    failDetails: fresh.failDetails || {},
  };
}

async function run(fn) {
  try {
    state = adopt(await fn());
    loaded = true;
    showNote("");
  } catch (err) {
    // handled — про ошибку уже сказано в карточке дня, верхний баннер не нужен
    if (err.handled) showNote("");
    else {
      const message = err.message === "Failed to fetch" ? "Нет связи с сервером. Проверьте, что он запущен." : err.message;
      if ($("reason-dialog").open) {
        $("reason-error").textContent = message;
        $("reason-error").hidden = false;
      } else showNote(message);
    }
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
          setDayNote("");
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
  const counts = Object.values(state.days).map(visitTotal);
  const max = Math.max(1, ...counts);
  for (const [key, btn] of cells) {
    const n = visitTotal(state.days[key] || []);
    const level = n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4));
    btn.className = `cell l${level}${key === selected ? " sel" : ""}`;
    btn.title = `${key} — ${n}`;
    btn.setAttribute("aria-label", `${key}, посещений ${n}`);
  }
}

function prettyDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return `${d} ${M_GEN[m - 1]}, ${DOW[dowMon(new Date(y, m - 1, d))]}`;
}

// Все участники остаются в списке; активная кнопка снимает отметку.
function renderDay() {
  const list = state.days[selected] || [];
  const missed = state.skips[selected] || [];
  const botched = state.fails[selected] || [];
  $("day-title").textContent = prettyDate(selected);
  const parts = [];
  if (list.length) parts.push(`Посещений: ${visitTotal(list)}`);
  if (missed.length) parts.push(`Кинули: ${missed.length}`);
  if (botched.length) parts.push(`Косяков: ${botched.length}`);
  $("day-count").textContent = parts.join(" · ") || "Пока никто не отмечен";

  const all = knownPeople();
  const signature = JSON.stringify([selected, list, missed, botched, all, markPending, loaded]);
  if (signature === renderedDay) return;
  renderedDay = signature;
  const people = $("people");
  const focused = people.contains(document.activeElement) ? document.activeElement.dataset : null;
  const focusName = focused?.person;
  const focusKind = focused?.kind;
  people.textContent = "";
  people.setAttribute("aria-busy", String(markPending || !loaded));
  for (const person of all) {
    const row = document.createElement("div");
    row.className = "person-row";
    const label = document.createElement("span");
    label.className = "person-name";
    const mark = crown(person);
    if (mark) label.append(mark);
    label.append(person);
    const actions = document.createElement("div");
    actions.className = "person-actions";
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", `Отметки: ${person}`);
    const count = visitsFor(selected, person);
    const counter = document.createElement("div");
    counter.className = "visit-counter";
    counter.setAttribute("role", "group");
    counter.setAttribute("aria-label", `Посещения: ${person}`);
    const value = document.createElement("input");
    value.type = "text";
    value.readOnly = true;
    value.value = String(count);
    value.setAttribute("aria-label", `${person}: количество посещений`);
    for (const delta of [-1, 1]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "visit-step";
      button.textContent = delta < 0 ? "−" : "+";
      button.dataset.person = person;
      button.dataset.kind = delta < 0 ? "decrement" : "increment";
      button.setAttribute("aria-label", `${person}: ${delta < 0 ? "уменьшить" : "увеличить"} посещения`);
      button.disabled = markPending || !loaded || (delta < 0 && count === 0);
      button.addEventListener("click", () => adjustVisits(person, delta));
      if (delta > 0) counter.append(value);
      counter.append(button);
    }
    actions.append(counter);
    for (const [kind, title, bag] of [
      ["skips", "Кинул", missed], ["fails", "Накосячил", botched],
    ]) {
      const active = bag.some(name => lower(name) === lower(person));
      const button = document.createElement("button");
      button.type = "button";
      button.className = `status-button ${kind}`;
      button.textContent = (active ? "✓ " : "") + title;
      button.dataset.person = person;
      button.dataset.kind = kind;
      button.setAttribute("aria-pressed", String(active));
      button.setAttribute("aria-label", `${person}: ${title}`);
      button.title = active ? "Снять отметку" : "Поставить отметку";
      button.disabled = markPending || !loaded;
      button.addEventListener("click", () => toggleMark(person, kind));
      actions.append(button);
    }
    if (botched.some(name => lower(name) === lower(person))) {
      const info = document.createElement("button");
      info.type = "button";
      info.className = "reason-info";
      info.textContent = "ⓘ";
      info.dataset.person = person;
      info.dataset.kind = "reason-info";
      info.setAttribute("aria-label", `${person}: посмотреть причину косяка`);
      info.title = "Посмотреть причину косяка";
      info.addEventListener("click", () => viewFailReason(person));
      actions.append(info);
    }
    row.append(label, actions);
    people.append(row);
  }
  if (!all.length) {
    const empty = document.createElement("p");
    empty.className = "sub";
    empty.textContent = loaded ? "Список участников пуст" : "Загружаю участников…";
    people.append(empty);
  }
  if (focusName && !markPending) {
    const button = [...people.querySelectorAll("button")].find(b => b.dataset.person === focusName && b.dataset.kind === focusKind);
    button?.focus({ preventScroll: true });
  }
}

// Рейтинг мешка: [[имя, сколько раз], …] без порядка — сортирует вызывающий.
// Все известные имена попадают сюда, даже с нулём: иначе тот, кто ещё ни разу
// не приходил (или ни разу не кидал), не показался бы в рейтинге вовсе.
function tally(bag, visits = false) {
  const counts = new Map(); // ключ — имя в нижнем регистре
  const add = (person, n) => {
    const row = counts.get(lower(person));
    if (row) row.n += n;
    else counts.set(lower(person), { person, n });
  };

  // сначала список — от него берём написание имени, потом отметки
  for (const person of knownPeople()) add(person, 0);
  for (const list of Object.values(bag)) {
    for (const entry of list) add(visits ? entry.name : entry, visits ? entry.count : 1);
  }

  return [...counts.values()].map((row) => [row.person, row.n]);
}

// Оба рейтинга идут по убыванию счёта: сверху те, за кем больше записей.
// Равный счёт — по алфавиту, иначе порядок зависел бы от того, как обошёлся
// мешок.
const mostFirst = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru");

// Ранг — место в списке: 1 у первой строки, у кого счёт равный, у тех ранг
// общий. В приходах 1 ранг у того, кто ходит чаще всех, в кидках — у того,
// кто чаще всех кидает.
function withRanks(rows) {
  let rank = 0;
  let prevCount = null;
  return rows.map(([person, n]) => {
    if (n !== prevCount) {
      rank += 1;
      prevCount = n;
    }
    return { person, n, rank };
  });
}

function renderTops() {
  renderTopAttendees();
  renderTopSkippers();
  renderTopFails();
}

// Кто ходит чаще, тот выше: картинки рангов из window.RANKS. В списке весь
// состав, включая тех, кто ещё ни разу не пришёл. Но пока никто не пришёл
// вовсе, карточку не показываем: столбик нулей ничего не говорит.
function renderTopAttendees() {
  const rows = withRanks(tally(state.days, true).sort(mostFirst));
  $("top-card").hidden = !rows.some(({ n }) => n > 0);
  renderBars($("top"), rows, {
    badges: Array.isArray(window.RANKS) ? window.RANKS : [],
    rankWord: "ранг",
  });
}

// Кто чаще кидает, тот выше: свои картинки, антиранги из window.ANTIRANKS.
// Тех, кто не кидал ни разу, в этот список не берём: он про кидки, а не про
// весь состав. В приходах наоборот — там ноль тоже результат.
function renderTopSkippers() {
  const kicked = tally(state.skips).filter(([, n]) => n > 0);
  const rows = withRanks(kicked.sort(mostFirst));
  $("miss-card").hidden = rows.length === 0;
  renderBars($("miss-top"), rows, {
    badges: Array.isArray(window.ANTIRANKS) ? window.ANTIRANKS : [],
    rankWord: "антиранг",
  });
}

// Кто чаще косячит: картинки из window.FAILRANKS. Как и в кидках, тех, за кем
// косяков нет, в списке не показываем.
function renderTopFails() {
  const botched = tally(state.fails).filter(([, n]) => n > 0);
  const rows = withRanks(botched.sort(mostFirst));
  $("fail-card").hidden = rows.length === 0;
  renderBars($("fail-top"), rows, {
    badges: Array.isArray(window.FAILRANKS) ? window.FAILRANKS : [],
    rankWord: "антиранг",
  });
}

// Полоски с именами. Рисуются одинаково для обоих списков: разница только
// в картинках и в цвете (его задаёт css по id карточки).
function renderBars(box, rows, { badges, rankWord }) {
  box.textContent = "";
  const max = rows.reduce((m, { n }) => Math.max(m, n), 0);

  for (const { person, n, rank } of rows) {
    const row = document.createElement("div");
    row.className = "bar-row";

    const who = document.createElement("span");
    who.className = "who";
    const badge = n > 0 ? badges[rank - 1] : null; // за ноль картинки нет
    if (badge) {
      const img = document.createElement("img");
      img.className = "rank";
      img.src = badge;
      img.alt = "";
      img.title = `${rank} ${rankWord}`;
      who.appendChild(img);
    }
    who.append(person);

    const bar = document.createElement("span");
    bar.className = "bar";
    const fill = document.createElement("i");
    fill.style.width = max ? `${(n / max) * 100}%` : "0%";
    bar.appendChild(fill);

    const num = document.createElement("span");
    num.className = "n";
    num.textContent = n;

    row.append(who, bar, num);
    box.appendChild(row);
  }
}

function renderSummary() {
  const days = Object.keys(state.days).length;
  const total = (bag) => Object.values(bag).reduce((s, v) => s + v.length, 0);
  const visits = Object.values(state.days).reduce((sum, rows) => sum + visitTotal(rows), 0);
  const misses = total(state.skips);
  const fails = total(state.fails);
  if (!days && !misses && !fails) {
    $("summary").textContent = "Пока пусто. Отметьте первого — и день окрасится.";
    return;
  }
  $("summary").textContent =
    `${visits} посещений за ${days} дней.` +
    (misses ? ` Кидков: ${misses}.` : "") +
    (fails ? ` Косяков: ${fails}.` : "");
}

function render() {
  paintGrid();
  renderDay();
  renderTops();
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
  setDayNote("");
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
      setDayNote("Логин или пароль не подошли");
      $("auth-pass").select();
      return;
    }
    if (!res.ok) {
      setDayNote(`Проверка не прошла: сервер ответил ${res.status}`);
      return;
    }
    rememberAuth(candidate);
    closeAuth();
    setDayNote("");
  } catch {
    setDayNote("Нет связи с сервером");
  } finally {
    btn.disabled = false;
  }
});

// ---------- действия ----------

function viewFailReason(person) {
  $("fail-view-person").textContent = `${person} · ${prettyDate(selected)}`;
  const details = (state.failDetails?.[selected] || []).filter(row => lower(row.name) === lower(person));
  $("fail-view-reasons").textContent = details.length
    ? details.map(detail => detail.reason?.trim() ? detail.reason : "Причина не указана в записи косяка.").join("\n")
    : "Не удалось получить причину. Обновите страницу.";
  $("fail-view-dialog").showModal();
}

function openReasonDialog(person, date) {
  failChoice = { person, date };
  $("reason-person").textContent = `${person} · ${prettyDate(date)}`;
  $("reason-error").hidden = true;
  const select = $("reason-select");
  select.textContent = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "ризоны";
  placeholder.disabled = true;
  placeholder.selected = true;
  select.append(placeholder);
  const reasons = (state.reasons || []).filter(reason => reason.reason.trim());
  for (const reason of reasons) {
    const option = document.createElement("option");
    option.value = String(reason.id);
    option.textContent = reason.reason;
    select.append(option);
  }
  select.disabled = !reasons.length;
  $("reason-save").disabled = true;
  if (select.disabled) {
    $("reason-error").textContent = "В базе пока нет причин. Добавьте причину и обновите страницу.";
    $("reason-error").hidden = false;
  }
  $("reason-dialog").showModal();
}

$("reason-select").addEventListener("change", () => {
  $("reason-save").disabled = !$("reason-select").value || markPending;
  $("reason-error").hidden = true;
});
$("reason-cancel").addEventListener("click", () => {
  $("reason-dialog").close();
  failChoice = null;
});
$("reason-dialog").addEventListener("cancel", event => {
  if (markPending) event.preventDefault();
  else failChoice = null;
});
$("reason-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!failChoice || markPending || !$("reason-select").value) return;
  if (failChoice.date !== selected) {
    $("reason-dialog").close();
    failChoice = null;
    return;
  }
  const person = failChoice.person;
  const reasonId = Number($("reason-select").value);
  $("reason-error").hidden = true;
  $("reason-select").disabled = true;
  $("reason-save").disabled = true;
  $("reason-cancel").disabled = true;
  try { await toggleMark(person, "fails", reasonId); }
  finally {
    $("reason-select").disabled = false;
    $("reason-save").disabled = !$("reason-select").value;
    $("reason-cancel").disabled = false;
  }
});

async function adjustVisits(person, delta) {
  if (markPending || !loaded || (delta < 0 && visitsFor(selected, person) === 0)) return;
  const date = selected;
  setDayNote("");
  if (delta > 0) {
    const required = requiredNames();
    const attendees = [...(state.days[date] || []).filter(row => row.count > 0).map(row => row.name), person];
    if (required.length && !required.some(name => attendees.some(p => lower(p) === lower(name)))) {
      setDayNote(window.REQUIRED_NOTE || "Сначала отметьте одного из обязательных участников");
      return;
    }
  }
  const action = delta > 0 ? "increment" : "decrement";
  markPending = true;
  revision += 1;
  renderDay();
  try { await run(() => api("POST", `/api/days/${date}/visits/${action}`, { name: person })); }
  finally {
    markPending = false;
    revision += 1;
    renderDay();
    if (selected === date && document.activeElement === document.body) {
      const buttons = [...$("people").querySelectorAll("button")];
      const button = buttons.find(b => b.dataset.person === person && b.dataset.kind === action && !b.disabled)
        || buttons.find(b => b.dataset.person === person && b.dataset.kind === "increment");
      button?.focus({ preventScroll: true });
    }
  }
}

async function toggleMark(person, kind, reasonId) {
  if (markPending || !loaded) return;
  const date = selected;
  const bag = state[kind];
  const active = reasonId === undefined && (bag[date] || []).some(name => lower(name) === lower(person));
  setDayNote("");
  if (kind === "fails" && !active && reasonId === undefined) {
    openReasonDialog(person, date);
    return;
  }
  markPending = true;
  revision += 1;
  renderDay();
  const url = `/api/days/${date}/${kind}`;
  try {
    await run(async () => {
      const fresh = active
        ? await api("DELETE", `${url}/${encodeURIComponent(person)}`)
        : await api("POST", url, { name: person, ...(kind === "fails" ? { reason_id: reasonId } : {}) });
      if (reasonId !== undefined) {
        $("reason-dialog").close();
        failChoice = null;
      }
      return fresh;
    });
  } finally {
    markPending = false;
    revision += 1;
    renderDay();
    if (selected === date && document.activeElement === document.body) {
      const button = [...$("people").querySelectorAll("button")].find(b => b.dataset.person === person && b.dataset.kind === kind);
      button?.focus({ preventScroll: true });
    }
  }
}

$("jump-today").addEventListener("click", () => {
  selected = iso(today);
  setDayNote("");
  $("scroll").scrollLeft = $("scroll").scrollWidth;
  render();
});

// ---------- старт ----------

buildGrid();
renderAuth();
run(() => api("GET", "/api/log"));

// подтягиваем чужие отметки, пока страница открыта
function refresh() {
  if (markPending) return;
  const version = revision;
  api("GET", "/api/log").then((fresh) => {
    if (markPending || version !== revision) return;
    state = adopt(fresh);
    loaded = true;
    render();
  }).catch(() => {});
}

setInterval(() => {
  if (document.hidden) return;
  refresh();
}, POLL_MS);

// Вернулись на вкладку — обновляем сразу, не дожидаясь тика: пока вкладка была
// в фоне, опрос не шёл, и данные могли устареть на все POLL_MS.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
