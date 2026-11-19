BEGIN;

-- =====================================================================
-- ЧАСТЬ 1. СХЕМА
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ===== Типы =====
CREATE TYPE user_role        AS ENUM ('user', 'company', 'admin');
CREATE TYPE company_status   AS ENUM ('pending', 'approved', 'rejected', 'blocked');
CREATE TYPE promotion_status AS ENUM ('draft', 'pending', 'approved', 'rejected', 'hidden', 'finished');
CREATE TYPE report_status    AS ENUM ('open', 'approved', 'rejected');

-- Причины жалобы (русские подписи хранятся на фронте)
CREATE TYPE report_reason_type AS ENUM (
  'impossible_requirements',   -- Невыполнимые требования
  'personal_data_collection',  -- Сбор личных данных
  'suspected_fraud',           -- Подозрение на мошенничество
  'branch_closed_or_missing',  -- Филиал закрыт или не существует
  'wrong_reward_info',         -- Не правильно указана награда
  'other'                      -- Другое
);

-- ===== Пользователи =====
CREATE TABLE users (
  id             INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email          CITEXT       NOT NULL UNIQUE,
  password_hash  TEXT         NOT NULL,
  role           user_role    NOT NULL DEFAULT 'user',
  full_name      VARCHAR(150) NOT NULL,
  phone          VARCHAR(20),
  is_blocked     BOOLEAN      NOT NULL DEFAULT FALSE
);

-- ===== Компании =====
CREATE TABLE companies (
  id            INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          VARCHAR(200)   NOT NULL,
  bin           CHAR(12)       NOT NULL UNIQUE CHECK (bin ~ '^[0-9]{12}$'),
  contact_phone VARCHAR(20),
  email         CITEXT       UNIQUE,
  password_hash TEXT,
  CHECK ((email IS NULL) = (password_hash IS NULL)),
  status        company_status NOT NULL DEFAULT 'pending'
);

-- ===== Акции / челленджи =====
-- Само задание — в description, условия выполнения — в conditions.
CREATE TABLE promotions (
  id            INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    INT              NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title         VARCHAR(200)     NOT NULL,
  description   TEXT             NOT NULL,
  conditions    TEXT,
  address       TEXT,
  source_url    TEXT             NOT NULL,
  status        promotion_status NOT NULL DEFAULT 'draft',
  starts_at     TIMESTAMPTZ,
  ends_at       TIMESTAMPTZ,
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);

-- ===== Участие =====
-- Запись есть только если пользователь поучаствовал, поэтому статуса нет.
CREATE TABLE participations (
  id            INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       INT          NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  promotion_id  INT          NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  joined_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (user_id, promotion_id)
);

-- ===== Жалобы =====
-- Пожаловаться может любой пользователь (участие в акции не требуется).
-- Решение админа (approved / rejected) обязательно с объяснением.
CREATE TABLE reports (
  id             INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  promotion_id   INT                NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  reporter_id    INT                NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  reason_type    report_reason_type NOT NULL,
  description    TEXT               NOT NULL CHECK (char_length(btrim(description)) >= 10),
  status         report_status      NOT NULL DEFAULT 'open',
  admin_comment  TEXT,
  resolved_by    INT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ        NOT NULL DEFAULT now(),
  UNIQUE (promotion_id, reporter_id),
  CHECK (status = 'open'
         OR (admin_comment IS NOT NULL AND char_length(btrim(admin_comment)) > 0
             AND resolved_at IS NOT NULL))
);

-- Автоблокировка: 3 жалобы, подтверждённые админом (status = 'approved'),
-- на акции одной компании -> компания получает статус 'blocked'.
CREATE OR REPLACE FUNCTION block_company_on_approved_reports() RETURNS trigger AS $$
DECLARE
  v_company_id INT;
  v_cnt        INT;
BEGIN
  SELECT company_id INTO v_company_id FROM promotions WHERE id = NEW.promotion_id;

  PERFORM 1 FROM companies WHERE id = v_company_id FOR NO KEY UPDATE;

  SELECT count(*) INTO v_cnt
  FROM reports r
  JOIN promotions p ON p.id = r.promotion_id
  WHERE p.company_id = v_company_id AND r.status = 'approved';

  IF v_cnt >= 3 THEN
    UPDATE companies SET status = 'blocked'
    WHERE id = v_company_id AND status <> 'blocked';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reports_autoblock
  AFTER UPDATE OF status ON reports
  FOR EACH ROW
  WHEN (NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved')
  EXECUTE FUNCTION block_company_on_approved_reports();

-- ===== Отзывы (с фото участия) =====
CREATE TABLE reviews (
  id                INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  participation_id  INT          NOT NULL UNIQUE REFERENCES participations(id) ON DELETE CASCADE,
  rating            SMALLINT     NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment           TEXT,
  photo_path        TEXT         NOT NULL CHECK (photo_path ~* '\.(jpg|jpeg|png|webp)$'),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ===== Представление: отзывы со всеми связями =====
CREATE VIEW v_reviews AS
SELECT r.id, r.rating, r.comment, r.photo_path, r.created_at,
       pt.user_id,
       u.full_name AS author_name,
       p.id        AS promotion_id,
       p.title     AS promotion_title,
       p.company_id
FROM reviews r
JOIN participations pt ON pt.id = r.participation_id
JOIN promotions p      ON p.id  = pt.promotion_id
JOIN users u           ON u.id  = pt.user_id;

-- ===== Индексы =====
CREATE INDEX idx_promotions_status     ON promotions (status);
CREATE INDEX idx_promotions_company    ON promotions (company_id);
CREATE INDEX idx_participations_promo  ON participations (promotion_id);
CREATE INDEX idx_participations_user   ON participations (user_id);
CREATE INDEX idx_reports_status        ON reports (status);
CREATE INDEX idx_companies_status      ON companies (status);

-- Live aggregates include all reviews and approved reports across company promotions.
CREATE VIEW v_company_stats AS
SELECT c.id AS company_id,
       round(avg(r.rating), 2)::double precision AS rating,
       count(r.id)::integer AS review_count,
       (SELECT count(*)::integer
        FROM reports rp JOIN promotions p ON p.id = rp.promotion_id
        WHERE p.company_id = c.id AND rp.status = 'approved') AS approved_report_count
FROM companies c
LEFT JOIN v_reviews r ON r.company_id = c.id
GROUP BY c.id;

CREATE INDEX idx_reports_promotion ON reports (promotion_id);

COMMIT;
