# История миграций production — 14 октября 2026

Проверенный проект: `vzjlhiqvfgrrlfdgyebx` (`https://vzjlhiqvfgrrlfdgyebx.supabase.co`). Срез получен через подключённый Supabase: `list_migrations`, чтение `supabase_migrations.schema_migrations`, системных каталогов и advisors. История и application data при этой проверке не изменялись. SQL-проверка безопасности создала только временную таблицу результатов.

Репозиторий содержит два независимых набора: `migrations/` — legacy/manual SQL; `supabase/migrations/` — текущая папка CLI. Номер в имени (`020`, `031`) не является идентификатором применения. Supabase сопоставляет миграции по timestamp `version`. Одинаковое назначение с разными timestamp остаётся расхождением истории для CLI.

## Точное сопоставление записей production с файлами

Для 001–021, 027–028 ниже приведено сопоставление по имени и назначению; полное равенство текущего файла историческому SQL не заявляется. У части исторических записей менялись текст, комментарии, формат и последующие определения функций. Для 029–035 дополнительно проверено точное равенство MD5 сохранённого SQL и текущего локального файла. SQL 036–037 совпадает после нормализации завершающих переводов строк; connector сохранил дополнительный CRLF.

| Production `version` | Production `name` | Локальный файл |
|---|---|---|
| `20260413112900` | `001_create_users` | `migrations/001_create_users.sql` |
| `20260413112929` | `002_create_otp_codes` | `migrations/002_create_otp_codes.sql` |
| `20260413112942` | `003_create_sessions` | `migrations/003_create_sessions.sql` |
| `20260413112958` | `004_create_messages` | `migrations/004_create_messages.sql` |
| `20260413113014` | `005_create_rate_log` | `migrations/005_create_rate_log.sql` |
| `20260413113027` | `006_create_device_blocks` | `migrations/006_create_device_blocks.sql` |
| `20260413113048` | `007_rls_policies` | `migrations/007_rls_policies.sql` |
| `20260413113113` | `008_functions_triggers` | `migrations/008_functions_triggers.sql` |
| `20260414155453` | `009_pg_cron_cleanup` | `migrations/009_pg_cron_cleanup.sql` |
| `20260414155515` | `010_rate_limit_log` | `migrations/010_rate_limit_log.sql` |
| `20260414155528` | `011_users_missing_constraints` | `migrations/011_users_missing_constraints.sql` |
| `20260414155543` | `012_rate_log_db_constraints` | `migrations/012_rate_log_db_constraints.sql` |
| `20260414155602` | `013_approval_log` | `migrations/013_approval_log.sql` |
| `20260414155616` | `014_messages_read_status` | `migrations/014_messages_read_status.sql` |
| `20260415152325` | `017_rate_atomic_rpc` | `migrations/017_rate_atomic_rpc.sql` |
| `20260415153420` | `018_messages_unread_rpc` | `migrations/018_messages_unread_rpc.sql` |
| `20260415160251` | `019_security_hardening` | `migrations/019_security_hardening.sql` |
| `20260422181820` | `020_add_avatarurl_to_users` | `supabase/migrations/20260422000000_020_add_avatarurl_to_users.sql` |
| `20260422182248` | `021_avatars_storage_rls` | `supabase/migrations/20260422000001_021_avatars_storage_rls.sql` |
| `20260826120000` | `027_harden_group_table_access` | `supabase/migrations/20260826120000_027_harden_group_table_access.sql` |
| `20260827120000` | `028_user_safety_reports_blocks` | `supabase/migrations/20260827120000_028_user_safety_reports_blocks.sql` |
| `20261014181645` | `029_reports_abuse_hardening` | `supabase/migrations/20260828120000_029_reports_abuse_hardening.sql` |
| `20261014181650` | `030_report_target_message` | `supabase/migrations/20260829120000_030_report_target_message.sql` |
| `20261014181655` | `031_account_deletion_preserve_groups` | `supabase/migrations/20261014120000_031_account_deletion_preserve_groups.sql` |
| `20261014181701` | `032_service_only_application_access` | `supabase/migrations/20261014121000_032_service_only_application_access.sql` |
| `20261014181706` | `033_atomic_report_rate_limit` | `supabase/migrations/20261014123000_033_atomic_report_rate_limit.sql` |
| `20261014181711` | `034_image_caption_constraint` | `supabase/migrations/20261014124000_034_image_caption_constraint.sql` |
| `20261014182536` | `035_device_tokens` | `supabase/migrations/20261014181601_035_device_tokens.sql` |
| `20261014183511` | `036_variable_apns_token_length` | `supabase/migrations/20261014190000_036_variable_apns_token_length.sql` |
| `20261014191518` | `037_finalize_media_upload` | `supabase/migrations/20261014191050_037_finalize_media_upload.sql` |

Миграции 029–037 применены через Supabase connector 14 октября UTC (14–15 октября в локальном часовом поясе): он создал свои timestamp версии. Они уже выполнены на production, несмотря на другие локальные timestamp. Повторять SQL под локальным timestamp не требуется.

| Номер | MD5 сохранённого SQL = MD5 локального файла |
|---|---|
| 029 | `5f2e254dce9681392d3417981707b666` |
| 030 | `f385c99b150d118e27aabd512b689aa1` |
| 031 | `177c61f3cde0a4ab31438c9130b1d567` |
| 032 | `4d8bde3d2b9c666cd22938997b35a9c7` |
| 033 | `36b006f95185b9d8cd3537466b4b4350` |
| 034 | `8c6d6895d9de7db508089f14939f5b35` |
| 035 | `8aaf8e5894959b977cc1532904a291da` |

Для 036 исходный production MD5 — `a012bc6d5def955db98cddb468f47056`, локальный — `fe19e30db052cb260e6ef367a4d1e36f`; отличие только в дополнительном завершающем CRLF, SQL одинаков.
Для 037 production MD5 — `c5c4ca1cb86c31b7b881acee95641d21`, локальный — `24deee0c4846b59f7ed1e71797bcffbb`; завершающий CRLF нормализован в LF для Git, SQL одинаков.

MD5 здесь служит сравнением текстов, а не криптографической подписью релиза. Для 029–030 сравнение учитывает исходные окончания строк; переоформление LF/CRLF изменит хеш без изменения поведения SQL.

## Локальные изменения без отдельных записей истории

Отсутствие записи не означает, что соответствующего состояния нет в базе. Следующие эффекты проверены отдельно. Нельзя автоматически превращать эту проверку состояния в доказательство применения конкретного исторического файла.

| Локальный файл | Проверенное состояние production | Ограничение |
|---|---|---|
| `migrations/015_otp_attempts_counter.sql` | `otp_codes.attempts` существует | Записи `015_otp_attempts_counter` нет |
| `migrations/016_approve_reject_rpc.sql` | `approve_and_log(uuid,uuid)` и `reject_and_log(uuid,uuid,text)` существуют | Функции также переопределялись в 019; отдельной записи 016 нет |
| `supabase/migrations/20260517120000_022_admin_role.sql` | `users.role` и `users_role_check` существуют | Отдельной записи 022 нет; legacy `migrations/020_add_admin_role.sql` имеет это же назначение |
| `supabase/migrations/20260517120001_023_disable_auto_approve.sql` | `auto_approve_first()` только возвращает `NEW` | Отдельной записи 023 нет; legacy `migrations/021_disable_auto_approve.sql` также отключает auto-approval; 032 обновила `search_path` |
| `supabase/migrations/20260517153000_024_groups_and_media.sql` | `chat_groups`, `group_members`, `group_invites`, `messages.groupId` и private bucket `chat-media` существуют | Отдельной записи 024 нет; её текущую схему дополнительно изменяют 027–028, 031–032, 034 |
| `supabase/migrations/20260517170000_025_canonicalize_fiztekh_school.sql` | Алиасов `fiztex`/`phystech` в `users.school` и `chat_groups.school` нет; каноническое `Физтех` присутствует | Отдельной записи 025 нет. Это миграция данных: нельзя повторять ради исправления истории |

Production 020 и 021 относятся к **аватарам**. Legacy `migrations/020_add_admin_role.sql` и `migrations/021_disable_auto_approve.sql` относятся к **админской роли и auto-approval**. Их нельзя сопоставлять только по номеру.

Миграция `026_unify_all_users_into_fiztex` не входит в активную папку и не числится в этой истории. Она объединяла бы школы и изменяла пользователей; для текущего релиза её применять или восстанавливать не нужно.

## Безопасная работа CLI до согласования истории

Проверена версия CLI **2.120.0** и фактический `--help` соответствующих команд. Используйте установленный `supabase` в окружении с доступом к проекту; секреты передавайте через разрешённое окружение, без записи в Git и без вывода командной строки с паролем.

Для диагностики после корректной локальной привязки к этому проекту:

```bash
supabase migration list --linked
supabase db push --linked --dry-run --skip-vault
```

`--skip-vault` исключает обновление Vault из конфигурации: эта версия CLI предупреждает, что обычный `db push` может выполнять такие обновления до миграций. При расхождении истории остановиться и изучить список. На текущем срезе обычный push не является готовым рабочим процессом: у production есть remote-only исторические версии, у локальной папки — local-only файлы уже выполненных изменений.

Не использовать `--include-all`, `--include-seed`, reset удалённой базы или автоматический `migration repair` для обхода ошибки. `--include-all` означал бы повторное применение отсутствующих локальных timestamp, в том числе уже выполненных файлов и миграции данных 025. Скрипт `supabase/seed.sql` не предназначен для production.

До отдельного согласования истории новые изменения можно применять по одному проверенному SQL-файлу через уже подключённый Supabase connector, фиксируя возвращённую remote version. Файл новой миграции создавать командой `supabase migration new <descriptive_name>`. Перед применением проверить зависимости, результат локальных/staging тестов и совместимость API; после — schema/advisors и API smoke. Не применять весь старый набор ради появления новых записей истории.

После согласования истории CLI допускается в таком порядке:

1. Создать новую миграцию через `supabase migration new`.
2. Проверить `supabase migration list --linked`.
3. Проверить `supabase db push --linked --dry-run --skip-vault`: список должен содержать только ожидаемые новые миграции.
4. Применить `supabase db push --linked --skip-vault` после проверки этого конкретного списка.
5. Повторить SQL security checks, advisors и Postman/API smoke.

## Отдельный план согласования истории и baseline

Согласование истории — отдельная задача, не выполненная этим документом. Рекомендуем сначала сохранить production schema dump и экспорт строк `schema_migrations`, затем восстановить архив исторического SQL по реальным remote version. Для уже выполненных 029–035 равенство текста проверено, поэтому согласование timestamp можно обосновать без повторного исполнения SQL. Для старых файлов сначала нужен анализ различий и текущих зависимостей.

Для новой чистой базы подготовить отдельную проверенную baseline из текущей схемы: таблицы, FK, ограничения, индексы, RLS, ACL, RPC, triggers, default privileges, а также явно необходимые Storage buckets/policies и Cron configuration. Нельзя включать пользовательские данные, production секреты или предполагать, что CLI-папка, начинающаяся с 020, сама создаст базовую схему 001–019.

Baseline нужно полностью проверить на disposable Supabase/local проекте и сравнить его схему и права с production. Затем отдельно согласовать переход активного migration stream: какие старые файлы архивируются, какие timestamp сохраняются и какие только метаданные истории потребуется изменить. Сохранить прежние записи в архиве и подготовить проверяемый план восстановления. Если потребуется пометить подтверждённую baseline как уже применённую на существующем проекте, это должно быть отдельным осознанным изменением истории; не запускать её SQL на существующих таблицах.

Для 025 и любых других миграций данных базой решения служат сохранённая история и проверенные инварианты, а не повторное исполнение. Предпочтителен воспроизводимый schema baseline плюс отдельные будущие миграции данных с явно описанными условиями и последствиями.

## Результат проверки production

- Все **15** application tables в `public` имеют RLS.
- `tests/sql/group_table_security_checks.sql`: **244 проверки**, **0 ошибок**; динамический обход включает **7 проверок** `device_tokens`, хотя обязательный список исторического теста заканчивается на `chat_media_cleanup_queue`.
- Supabase security advisors: **0 замечаний**.
- Performance advisors: четыре INFO о FK без покрывающего индекса — `chat_groups.createdBy`, `group_invites.invitedBy`, `group_members.addedBy`, `user_reports.reviewedBy`. См. [объяснение и рекомендации Supabase](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys).
- Также десять INFO об индексах, которые пока не использовались. Среди них индексы только что добавленных таблиц/полей; по этому срезу удалять их нельзя. См. [Unused Index advisor](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index).

Эта проверка подтверждает историю, текущую схему и права. Проверка конкретных развёрнутых Edge Functions, App Review login и Postman выполняется отдельно в рамках релиза; её результаты записываются в `docs/backend-release-2026-10-14.md`.
