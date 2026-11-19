# Tasker Backend

REST API каталога акций и челленджей на Node.js 22+, Express и PostgreSQL.

## Запуск

1. Создайте пустую БД `tasker` и выполните `psql -v ON_ERROR_STOP=1 -d tasker -f ebobo_2.sql`. Для БД, уже созданной из исходной схемы v2, выполните только `psql -v ON_ERROR_STOP=1 -d tasker -f migrations/001_company_accounts_and_rating.sql`. Миграция пересчитывает рейтинг из сохранённых отзывов. Существующим компаниям без учётных данных администратор БД может назначить email и bcrypt-хеш пароля одним обновлением.
2. Скопируйте `.env.example` в `.env`. Укажите свой `DATABASE_URL`, случайный `JWT_SECRET` и адрес фронтенда в `CORS_ORIGIN`. Секрет можно сгенерировать командой `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
3. Установите зависимости через `npm install` и запустите `npm start`. На Windows при ограничении PowerShell используйте `npm.cmd`.
4. Для создания администратора задайте `ADMIN_EMAIL`, `ADMIN_NAME` и `ADMIN_PASSWORD` в окружении и выполните `npm run admin:create`.
5. Проверьте `GET http://localhost:3000/api/health`. Отдельные проверки запускаются через `npm test`.

Фотографии хранятся на диске в каталоге `uploads` (переопределяется через `UPLOADS_DIR`). При размещении сервера используйте постоянное хранилище для этого каталога. Поле `photo_path` содержит путь относительно адреса API.

## API

Все маршруты ниже имеют префикс `/api`. Закрытые маршруты принимают заголовок `Authorization: Bearer <token>`. Токен действует 2 часа. Формат ошибки — `{"error":"сообщение"}`. Списки поддерживают `limit` и `offset` (по умолчанию 20 и 0).

| Метод и путь | Входные данные или назначение |
|---|---|
| `POST /auth/register/user` | `email`, `password`, `full_name`, опционально `phone` |
| `POST /auth/register/company` | `email`, `password`, `name`, `bin`, опционально `contact_phone` |
| `POST /auth/login` | `role` (`user`, `company`, `admin`), `email`, `password`. Как и регистрация, возвращает `{token, account}` |
| `GET /me` | Текущий аккаунт |
| `GET /promotions` | Каталог действующих акций. Фильтры `q` по названию и `company_id` |
| `GET /promotions/:id`, `GET /companies/:id` | Страница акции или компании |
| `GET /promotions/:id/reviews`, `GET /companies/:id/reviews` | Публичные отзывы |
| `GET /user/dashboard` | Профиль, история участий и отзывы, жалобы с причинами решения |
| `POST /user/promotions/:id/reviews` | `multipart/form-data` с `rating`, `comment`, `photo` (JPG, PNG, WebP до 5 МиБ) |
| `POST /user/promotions/:id/reports` | `reason_type` из схемы БД и `description` от 10 символов |
| `GET /company/dashboard` | Рейтинг, число отзывов и подтверждённых жалоб, объявления, последние отзывы |
| `POST /company/promotions`, `PUT /company/promotions/:id` | `title`, `description`, `source_url` (HTTP/HTTPS), опционально `conditions`, `address`, `starts_at`, `ends_at` (ISO 8601 с часовым поясом). Изменение возвращает объявление в черновик |
| `GET /company/promotions/:id`, `DELETE /company/promotions/:id` | Чтение своего объявления и скрытие из каталога с сохранением истории |
| `POST /company/promotions/:id/submit`, `POST /company/promotions/:id/finish` | Отправка на модерацию и завершение одобренного объявления |
| `GET /admin/dashboard` | Счётчики модерации |
| `GET /admin/companies`, `GET /admin/promotions`, `GET /admin/reports` | Очереди модерации с фильтром `status`. По умолчанию `pending` для компаний и объявлений, `open` для жалоб |
| `PATCH /admin/companies/:id/status` | `status` = `approved`, `rejected` или `blocked`. БИН администратор сверяет вручную |
| `PATCH /admin/promotions/:id/status` | `status` = `approved`, `rejected` или `hidden` |
| `PATCH /admin/reports/:id/resolve` | `status` = `approved` или `rejected` и обязательный `admin_comment` |
| `GET /admin/users`, `PATCH /admin/users/:id` | Список пользователей и блокировка через булево поле `is_blocked` |

Компания создаёт черновик. После одобрения компании черновик можно отправить на модерацию. Действующие одобренные объявления появляются в каталоге. Участие и отзыв фиксируются одной транзакцией. Один пользователь может оставить один отзыв и одну жалобу на объявление, причём для жалобы достаточно доступного объявления.

В PostgreSQL `reviews.rating` принимает целые оценки от 1 до 5. Представление `v_company_stats` вычисляет среднее по всем отзывам на объявления компании, включая скрытые и завершённые, с округлением до двух знаков. Для компании без отзывов `rating` равен `null`. Три подтверждённые жалобы автоматически блокируют компанию.

## Интеграционная проверка

Создайте отдельную пустую тестовую БД, примените к ней `ebobo_2.sql`, укажите её URL в переменной `TASKER_TEST_DATABASE_URL` и запустите `npm test`. Тест создаёт демонстрационные записи, поэтому для повторного прогона используйте новую тестовую БД.
