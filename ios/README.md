# Fcom iOS scaffold

Минимальный SwiftUI-проект для iOS 17+: вход, восстановление сессии, профиль и выход. Полного messenger UI, onboarding и регистрации в интерфейсе пока нет. DTO и APIClient — стартовая основа по `docs/api-contract.md`.

## Открыть и настроить

1. На Mac с Xcode 15 или новее открыть `ios/Fcom.xcodeproj`, выбрать scheme **Fcom** и iPhone Simulator.
2. Адрес функций хранится в `Fcom/Info.plist`, ключ **SupabaseFunctionsBASEURL**. Он уже указывает на публичный production URL; для разработки замените на HTTPS URL своего staging `/functions/v1`. Ключи `service_role`, `JWT_SECRET`, APNs `.p8` и пароли сюда не добавляются.
3. В `Config/App.xcconfig` заменить placeholder **com.example.Fcom** на свой зарегистрированный bundle ID и заполнить **DEVELOPMENT_TEAM**. Для simulator сборки без подписи команда ниже это не требует. Для устройства/App Store нужны Apple Developer team, signing и выбранные capabilities.
4. Ввести одобренный тестовый аккаунт. Учётные данные App Review выдаются отдельно и не включены в исходники.

Из корня репозитория на macOS:

```bash
xcodebuild -project ios/Fcom.xcodeproj -scheme Fcom -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

## API и сессия

`APIClient` — actor; generic `send` декодирует типизированный ответ после проверки HTTP и `{ok,error}`. Методы с JSON body принимают `Encodable & Sendable`. Protected запросы добавляют `Authorization: Bearer`; Supabase Auth SDK здесь не используется. HTTP ошибки, server machine codes, не-JSON ответы, decoding и network failures разделены. Автоматического POST retry нет, поскольку сервер не поддерживает idempotency keys.

JWT сохраняется только в Keychain с [AfterFirstUnlockThisDeviceOnly](https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly), без синхронизации iCloud. При authenticated 401 очищается только токен той сессии, которой был отправлен запрос. Выход сначала пытается отозвать серверную сессию и всегда удаляет локальный токен; если сеть недоступна, серверная сессия может существовать до expiry. Пароль не сохраняется и не логируется.

`SessionStore` и SwiftUI views работают на `@MainActor`. Сеть использует [URLSession async data(for:)](https://developer.apple.com/documentation/foundation/urlsession/data(for:)). UI не получает bearer token. `UserDTO` поддерживает отсутствие credo metadata в login/register и в старых deployment; UI отображает server `credLevel`/`credProgress` без повторения алгоритма. Статусы, роли и error codes сохраняются строками для совместимого расширения API.

Dates декодируются как ISO 8601 с дробными секундами или без них, с `Z` либо offset. `MessageDTO` сохраняет string `fromId`; optional `senderDeleted` трактуется как false, если поле отсутствует. Это учитывает сохранённую историю удалённого автора в группах.

## Проверка этого scaffold

Создано на Windows: доступных Xcode, iOS SDK и Swift compiler здесь нет. Полноценная сборка, simulator login, runtime Keychain и UI проверка **не выполнены**. Структура `project.pbxproj` проверена OpenStep PBX parser, ссылки на файлы/build phases/scheme сверены, XML plist и scheme разобраны. Это проверка структуры, а не утверждение об успешной сборке.

На Mac сначала выполните указанную simulator сборку, затем проверьте login, `/me`, перезапуск приложения с восстановлением токена, logout и ответ expired/revoked session. Для App Store ещё нужны полноценный UI, app icon и release assets, legal screens и device QA. Push entitlement и APNs registration будут добавлены вместе с зарегистрированным App ID; в scaffold приватных ключей нет.
