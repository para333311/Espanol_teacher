-- 시간 슬롯별 발송 기록 (중복 발송 방지)
-- 외부 스케줄러가 같은 시간에 여러 번 호출해도 한 번만 보내도록 한다.
CREATE TABLE IF NOT EXISTS sent_slots (
  slot    TEXT PRIMARY KEY,   -- 'YYYY-MM-DD-HH' (KST 기준)
  sent_at TEXT
);
