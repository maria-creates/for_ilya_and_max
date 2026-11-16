const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TEMPLATE = path.join(__dirname, "report-template.html");
const OUTPUT = path.join(ROOT, "site", "index.html");
const TIME_ZONE = "Europe/Minsk";

function todayInMinsk() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function parseRow(line) {
  return line.split("|").slice(1, -1).map((cell) => cell.trim());
}

function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function displayMetric(metric) {
  const name = metric.replace(/^→\s*/, "");
  if (/^Закрыто и не реализовано$/i.test(name)) return "Нереализовано";
  if (/^Успешно реализовано/i.test(name)) return "Успешно реализовано";
  if (/^вернуться позже$/i.test(name)) return "Вернуться позже";
  if (/^демо \/ КП \/ Первичная квалификация$/i.test(name)) return "Демо / КП / первичная квалификация";
  return name;
}

function numberFromCell(cell) {
  const match = cell.match(/^\d+/);
  if (!match) throw new Error(`Не удалось прочитать число из «${cell}»`);
  return Number(match[0]);
}

function dateObject(iso) {
  return new Date(`${iso}T12:00:00Z`);
}

function periodLabel(from, to) {
  const a = dateObject(from);
  const b = dateObject(to);
  const monthsGenitive = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
  ];
  const day = (date) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", timeZone: "UTC" }).format(date);
  const month = (date) => monthsGenitive[date.getUTCMonth()];
  if (from.slice(0, 7) === to.slice(0, 7)) return `${day(a)}–${day(b)} ${month(b)}`;
  return `${day(a)} ${month(a)} – ${day(b)} ${month(b)}`;
}

const to = process.argv[3] || todayInMinsk();
const from = process.argv[2] || `${to.slice(0, 8)}01`;
let tableOutput;
if (process.env.REPORT_TABLE_FILE) {
  tableOutput = fs.readFileSync(process.env.REPORT_TABLE_FILE, "utf8");
} else {
  const report = spawnSync(process.execPath, [
    path.join(__dirname, "fetch_period_report_data.js"),
    from,
    to,
    "--table",
  ], {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (report.status !== 0) {
    process.stderr.write(report.stderr || report.stdout);
    process.exit(report.status || 1);
  }
  tableOutput = report.stdout;
}

const tableLines = tableOutput.split("\n").filter((line) => line.startsWith("|"));
if (tableLines.length < 3) throw new Error("В выгрузке не найдена таблица отчёта");

const header = parseRow(tableLines[0]);
const people = header.slice(2);
const rows = tableLines.slice(2).map(parseRow).map((cells) => {
  const metric = cells[0];
  const group = metric.startsWith("→") ? "stage" : "activity";
  return [group, displayMetric(metric), capitalize(cells[1]), ...cells.slice(2).map(numberFromCell)];
});

const period = periodLabel(from, to);
const title = `Аутбаунд: ${period}`;
const snapshot = new Intl.DateTimeFormat("ru-RU", {
  timeZone: TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
}).format(new Date());
const ownerHeaders = people.map((person) => `<th class="num">${person}</th>`).join("");
const peopleText = people.length > 1
  ? `${people.slice(0, -1).join(", ")} и ${people.at(-1)}`
  : people[0];
const dataNote = `Данные выгружены из amoCRM ${snapshot}, период ${period} включительно.`;

let html = fs.readFileSync(TEMPLATE, "utf8");
const replacements = {
  "{{TITLE}}": title,
  "{{OWNER_HEADERS}}": ownerHeaders,
  "{{DATA_NOTE}}": dataNote,
  "{{SNAPSHOT_DATE}}": snapshot,
  "{{ROWS_JSON}}": JSON.stringify(rows),
  "{{PEOPLE_JSON}}": JSON.stringify(people),
  "{{PEOPLE_TEXT}}": peopleText,
};
for (const [token, value] of Object.entries(replacements)) html = html.replaceAll(token, value);
if (/\{\{[A-Z_]+\}\}/.test(html)) throw new Error("В шаблоне остались незаполненные поля");

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, html);
console.log(`Собран ${OUTPUT}: ${title}`);
