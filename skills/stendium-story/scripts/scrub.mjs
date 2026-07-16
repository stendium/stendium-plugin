#!/usr/bin/env node
/**
 * Скраб секретов и ПДн для «истории сборки» (Ф1 шаг 6).
 *
 * История собирается из git-логов/сессий, куда легко попадают ключи, токены,
 * пароли, .env-значения, приватные ключи, строки подключения, email/телефоны.
 * Этот модуль — жёсткий гейт: находит их и заменяет на [REDACTED:<тип>].
 *
 * Самодостаточен (без зависимостей и без pdn-guard — плагин ставят внешние
 * авторы). Экспортирует scrubText() для publish-story.mjs; как CLI —
 * `node scrub.mjs <файл>` печатает находки и пишет <файл>.scrubbed.md.
 *
 * ВАЖНО: regex не ловит всё. Второй, главный гейт — ОБЯЗАТЕЛЬНЫЙ просмотр
 * автором финального текста перед публикацией (см. SKILL.md).
 */
import { readFileSync, writeFileSync } from "node:fs";

// Каждый паттерн: type (метка), sev ("secret" | "pii"), re (глобальный).
// Для env-secret редактируем только значение (группа 2), ключ оставляем.
const PATTERNS = [
  { type: "private-key", sev: "secret", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { type: "aws-access-key-id", sev: "secret", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: "google-api-key", sev: "secret", re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { type: "github-token", sev: "secret", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { type: "openai-key", sev: "secret", re: /\bsk-[A-Za-z0-9_\-]{20,}\b/g },
  { type: "stendium-token", sev: "secret", re: /\bstnd_[A-Za-z0-9_\-]{20,}\b/g },
  { type: "slack-token", sev: "secret", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "jwt", sev: "secret", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g },
  { type: "bearer-token", sev: "secret", re: /\bBearer\s+[A-Za-z0-9._\-]{20,}/gi },
  { type: "conn-string", sev: "secret", re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp)s?:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/gi },
  // KEY=value / KEY: value, где имя ключа выглядит секретным. Редактируем значение.
  { type: "env-secret", sev: "secret", valueGroup: 2, re: /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET)[A-Za-z0-9_]*)\s*[=:]\s*['"]?([^\s'"]{6,})['"]?/gi },
  { type: "email", sev: "pii", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

function isPhoneLike(s) {
  const digits = (s.match(/\d/g) || []).length;
  if (digits < 10 || digits > 15) return false;
  // Отсекаем «голые» длинные числа (timestamp/id): требуем + или разделитель.
  return /^\+/.test(s.trim()) || /[\s().\-]/.test(s);
}

/**
 * Скрабит текст. Возвращает { redacted, findings: [{type, sev, count}] }.
 * Идемпотентно: повторный прогон уже очищенного текста находит 0.
 */
export function scrubText(input) {
  if (typeof input !== "string" || !input) return { redacted: input ?? "", findings: [] };
  let text = input;
  const counts = new Map(); // type -> { sev, count }

  const bump = (type, sev, n = 1) => {
    const cur = counts.get(type) || { sev, count: 0 };
    cur.count += n;
    counts.set(type, cur);
  };

  for (const p of PATTERNS) {
    text = text.replace(p.re, (match, ...groups) => {
      if (p.valueGroup) {
        // Редактируем только значение, ключ и разделитель оставляем.
        const value = groups[p.valueGroup - 1];
        if (!value) return match;
        bump(p.type, p.sev);
        return match.replace(value, `[REDACTED:${p.type}]`);
      }
      bump(p.type, p.sev);
      return `[REDACTED:${p.type}]`;
    });
  }

  // Телефоны — отдельно, с проверкой «похоже на телефон».
  text = text.replace(/\+?\d[\d\s().\-]{7,}\d/g, (m) => {
    if (!isPhoneLike(m)) return m;
    bump("phone", "pii");
    return "[REDACTED:phone]";
  });

  const findings = [...counts.entries()].map(([type, v]) => ({ type, sev: v.sev, count: v.count }));
  return { redacted: text, findings };
}

/** Есть ли находки категории secret (жёсткий гейт). */
export function hasSecrets(findings) {
  return findings.some((f) => f.sev === "secret");
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function isMain() {
  return process.argv[1] && process.argv[1].endsWith("scrub.mjs");
}

if (isMain()) {
  const file = process.argv[2];
  if (!file) {
    console.error("Использование: node scrub.mjs <файл.md>");
    process.exit(2);
  }
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    console.error(`Не удалось прочитать ${file}: ${e.message}`);
    process.exit(2);
  }
  const { redacted, findings } = scrubText(raw);
  const out = file.replace(/(\.[^.]+)?$/, ".scrubbed$1");
  writeFileSync(out, redacted, "utf8");
  if (findings.length === 0) {
    console.log("✓ Секретов/ПДн не найдено. Копия: " + out);
  } else {
    console.log("⚠ Найдено и вырезано:");
    for (const f of findings) console.log(`  - ${f.type} (${f.sev}): ${f.count}`);
    console.log("Очищенная версия: " + out);
    console.log("Покажите её автору перед публикацией.");
  }
}
