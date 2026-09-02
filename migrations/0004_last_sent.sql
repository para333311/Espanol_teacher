-- 마지막으로 발송한 콘텐츠. 로컬 PC 의 scripts/daily_clip.py 가 /today 로 읽어
-- 그 문장이 나오는 유튜브 클립을 찾아 영상으로 뒤따라 보낸다.
CREATE TABLE IF NOT EXISTS last_sent (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  kind TEXT NOT NULL,
  content_json TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
