# Подготовка API к iOS — 14–15 октября 2026

Проверенный и обновлённый production: `vzjlhiqvfgrrlfdgyebx`.
Сроки 2 и 4 октября в исходном задании уже прошли; ниже фактические результаты
работы 14–15 октября. Credentials App Review передаются отдельным локальным
файлом и не входят в Git.

| Пункт | Результат |
|---|---|
| 1. Деплой | Наличие 028 подтверждено. Применены 029–037, включая исправления удаления, доступа, квоты, изображений без подписи и гонки загрузки с удалением аккаунта. Все 21 Edge Functions развёрнуты и ACTIVE; `verify_jwt=false`, проверка собственного JWT выполняется внутри функций. |
| 2. RLS и права | На production прошли 249 проверок всех 15 public application tables, столбцов, views, sequences, RPC и default ACL. У anon/authenticated/PUBLIC нет доступа к данным приложения; security advisor без замечаний. Пункт handoff отмечен выполненным. |
| 3. Контракт Swift | `docs/api-contract.md`: все 20 исходных функций, методы, auth, тела, модели, примеры ответов и коды ошибок; `register-push` описан отдельно как 21-я функция. Старый export ссылается на контракт. |
| 4. App Review | Создан одобренный member в школе Fcom App Review с паролем, тремя одобренными собеседниками и шестью сообщениями. Проверены login, me, users, три переписки, groups, blocks, register/unregister push и logout. |
| 5. Лимит жалоб | После JWT и проверки approved квота считается по `payload.sub`: 5 запросов за скользящий час через атомарный RPC. На production шестой запрос дал 429, другой пользователь с того же IP сохранил свою квоту. Сбой лимитера даёт 503; targetMessageId сохраняется. |
| 6. Удаление | Атомарный RPC передаёт группу старейшему оставшемуся участнику и назначает его admin; пустую группу удаляет. На production после удаления выделенного тестового создателя сохранились группа, оба сообщения и доступное изображение; JWT удалённого пользователя отозван. |
| 7. Блокировки | В веб-настройках восстановлены список и кнопка «Разблокировать», включая устаревшие цели; есть синхронизация блокировок. Backend и веб опубликованы. PR #1 слит в main, Vercel production READY; пять основных файлов на fcom-app.vercel.app совпали с коммитом. |
| 8. Кредо | Сервер возвращает `credLevel`, `credProgress`, `canRate`, `usersToRate`; веб использует ответы сервера. Проверены дробные пороги, eligibility, повторное голосование и блокировки. |
| 9. Push | Развёрнуты device_tokens, register-push и APNs hooks для сообщений, заявок и одобрения. Отправка отключена до выдачи .p8 и параметров Apple. Доставку на устройстве ещё предстоит проверить; долговременной очереди повторов нет. |
| 10. Xcode/SwiftUI | Созданы Xcode project, shared scheme, SwiftUI login/profile, APIClient с bearer-токеном, Keychain и разбором ok/error. Структура проекта проверена; сборка и запуск требуют macOS/Xcode и здесь не выполнялись. |

## Выполненные проверки

- Deno: typecheck 21 функции; 26 тестов доменной логики, Edge Functions и push,
  включая шесть сценариев HTTP handler финализации загрузки/очистки.
- Node: 19 тестов веба и защит Postman-коллекций.
- PostgreSQL/PGlite: 6 SQL-наборов (удаление/откат, grants/RLS,
  изображения без подписи, квота, device_tokens, завершение upload). Платформенные auth,
  Storage metadata и cron заменены локальными заглушками.
- Production: `tests/sql/group_table_security_checks.sql`, 249 утверждений.
- Основная Postman-коллекция: проверены все 104 уникальных сценария в
  поэтапных прогонах. Исправлен неправильно собранный URL M02; C00 один раз
  вернул 500 `fetch_failed`, причина не установлена. Оба сценария повторены
  успешно. Это поэтапный прогон с исправлением и повтором, а не один
  непрерывный запуск без сбоев.
- Дополнительная contract smoke collection: чистый итоговый прогон,
  15 запросов, 33 утверждения, 0 ошибок. Исправлена область видимости
  pre-request guards; добавлен тест совместного исполнения global/item scripts.
- Дополнительные live-сценарии подтвердили отдельные квоты пользователей
  одного IP и сохранение группы/медиа при удалении её создателя.
- После 037 повторно проверены live upload → delete-account → session revocation
  и отсутствие файла/очереди после удаления временного аккаунта. SQL fixtures
  проверяют оба порядка upload/deletion; полноценный multi-connection lock stress
  не выполнялся.
- Все временные QA-пользователи и их данные удалены. Сохранены 18 исходных
  пользователей и 4 App Review; у App Review 6 сообщений. На завершение
  проверок очередь удаления медиа и device_tokens пусты.

## Следующие внешние шаги

1. Получить `APNS_PRIVATE_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`,
   `APNS_BUNDLE_ID`, настроить environment и проверить реальное устройство.
   Порядок и ограничения описаны в `docs/push-server.md`.
2. Открыть `ios/Fcom.xcodeproj` на Mac, выбрать signing team и Bundle ID,
   собрать и проверить приложение. Scaffold пока не является готовым
   App Store binary.
3. Перед следующим CLI `db push` согласовать timestamps истории с
   `docs/migration-history-2026-10-14.md`. Не повторять применённые
   миграции и не запускать production seed для исправления истории.
4. Настроить периодический защищённый вызов `/cleanup` для повторов
   удаления orphaned Storage objects. Текущие pg_cron jobs очищают DB
   sessions/OTP/rate logs; они не вызывают этот Edge endpoint.
   При удалении аккаунта очередь уже обрабатывается best effort.

Новые поля API обратно совместимы. `message.fromId` и `group.createdBy`
остаются строковыми UUID; internal `deletedFromId` не выходит в ответ.
Удалённый автор обозначен `senderDeleted`. Необработанные ошибки всех
функций возвращают JSON `{ok:false,error:"internal_error"}`.

## Публикация

[PR #1](https://github.com/Enkrous/Fcom-app/pull/1) слит в main 15 октября
2026 по Asia/Qyzylorda, merge commit `4231eafa249b0471f95fd2a4d201f5df4487844b`.
Оба Vercel preview checks успешны. Production deployment
`dpl_6wNT5ZCPGTRD88GdZ8Tzck9akHi4` READY и назначен
[fcom-app.vercel.app](https://fcom-app.vercel.app).
`index.html`, `app.js`, `api.js`, `credo.js`, `style.css` дали HTTP 200 и
точно совпали с исходниками после нормализации переводов строк.
