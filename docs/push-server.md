# APNs, серверная часть

Миграции 035–036 и `/register-push` сохраняют iOS-токены по пользователю и
окружению `sandbox`/`production`. Токен — hex-представление байтов APNs,
чётное число символов от 2 до 1024; фиксированной длины 32 байта нет.
Состояния `pending` и `approved` могут зарегистрировать устройство: токен
нужен до одобрения, чтобы отправить уведомление об одобрении.

После успешной записи сообщения сервер уведомляет получателя или участников
группы. Регистрация уведомляет одобренных администраторов о новой заявке;
одобрение уведомляет самого пользователя. Текст переписки, имя и телефон
не помещаются в lock-screen alert. Поля маршрутизации перечислены в API-контракте.

Для включения нужны секреты Supabase Edge Functions:

| Секрет | Значение |
|---|---|
| `APNS_PRIVATE_KEY` | Полное содержимое `.p8` в формате PKCS#8 PEM |
| `APNS_KEY_ID` | Apple Key ID |
| `APNS_TEAM_ID` | Apple Developer Team ID |
| `APNS_BUNDLE_ID` | Bundle ID приложения с Push Notifications capability |
| `APNS_ENVIRONMENT` | `sandbox` для development или `production` для App Store/TestFlight |

Без любого из четырёх обязательных секретов отправка отключена. Успешные
сообщения и регистрации продолжают работать. Ключи не должны попадать в
Git или JSON ответа. После настройки необходимо проверить доставку на
настоящем устройстве; это пока не выполнено, поскольку `.p8` не выдан.

Отправка использует HTTP/2, ES256 provider JWT с кешем 40 минут, таймаут
каждого запроса 5 секунд и максимум 20 секунд на фоновую задачу.
`EdgeRuntime.waitUntil` удерживает задачу после JSON-ответа. Ошибка APNs не
откатывает сообщение. Недействительный токен удаляется только при совпадении
владельца, окружения и версии регистрации; ответ 410 учитывает timestamp APNs.

Доставка сейчас best effort. Долговременная очередь и повтор после 15 минут
для APNs 5xx не реализованы; если требуется гарантированная повторная попытка,
это следующий отдельный шаг. Устройство повторно регистрирует свежий APNs
токен при запуске/входе и снимает регистрацию перед выходом.

Источники:

- [Регистрация приложения и device token](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns)
- [Переменная длина токена](https://developer.apple.com/documentation/uikit/uiapplicationdelegate/application(_:didRegisterForRemoteNotificationsWithDeviceToken:))
- [Token-based connection и ES256](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)
- [HTTP/2 запросы APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)
- [Ошибки и повторные попытки APNs](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns)
- [Фоновые задачи Supabase](https://supabase.com/docs/guides/functions/background-tasks)
