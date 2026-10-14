# Fcom API — контракт для веба и Swift

Версия: **2026-10-15**. Источник: исполняемый код `supabase/functions/*/index.ts`, общие helpers и миграции этого репозитория. Документ описывает код в репозитории; наличие этой версии на production подтверждается отдельно результатом deploy и smoke tests. Исторический `export-web-api-supabase.txt` содержит снимок клиентского JavaScript, а не сетевой контракт.

Основные 20 функций описаны ниже; дополнительная функция `register-push` — в приложении. Дополнительные возможности следует добавлять совместимо: сохранять имена, типы и смысл существующих полей и кодов ошибок; новые поля клиент должен игнорировать, если он их не знает.

## 1. Транспорт, авторизация и общие правила

Базовый URL, используемый вебом: `https://vzjlhiqvfgrrlfdgyebx.supabase.co/functions/v1`. Для staging/local URL задаётся конфигурацией клиента. Все пути ниже относительны к нему, например `GET /me`.

- JSON-запросы: `Content-Type: application/json`, `Accept: application/json`. Тело — JSON-объект; строки передавать строками, числа числами. GET не имеет тела. `upload-media` использует `multipart/form-data` с автоматически созданной boundary.
- Это custom HS256 JWT, **не Supabase Auth**. В конфигурации Edge Functions `verify_jwt = false`; проверку выполняет сама функция. `apikey` для вызова функции не требуется. Ключ `service_role`, `JWT_SECRET` и `CLEANUP_SECRET` клиенту не передаются.
- Защищённые вызовы: `Authorization: Bearer <token>`; префикс `Bearer ` чувствителен к регистру. Идентификатор действующего пользователя всегда берётся из JWT `sub`.
- **Auth R**: JWT проверяется, `jti` должен оставаться в `sessions`, пользователь должен существовать. Актуальные `status`, `school`, `role` читаются из базы, а не только из claims. Используется всеми защищёнными функциями, кроме `logout` и `cleanup`.
- **Auth J** (`logout`): подпись и срок JWT, без проверки существования сессии/пользователя. **Auth C** (`cleanup`): `Bearer <CLEANUP_SECRET>`, только серверный scheduler.
- `register` выдаёт registration token на 1 час. Он подходит для `/me`, `/set-password`, `/delete-account`, пока живёт сессия, даже при `pending`. `login` выдаёт session token на 7 дней только одобренному пользователю с подтверждённым телефоном, если телефон указан. Refresh endpoint отсутствует; после истечения срока нужен login. JWT `iat`/`exp` — Unix seconds, `sub` — UUID пользователя, `jti` — UUID сессии.
- Успех функции: HTTP **200**, `{"ok":true,...}`. Ошибка: `{"ok":false,"error":"machine_code"}` с указанным HTTP status. Для `verify-phone/invalid_code` дополнительно `attemptsLeft:Int`. Не выводить `error` пользователю без локализованного текста.
- Все 20 функций принимают `OPTIONS` без авторизации и отвечают **204**, без JSON. Методы кроме документированных: **405** `method_not_allowed`; `messages`/`groups` выполняют auth до проверки неподдерживаемого метода.
- Обработанное неожиданное исключение: **500** `internal_error`. На уровне Supabase gateway/network возможен ответ без `{ok,error}`; клиент отдельно обрабатывает HTTP, не-JSON, timeout и отсутствие сети. Код `network_error` в `api.js` — клиентский, сервер его не возвращает.
- Неизвестные входные поля обычно игнорируются. Невалидный тип поля/JSON `null` не является допустимым запросом: часть функций вернёт `internal_error`, а не `invalid_json`. `invalid_json` означает ошибку разбора JSON, а не универсальную проверку схемы.
- Нет idempotency key и универсального `Retry-After`. После timeout у POST сначала синхронизировать состояние: сервер мог уже выполнить операцию. После logout/deletion удалять локальные токены и кэш.
- Лимиты — rolling windows по серверному времени. `report-user` использует атомарную DB квоту и закрывает запрос при её недоступности. Остальные перечисленные IP-лимиты исторически допускают запрос при DB ошибке и не сериализуют count/insert; это номинальные ограничения, а не строгая гарантия при конкурентных запросах.
- Доступ к таблицам через PostgREST для `anon`/`authenticated` не входит в API. Получать данные через функции.

### Индекс 20 функций

| Function/path | Метод | Auth | Дополнительный доступ |
|---|---|---|---|
| `/register` | POST | public | — |
| `/login` | POST | public | Успешный login только approved |
| `/set-password` | POST | R | — |
| `/verify-phone` | POST | public | — |
| `/resend-otp` | POST | public | — |
| `/logout` | POST | J | — |
| `/me` | GET | R | — |
| `/users` | GET | R | approved |
| `/approve` | POST | R | approved admin |
| `/reject` | POST | R | approved admin |
| `/rate` | POST | R | approved + same school + direct chat + cooldown |
| `/messages` | GET, POST | R | approved + direct/group доступ |
| `/upload-media` | POST | R | approved |
| `/groups` | GET, POST | R | approved |
| `/block-user` | GET, POST | R | approved |
| `/report-user` | POST | R | approved |
| `/reports-admin` | GET, POST | R | approved admin |
| `/delete-account` | POST | R | — |
| `/admin-stats` | GET | R | approved admin |
| `/cleanup` | POST | C | Server scheduler |

### Общие ошибки (добавляются к таблице каждого endpoint)

**E0 — все функции**:

| HTTP | `error` | Условие |
|---|---|---|
| 405 | `method_not_allowed` | Неподдерживаемый метод |
| 500 | `internal_error` | Неожиданное исключение, в том числе сбой общего DB/helper кода |

**ER — все endpoints с Auth R**, в дополнение к E0:

| HTTP | `error` | Условие |
|---|---|---|
| 500 | `server_misconfigured` | Отсутствует `JWT_SECRET` |
| 401 | `missing_token` | Нет корректного префикса Bearer/токена |
| 401 | `invalid_token` | Формат из трёх частей или подпись невалидны |
| 401 | `token_expired` | Истёк `exp` |
| 401 | `session_revoked` | Сессия `jti` не найдена; DB lookup error тоже может попасть в этот путь |
| 401 | `user_not_found` | Пользователь JWT не найден во время auth |
| 401 | `unauthorized` | Fallback при auth exception без сообщения |
| 401 | `<message>` | Историческое поведение: низкоуровневая ошибка base64/JSON/crypto внутри JWT возвращает своё сообщение. Строка не является закрытым enum |

**EJ — Auth J**: E0 + `server_misconfigured` (500), `missing_token`, `invalid_token`, `token_expired`, `unauthorized` и произвольное auth `<message>` (все 401). У EJ нет `session_revoked` или auth `user_not_found`.

Одинаковый `error` иногда имеет разные HTTP status: auth `user_not_found` — 401, lookup после auth — 404. Обрабатывать пару `(HTTP status, error)`. `error` и значения расширяемых enum лучше хранить строкой либо предусмотреть `unknown(String)` в Swift.

### Общие типы и nullability

Нотация: `T?` — JSON `null`; **optional** — ключ может отсутствовать. `UUID` — JSON string, `DateTime` — ISO 8601/RFC 3339 string с timezone. Время базы обычно имеет `+00:00`, время Deno — `Z`; дробные секунды могут отсутствовать или иметь разную точность. Для Swift использовать decoder, принимающий оба вида. ID хранить непрозрачной строкой/UUID, а не числом. `cred`, веса и изменения — JSON numbers, в Swift `Double`, `score` и счётчики — `Int`.

**UserCore** (register/login):

| Поле | JSON/Swift тип | Значение |
|---|---|---|
| `id` | UUID/String | Пользователь |
| `fullName`, `school`, `grade`, `nickname` | String | `grade` — класс, например `10А`, не Int |
| `phone` | String? | Нет телефона → null; формат хранится как введённая строка после trim |
| `phoneVerified` | Bool | Подтверждение телефона |
| `role` | String | `member` / `admin` |
| `status` | String | `pending` / `approved` / `rejected` |
| `cred` | Double | Текущий уровень доверия, неотрицательное число |
| `createdAt` | DateTime/String | Время создания |

`register`/`login` **не возвращают** `avatarUrl`, `credLevel`, `credProgress`, `canRate`; не делайте их обязательными в общей модели.

**PublicUser**: UserCore **без `phone`**, плюс `avatarUrl:String?`. Используется в `block-user` и вложенных профилях `reports-admin`; в этих двух функциях нет обязательных полей credo/eligibility.

**MeUser**: UserCore + `avatarUrl:String?`, `credLevel:CredLevel`, `credProgress:Double`.

**DirectoryUser**: PublicUser + `credLevel`, `credProgress`; для approved записей `/users` также `canRate:CanRate`; у `pending` ключ `canRate` отсутствует.

**CredLevel**: `{name:String,min:Double,max:Double?,css:String}`. Уровень определяется сервером, включая дробный `cred`:

| `cred` | `name` | `min` | `max` | `css` |
|---|---|---|---|---|
| `< 5` | `Новичок` | 0 | 4 | `novice` |
| `>= 5, < 15` | `Знакомый` | 5 | 14 | `known` |
| `>= 15, < 30` | `Доверенный` | 15 | 29 | `trusted` |
| `>= 30` | `Свой` | 30 | null | `own` |

`max` — историческая метка диапазона целых очков; например `4.5` всё ещё `Новичок`. `credProgress` — доля 0...1: при `cred < 30` это `max(0, cred)/40`, при `cred >= 30` это 1. Масштаб сохраняет веб-поведение, включая скачок на 30. Swift отображает эти поля, не пересчитывая их.

**CanRate**: `{ok:true}` либо `{ok:false,reason:"no_chat"|"24h_limit"}`. Снимок eligibility на момент GET, окончательная проверка всегда в `/rate`.

**Message**:

| Поле | Тип | Значение |
|---|---|---|
| `id` | UUID | Сообщение |
| `fromId` | UUID | Автор; у сохранённого сообщения удалённого автора остаётся исходный UUID |
| `toId` | UUID? | Для direct обязателен, для group null |
| `groupId` | UUID? | Для group обязателен, для direct null |
| `type` | String | `text` / `image` |
| `text` | String | Обрезается trim; у image может быть пустой |
| `time` | DateTime | Время вставки в БД |
| `readAt` | DateTime? | Первое прочтение direct; null пока не прочитано, у group обычно null |
| `attachmentPath`, `attachmentMime` | String? | Storage path / MIME |
| `attachmentBytes`, `attachmentWidth`, `attachmentHeight` | Int? | Размер и размеры изображения |
| `attachmentUrl` | String?, optional | Signed URL на 1 час; может отсутствовать при отсутствии вложений или сбое подписи |
| `senderDeleted` | Bool | true у сохранённого group message удалённого автора, false у остальных; при поддержке прежнего deployment декодировать optional, отсутствие трактовать как false |

`deletedFromId` — внутреннее DB поле и в API не передаётся. Не считать наличие `fromId` гарантией, что профиль автора существует.

**GroupBase**: `{id:UUID,name:String,school:String,type:"private"|"school_public",createdBy:UUID,avatarUrl:String?,createdAt:DateTime}`.

**GroupMember**: `{id:UUID,nickname:String,fullName:String,school:String,status:String,avatarUrl:String?,role:"admin"|"member",joinedAt:DateTime}`. `role` здесь роль **в группе**, не глобальная роль пользователя. При редкой гонке удаления профиля сервер может вернуть только `role`/`joinedAt`; в Swift остальные профильные поля можно сделать optional.

**Group**: GroupBase + `members:[GroupMember]`, `memberCount:Int`, `myRole:"admin"|"member"|"observer"|null`, `canManage:Bool`. Global admin может быть observer; право управления зависит от роли в группе.

**GroupInvite**: `{id:UUID,createdAt:DateTime,group:{id,name,school,type}?,invitedBy:{id,nickname,fullName}?}`. В этом GET-представлении нет `status`/`groupId`/`invitedUserId`; все записи — pending для текущего пользователя.

**Report**: `{id:UUID,reporterId:UUID,targetId:UUID,targetMessageId:UUID?,reason:String,details:String,status:String,createdAt:DateTime}`. AdminReport также имеет `reviewedBy:UUID?`, `reviewedAt:DateTime?`, `reporter:PublicUser?`, `target:PublicUser?`, `reviewer:PublicUser?`. Статусы: `open`, `reviewed`, `dismissed`, `actioned`.

**Block**: `{blockerId:UUID,blockedId:UUID,createdAt:DateTime,user:PublicUser?}`. Возвращаются только исходящие блокировки текущего пользователя.

## 2. POST /register

Auth: public. Body:

```json
{"fullName":"Тестовый Пользователь","school":"App Review School","grade":"10А","nickname":"review_example","phone":"","deviceFingerprint":"ios-install-id"}
```

Обязательны непустые `fullName`, `school`, `grade`, `nickname`; `phone` и `deviceFingerprint` optional, default `""`. Имя/ник/класс/телефон trim. Школа: Unicode NFKC, схлопывание пробелов, trim; aliases `физтех`, `phystech`, `fiztekh`, `fiztex` → `Fiztex`. Уникальность ника и полного имени без учёта регистра; телефона — по сохранённой строке.

Ответ: `{ok:true,user:UserCore,token:String (optional),_devOtp:String (optional)}`. Регистрация всегда pending/member/cred=0; создаёт membership в school_public group. При указанном телефоне создаёт OTP на 5 минут. `_devOtp` появляется только без `SMS_API_URL`. `token` отсутствует при отсутствии `JWT_SECRET` — историческая особенность; клиент не должен продолжать защищённые вызовы без токена.

```json
{"ok":true,"user":{"id":"11111111-1111-4111-8111-111111111111","fullName":"Тестовый Пользователь","school":"App Review School","grade":"10А","nickname":"review_example","phone":null,"phoneVerified":false,"role":"member","status":"pending","cred":0,"createdAt":"2026-10-14T09:00:00+00:00"},"token":"<registration-jwt>"}
```

Ошибки: E0 и:

| HTTP | `error` |
|---|---|
| 400 | `invalid_json`, `fullName_required`, `school_required`, `grade_required`, `nickname_required`, `nickname_taken`, `phone_taken`, `fullName_taken` |
| 403 | `device_blocked` |
| 429 | `rate_limit_exceeded` |
| 500 | `registration_failed` |

Лимит 5 запросов / IP / минуту после проверки обязательных полей. Ошибка school-group sync может произойти уже после создания пользователя; повторная регистрация тогда может получить `*_taken`. SMS доставляется best effort; 200 не гарантирует получение SMS.

## 3. POST /login

Auth: public. Body:

```json
{"nickname":"review_example","password":"example-password"}
```

Ответ `{ok:true,token:String,user:UserCore}`. Ник ищется без учёта регистра, password не trim. Только approved; если `phone != null`, требуется `phoneVerified=true`.

```json
{"ok":true,"token":"<session-jwt>","user":{"id":"11111111-1111-4111-8111-111111111111","fullName":"Тестовый Пользователь","school":"App Review School","grade":"10А","nickname":"review_example","phone":null,"phoneVerified":false,"role":"member","status":"approved","cred":1,"createdAt":"2026-10-14T09:00:00+00:00"}}
```

Ошибки: E0 и:

| HTTP | `error` |
|---|---|
| 400 | `invalid_json`, `nickname_required`, `password_required` |
| 401 | `invalid_credentials` |
| 403 | `account_rejected`, `account_not_approved`, `phone_not_verified` |
| 429 | `rate_limit_exceeded` |
| 500 | `server_misconfigured` |

Лимит 10 / IP / минуту. Ошибки статуса/телефона возвращаются после верного пароля. `invalid_credentials` объединяет отсутствующего пользователя, неустановленный пароль и неверный пароль.

## 4. POST /set-password

Auth R; pending допускается. Body:

```json
{"password":"example-password"}
```

Password — String длиной 6...128 единиц UTF-16 JavaScript; пробелы сохраняются. Ответ:

```json
{"ok":true}
```

Ошибки: E0 + ER и:

| HTTP | `error` |
|---|---|
| 400 | `invalid_json`, `password_required`, `password_too_short`, `password_too_long` |
| 404 | `user_not_found` |
| 500 | `update_failed` |

Меняет пароль текущего пользователя без oldPassword и без отзыва существующих сессий. Сам endpoint не выдаёт новый токен и не выполняет login. Ответ `API.setPassword` в вебе может дополнительно содержать login token/user — это поведение клиента, не wire response.

## 5. POST /verify-phone

Auth: public. Body, обе строки обязательны:

```json
{"phone":"+77000000000","code":"123456"}
```

Trim обоих полей. Ответы — один из вариантов:

```json
{"ok":true,"userId":"11111111-1111-4111-8111-111111111111"}
```

```json
{"ok":true,"already_verified":true}
```

```json
{"ok":false,"error":"invalid_code","attemptsLeft":3}
```

Ошибки: E0 и:

| HTTP | `error` |
|---|---|
| 400 | `invalid_json`, `phone_required`, `code_required`, `otp_not_found_or_expired`, `invalid_code` |
| 404 | `user_not_found` |
| 429 | `too_many_attempts` |
| 500 | `verification_failed` |

Лимит 5 / IP+phone / 10 минут; максимум 5 попыток одного OTP. При последней неверной попытке ответ `too_many_attempts`, `attemptsLeft` отсутствует. OTP действует 5 минут. Без `SMS_API_URL` также принимается `000000`, но только если найден действующий OTP. `userId` отсутствует в варианте already_verified. Ветка `invalid_code` исторически не добавляет CORS headers; native клиенту это не мешает.

## 6. POST /resend-otp

Auth: public. Body:

```json
{"phone":"+77000000000"}
```

Ответ `{ok:true}`, либо `{ok:true,_devOtp:String}` без SMS_API_URL, либо `{ok:true,already_verified:true}`.

```json
{"ok":true,"_devOtp":"123456"}
```

Ошибки: E0 и:

| HTTP | `error` |
|---|---|
| 400 | `invalid_json`, `phone_required`, `no_phone_on_record` |
| 404 | `user_not_found` |
| 429 | `too_many_attempts` |
| 500 | `otp_create_failed` |

Лимит 3 / IP+phone / 10 минут. Старые OTP пользователя инвалидируются, новый живёт 5 минут. SMS best effort; не использовать `_devOtp` в production UI.

## 7. POST /logout

Auth J. Body отсутствует, ignored если передан. Отзывает только session текущего `jti`; повторный вызов с ещё не истёкшим JWT успешен.

```json
{"ok":true}
```

Ошибки: E0 + EJ и `logout_failed` (500). Сервер может вернуть `token_expired` для уже истёкшего токена; клиент всё равно должен удалить локальную сессию.

## 8. GET /me

Auth R, approved не требуется. Query/body отсутствуют. Ответ `{ok:true,user:MeUser,canApprove:Bool}`. `canApprove` true только у approved global admin.

```json
{"ok":true,"user":{"id":"11111111-1111-4111-8111-111111111111","fullName":"Тестовый Пользователь","school":"App Review School","grade":"10А","nickname":"review_example","phone":null,"phoneVerified":false,"role":"member","status":"approved","cred":1,"createdAt":"2026-10-14T09:00:00+00:00","avatarUrl":null,"credLevel":{"name":"Новичок","min":0,"max":4,"css":"novice"},"credProgress":0.025},"canApprove":false}
```

Ошибки: E0 + ER, `user_not_found` (404), `fetch_failed` (500). Подходит для polling статуса заявки registration token'ом. На `/me` нет списка rate targets; он в `/users`.

## 9. GET /users

Auth R, approved. Query: optional `rateTargets=true`; любая другая строка/отсутствие означает false. Исторический `status=pending|approved|all` **не применяется** в реализации. Body отсутствует.

Ответ `{ok:true,users:[DirectoryUser],pending:[DirectoryUser],usersToRate:[DirectoryUser]}`. `users` — approved из школы текущего пользователя, без него самого и без заблокированных в любом направлении, по cred descending. `pending` — все pending пользователи **всех школ** для global admin, остальные получают `[]`; сортировка createdAt ascending. `usersToRate` всегда содержит доступных для оценки approved пользователей; при `rateTargets=true` `users` также ограничен этим списком.

```json
{"ok":true,"users":[{"id":"22222222-2222-4222-8222-222222222222","fullName":"Тестовый Собеседник","school":"App Review School","grade":"10А","nickname":"review_peer","phoneVerified":false,"role":"member","status":"approved","cred":5.2,"createdAt":"2026-10-14T09:00:00+00:00","avatarUrl":null,"credLevel":{"name":"Знакомый","min":5,"max":14,"css":"known"},"credProgress":0.13,"canRate":{"ok":false,"reason":"24h_limit"}}],"pending":[],"usersToRate":[]}
```

Ошибки: E0 + ER, `caller_not_found` (404), `forbidden` (403), `fetch_failed` (500).

Eligibility: хотя бы одно direct сообщение в любую сторону и нет оценки от caller этому target за последние 24 часа. Переписка в общей группе не даёт eligibility. `usersToRate` повторяет полные объекты из directory, у каждого `canRate.ok=true`. Список — подсказка UI; `/rate` может позже ответить отказом из-за новой оценки или изменения доступа. Отдельной функции `getUsersToRate` нет.

## 10. POST /approve

Auth R; caller approved/global admin. Body:

```json
{"userId":"22222222-2222-4222-8222-222222222222"}
```

Ответ — сокращённый профиль, не UserCore:

```json
{"ok":true,"user":{"id":"22222222-2222-4222-8222-222222222222","status":"approved","cred":1}}
```

Ошибки: E0 + ER и:

| HTTP | `error` |
|---|---|
| 400 | `invalid_json`, `userId_required`, `user_not_pending`, `cannot_approve_self` |
| 403 | `forbidden`, `admin_only` |
| 404 | `caller_not_found`, `user_not_found` |
| 500 | `approve_failed` |

Требует pending target. Global admin может одобрять заявки всех школ; ограничения same-school в исполняемом коде нет. RPC атомарно меняет статус, записывает actor в approval_log и добавляет стартовое cred=1. После изменения перечитать `/me`/`/users`.

## 11. POST /reject

Auth R; caller approved/global admin. Body:

```json
{"userId":"22222222-2222-4222-8222-222222222222","deviceFingerprint":"optional-fingerprint"}
```

`deviceFingerprint` optional/default `""`; непустой добавляется в device_blocks. Клиент должен передавать fingerprint отклоняемого устройства только если знает его; поле не идентифицирует устройство target автоматически.

```json
{"ok":true,"user":{"id":"22222222-2222-4222-8222-222222222222","status":"rejected"}}
```

Ошибки: E0 + ER и:

| HTTP | `error` |
|---|---|
| 400 | `invalid_json`, `userId_required`, `user_not_pending`, `cannot_reject_self` |
| 403 | `forbidden`, `admin_only` |
| 404 | `caller_not_found`, `user_not_found` |
| 500 | `reject_failed` |

Глобальная модерация, same-school check отсутствует; RPC атомарно меняет статус, пишет audit и optional device block.

## 12. POST /rate

Auth R; approved caller/target, одна нормализованная школа, нет блока в любом направлении. Body:

```json
{"toUserId":"22222222-2222-4222-8222-222222222222","score":5,"fromUserId":"11111111-1111-4111-8111-111111111111"}
```

`score` Int 1...5. `toId` — поддерживаемый legacy alias `toUserId`; при обоих `toUserId` имеет приоритет, включая пустую строку. `fromUserId` optional; если задан непустым, обязан совпасть с JWT sub. Автор всегда JWT sub.

Ответ `{ok:true,entry:RatingEntry,newCred:Double,credLevel:CredLevel,credProgress:Double}`. RatingEntry: `{from:UUID,to:UUID,score:Int,weight:Double,baseDelta:Double,effectiveDelta:Double,date:DateTime}`. `id` записи в ответе отсутствует. `date` создан на Edge Function после RPC, может немного отличаться от времени audit строки в БД.

```json
{"ok":true,"entry":{"from":"11111111-1111-4111-8111-111111111111","to":"22222222-2222-4222-8222-222222222222","score":5,"weight":0.3,"baseDelta":2,"effectiveDelta":0.6,"date":"2026-10-14T09:30:00.000Z"},"newCred":1.6,"credLevel":{"name":"Новичок","min":0,"max":4,"css":"novice"},"credProgress":0.04}
```

Ошибки: E0 + ER и:

| HTTP | `error` |
|---|---|
| 400 | `invalid_json`, `toId_required`, `invalid_score`, `self` |
| 403 | `fromUserId_mismatch`, `forbidden`, `target_not_approved`, `cross_school_forbidden`, `user_blocked`, `no_chat` |
| 404 | `user_not_found` |
| 429 | `rate_limit_exceeded`, `24h_limit` |
| 500 | `fetch_failed`, `rate_failed` |

Лимит 20 / IP / минуту. Требуется direct переписка; повтор caller→target раз в 24 часа, БД дополнительно защищает гонку. Эффект оценки вычисляет сервер: веса по cred 0.3/0.7/1; repeat decay `max(0.2,0.8^timesRated)`; base deltas `[-2,-1,0,1,2]`; суммарное абсолютное изменение target максимум 5 за rolling 24 часа. При исчерпанном дневном изменении оценка успешна с `effectiveDelta=0` и всё равно запускает cooldown. `newCred`, level и progress относятся к target.

## 13. GET/POST /messages

Auth R, approved. Direct: target approved той же школы и нет блока в любом направлении. Group: доступ определяется membership/global admin; pairwise blocks не скрывают group messages.

GET query: **ровно один** `partnerId:UUID` или `groupId:UUID`; optional `limit` и `before:DateTime`.

```text
GET /messages?partnerId=22222222-2222-4222-8222-222222222222&limit=50&before=2026-10-14T09%3A30%3A00.000Z
```

Без `limit` — ascending выборка без pagination, `before` игнорируется после проверки его корректности, `hasMore=false`. База/проект может ограничить число возвращаемых строк; не полагаться на обещание неограниченной истории. С `limit`: parseInt, invalid/0/пустой → 50, clamp 1...100; берётся самая новая страница строго до `before` (`time < before`), затем возвращается ascending. Для следующей старой страницы взять time первой записи; cursor только timestamp, поэтому одинаковые time на границе могут пропустить записи. `hasMore` определяется дополнительной строкой.

GET response `{ok:true,messages:[Message],markedRead:Int,hasMore:Bool}`:

```json
{"ok":true,"messages":[{"id":"33333333-3333-4333-8333-333333333333","fromId":"22222222-2222-4222-8222-222222222222","toId":"11111111-1111-4111-8111-111111111111","groupId":null,"type":"text","text":"Привет!","time":"2026-10-14T09:20:00+00:00","readAt":null,"attachmentPath":null,"attachmentMime":null,"attachmentBytes":null,"attachmentWidth":null,"attachmentHeight":null,"senderDeleted":false}],"markedRead":1,"hasMore":false}
```

GET direct помечает **все** входящие сообщения partner→caller прочитанными, даже вне текущей страницы. `messages` выбраны до этой операции, поэтому их `readAt` в том же ответе может ещё быть null. `markedRead` — число обновлённых строк, 0 также при best-effort RPC failure. Group всегда `markedRead=0`, общего per-user group receipt нет. Global admin может читать private group как observer, но POST требует membership. School_public access может автоматически создать membership.

POST body: ровно один `toId`/`groupId`; optional `text` default `""`, optional attachment metadata. Text trim, максимум 4000 единиц UTF-16; должен быть текст или непустой `attachmentPath`. Отправитель из JWT. Сначала загрузить image через `/upload-media`, затем передать его `media`:

```json
{"groupId":"44444444-4444-4444-8444-444444444444","text":"Фото","attachmentPath":"11111111-1111-4111-8111-111111111111/2026-10-14/image.png","attachmentMime":"image/png","attachmentBytes":120000,"attachmentWidth":640,"attachmentHeight":480}
```

POST ответ `{ok:true,message:Message}`:

```json
{"ok":true,"message":{"id":"33333333-3333-4333-8333-333333333333","fromId":"11111111-1111-4111-8111-111111111111","toId":null,"groupId":"44444444-4444-4444-8444-444444444444","type":"image","text":"Фото","time":"2026-10-14T09:30:00+00:00","readAt":null,"attachmentPath":"11111111-1111-4111-8111-111111111111/2026-10-14/image.png","attachmentMime":"image/png","attachmentBytes":120000,"attachmentWidth":640,"attachmentHeight":480,"senderDeleted":false,"attachmentUrl":"https://example.supabase.co/storage/v1/object/sign/chat-media/example?token=example"}}
```

Лимит POST 30 / IP / минуту; type автоматически `image` при path, иначе `text`. Передавать только path собственного upload: первый сегмент должен быть caller UUID, сегменты `..` запрещены. DB guard также требует существующий объект chat-media и отсутствие path в очереди удаления; нарушение возвращается как `send_failed` 500. Метаданные принимает сервер, path не заменять signed URL. Signed URL обновляется новым GET, не сохранять его как постоянный адрес. Multipart не принимается этим endpoint.

Ошибки: E0 + ER и:

| HTTP | `error` | Где |
|---|---|---|
| 400 | `conversation_target_required`, `conversation_target_conflict` | GET/POST |
| 400 | `invalid_before_cursor`, `partner_not_approved` | GET |
| 400 | `invalid_json`, `text_required`, `text_too_long`, `cannot_message_self`, `recipient_not_approved`, `attachment_forbidden` | POST |
| 403 | `forbidden`, `cross_school_forbidden`, `user_blocked` | GET/POST |
| 404 | `caller_not_found`, `group_not_found` | GET/POST |
| 404 | `partner_not_found` | GET |
| 404 | `recipient_not_found` | POST |
| 429 | `rate_limit_exceeded` | POST |
| 500 | `fetch_failed` | GET |
| 500 | `send_failed` | POST |

Неизвестная и недоступная group дают одинаковый `group_not_found`. Ошибка DB в block/access helper закрывает доступ через `internal_error` 500. Удаление автора сохраняет его group историю с `senderDeleted=true`; direct история с удалённым аккаунтом удаляется.

## 14. POST /upload-media

Auth R, approved. `multipart/form-data`: `file` обязательный File с MIME `image/*`, 1...6291456 bytes (6 MiB), `width`/`height` optional числовые строки. Рекомендуемые MIME, разрешённые bucket: `image/jpeg`, `image/png`, `image/webp`, `image/gif`. Другой image MIME может пройти validation функции и получить `upload_failed` от storage.

```text
file=<binary image>; filename=photo.png; Content-Type=image/png
width=640
height=480
```

Ответ `{ok:true,media:{path:String,mime:String,bytes:Int,width:Int?,height:Int?}}`:

```json
{"ok":true,"media":{"path":"11111111-1111-4111-8111-111111111111/2026-10-14/random-id.png","mime":"image/png","bytes":120000,"width":640,"height":480}}
```

Ширина/высота из input, изображение сервер не измеряет. Отсутствие, 0 или нечисловой ввод → null; передавайте положительные целые. Ответ не содержит URL, upload не создаёт message. Path всегда `<callerId>/<UTC YYYY-MM-DD>/<random UUID>.<ext>`.

После записи в Storage сервер подтверждает загрузку через service-only RPC `finalize_chat_media_upload` (миграция 037). Если аккаунт удалён во время загрузки, ответ **401 `session_revoked`**, без `media`; при сбое Storage или подтверждения — **500 `upload_failed`**, также без `media`. Неподтверждённый файл ставится в очередь очистки и удаляется адресно; сбой очистки сохраняет очередь для повторной попытки. Клиент не должен прикреплять файл из неуспешного ответа. Формат успешного ответа не меняется.

Ошибки: E0 + ER и:

| HTTP | `error` |
|---|---|
| 400 | `invalid_form_data`, `file_required`, `image_only`, `empty_file`, `file_too_large` |
| 401 | `session_revoked` — в том числе удаление аккаунта во время загрузки |
| 403 | `forbidden` |
| 404 | `caller_not_found` |
| 500 | `upload_failed` — ошибка Storage или подтверждения загрузки |

## 15. GET/POST /groups

Auth R, approved. Каждый вызов обеспечивает membership caller в school_public group; если группы нет, создаёт её.

GET без query/body: `{ok:true,groups:[Group],invites:[GroupInvite]}`. Member видит свои группы; global admin — все группы всех школ, в том числе как observer. Groups по type/name ascending; members по nickname (ru). Pending invites адресованы caller, newest first; приглашения от заблокированных в любом направлении скрываются.

```json
{"ok":true,"groups":[{"id":"44444444-4444-4444-8444-444444444444","name":"App Review School","school":"App Review School","type":"school_public","createdBy":"11111111-1111-4111-8111-111111111111","avatarUrl":null,"createdAt":"2026-10-14T09:00:00+00:00","members":[{"id":"11111111-1111-4111-8111-111111111111","nickname":"review_example","fullName":"Тестовый Пользователь","school":"App Review School","status":"approved","avatarUrl":null,"role":"admin","joinedAt":"2026-10-14T09:00:00+00:00"}],"memberCount":1,"myRole":"admin","canManage":true}],"invites":[]}
```

POST, вариант create:

```json
{"action":"create","name":"Наш класс","memberIds":["22222222-2222-4222-8222-222222222222"]}
```

`name` String trim 1...80 единиц UTF-16. `memberIds` optional array, deduplicated, default `[]`; приглашение отправляется только существующим approved same-school незаблокированным пользователям, кроме creator. Неподходящие ids игнорируются. Creator становится group admin. Ответ `{ok:true,group:GroupBase}` без members/canManage:

```json
{"ok":true,"group":{"id":"44444444-4444-4444-8444-444444444444","name":"Наш класс","school":"App Review School","type":"private","createdBy":"11111111-1111-4111-8111-111111111111","avatarUrl":null,"createdAt":"2026-10-14T09:30:00+00:00"}}
```

POST, ответ на invite:

```json
{"action":"respond_invite","inviteId":"55555555-5555-4555-8555-555555555555","decision":"accept"}
```

`decision` только `accept` / `decline`; invite должен быть pending и адресован caller. Accept добавляет membership/member; при блокировке inviter accept запрещён, decline допускается.

```json
{"ok":true,"inviteId":"55555555-5555-4555-8555-555555555555","decision":"accept"}
```

POST, выход:

```json
{"action":"leave","groupId":"44444444-4444-4444-8444-444444444444"}
```

```json
{"ok":true,"groupId":"44444444-4444-4444-8444-444444444444"}
```

Выход из school_public и выход последнего group admin запрещены. API для ручного удаления/rename группы или передачи ownership сейчас нет; при удалении аккаунта policy описана в delete-account.

Ошибки: E0 + ER и:

| HTTP | `error` | Где |
|---|---|---|
| 403 | `forbidden` | Все |
| 404 | `caller_not_found` | Все |
| 500 | `fetch_failed` | GET |
| 400 | `invalid_json`, `unsupported_action` | POST |
| 400 | `name_required`, `name_too_long` | create |
| 500 | `group_create_failed` | create |
| 400 | `inviteId_required`, `invalid_decision` | respond_invite |
| 403 | `user_blocked` | respond_invite/accept |
| 404 | `invite_not_found` | respond_invite |
| 500 | `invite_update_failed` | respond_invite |
| 400 | `groupId_required`, `cannot_leave_school_group`, `last_admin_cannot_leave` | leave |
| 404 | `group_not_found` | leave |
| 500 | `leave_failed` | leave |

Create/invite операции состоят из нескольких запросов; ошибка может оставить уже созданную group/invite. После ошибки перечитать GET перед повтором.

## 16. GET/POST /block-user

Auth R, approved. GET без query/body возвращает `{ok:true,blocks:[Block]}`, newest first; только исходящие блокировки.

```json
{"ok":true,"blocks":[]}
```

POST:

```json
{"targetId":"22222222-2222-4222-8222-222222222222","action":"unblock"}
```

`action` optional/default `block`, допустим `block` / `unblock`. Для block target должен существовать, быть approved, той же школы. Unblock удаляет принадлежащую caller блокировку независимо от текущего статуса/школы/существования target. Повтор block/upsert или unblock/delete успешен.

```json
{"ok":true,"targetId":"22222222-2222-4222-8222-222222222222","action":"unblock","blocks":[]}
```

Ошибки: E0 + ER и:

| HTTP | `error` | Где |
|---|---|---|
| 403 | `forbidden` | GET/POST |
| 404 | `caller_not_found` | GET/POST |
| 500 | `fetch_failed` | GET/POST |
| 400 | `invalid_json`, `targetId_required`, `invalid_action`, `cannot_block_self` | POST |
| 403 | `target_not_approved`, `cross_school_forbidden` | POST/block |
| 404 | `target_not_found` | POST/block |
| 429 | `rate_limit_exceeded` | POST |
| 500 | `block_failed`, `unblock_failed` | POST |

Лимит POST 30 / IP / минуту. Блок влияет на directory, direct сообщения, оценки, приглашения; не удаляет прошлые сообщения. Unblock снимает только caller→target: если target тоже заблокировал caller, контакт остаётся запрещённым. Group membership/история от блокировок не скрываются.

## 17. POST /report-user

Auth R, approved. Body:

```json
{"targetId":"22222222-2222-4222-8222-222222222222","targetMessageId":"33333333-3333-4333-8333-333333333333","reason":"harassment","details":"Текст жалобы"}
```

`targetId`, `reason` обязательны. `targetMessageId` optional/empty означает жалобу на пользователя. `details` optional/default `""`, trim и обрезание до 1000 единиц UTF-16 (DB дополнительно проверяет 1000 characters). Причины: `spam`, `harassment`, `fake_account`, `inappropriate_content`, `other`; legacy `fake_profile` принимается и сохраняется как `fake_account`.

Target — любой существующий пользователь, не caller; проверки школы/approved target нет. Если message задан, должен быть direct сообщением между caller и target в любую сторону; group сообщение не подходит. Одна open жалоба на пару reporter→target, независимо от reason/message.

Ответ `{ok:true,report:Report}`:

```json
{"ok":true,"report":{"id":"66666666-6666-4666-8666-666666666666","reporterId":"11111111-1111-4111-8111-111111111111","targetId":"22222222-2222-4222-8222-222222222222","targetMessageId":"33333333-3333-4333-8333-333333333333","reason":"harassment","details":"Текст жалобы","status":"open","createdAt":"2026-10-14T09:30:00+00:00"}}
```

Ошибки: E0 + ER и:

| HTTP | `error` |
|---|---|
| 400 | `invalid_json`, `targetId_required`, `cannot_report_self`, `invalid_reason`, `target_message_invalid` |
| 403 | `forbidden` |
| 404 | `caller_not_found`, `target_not_found` |
| 409 | `report_already_open` |
| 429 | `rate_limit_exceeded` |
| 500 | `report_failed` |
| 503 | `rate_limit_unavailable` |

Лимит **5 / approved authenticated user (`payload.sub`) / rolling час**, после JWT verification и проверки approved. Общий IP школьного Wi-Fi не объединяет лимиты разных пользователей. Валидированный JWT не позволяет выбрать ключ лимита через тело. Атомарный DB счётчик учитывает запросы до дальнейшей валидации/duplicate check, а не только созданные reports. При недоступности проверки квоты запрос не принимается и возвращается `rate_limit_unavailable` 503.

## 18. GET/POST /reports-admin

Auth R, approved/global admin; школы не ограничивают модерацию.

GET query `status` optional/default `open`: `open`, `reviewed`, `dismissed`, `actioned`, `all`. Ответ `{ok:true,reports:[AdminReport],summary:ReportSummary}`. Summary: все `Int` — `total`, `open`, `reviewed`, `dismissed`, `actioned`. Возвращается максимум 100 reports, newest first; summary относится к **этой отфильтрованной выборке**, не ко всей базе.

```json
{"ok":true,"reports":[],"summary":{"total":0,"open":0,"reviewed":0,"dismissed":0,"actioned":0}}
```

POST:

```json
{"reportId":"66666666-6666-4666-8666-666666666666","action":"review"}
```

Actions `review`/`reviewed` → reviewed, `dismiss`/`dismissed` → dismissed, `action`/`actioned` → actioned. Только open report; сохраняет caller как reviewedBy и текущее время reviewedAt. Действие `action` само по себе не блокирует/удаляет пользователя.

```json
{"ok":true,"report":{"id":"66666666-6666-4666-8666-666666666666","reporterId":"11111111-1111-4111-8111-111111111111","targetId":"22222222-2222-4222-8222-222222222222","targetMessageId":null,"reason":"spam","details":"","status":"reviewed","reviewedBy":"77777777-7777-4777-8777-777777777777","createdAt":"2026-10-14T09:30:00+00:00","reviewedAt":"2026-10-14T09:40:00.000Z","reporter":null,"target":null,"reviewer":null}}
```

Вложенные user могут быть null при отсутствии профиля или ошибке дополнительной загрузки; такая ошибка не превращает ответ в 500.

Ошибки: E0 + ER и:

| HTTP | `error` | Где |
|---|---|---|
| 403 | `admin_only`, `forbidden` | GET/POST |
| 404 | `caller_not_found` | GET/POST |
| 400 | `invalid_status` | GET |
| 500 | `fetch_failed` | GET |
| 400 | `invalid_json`, `reportId_required`, `invalid_action` | POST |
| 409 | `report_not_open` | POST, также несуществующий report |
| 500 | `report_update_failed` | POST |

## 19. POST /delete-account

Auth R; pending/approved/rejected допускаются, пока есть действующая сессия. Body отсутствует; `userId` не принимается как target, удаляется только JWT sub.

```json
{"ok":true,"deletedUserId":"11111111-1111-4111-8111-111111111111"}
```

Ошибки: E0 + ER, `user_not_found` (404), `delete_failed` (500).

Атомарная DB операция передаёт созданные пользователем группы **самому старому оставшемуся участнику** (joinedAt ascending, затем userId для одинакового времени) и делает его group admin. Если удаляемый пользователь был последним admin другой группы, старший оставшийся участник также становится admin. Если участников нет, group удаляется. Политика действует для private и school_public; пустая школьная группа может быть создана заново обычным group sync.

Group история и вложения остальных участников сохраняются. Group сообщения удаляемого автора остаются с исходным `fromId` и `senderDeleted=true`; UI показывает «Удалённый пользователь». Direct сообщения с участием аккаунта удаляются. Сессии, пользовательские ratings/reports/blocks/invites/OTP и остальные связанные записи удаляются/обнуляются по FK policy. Медиа, нужные оставшейся group истории, сохраняются; удаление неиспользуемого private chat-media выполняется после DB commit/best effort. Ответ 200 означает завершённое DB удаление, не гарантирует завершение storage cleanup. После успеха никакой JWT удалённого аккаунта больше не даёт Auth R.

## 20. GET /admin-stats

Auth R, approved/global admin. Query/body отсутствуют. Статистика по всем школам. Ответ `{ok:true,summary:AdminSummary,charts:AdminCharts,schools:[SchoolStats],recentUsers:[AdminUser],groups:[AdminGroup]}`.

- **AdminSummary**: все `Int`: `totalUsers`, `approvedUsers`, `pendingUsers`, `rejectedUsers`, `adminUsers`, `newUsers24h`, `newUsers7d`, `newApplications24h`, `totalMessages`, `messages24h`, `images24h`, `totalGroups`, `publicGroups`, `privateGroups`, `pendingInvites`, `totalReports`, `openReports`, `reports24h`, `totalBlocks`.
- **AdminCharts**: `registrationsByDay` и `messagesByDay` — `[DailyBucket]`, последние 7 **UTC** дат включая сегодня. DailyBucket `{key:String YYYY-MM-DD,label:String DD.MM,count:Int}`. `topSchoolsByUsers:[{label:String,value:Int,pendingUsers:Int}]`, максимум 6.
- **SchoolStats** `{school:String,totalUsers:Int,approvedUsers:Int,pendingUsers:Int}`, `schools` максимум 12, totalUsers descending, затем ru school name. Здесь группировка по сохранённой строке школы, не по normalized key.
- **AdminUser** `{id:UUID,nickname:String,fullName:String,school:String,role:String,status:String,createdAt:DateTime,avatarUrl:String?}`; `recentUsers` максимум 12 newest first. Нет grade/phone/cred/credo.
- **AdminGroup** `{id:UUID,name:String,school:String,type:String,createdAt:DateTime,avatarUrl:String?,memberCount:Int,adminCount:Int,messageCount:Int,imageCount:Int}`; `groups` максимум 20 newest first. Нет createdBy/members/myRole.

```json
{"ok":true,"summary":{"totalUsers":0,"approvedUsers":0,"pendingUsers":0,"rejectedUsers":0,"adminUsers":0,"newUsers24h":0,"newUsers7d":0,"newApplications24h":0,"totalMessages":0,"messages24h":0,"images24h":0,"totalGroups":0,"publicGroups":0,"privateGroups":0,"pendingInvites":0,"totalReports":0,"openReports":0,"reports24h":0,"totalBlocks":0},"charts":{"registrationsByDay":[{"key":"2026-10-08","label":"08.10","count":0},{"key":"2026-10-09","label":"09.10","count":0},{"key":"2026-10-10","label":"10.10","count":0},{"key":"2026-10-11","label":"11.10","count":0},{"key":"2026-10-12","label":"12.10","count":0},{"key":"2026-10-13","label":"13.10","count":0},{"key":"2026-10-14","label":"14.10","count":0}],"messagesByDay":[{"key":"2026-10-08","label":"08.10","count":0},{"key":"2026-10-09","label":"09.10","count":0},{"key":"2026-10-10","label":"10.10","count":0},{"key":"2026-10-11","label":"11.10","count":0},{"key":"2026-10-12","label":"12.10","count":0},{"key":"2026-10-13","label":"13.10","count":0},{"key":"2026-10-14","label":"14.10","count":0}],"topSchoolsByUsers":[]},"schools":[],"recentUsers":[],"groups":[]}
```

Ошибки: E0 + ER, `caller_not_found` (404), `admin_only`/`forbidden` (403), `fetch_failed` (500). Сбой загрузки reports/blocks исторически даёт нулевые связанные счётчики в успешном ответе; ошибки основных выборок дают fetch_failed. Агрегаты рассчитываются из загруженных rows, и default лимит Supabase/PostgREST может их ограничить на большой базе; это не точный отчёт неограниченного размера.

## 21. POST /cleanup

Auth C, только сервер. Никогда не сохранять CLEANUP_SECRET в Swift/web. Body отсутствует. Удаляет просроченные sessions/OTP и rate-limit logs старше часа, затем одну пачку (до 100 queued paths) неиспользуемого chat-media. Сохраняемые сообщения проверяются перед удалением файла.

```json
{"ok":true,"deleted":{"sessions":2,"otp":3,"rateLimitLog":10,"chatMedia":1}}
```

Response counts Int; `chatMedia` — количество удалённых файлов, не число сообщений или оставшихся элементов очереди. В старой версии deployment поле может отсутствовать. Ошибки: E0, `server_misconfigured` (500; отсутствует CLEANUP_SECRET), `forbidden` (403; секрет не совпал). Ошибка отдельного cleanup RPC/media cleanup логируется, но endpoint исторически возвращает 200 и count=0 для этой операции; 200 не доказывает, что все cleanup задачи успешны. Неудалённые queued paths сохраняются для следующего запуска.

## 22. Подключение Swift и проверка совместимости

Минимальная последовательность onboarding: `register` → сохранить registration token → `set-password` → optional `verify-phone` → polling `me` до approved → `login` и заменить registration token session token'ом. `login` при pending вернёт `account_not_approved`; registration token не продлевается, после часа polling требует нового доступного auth способа (refresh/recovery API сейчас отсутствует).

Для одной модели User поля, которые различаются между endpoints (`phone`, `avatarUrl`, `credLevel`, `credProgress`, `canRate`), декодировать через `decodeIfPresent`; ещё точнее завести отдельные DTO для UserCore/MeUser/DirectoryUser и сокращённых approval/admin профилей. `ok` — Bool, `error:String?`, `attemptsLeft:Int?`. Сначала проверять HTTP/`ok`, затем декодировать конкретный success DTO; не требовать success поля в ошибке. Успешные пустые arrays — `[]`, не null.

Не пересчитывать credo или eligibility на iOS. Использовать `user.credLevel`/`credProgress`, `usersToRate`/`canRate`; после rate синхронизировать данные. На 401 удалить/обновить auth состояние по смыслу ошибки; на 403 показать состояние/недоступность действия; на 429 соблюдать cooldown без автоматического повторения POST.

Для contract проверки: вызовы всех 20 функций сверены с текущим кодом; перед выпуском native клиента прогнать Postman-коллекцию на целевом окружении и отдельно проверить registration/pending token, revoked JWT, decimal cred, image signed URL, deleted group author, block/unblock и report duplicate. Production URL сам по себе не подтверждает актуальную версию API.

## Приложение: POST /register-push

Дополнительный endpoint для iOS push, требует migrations 035–036/device_tokens и deploy функции. Auth R; caller может быть **pending или approved**, чтобы зарегистрировать устройство до одобрения заявки. Rejected получает `forbidden` 403.

Body:

```json
{"token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","platform":"ios","environment":"sandbox","action":"register"}
```

- `token` — обязательная hex строка **чётной длины от 2 до 1024 символов**, без пробелов/скобок; server сохраняет lowercase. Swift переводит весь APNs device token `Data` в hex, не в Base64, и не предполагает фиксированную длину. Apple указывает, что [device token имеет переменную длину](https://developer.apple.com/documentation/uikit/uiapplicationdelegate/application(_:didRegisterForRemoteNotificationsWithDeviceToken:)). Предел 1024 hex символа — ограничение этого API (до 512 bytes), не обещание фиксированного размера Apple token.
- `platform` optional/default `ios`; другие значения не поддерживаются.
- `environment` optional, `sandbox` / `production`. По умолчанию `APNS_ENVIRONMENT` сервера, если секрет отсутствует — `production`. Клиент явно передаёт окружение своего APNs token: development/sandbox и production tokens не взаимозаменяемы.
- `action` optional/default `register`; допустим `register` / `unregister`.

Register/upsert закрепляет одну пару `(platform,environment,token)` за текущим пользователем; повторный login на устройстве может передать token новому владельцу. Ответ не раскрывает raw device token:

```json
{"ok":true,"action":"register","registered":true,"device":{"platform":"ios","environment":"sandbox","createdAt":"2026-10-14T09:00:00+00:00","updatedAt":"2026-10-14T09:30:00+00:00"}}
```

Unregister удаляет только запись текущего владельца с этой тройкой; повторный вызов успешен. Перед logout желательно вызвать unregister на используемом устройстве.

```json
{"ok":true,"action":"unregister","registered":false}
```

Ошибки: E0 + ER и:

| HTTP | `error` |
|---|---|
| 400 | `invalid_json`, `invalid_body`, `token_required`, `invalid_token`, `invalid_platform`, `invalid_environment`, `invalid_action` |
| 403 | `forbidden` |
| 429 | `rate_limit_exceeded` |
| 503 | `rate_limit_unavailable` |
| 500 | `registration_failed`, `unregister_failed`, `server_misconfigured` |

Здесь `invalid_token` 400 означает неверный APNs token в body; `invalid_token` 401 из ER означает неверный auth JWT. Лимит 30 / пользователь / rolling минуту, атомарный и закрывается при DB ошибке. Invalid body отклоняется до расходования квоты. Неверный `APNS_ENVIRONMENT` серверного конфига — `server_misconfigured` 500.

APNs отправляется после создания direct/group сообщения, после новой заявки (approved global admins) и после одобрения аккаунта (этому пользователю). HTTP ответ основного endpoint не подтверждает доставку уведомления. Если хотя бы одного обязательного секрета нет, push отправка выключена, API продолжает работать: `APNS_PRIVATE_KEY` (содержимое .p8), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`; `APNS_ENVIRONMENT` optional/default production. Секреты находятся только в Supabase, iOS их не получает. Без ключа .p8 реальную доставку проверить нельзя.

Payload содержит `aps:{alert:{title:String,body:String},sound:"default"}` и `event:"message"|"approval_request"|"account_approved"`. Для message добавляются `messageId:UUID`, `fromId:UUID` и optional `groupId:UUID`. Прямую переписку клиент открывает через `/messages?partnerId=fromId`, групповую — через `groupId`. Текст сообщения, полное имя, cred и details жалобы в push payload не передаются. По уведомлению клиент перечитывает API; payload не является источником актуального состояния. Отправка best effort, с ограниченным временем APNs/fanout; durable автоматических retries нет.
