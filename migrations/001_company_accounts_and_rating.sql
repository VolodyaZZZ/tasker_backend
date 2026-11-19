BEGIN;
ALTER TABLE companies
  ADD COLUMN email CITEXT UNIQUE,
  ADD COLUMN password_hash TEXT,
  ADD CHECK ((email IS NULL) = (password_hash IS NULL)),
  DROP COLUMN rating;

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
