-- 오늘 것에 대한 클립 영상이 나갔는지. daily-clip.yml 이 워커의 즉시 호출과
-- GitHub 예약(예비) 두 경로로 뜨므로, 둘 다 떠도 한 번만 보낸다.
-- for_sent_at 이 last_sent.sent_at 과 같을 때만 '오늘 것 처리됨'으로 본다.
-- (배포마다 이 파일이 다시 실행되니 ALTER 가 아니라 IF NOT EXISTS 여야 한다)
CREATE TABLE IF NOT EXISTS clip_sent (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  for_sent_at TEXT NOT NULL,
  clip_at TEXT NOT NULL
);
