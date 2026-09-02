-- 오늘 것에 대한 클립 영상이 나갔는지. 로컬 PC 의 daily_clip.py 가 여러 번
-- 떠도(예약작업 재시도) 한 번만 보낸다.
-- for_sent_at 이 last_sent.sent_at 과 같을 때만 '오늘 것 처리됨'으로 본다.
-- (배포마다 이 파일이 다시 실행되니 ALTER 가 아니라 IF NOT EXISTS 여야 한다)
CREATE TABLE IF NOT EXISTS clip_sent (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  for_sent_at TEXT NOT NULL,
  clip_at TEXT NOT NULL
);
