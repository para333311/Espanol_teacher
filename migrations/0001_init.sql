-- 구독자 목록
CREATE TABLE IF NOT EXISTS subscribers (
  chat_id    TEXT PRIMARY KEY,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_subscribers_active ON subscribers (active);

-- 학습 진도 (단일 행: id = 1)
CREATE TABLE IF NOT EXISTS progress (
  id    INTEGER PRIMARY KEY,
  round INTEGER NOT NULL DEFAULT 1,
  seen  TEXT    NOT NULL DEFAULT '[]'
);

INSERT OR IGNORE INTO progress (id, round, seen) VALUES (1, 1, '[]');
