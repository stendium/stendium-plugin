#!/usr/bin/env node
/**
 * Stendium — транспорт публикации инструмента.
 *
 * Читает машиночитаемую карточку (JSON) и отправляет её на Стендиум через API
 * с персональным токеном (Bearer PAT). Без внешних зависимостей — только
 * глобальный fetch (Node 18+).
 *
 * Использование:
 *   node publish.mjs --card <path.json>                  # опубликовать (POST)
 *   node publish.mjs --card <path.json> --update <toolId> # обновить существующий (PATCH)
 *   node publish.mjs --check                              # проверить токен и доступ
 *
 * Окружение:
 *   STENDIUM_TOKEN     — персональный токен (обязателен). Создать: <base>/profile/tokens
 *   STENDIUM_BASE_URL  — база API (опц., по умолчанию https://stendium.ru); также --base
 *
 * Формат карточки (JSON) — это тело запроса:
 *   {
 *     "title":       "строка ≤120",
 *     "excerpt":     "тизер для ленты ≤280",
 *     "description": "подробное описание ≤500 (опц.)",
 *     "url":         "https://... — рабочая ссылка на инструмент",
 *     "category":    "product|growth|data|design|engineering|team|market|other",
 *     "thumbnail":   "/uploads/... (опц., путь на Стендиуме)",
 *     "toolType":    "web_app|tg_bot|website|code_snippet|skill_plugin|api_endpoint|other",
 *     "machineCard": {
 *       "toolType":  "то же значение",
 *       "jobs":      ["какие задачи решает — человеческими словами"],
 *       "inputs":    ["что принимает на вход"],
 *       "outputs":   ["что отдаёт"],
 *       "techStack": ["чем собрано"],
 *       "embeddable":   null,
 *       "launchHint":   "t.me/...?start=... (для tg_bot, опц.)",
 *       "buildStoryUrl": null,
 *       "authorContact": "@nick (опц.)"
 *     }
 *   }
 */
import { readFileSync } from "node:fs";

function argVal(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name) {
  return process.argv.includes(name);
}

const BASE = (argVal("--base") || process.env.STENDIUM_BASE_URL || "https://stendium.ru").replace(/\/+$/, "");
const TOKEN = process.env.STENDIUM_TOKEN;

const TITLE_MAX = 120;
const EXCERPT_MAX = 280;
const DESCRIPTION_MAX = 500;

function die(msg, code = 1) {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

function ok(msg) {
  console.log(`✓ ${msg}`);
}

if (!TOKEN) {
  die(
    "Не задан STENDIUM_TOKEN.\n" +
      `  1) Создайте персональный токен: ${BASE}/profile/tokens\n` +
      '  2) bash/zsh:       export STENDIUM_TOKEN="stnd_..."\n' +
      '     PowerShell:      $env:STENDIUM_TOKEN = "stnd_..."'
  );
}

if (!TOKEN.startsWith("stnd_")) {
  die("STENDIUM_TOKEN не похож на токен Стендиума (ожидается префикс stnd_).");
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function check() {
  // Лёгкая проверка: токен формата stnd_ уже прошёл; проверяем, что база отвечает
  // и токен принимается (401 = токен неверный). Пробуем безопасный GET.
  let res;
  try {
    res = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  } catch (e) {
    die(`Не удалось соединиться с ${BASE}: ${e.message}`);
  }
  if (res.status === 401) die("Токен не принят (401). Проверьте STENDIUM_TOKEN.");
  ok(`База доступна: ${BASE} (HTTP ${res.status}). Токен задан.`);
}

function validateCard(card) {
  const errs = [];
  if (!card || typeof card !== "object") errs.push("карточка не является объектом");
  const s = (v) => (typeof v === "string" ? v.trim() : "");
  if (!s(card.title)) errs.push("нет title");
  else if (card.title.length > TITLE_MAX) errs.push(`title длиннее ${TITLE_MAX}`);
  if (!s(card.excerpt)) errs.push("нет excerpt (тизер для ленты)");
  else if (card.excerpt.length > EXCERPT_MAX) errs.push(`excerpt длиннее ${EXCERPT_MAX}`);
  if (typeof card.description === "string" && card.description.length > DESCRIPTION_MAX)
    errs.push(`description длиннее ${DESCRIPTION_MAX}`);
  if (!s(card.url)) errs.push("нет url");
  else if (!/^https?:\/\//i.test(card.url)) errs.push("url должен начинаться с http(s)://");
  if (!s(card.category)) errs.push("нет category");
  if (!s(card.toolType)) errs.push("нет toolType");
  return errs;
}

async function publish(card, updateId) {
  const errs = validateCard(card);
  if (errs.length) die("Карточка не прошла проверку:\n  - " + errs.join("\n  - "));

  const isUpdate = Boolean(updateId);
  const url = isUpdate
    ? `${BASE}/api/tools/${encodeURIComponent(updateId)}`
    : `${BASE}/api/tools`;
  const method = isUpdate ? "PATCH" : "POST";

  let res;
  try {
    res = await fetch(url, { method, headers, body: JSON.stringify(card) });
  } catch (e) {
    die(`Сетевая ошибка при обращении к ${url}: ${e.message}`);
  }

  const data = await readJson(res);

  if (res.status === 401) die("Токен не принят (401). Проверьте STENDIUM_TOKEN.");
  if (res.status === 403) die("Нет прав на это действие (403).");
  if (res.status === 404 && isUpdate) die("Инструмент для обновления не найден (404).");
  if (res.status === 409) {
    die(
      "У вас уже опубликован инструмент с этим URL (409).\n" +
        "  Чтобы обновить существующий — передайте --update <toolId>.\n" +
        "  toolId можно взять из ссылки на инструмент или из /profile."
    );
  }
  if (res.status === 429) die((data && data.error) || "Достигнут суточный лимит публикаций (429).");
  if (!res.ok) die((data && data.error) || `Сервер вернул ошибку HTTP ${res.status}.`);

  const slug = (data && (data.slug || data.id)) || null;
  ok(isUpdate ? "Инструмент обновлён." : "Инструмент опубликован.");
  if (slug) console.log(`  ${BASE}/tool/${slug}`);
  // Машиночитаемый результат — последней строкой, чтобы вызывающий агент мог распарсить.
  console.log(JSON.stringify({ ok: true, action: isUpdate ? "update" : "create", ...(data || {}) }));
}

async function main() {
  if (hasFlag("--check")) {
    await check();
    return;
  }
  const cardPath = argVal("--card");
  if (!cardPath) {
    die("Укажите карточку: --card <path.json> (или --check для проверки токена).");
  }
  let raw;
  try {
    raw = readFileSync(cardPath, "utf8");
  } catch (e) {
    die(`Не удалось прочитать файл карточки ${cardPath}: ${e.message}`);
  }
  let card;
  try {
    card = JSON.parse(raw);
  } catch (e) {
    die(`Файл карточки не является валидным JSON: ${e.message}`);
  }
  await publish(card, argVal("--update"));
}

main().catch((e) => die(`Непредвиденная ошибка: ${e.message}`));
