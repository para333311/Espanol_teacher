-- 단어 진도 (progress 테이블의 id=2 행을 단어용으로 재사용)
INSERT OR IGNORE INTO progress (id, round, seen) VALUES (2, 1, '[]');

-- 문장/단어를 번갈아 보내기 위한 다음 발송 종류 상태 (단일 행)
CREATE TABLE IF NOT EXISTS send_state (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  next_kind TEXT NOT NULL DEFAULT 'phrase'
);

INSERT OR IGNORE INTO send_state (id, next_kind) VALUES (1, 'phrase');
