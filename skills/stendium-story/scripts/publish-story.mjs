#!/usr/bin/env node
/**
 * Stendium — публикация «истории сборки» как материала (Resource). Ф1 шаг 6.
 *
 * ЖЁСТКИЙ ГЕЙТ БЕЗОПАСНОСТИ: перед отправкой прогоняет title/excerpt/contentMd
 * через scrub.mjs. При находках категории secret (ключи/токены/пароли/приватные
 * ключи/строки подключения) — ОТКАЗЫВАЕТСЯ публиковать (exit 3), пока автор не
 * уберёт их и не подтвердит. ПДн (email/телефон) авто-редактируются с
 * предупреждением. Публикуется всегда ОЧИЩЕННАЯ версия, не сырой текст.
 *
 * Использование:
 *   node publish-story.mjs --story <path.json>
 *   node publish-story.mjs --story <path.json> --force   # опубликовать несмотря
 *        на secret-находки (ТОЛЬКО после того, как автор их отсмотрел и подтвердил)
 *
 * Окружение: STENDIUM_TOKEN (обязателен), STENDIUM_BASE_URL / --base (опц.).
 *
 * Формат истории (JSON):
 *   { "title": "≤120", "excerpt": "тизер ≤280", "category": "<ключ темы>",
 *     "contentMd": "markdown истории (со ссылкой на инструмент)",
 *     "externalUrl": "опц. внешняя ссылка вместо/вместе с markdown" }
 */
import { readFileSync } from "node:fs";
import { scrubText, hasSecrets } from "./scrub.mjs";

function argVal(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const FORCE = process.argv.includes("--force");

const BASE = (argVal("--base") || process.env.STENDIUM_BASE_URL || "https://stendium.ru").replace(/\/+$/, "");
const TOKEN = process.env.STENDIUM_TOKEN;

const TITLE_MAX = 120;
const EXCERPT_MAX = 280;
const CONTENT_MAX = 20000;

function die(msg, code = 1) {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

if (!TOKEN) {
  die(
    "Не задан STENDIUM_TOKEN.\n" +
      `  1) Создайте токен: ${BASE}/profile/tokens\n` +
      '  2) export STENDIUM_TOKEN="stnd_..."  (PowerShell: $env:STENDIUM_TOKEN="stnd_...")'
  );
}
if (!TOKEN.startsWith("stnd_")) die("STENDIUM_TOKEN не похож на токен Стендиума (префикс stnd_).");

const storyPath = argVal("--story");
if (!storyPath) die("Укажите историю: --story <path.json>");

let story;
try {
  story = JSON.parse(readFileSync(storyPath, "utf8"));
} catch (e) {
  die(`Не удалось прочитать/распарсить ${storyPath}: ${e.message}`);
}

const title = typeof story.title === "string" ? story.title.trim() : "";
const excerpt = typeof story.excerpt === "string" ? story.excerpt.trim() : "";
const category = typeof story.category === "string" ? story.category.trim() : "";
const contentMd = typeof story.contentMd === "string" ? story.contentMd : "";
const externalUrl = typeof story.externalUrl === "string" ? story.externalUrl.trim() : "";

if (!title) die("Нет title.");
if (title.length > TITLE_MAX) die(`title длиннее ${TITLE_MAX}.`);
if (!excerpt) die("Нет excerpt (тизер для ленты).");
if (excerpt.length > EXCERPT_MAX) die(`excerpt длиннее ${EXCERPT_MAX}.`);
if (!category) die("Нет category.");
if (!contentMd && !externalUrl) die("История пуста: добавьте contentMd (markdown) или externalUrl.");
if (contentMd.length > CONTENT_MAX) die(`contentMd длиннее ${CONTENT_MAX}.`);

// ── ГЕЙТ: скраб ───────────────────────────────────────────────────────────
const st = scrubText(title);
const se = scrubText(excerpt);
const sc = scrubText(contentMd);
const allFindings = [...st.findings, ...se.findings, ...sc.findings];

if (allFindings.length > 0) {
  const agg = new Map();
  for (const f of allFindings) {
    const cur = agg.get(f.type) || { sev: f.sev, count: 0 };
    cur.count += f.count;
    agg.set(f.type, cur);
  }
  console.error("⚠ Скраб нашёл чувствительные данные:");
  for (const [type, v] of agg) console.error(`  - ${type} (${v.sev}): ${v.count}`);

  if (hasSecrets(allFindings) && !FORCE) {
    die(
      "Найдены СЕКРЕТЫ (ключи/токены/пароли). Публикация остановлена.\n" +
        "  Уберите их из истории, покажите очищенный текст автору и повторите.\n" +
        "  Если это ложное срабатывание и автор подтвердил — добавьте --force.",
      3
    );
  }
  console.error("  → Публикуется ОЧИЩЕННАЯ версия (данные заменены на [REDACTED:*]).");
}

const cleanBody = {
  title: st.redacted,
  excerpt: se.redacted,
  category,
  contentMd: sc.redacted || null,
  ...(externalUrl ? { externalUrl } : {}),
};

// ── Публикация ──────────────────────────────────────────────────────────────
const res = await fetch(`${BASE}/api/resources`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify(cleanBody),
}).catch((e) => die(`Сетевая ошибка: ${e.message}`));

const data = await res.json().catch(() => null);
if (res.status === 401) die("Токен не принят (401).");
if (res.status === 429) die((data && data.error) || "Суточный лимит публикаций (429).");
if (!res.ok) die((data && data.error) || `Сервер вернул HTTP ${res.status}.`);

const slug = (data && (data.slug || data.id)) || null;
console.log("✓ История сборки опубликована.");
if (slug) console.log(`  ${BASE}/resource/${slug}`);
console.log(JSON.stringify({ ok: true, ...(data || {}) }));
