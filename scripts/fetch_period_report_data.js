// Тянет сырые данные из воронки "Воронка | Аутбаунд" (id 10793110) для периодических
// отчетов (неделя/2 недели/месяц/квартал): сделки-снэпшот на конец периода, события
// (новые сделки + смены стадий) и заметки за объединенный диапазон [prevFrom, currentTo].
// Метрики не считает — только выгружает данные, интерпретация остается за скиллом.
// Каждая сделка, событие и заметка помечены полем "Ньюбиз" (кто ведет контакт: Маша/Лиза/Саша),
// чтобы скилл мог считать метрики отдельно по каждому человеку.
//
// Использование:
//   node scripts/fetch_period_report_data.js <currentFrom> <currentTo> [<prevFrom> <prevTo>] > period_data.json
// Даты — в формате YYYY-MM-DD (включительно), например:
//   node scripts/fetch_period_report_data.js 2026-08-04 2026-08-10 2026-07-28 2026-08-03 > period_data.json
// Прошлый период необязателен: без него табличка показывает только текущий.
//
// Флаги:
//   --table    вместо JSON печатает табличку по каждому ньюбизу: текущий период (в скобках прошлый, если задан)
//   --details  вместе с --table перечисляет карточки по переходам на этапы и по строкам «по заметкам»
const fs = require("fs");
const path = require("path");

function loadEnv(filePath) {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return env;
}

const env = loadEnv(path.join(__dirname, "..", ".env"));
for (const key of ["AMOCRM_SUBDOMAIN", "AMOCRM_TOKEN", "AMOCRM_API_BASE"]) {
  if (process.env[key]) env[key] = process.env[key];
}
const SUBDOMAIN = env.AMOCRM_SUBDOMAIN;
const TOKEN = env.AMOCRM_TOKEN;
const API_BASE = env.AMOCRM_API_BASE;
const PIPELINE_ID = 10793110;
const NEWBIZ_FIELD_ID = 921917; // поле "Ньюбиз" (select: Маша / Лиза / Саша)
const NEWBIZ_EMPTY = "не указан";
const NEWBIZ_TEAM = ["Маша", "Лиза", "Саша"]; // всегда в табличке, даже без сделок
const STATUS_UNSORTED = 84974846; // "Неразобранное" — не этап работы
const STATUS_NEW = 87118722; // "Новые контакты" — уже есть строка «Новые контакты»
const STATUS_HANDED_OVER = 85003050; // "Передано команде"
const STATUS_LOST = 143;
const LOSS_REASON_TEAM_TOOK = 24880686; // "Подхватила команда"

// Строки «по заметкам» — эвристика по тексту примечаний Марии, нужна сверка (--details).
// Считается карточка, если в одной ее заметке за период есть и тема, и подтверждение,
// и нет слов, говорящих, что это только предложение или отказ.
const NOTE_RULES = {
  meetings: {
    topic: /встреч|офлайн|оффлайн|кофе|пересечь|пересеклись/i,
    confirm: /договорил|согласил|встречаются|назначил|прошла|состоялась|встреча \S+ с |\d{1,2}\.\d{1,2}/i,
    exclude: /предложил|пинганул|отложить|не получилось|нет времени|не пришел|не пришла|напишу|позову|позвать|хочу/i,
  },
  calls: {
    topic: /созвон|звон|демо|голосом/i,
    confirm: /созвонились|провели|прошел|прошло|был звонок|разобрались|поговорили/i,
    exclude: /предложил|перенос|не нужен/i,
  },
};

// Пояснения к строкам таблички (для Ильи и команды). Этапы ищутся по названию,
// чтобы переименование этапа в amoCRM не ломало пояснение.
const ROW_NOTES = [
  [/^Новые контакты$/, "карточки, заведенные в периоде"],
  [/^Продолжающиеся контакты$/, "заведены раньше, в периоде было касание: заметка или смена этапа"],
  [/^Заметки$/, "все примечания в карточках за период"],
  [/^Встречи/, "встреча договорена или прошла (оценка по тексту заметок)"],
  [/^Звонки/, "созвон или демо прошли (оценка по тексту заметок)"],
  [/аутрич|потепл/i, "написали первое сообщение"],
  [/общаемся/i, "контакт ответил, завязался теплый диалог: подключает внешние команды или готов нас рассмотреть, но пока неясно, под какую задачу и когда"],
  [/жд\S* задач/i, "клиент пообещал конкретный шаг: прислать план задач, позвать в тендер"],
  [/демо|кп/i, "дали первые ориентиры, клиент готов обсуждать дальше. КП — не документ, а ориентир по стоимости или предложение текстом в тг; демо — проба идеи, чаще у ЦД"],
  [/передано/i, "дали первые ориентиры, клиент готов обсуждать дальше, запрос передали команде"],
  [/илье|оффлайн|офлайн/i, "нужна личная встреча или знакомство через Илью"],
  [/вернуться позже/i, "контакт теплый, но в ближайшие три недели повода продолжать нет"],
  [/успешно/i, "сделка состоялась"],
  [/закрыто и не|нереализ/i, "диалог заглох или внешние команды не подключают либо планируют не раньше середины следующего года; раз в квартал проверяем повод"],
];
const rowNote = (name) => ROW_NOTES.find(([re]) => re.test(name.replace(/^→ /, "")))?.[1] || "";

// Переход на этап и обратно за это время считаем случайным кликом.
const REVERT_WINDOW_SEC = 10 * 60;

// Приходы карточек на этапы: [{lead_id, status_id, period}]. Не считаются переход,
// откатанный за 10 минут, и возврат на этап, с которого карточка ушла за 10 минут до этого.
function stageArrivals(events) {
  const byLead = {};
  for (const e of events) {
    if (e.type !== "lead_status_changed") continue;
    (byLead[e.lead_id] ||= []).push(e);
  }
  const within = (a, b) => (Date.parse(b.created_at) - Date.parse(a.created_at)) / 1000 <= REVERT_WINDOW_SEC;
  const arrivals = [];
  for (const list of Object.values(byLead)) {
    list.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    list.forEach((e, i) => {
      const prev = list[i - 1];
      const next = list[i + 1];
      const reverted = next && next.from_status_id === e.to_status_id && within(e, next);
      const returned = prev && prev.from_status_id === e.to_status_id && within(prev, e);
      if (!reverted && !returned) arrivals.push({ lead_id: e.lead_id, status_id: e.to_status_id, period: e.period });
    });
  }
  return arrivals;
}

function matchesRule(text, rule) {
  return rule.topic.test(text) && rule.confirm.test(text) && !(rule.exclude && rule.exclude.test(text));
}
const BASE = (API_BASE || `https://${SUBDOMAIN}.amocrm.ru/api/v4`).replace(/\/$/, "");

function parseDayBoundary(dateStr, endOfDay) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = endOfDay
    ? new Date(Date.UTC(y, m - 1, d, 23, 59, 59))
    : new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  return Math.floor(dt.getTime() / 1000);
}

// Связь с amoCRM бывает нестабильной (VPN), поэтому сетевые обрывы повторяем.
async function fetchWithRetry(url, options, attempts = 6) {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 2000 * i)); // 2, 4, 6... секунд
    }
  }
}

async function amoGet(pathAndQuery) {
  const res = await fetchWithRetry(`${BASE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${pathAndQuery} ${body.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function fetchAllPages(pathBase, embeddedKey, extraQuery = "") {
  const items = [];
  let page = 1;
  while (true) {
    const data = await amoGet(`${pathBase}?limit=250&page=${page}${extraQuery}`);
    const chunk = data?._embedded?.[embeddedKey] || [];
    items.push(...chunk);
    if (chunk.length < 250) break;
    page += 1;
  }
  return items;
}

function customFieldsToMap(customFieldsValues) {
  const map = {};
  for (const field of customFieldsValues || []) {
    const values = (field.values || []).map((v) => v.value).join("; ");
    map[field.field_name] = values;
  }
  return map;
}

function getNewbiz(customFieldsValues) {
  const field = (customFieldsValues || []).find((f) => f.field_id === NEWBIZ_FIELD_ID);
  return field?.values?.[0]?.value || NEWBIZ_EMPTY;
}

function tagPeriod(ts, ranges) {
  if (ts >= ranges.current.from && ts <= ranges.current.to) return "current";
  if (ts >= ranges.previous.from && ts <= ranges.previous.to) return "previous";
  return null;
}

async function getStatuses() {
  const data = await amoGet(`/leads/pipelines/${PIPELINE_ID}`);
  const list = (data?._embedded?.statuses || []).map((s) => ({
    id: s.id,
    name: s.name,
  }));
  const byId = {};
  for (const s of list) byId[s.id] = s.name;
  return { list, byId };
}

async function getLeads() {
  return fetchAllPages(
    "/leads",
    "leads",
    `&filter[pipeline_id]=${PIPELINE_ID}&with=contacts`
  );
}

async function getEvents(fromTs, toTs) {
  return fetchAllPages(
    "/events",
    "events",
    `&filter[entity]=lead&filter[created_at][from]=${fromTs}&filter[created_at][to]=${toTs}&filter[type][]=lead_added&filter[type][]=lead_status_changed`
  );
}

async function getNotes(fromTs, toTs) {
  return fetchAllPages(
    "/leads/notes",
    "notes",
    `&filter[updated_at][from]=${fromTs}&filter[updated_at][to]=${toTs}`
  );
}

// Табличка по ньюбизам. Каждая метрика — число уникальных карточек, кроме «заметок».
// Блок «→ этап» — сколько карточек пришло на каждый этап воронки в периоде; этапы берутся
// из самой воронки, так что новые и переименованные этапы появляются без правки скрипта.
function buildSummary(result, ranges, withActivity) {
  const leadById = {};
  for (const l of result.leads) leadById[l.id] = l;
  // Закрытые с причиной «Подхватила команда» — контакт добывал не ньюбиз, в отчет не идут.
  const excluded = new Set(result.leads
    .filter((l) => l.status_id === STATUS_LOST && l.loss_reason_id === LOSS_REASON_TEAM_TOOK)
    .map((l) => l.id));
  const events = result.events.filter((e) => !excluded.has(e.lead_id));
  const allNotes = result.notes.filter((n) => !excluded.has(n.lead_id));
  const arrivals = stageArrivals(events);
  const stages = result.statuses.filter((s) => s.id !== STATUS_UNSORTED && s.id !== STATUS_NEW);
  const periods = result.period.previous ? ["current", "previous"] : ["current"];

  const owners = [...new Set([...NEWBIZ_TEAM, ...result.newbiz_owners])];
  const summary = {};
  for (const owner of owners) {
    summary[owner] = {};
    for (const period of periods) {
      const ev = events.filter((e) => e.newbiz === owner && e.period === period);
      const notes = allNotes.filter((n) => n.newbiz === owner && n.period === period);
      const added = new Set(ev.filter((e) => e.type === "lead_added").map((e) => e.lead_id));
      const touched = new Set([
        ...notes.map((n) => n.lead_id),
        ...ev.filter((e) => e.type === "lead_status_changed").map((e) => e.lead_id),
      ]);
      const continuing = [...touched].filter((id) => !added.has(id));
      const byRule = (rule) => [...new Set(notes.filter((n) => matchesRule(n.text, rule)).map((n) => n.lead_id))];
      const arrivedAt = (statusId) => new Set(arrivals
        .filter((a) => a.status_id === statusId && a.period === period && leadById[a.lead_id]?.newbiz === owner)
        .map((a) => a.lead_id));

      const row = {
        "Новые контакты": [...added],
        "Продолжающиеся контакты": continuing,
      };
      if (withActivity) {
        row["Заметки"] = notes.length;
        row["Встречи (по заметкам)"] = byRule(NOTE_RULES.meetings);
        row["Звонки (по заметкам)"] = byRule(NOTE_RULES.calls);
      }
      for (const s of stages) row[`→ ${s.name}`] = [...arrivedAt(s.id)];
      summary[owner][period] = row;
    }
  }
  return { summary, leadById, owners, excluded };
}

function printTable(result, ranges, withDetails, withActivity) {
  const { summary, leadById, owners, excluded } = buildSummary(result, ranges, withActivity);
  const hasPrev = Boolean(result.period.previous);
  const size = (v) => (Array.isArray(v) ? v.length : v);
  const cell = (o, m) => hasPrev
    ? `${size(summary[o].current[m])} (${size(summary[o].previous[m])})`
    : `${size(summary[o].current[m])}`;
  const metrics = Object.keys(summary[owners[0]].current);
  const header = ["Метрика", "Что значит", ...owners];
  const rows = metrics.map((m) => [m, rowNote(m), ...owners.map((o) => cell(o, m))]);
  const widths = header.map((_, i) => Math.max(...[header, ...rows].map((r) => r[i].length)));
  const line = (r) => "| " + r.map((c, i) => c.padEnd(widths[i])).join(" | ") + " |";
  const { current, previous } = result.period;
  console.log(`Период: ${current.from} — ${current.to}` + (hasPrev ? `, в скобках ${previous.from} — ${previous.to}` : "") + "\n");
  console.log(line(header));
  console.log("|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|");
  for (const r of rows) console.log(line(r));
  if (withActivity) console.log("\nСтроки «по заметкам» — оценка по тексту примечаний, сверять через --details.");
  console.log("\nСтроки «→ этап» — сколько карточек перешли на этап в периоде.");
  if (excluded.size) {
    console.log(`Не учтены (закрыты с причиной «Подхватила команда», контакт добывал не ньюбиз): ${excluded.size}`);
    if (withDetails) for (const id of excluded) console.log(`  ${id} ${leadById[id]?.name || ""}`);
  }
  if (!withDetails) return;
  for (const o of owners) {
    for (const m of metrics.filter((x) => x.includes("по заметкам") || x.startsWith("→"))) {
      const ids = summary[o].current[m];
      if (!ids.length) continue;
      console.log(`\n${o} — ${m}:`);
      for (const id of ids) console.log(`  ${id} ${leadById[id]?.name || ""}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const [curFromStr, curToStr, prevFromStr, prevToStr] = args.filter((a) => !a.startsWith("--"));
  const hasPrev = Boolean(prevFromStr && prevToStr);
  if (!curFromStr || !curToStr || (prevFromStr && !prevToStr)) {
    console.error(
      "Использование: node fetch_period_report_data.js <currentFrom> <currentTo> [<prevFrom> <prevTo>] (YYYY-MM-DD)"
    );
    process.exit(1);
  }
  if (!TOKEN || (!SUBDOMAIN && !API_BASE)) {
    throw new Error("Нужны AMOCRM_TOKEN и AMOCRM_SUBDOMAIN (или AMOCRM_API_BASE)");
  }

  const ranges = {
    current: { from: parseDayBoundary(curFromStr, false), to: parseDayBoundary(curToStr, true) },
    // Без прошлого периода — пустой диапазон, в него ничего не попадает.
    previous: hasPrev
      ? { from: parseDayBoundary(prevFromStr, false), to: parseDayBoundary(prevToStr, true) }
      : { from: Infinity, to: -Infinity },
  };
  const rangeFrom = Math.min(ranges.current.from, ranges.previous.from);

  console.error("Тяну стадии воронки Аутбаунд...");
  const statuses = await getStatuses();

  console.error("Тяну сделки воронки Аутбаунд (снэпшот на текущий момент)...");
  const rawLeads = await getLeads();
  const pipelineLeadIds = new Set(rawLeads.map((l) => l.id));
  const newbizByLeadId = {};
  for (const lead of rawLeads) newbizByLeadId[lead.id] = getNewbiz(lead.custom_fields_values);

  const leads = rawLeads.map((lead) => ({
    id: lead.id,
    name: lead.name,
    newbiz: newbizByLeadId[lead.id],
    price: lead.price,
    status_id: lead.status_id,
    status: statuses.byId[lead.status_id] || null,
    loss_reason_id: lead.loss_reason_id ?? null,
    created_at: lead.created_at ? new Date(lead.created_at * 1000).toISOString() : null,
    updated_at: lead.updated_at ? new Date(lead.updated_at * 1000).toISOString() : null,
    closed_at: lead.closed_at ? new Date(lead.closed_at * 1000).toISOString() : null,
    custom_fields: customFieldsToMap(lead.custom_fields_values),
  }));

  console.error("Тяну события (новые сделки + смены стадий) за объединенный период...");
  const rawEvents = await getEvents(rangeFrom, ranges.current.to);
  const events = rawEvents
    .filter((e) => pipelineLeadIds.has(e.entity_id))
    .map((e) => {
      const base = {
        type: e.type,
        lead_id: e.entity_id,
        newbiz: newbizByLeadId[e.entity_id],
        created_at: new Date(e.created_at * 1000).toISOString(),
        period: tagPeriod(e.created_at, ranges),
      };
      if (e.type === "lead_status_changed") {
        const before = e.value_before?.[0]?.lead_status;
        const after = e.value_after?.[0]?.lead_status;
        base.from_status_id = before?.id ?? null;
        base.from_status = statuses.byId[before?.id] || null;
        base.to_status_id = after?.id ?? null;
        base.to_status = statuses.byId[after?.id] || null;
      }
      return base;
    })
    .filter((e) => e.period);

  console.error("Тяну заметки (common) за объединенный период...");
  const rawNotes = await getNotes(rangeFrom, ranges.current.to);
  const notes = rawNotes
    .filter((n) => n.note_type === "common" && n.params?.text && pipelineLeadIds.has(n.entity_id))
    .map((n) => ({
      lead_id: n.entity_id,
      newbiz: newbizByLeadId[n.entity_id],
      text: n.params.text,
      created_at: new Date(n.created_at * 1000).toISOString(),
      period: tagPeriod(n.created_at, ranges),
    }))
    .filter((n) => n.period);

  const result = {
    period: {
      current: { from: curFromStr, to: curToStr },
      previous: hasPrev ? { from: prevFromStr, to: prevToStr } : null,
    },
    statuses: statuses.list,
    newbiz_owners: [...new Set(leads.map((l) => l.newbiz))].sort(),
    leads,
    events,
    notes,
  };

  if (flags.has("--table")) {
    printTable(result, ranges, flags.has("--details"), true);
    return;
  }

  console.log(JSON.stringify(result, null, 2));
  console.error(
    `Готово: ${leads.length} сделок, ${events.length} событий и ${notes.length} заметок в диапазоне периодов.`
  );
  for (const owner of result.newbiz_owners) {
    const count = (arr) => arr.filter((x) => x.newbiz === owner).length;
    console.error(
      `  Ньюбиз ${owner}: ${count(leads)} сделок, ${count(events)} событий, ${count(notes)} заметок`
    );
  }
}

main().catch((err) => {
  console.error("Ошибка:", err.message);
  process.exit(1);
});
