# Отчёт по аутбаунду для Ильи и Макса

Сайт показывает агрегированную активность Маши, Лизы и Саши в воронке amoCRM «Аутбаунд»: новые и продолжающиеся контакты, заметки, встречи, звонки и переходы по этапам, включая «Нереализовано».

Сайт: https://maria-creates.github.io/for_ilya_and_max/

## Как обновляется

- автоматически по будням в 09:00 по Минску;
- при каждом push в `main`;
- вручную: **Actions → Обновить отчёт и сайт → Run workflow**.

Отчёт строится с первого числа текущего месяца по текущую дату. На сайт попадают только агрегированные цифры — имена контактов и тексты заметок не публикуются.

## Что один раз настроить в GitHub

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Settings → Secrets and variables → Actions → New repository secret**:
   - `AMOCRM_SUBDOMAIN` — поддомен amoCRM без `.amocrm.ru`;
   - `AMOCRM_TOKEN` — долгосрочный токен amoCRM;
   - `AMOCRM_API_BASE` — необязательно, только если используется API-шлюз.

Не добавляйте токен или `.env` в репозиторий.

## Локальная сборка

```bash
node scripts/build_report_site.js
```

Можно явно указать период:

```bash
node scripts/build_report_site.js 2026-11-01 2026-11-16
```
