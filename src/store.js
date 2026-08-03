// D1 저장소 계층 — 구독자와 학습 진도를 보관한다.

import { PHRASES, TOTAL } from "./phrases.js";
import { WORDS, WORD_TOTAL } from "./words.js";

/** 구독자 등록. 이미 있으면 다시 활성화만 한다. @returns {boolean} 신규 여부 */
export async function addSubscriber(db, chatId) {
  const row = await db
    .prepare("SELECT chat_id, active FROM subscribers WHERE chat_id = ?")
    .bind(String(chatId))
    .first();

  if (row) {
    if (row.active === 1) return false;
    await db
      .prepare("UPDATE subscribers SET active = 1 WHERE chat_id = ?")
      .bind(String(chatId))
      .run();
    return true;
  }

  await db
    .prepare(
      "INSERT INTO subscribers (chat_id, active, created_at) VALUES (?, 1, datetime('now'))",
    )
    .bind(String(chatId))
    .run();
  return true;
}

export async function removeSubscriber(db, chatId) {
  await db
    .prepare("UPDATE subscribers SET active = 0 WHERE chat_id = ?")
    .bind(String(chatId))
    .run();
}

export async function listSubscribers(db) {
  const { results } = await db
    .prepare("SELECT chat_id FROM subscribers WHERE active = 1")
    .all();
  return (results ?? []).map((r) => r.chat_id);
}

// ------------------------------------------------------------ 진도 (공통)
//
// progress 테이블은 id 로 콘텐츠 종류를 구분해 재사용한다: 1=문장, 2=단어.
// 두 콘텐츠는 총 개수가 다를 뿐 "안 본 것 중 무작위 하나, 다 보면 회차 증가"
// 로직이 동일해서 id/total/pool 만 바꿔 공유한다.

async function readProgressRow(db, id, total) {
  const row = await db
    .prepare("SELECT round, seen FROM progress WHERE id = ?")
    .bind(id)
    .first();

  if (!row) {
    await db
      .prepare("INSERT INTO progress (id, round, seen) VALUES (?, 1, '[]')")
      .bind(id)
      .run();
    return { round: 1, seen: new Set() };
  }

  let seen = [];
  try {
    seen = JSON.parse(row.seen || "[]");
  } catch {
    seen = [];
  }
  // 목록이 줄어든 경우를 대비해 유효 범위만 남긴다
  const valid = seen.filter((i) => Number.isInteger(i) && i >= 0 && i < total);
  return { round: row.round || 1, seen: new Set(valid) };
}

async function writeProgressRow(db, id, round, seenSet) {
  await db
    .prepare("UPDATE progress SET round = ?, seen = ? WHERE id = ?")
    .bind(round, JSON.stringify([...seenSet]), id)
    .run();
}

async function pickNextFrom(db, id, total, pool) {
  let { round, seen } = await readProgressRow(db, id, total);

  let remaining = [];
  for (let i = 0; i < total; i++) if (!seen.has(i)) remaining.push(i);

  if (remaining.length === 0) {
    seen = new Set();
    round += 1;
    remaining = Array.from({ length: total }, (_, i) => i);
  }

  const idx = remaining[Math.floor(Math.random() * remaining.length)];
  seen.add(idx);
  await writeProgressRow(db, id, round, seen);

  return { item: pool[idx], progress: { done: seen.size, total, round } };
}

// ------------------------------------------------------------ 문장 진도 (id=1)
export async function getProgress(db) {
  return readProgressRow(db, 1, TOTAL);
}

export async function pickNextPhrase(db) {
  const { item, progress } = await pickNextFrom(db, 1, TOTAL, PHRASES);
  return { phrase: item, progress };
}

// ------------------------------------------------------------ 단어 진도 (id=2)
export async function getWordProgress(db) {
  return readProgressRow(db, 2, WORD_TOTAL);
}

export async function pickNextWord(db) {
  const { item, progress } = await pickNextFrom(db, 2, WORD_TOTAL, WORDS);
  return { word: item, progress };
}

// --------------------------------------------------- 문장 ↔ 단어 교대 발송
//
// 정기 발송과 /start·/now 는 매번 문장과 단어를 번갈아 보낸다.
// send_state 테이블에 "다음엔 뭘 보낼지"만 1행으로 저장해두고 매번 뒤집는다.
async function nextKind(db) {
  const row = await db
    .prepare("SELECT next_kind FROM send_state WHERE id = 1")
    .first();
  const kind = row?.next_kind === "word" ? "word" : "phrase";
  const flip = kind === "phrase" ? "word" : "phrase";
  await db
    .prepare(
      "INSERT INTO send_state (id, next_kind) VALUES (1, ?) " +
        "ON CONFLICT(id) DO UPDATE SET next_kind = excluded.next_kind",
    )
    .bind(flip)
    .run();
  return kind;
}

/** 진도를 소비하며 문장/단어를 번갈아 하나 고른다. */
export async function pickNextContent(db) {
  const kind = await nextKind(db);
  if (kind === "word") {
    const { word, progress } = await pickNextWord(db);
    return { kind: "word", content: word, progress };
  }
  const { phrase, progress } = await pickNextPhrase(db);
  return { kind: "phrase", content: phrase, progress };
}

/** 진도에 영향 주지 않는 무작위 콘텐츠(문장 또는 단어) 1개. */
export function pickRandomContent() {
  if (Math.random() < 0.5) {
    return { kind: "word", content: WORDS[Math.floor(Math.random() * WORD_TOTAL)] };
  }
  return { kind: "phrase", content: PHRASES[Math.floor(Math.random() * TOTAL)] };
}

export async function resetProgress(db) {
  await db
    .prepare("UPDATE progress SET round = 1, seen = '[]' WHERE id IN (1, 2)")
    .run();
}
