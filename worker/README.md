# Настройка серверной части (Cloudflare Worker)

После однократного развёртывания **всё управление Spotify происходит на главной странице Wither Spotify Widget**, а в OBS вставляется одна готовая ссылка. Отдельная программа на компьютере не нужна.

Worker использует Cloudflare D1 (базу данных) и два секретных значения. Spotify access/refresh tokens хранятся в базе только в зашифрованном виде (AES-256-GCM). В OBS-ссылку попадает **только отдельный ключ чтения**, который можно перевыпустить или отозвать.

## 1. Создать базу D1

1. Зарегистрируйся/войди в [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Открой **Storage & databases → D1 → Create database**.
3. Название базы: `wither-spotify-widget-db`.
4. Скопируй выданный **Database ID**.
5. Открой эту базу, перейди в **Console** и выполни SQL из [schema.sql](schema.sql). Он создаст пять таблиц: `pending_oauth`, `overlays`, `art_cache`, `invites` и `admin_sessions`.

## 2. Настроить репозиторий

Открой [worker/wrangler.toml](wrangler.toml) на GitHub и нажми карандаш (Edit).

- В `database_id` вместо `REPLACE_WITH_YOUR_D1_DATABASE_ID` вставь UUID базы D1.
- В `SPOTIFY_CLIENT_ID` вместо `REPLACE_WITH_YOUR_SPOTIFY_CLIENT_ID` вставь Client ID приложения из [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
- `SITE_URL` уже настроен на `https://witheroffic.github.io/spotify-widget-pkce/index.html`.
- Сохрани изменения в **main**.

**Никогда не сохраняй в GitHub refresh token, PAIRING_KEY, TOKEN_ENC_KEY или Client Secret.** Client ID — публичный идентификатор, его хранить в файле допускается.

## 3. Подключить Cloudflare Worker к GitHub

1. В Cloudflare открой **Workers & Pages → Create application → GitHub**.
2. Подключи репозиторий `WitherOffic/spotify-widget-pkce`.
3. Выбери основную ветку `main`.
4. Для Worker выбери имя `wither-spotify-widget-api`, как в `worker/wrangler.toml`.
5. Укажи **Root directory: `worker`**. Worker entrypoint: `src/index.js`, конфигурация — `wrangler.toml`.
6. Сохрани и запусти развёртывание. При необходимости укажи deploy command `npx wrangler deploy`.

Проверь, что Worker появился на адресе наподобие:
`https://wither-spotify-widget-api.<твой-workers-subdomain>.workers.dev`

Документация: [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/).

## 4. Добавить два секрета Worker

Открой Worker → **Settings → Variables and Secrets** и создай два значения типа **Secret**:

| Имя | Значение |
| --- | --- |
| `PAIRING_KEY` | Твоя случайная строка не менее 24 символов; понадобится один раз на главной странице |
| `TOKEN_ENC_KEY` | Строго 32 случайных байта в кодировке Base64; используется для шифрования Spotify-токенов |

На Windows можно сгенерировать две разные строки через стандартный PowerShell (никаких программ скачивать не нужно):

```powershell
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
[Convert]::ToBase64String($bytes)
$rng.Dispose()
```

Выполни команду дважды. Первый результат используй как `PAIRING_KEY`, второй как `TOKEN_ENC_KEY`. **Сохрани эти строки в надёжном месте.** При смене TOKEN_ENC_KEY старые подключения нельзя будет расшифровать, потребуется новая авторизация.

После сохранения секретов Cloudflare должен развернуть/активировать обновлённую конфигурацию Worker.

Проверка: открой `https://ТВОЙ-WORKER.workers.dev/api/health`. Ожидается `{"ready":true}`. Если `ready:false`, проверь названия секретов и их доступность Worker.

## 5. Обновить Spotify Redirect URI

В Spotify Developer → своё приложение → **Redirect URIs** добавь **точный адрес**:

```text
https://ТВОЙ-WORKER.workers.dev/oauth/callback
```

Нажми **Add**, затем **Save**. Spotify требует побуквенного совпадения URI. Старый адрес GitHub Pages можно оставить в списке, но новый способ авторизации использует только Worker callback.

## 6. Подключиться через главную страницу

1. Открой [Wither Spotify Widget](https://witheroffic.github.io/spotify-widget-pkce/index.html).
2. Вставь URL Worker и `PAIRING_KEY`.
3. Нажми **Проверить Worker**, затем **Подключить Spotify**.
4. Войди в Spotify в обычном браузере и разреши чтение текущего трека.
5. После возврата на главную страницу появится **готовая OBS-ссылка**. Она сразу работает без входа в Spotify внутри OBS.
6. В OBS добавь источник **Браузер** размером `550 × 160` с полученной ссылкой.

Управление: на главной странице можно изменить интервал опроса, анимации, наличие обложки; **Перевыпустить ссылку** (старая перестанет работать), **Отключить Spotify** (удаление подключённых данных с сервера).


## Приглашения друзьям и режим владельца

В существующей базе ты уже создавал таблицу `invites`. Для **запоминания прав владельца на 90 дней** нужно дополнительно выполнить в **Cloudflare → D1 → wither-spotify-widget-db → Console**:

```sql
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
```

Новые установки могут просто запустить полный файл [schema.sql](schema.sql), который создаст все таблицы через `IF NOT EXISTS`. Существующие таблицы Spotify не изменятся.

1. Убедись, что новая версия Worker из ветки `main` имеет статус Ready в Cloudflare Deployments.
2. Открой [панель Wither Spotify Widget](https://witheroffic.github.io/spotify-widget-pkce/index.html), обнови через Ctrl+Shift+R. Подключённый Spotify и старый OBS URL сохранятся.
3. В разделе **«Включить управление приглашениями»** раскрой **«Я владелец сервера»** и введи свой `PAIRING_KEY` **один раз**. Нажми **«Запомнить этот браузер»**.
4. Worker создаст случайный ключ со сроком действия **90 дней**. Он разрешает только создание приглашений, а не чтение Spotify refresh token, смену Worker или управление другими аккаунтами. В D1 хранится только SHA-256 хеш ключа. `PAIRING_KEY` не записывается в localStorage.
5. Теперь в разделе **«Пригласить друга»** нажимай **«Создать приглашение без PAIRING_KEY»**. Каждая ссылка одноразовая и действует **48 часов**. Не отправляй её публично.
6. Добавь Spotify-аккаунт друга в **Spotify Developer → User Management** до отправки ссылки. В Development Mode у Spotify есть лимит пользователей; приглашения его не обходят.
7. Друг открывает ссылку, авторизуется в Spotify и получает отдельную OBS-ссылку. Он не знает твой `PAIRING_KEY` и не получает прав администратора. Если друг оборвал авторизацию, нужно создать новое приглашение.
8. В любой момент нажми **«Отозвать доступ этого браузера»**, чтобы немедленно аннулировать его ограниченный админ-ключ на сервере. Это **не влияет** на Spotify, его D1-токены и рабочий URL в OBS.

**Безопасность:** ограниченный админ-ключ хранится в localStorage этого браузера. Любой с доступом к тому же браузерному профилю или вредоносное расширение потенциально может им воспользоваться, чтобы создавать приглашения. Не включай режим владельца на чужом ПК и отзывай его после использования на общем компьютере. Через 90 дней понадобится повторное подтверждение `PAIRING_KEY`. В случае утраты `PAIRING_KEY` можно заменить **только** этот Secret в Cloudflare; `TOKEN_ENC_KEY` менять нельзя, иначе существующие зашифрованные подключения перестанут открываться.

## Важные ограничения

- Это не обход ограничений Spotify: для Development Mode нужны соответствующие права, Premium и разрешённые пользователи.
- Текущий трек приходит через Spotify Web API. На паузу оверлей реагирует при следующем опросе, а не мгновенно.
- Никому не отправляй **полную OBS-ссылку**: она даёт доступ к данным о твоих текущих треках (но не позволяет переключать песни).
- Worker хранит токены на сервере, но база D1 и Worker — твоя ответственность. Не публикуй секреты, соблюдай правила Spotify Developer Policy.
- Авторизация в Chrome, сделанная в предыдущей браузерной версии, автоматически не переносится: надо пройти новый вход **один раз**.
- Если хочешь выдать публичную версию проекта для других пользователей, потребуется продумать многопользовательскую авторизацию, управление доступом и требования Spotify; текущий сервер — для персонального использования.

Полезные ссылки: [Cloudflare D1](https://developers.cloudflare.com/d1/), [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Spotify PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow).
