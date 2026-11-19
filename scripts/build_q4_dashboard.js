// Build the public dashboard from a private period export. Publish aggregates only.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'reports/q4-touches-dashboard');
const PEOPLE = ['Маша', 'Лиза', 'Саша'];
const FIELDS = ['new', 'continuing', 'wait_task', 'demo_kp', 'handed'];
const DAY = 86400000;
const date = (s) => Date.parse(s + 'T00:00:00+03:00');
const iso = (t) => new Date(t + 3 * 3600000).toISOString().slice(0, 10);
const fmt = (t) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Minsk' }).format(t);

function aggregate(raw) {
  const from = date(raw.period.current.from);
  const to = date(raw.period.current.to) + DAY - 1;
  const excluded = new Set(raw.leads.filter(l => l.status_id === 143 && l.loss_reason_id === 24880686).map(l => l.id));
  const leads = raw.leads.filter(l => !excluded.has(l.id));
  const byId = new Map(leads.map(l => [l.id, l]));
  const events = raw.events.filter(e => byId.has(e.lead_id));
  const notes = raw.notes.filter(n => byId.has(n.lead_id));
  const stage = (re) => {
    const matches = raw.statuses.filter(s => re.test(s.name));
    if (matches.length !== 1) throw new Error('Не найден однозначный этап: ' + re);
    return matches[0].id;
  };
  const stages = {wait_task: stage(/жд\S* задач/i), demo_kp: stage(/демо|кп/i), handed: stage(/передано/i)};
  const grouped = new Map();
  for (const e of events.filter(e => e.type === 'lead_status_changed')) {
    if (!grouped.has(e.lead_id)) grouped.set(e.lead_id, []);
    grouped.get(e.lead_id).push(e);
  }
  const arrivals = [];
  for (const list of grouped.values()) {
    list.sort((a,b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    list.forEach((e,i) => {
      const prev = list[i-1], next = list[i+1];
      const reverted = next && next.from_status_id === e.to_status_id && Date.parse(next.created_at) - Date.parse(e.created_at) <= 600000;
      const returned = prev && prev.from_status_id === e.to_status_id && Date.parse(e.created_at) - Date.parse(prev.created_at) <= 600000;
      if (!reverted && !returned) arrivals.push(e);
    });
  }
  function period(a,b) {
    const inside = x => Date.parse(x.created_at) >= a && Date.parse(x.created_at) <= b;
    return PEOPLE.map(newbiz => {
      const owned = leads.filter(l => l.newbiz === newbiz);
      const touched = new Set([...notes.filter(inside), ...events.filter(e => e.type === 'lead_status_changed' && inside(e))].map(x => x.lead_id));
      const row = {newbiz, new: owned.filter(inside).length, continuing: owned.filter(l => Date.parse(l.created_at) < a && touched.has(l.id)).length};
      for (const [key,id] of Object.entries(stages)) row[key] = new Set(arrivals.filter(e => inside(e) && e.to_status_id === id && byId.get(e.lead_id).newbiz === newbiz).map(e => e.lead_id)).size;
      return row;
    });
  }
  const months = [];
  for (let a = from; a <= to;) {
    const d = new Date(a + 3 * 3600000);
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth()+1, 1) - 3 * 3600000;
    const month = new Intl.DateTimeFormat('ru-RU', {month: 'long',timeZone: 'Europe/Minsk'}).format(a);
    months.push(...period(a, Math.min(to, next-1)).map(r => ({month: month[0].toUpperCase()+month.slice(1), ...r})));
    a = next;
  }
  const weeks = [];
  const weekday = (new Date(from + 3 * 3600000).getUTCDay()+6)%7;
  for (let mon = from - weekday*DAY; mon <= to; mon += 7*DAY) {
    const a = Math.max(from,mon), b = Math.min(to,mon+7*DAY-1);
    const month = new Intl.DateTimeFormat('ru-RU',{month:'long',timeZone:'Europe/Minsk'}).format(a);
    weeks.push(...period(a,b).map(r => ({week_start:iso(a), week: `${fmt(a)} — ${fmt(b)}`, month:month[0].toUpperCase()+month.slice(1),...r})));
  }
  return {quarter:period(from,to),months,weeks,meta:{from:raw.period.current.from,to:raw.period.current.to}};
}

function main() {
  const input = process.argv[2];
  let raw;
  if (input) raw = JSON.parse(fs.readFileSync(input,'utf8'));
  else {
    const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Minsk',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const to = today > '2026-12-31' ? '2026-12-31' : today;
    const fetch = spawnSync(process.execPath,[path.join(__dirname,'fetch_period_report_data.js'),'2026-10-01',to],{encoding:'utf8',maxBuffer:30*1024*1024});
    process.stderr.write(fetch.stderr || '');
    if(fetch.status !== 0) throw new Error('Не удалось получить выгрузку');
    raw = JSON.parse(fetch.stdout);
  }
  const data = aggregate(raw);
  let html = fs.readFileSync(path.join(DIR,'template.html'),'utf8');
  html = html.replace('1 октября — 19 ноября 2026.', `${fmt(date(data.meta.from))} — ${fmt(date(data.meta.to))} ${data.meta.to.slice(0,4)}.`)
    .replace('на 19 ноября 2026', `на ${fmt(date(data.meta.to))} ${data.meta.to.slice(0,4)}`)
    .replace('16–19 ноября', `${fmt(date(data.weeks.at(-1).week_start))} — ${fmt(date(data.meta.to))}`);
  fs.writeFileSync(path.join(DIR,'index.html'),html);
  fs.writeFileSync(path.join(DIR,'data.js'),'window.Q4_DATA = '+JSON.stringify(data)+';\n');
  const site = path.join(ROOT,'site');
  fs.mkdirSync(path.join(site,'vendor'),{recursive:true});
  for (const file of ['index.html','data.js','vendor/d3.min.js']) fs.copyFileSync(path.join(DIR,file),path.join(site,file));
  fs.writeFileSync(path.join(site,'.nojekyll'),'');
  fs.writeFileSync(path.join(site,'robots.txt'),'User-agent: *\nDisallow: /\n');
  console.log(JSON.stringify({totals:Object.fromEntries(FIELDS.map(k=>[k,data.quarter.reduce((a,r)=>a+r[k],0)])),weeks:data.weeks.length/3,months:data.months.length/3}));
}
if (require.main === module) main();
module.exports = {aggregate, main};
