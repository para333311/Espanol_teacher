// 생활 스페인어 텔레그램 봇 — Cloudflare Worker
//
// 두 개의 진입점으로 동작한다.
//   fetch()     : 텔레그램 웹훅 수신 → 명령어 즉시 응답
//   scheduled() : Cron 트리거 → 정기 발송

import { cycleText, formatHelp, formatLesson, formatStart, formatStats, formatWord } from "./format.js";
import {
  addSubscriber,
  getLastSent,
  markClipDone,
  getProgress,
  getWordProgress,
  listSubscribers,
  pickNextContent,
  pickRandomContent,
  removeSubscriber,
  resetProgress,
  saveLastSent,
} from "./store.js";
import { Telegram } from "./telegram.js";
import { synthesizeSpanish } from "./tts.js";
import { TOTAL } from "./phrases.js";
import { WORD_TOTAL } from "./words.js";

const COMMANDS = [
  { command: "now", description: "지금 바로 한 문장 받기" },
  { command: "again", description: "아무 문장 하나 더" },
  { command: "stats", description: "학습 진도 보기" },
  { command: "reset", description: "진도 초기화" },
  { command: "stop", description: "정기 발송 중지" },
  { command: "help", description: "도움말" },
];

// ------------------------------------------------------------------ 설정
function readConfig(env) {
  return {
    token: env.TELEGRAM_BOT_TOKEN,
    secret: env.WEBHOOK_SECRET || "",
    adminKey: env.ADMIN_KEY || "",
    intervalHours: Number(env.INTERVAL_HOURS || 1),
    tz: env.TIMEZONE || "Asia/Seoul",
    quietStart: Number(env.QUIET_START_HOUR ?? 0),
    quietEnd: Number(env.QUIET_END_HOUR ?? 7),
    quietEnabled: String(env.QUIET_ENABLED ?? "true") !== "false",
    sendVoice: String(env.SEND_VOICE ?? "true") !== "false",
    // 발음 음성 말하기 속도. "+0%" 가 원어민 보통 속도이고 양수면 더 빠르다.
    voiceRate: String(env.VOICE_RATE ?? "+0%"),
    voiceName: String(env.VOICE_NAME ?? "es-MX-DaliaNeural"),
    showSpanish: String(env.SHOW_SPANISH ?? "false") === "true",
  };
}

/** 지정한 시간대의 현재 '시(0-23)'를 구한다. */
function hourInTimezone(tz) {
  try {
    const s = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    }).format(new Date());
    return Number(s) % 24;
  } catch {
    return new Date().getUTCHours();
  }
}

/** 현재 시각을 'YYYY-MM-DD-HH' 형태의 시간 슬롯 문자열로 만든다. */
function currentSlot(tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value ?? "00";
    return `${get("year")}-${get("month")}-${get("day")}-${get("hour")}`;
  } catch {
    return new Date().toISOString().slice(0, 13);
  }
}

/**
 * 이 시간 슬롯의 발송권을 선점한다.
 * INSERT 가 성공하면 이번 호출이 첫 번째라는 뜻 → 발송 진행.
 * PRIMARY KEY 충돌로 실패하면 이미 보냈다는 뜻 → 건너뜀.
 */
async function claimSlot(db, slot) {
  try {
    const r = await db
      .prepare("INSERT INTO sent_slots (slot, sent_at) VALUES (?, datetime('now'))")
      .bind(slot)
      .run();
    // D1 은 충돌 시 예외를 던지지만, 드라이버에 따라 meta 로 올 수도 있어 함께 확인
    if (r?.meta && typeof r.meta.changes === "number" && r.meta.changes === 0) {
      return false;
    }
    return true;
  } catch (e) {
    const m = (e.message || "").toLowerCase();
    if (m.includes("unique") || m.includes("constraint")) return false;
    // 예상 못한 오류라면 발송을 막지 않는다(문장을 놓치는 게 더 나쁨)
    console.warn("슬롯 선점 확인 실패, 발송은 계속합니다:", e.message);
    return true;
  }
}

function inQuietHours(cfg, hour) {
  if (!cfg.quietEnabled || cfg.quietStart === cfg.quietEnd) return false;
  if (cfg.quietStart < cfg.quietEnd) {
    return hour >= cfg.quietStart && hour < cfg.quietEnd;
  }
  return hour >= cfg.quietStart || hour < cfg.quietEnd; // 자정을 넘는 구간
}

// ------------------------------------------------------------------ 발송

/** 문장/단어 공통 발송. kind 에 따라 포맷과 발송 라벨만 갈린다. */
async function sendContent(tg, cfg, chatId, kind, content, progress) {
  const text =
    kind === "word"
      ? formatWord(content, { progress })
      : formatLesson(content, { showSpanish: cfg.showSpanish, progress });
  await tg.sendMessage(chatId, text);

  if (cfg.sendVoice) {
    const mp3 = await synthesizeSpanish(content.es, {
      rate: cfg.voiceRate,
      voice: cfg.voiceName,
    });
    if (mp3) {
      const label = kind === "word" ? content.es : content.kr;
      try {
        await tg.sendDocument(chatId, mp3, { caption: `🔊 ${label}` });
      } catch (e) {
        console.warn(`음성 전송 실패(텍스트는 전송됨): ${e.message}`);
      }
    }
  }
}

/** 차단·삭제된 채팅인지 판별해 구독 해제 대상인지 본다. */
function isDeadChat(message = "") {
  const m = message.toLowerCase();
  return (
    m.includes("blocked") ||
    m.includes("chat not found") ||
    m.includes("user is deactivated") ||
    m.includes("kicked")
  );
}

async function broadcast(env, cfg, tg) {
  const chatIds = await listSubscribers(env.DB);
  if (chatIds.length === 0) {
    console.log("등록된 채팅이 없어 발송을 건너뜁니다.");
    return { sent: 0, failed: 0 };
  }

  const { kind, content, progress } = await pickNextContent(env.DB);
  let sent = 0;
  let failed = 0;

  for (const chatId of chatIds) {
    try {
      await sendContent(tg, cfg, chatId, kind, content, progress);
      sent += 1;
    } catch (e) {
      failed += 1;
      console.error(`발송 실패 (chat ${chatId}): ${e.message}`);
      if (isDeadChat(e.description || e.message)) {
        await removeSubscriber(env.DB, chatId);
        console.log(`더 이상 보낼 수 없어 구독 해제: ${chatId}`);
      }
    }
  }

  // 클립 검색(scripts/daily_clip.py)이 /today 로 읽어가도록 방금 나간 것을 남긴다.
  if (sent > 0) {
    try {
      await saveLastSent(env.DB, kind, content);
    } catch (e) {
      console.warn("마지막 발송 기록 실패(발송은 됐음):", e.message);
    }
  }

  const label = kind === "word" ? content.es : content.kr;
  console.log(
    `발송 완료: ${sent}명 성공, ${failed}명 실패 · [${kind}] ${label} ` +
      `(${progress.done}/${progress.total}, ${progress.round}회차)`,
  );
  return { sent, failed };
}

// ------------------------------------------------------------------ 명령어

// 진도상 '이번 문장'을 소비하는 명령어. 이걸 쓴 직후엔 정기 발송을 겹쳐
// 보내지 않는다. (/again 은 진도와 무관한 랜덤이라 제외)
const LESSON_COMMANDS = new Set(["/start", "/now"]);

async function handleCommand(env, cfg, tg, chatId, text) {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase().split("@")[0];

  switch (cmd) {
    case "/start": {
      const isNew = await addSubscriber(env.DB, chatId);
      await tg.sendMessage(chatId, formatStart(cfg.intervalHours));
      if (isNew) {
        const { kind, content, progress } = await pickNextContent(env.DB);
        await sendContent(tg, cfg, chatId, kind, content, progress);
      }
      break;
    }
    case "/now": {
      await addSubscriber(env.DB, chatId);
      const { kind, content, progress } = await pickNextContent(env.DB);
      await sendContent(tg, cfg, chatId, kind, content, progress);
      break;
    }
    case "/again": {
      const { kind, content } = pickRandomContent();
      await sendContent(tg, cfg, chatId, kind, content, null);
      break;
    }
    case "/stats": {
      await addSubscriber(env.DB, chatId);
      const phrase = await getProgress(env.DB);
      const word = await getWordProgress(env.DB);
      await tg.sendMessage(
        chatId,
        formatStats(
          { done: phrase.seen.size, total: TOTAL, round: phrase.round },
          { done: word.seen.size, total: WORD_TOTAL, round: word.round },
          cfg.intervalHours,
        ),
      );
      break;
    }
    case "/reset": {
      await resetProgress(env.DB);
      await tg.sendMessage(chatId, "🔄 진도를 처음부터 다시 시작합니다!");
      break;
    }
    case "/stop": {
      await removeSubscriber(env.DB, chatId);
      await tg.sendMessage(
        chatId,
        "🛑 정기 발송을 중지했어요.\n다시 받으려면 /start 를 눌러주세요.",
      );
      break;
    }
    case "/help":
    case "/commands":
      await tg.sendMessage(chatId, formatHelp(cfg.intervalHours));
      break;
    default:
      await tg.sendMessage(
        chatId,
        "잘 모르는 명령이에요. /help 를 눌러보세요.\n바로 한 문장 받으려면 /now 👇",
      );
  }
}

/**
 * 이번 시간 문장이 아직 안 나갔으면 지금 보낸다.
 *
 * 외부 스케줄러가 멈추거나 늦어도 사용자가 봇에 말을 걸면 그 시점에
 * 밀린 문장이 따라오도록 하는 안전망. 슬롯 선점 덕분에 한 시간에
 * 한 번을 절대 넘지 않으므로 도배될 일이 없다.
 */
async function catchUpIfDue(env, cfg, tg) {
  const hour = hourInTimezone(cfg.tz);
  if (inQuietHours(cfg, hour)) return;
  const slot = currentSlot(cfg.tz);
  if (!(await claimSlot(env.DB, slot))) return;
  console.log(`밀린 발송 따라잡기: ${slot}`);
  await broadcast(env, cfg, tg);
}

/**
 * 사용자가 /now 등으로 직접 문장을 받았으면 이번 시간 몫은 채운 것으로 본다.
 * 그래야 방금 문장을 본 직후에 정기 발송이 또 날아오지 않는다.
 */
async function markSlotConsumed(env, cfg) {
  const hour = hourInTimezone(cfg.tz);
  if (inQuietHours(cfg, hour)) return;
  await claimSlot(env.DB, currentSlot(cfg.tz));
}

async function handleUpdate(env, cfg, tg, update) {
  // 봇이 채널·그룹에 추가되거나 제거될 때 구독을 자동으로 맞춘다.
  // 채널에서는 /start 를 입력할 수 없으므로 이 경로가 유일한 자동 등록 수단이다.
  if (update.my_chat_member) {
    const { chat, new_chat_member: member } = update.my_chat_member;
    const status = member?.status;
    const chatId = chat?.id;
    if (!chatId) return;

    if (status === "administrator" || status === "member") {
      const isNew = await addSubscriber(env.DB, chatId);
      console.log(`채팅 등록 [${chatId}] ${chat.title || ""} (${status})`);
      if (isNew) {
        await tg.sendMessage(
          chatId,
          "✅ 여기로 스페인어 문장을 보내겠습니다.\n" +
            `${cycleText(cfg.intervalHours)} 한 문장씩 올라갑니다.`,
        );
      }
    } else if (status === "left" || status === "kicked") {
      await removeSubscriber(env.DB, chatId);
      console.log(`채팅 해제 [${chatId}] (${status})`);
    }
    return;
  }

  // 채널 글은 message 가 아니라 channel_post 로 들어온다
  const msg =
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post;
  if (!msg) return;

  const chatId = msg.chat?.id;
  const text = (msg.text || "").trim();
  if (!chatId || !text) return;

  const isChannel = msg.chat?.type === "channel";
  console.log(`수신 [${chatId}]${isChannel ? "(채널)" : ""}: ${text}`);

  // 말을 건 사람은 어떤 메시지든 자동 등록해서 /start 를 놓쳐도 받을 수 있게 한다
  await addSubscriber(env.DB, chatId);

  const cmd = text.split(/\s+/)[0].toLowerCase().split("@")[0];

  if (text.startsWith("/")) {
    await handleCommand(env, cfg, tg, chatId, text);
  } else if (!isChannel) {
    // 채널에서는 사람이 쓴 글마다 안내를 붙이면 방해가 되므로 조용히 넘어간다
    await tg.sendMessage(
      chatId,
      "👋 문장을 받으려면 /now,\n도움말은 /help 를 눌러주세요.",
    );
  }

  // 방금 문장을 받았으면 이번 시간 몫은 채운 것으로 처리하고,
  // 그렇지 않으면 밀린 문장이 있는지 확인해 따라잡는다.
  try {
    if (LESSON_COMMANDS.has(cmd)) {
      await markSlotConsumed(env, cfg);
    } else {
      await catchUpIfDue(env, cfg, tg);
    }
  } catch (e) {
    console.warn("슬롯 처리 실패:", e.message);
  }
}

// ------------------------------------------------------------------ 진입점
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cfg = readConfig(env);

    if (!cfg.token) {
      return new Response("TELEGRAM_BOT_TOKEN 이 설정되지 않았습니다.", {
        status: 500,
      });
    }
    const tg = new Telegram(cfg.token);

    // --- 텔레그램 웹훅 수신 ---
    if (url.pathname === "/webhook" && request.method === "POST") {
      if (
        cfg.secret &&
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== cfg.secret
      ) {
        return new Response("forbidden", { status: 403 });
      }
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("bad request", { status: 400 });
      }
      // 텔레그램에는 즉시 200을 주고 처리는 뒤에서 이어간다(타임아웃 방지)
      ctx.waitUntil(
        handleUpdate(env, cfg, tg, update).catch((e) =>
          console.error("업데이트 처리 오류:", e.stack || e.message),
        ),
      );
      return new Response("ok");
    }

    // --- 관리용 엔드포인트 (ADMIN_KEY 필요) ---
    const isAdmin = cfg.adminKey && url.searchParams.get("key") === cfg.adminKey;

    if (url.pathname === "/setup") {
      if (!isAdmin) return new Response("forbidden", { status: 403 });
      const hookUrl = `${url.origin}/webhook`;
      const hook = await tg.setWebhook(hookUrl, cfg.secret);
      await tg.setMyCommands(COMMANDS);
      const me = await tg.getMe();
      return Response.json({
        ok: true,
        bot: me.username,
        webhook: hookUrl,
        result: hook,
      });
    }

    // 오늘 나간 문장. 로컬 PC 의 scripts/daily_clip.py 가 읽어
    // 그 문장이 나오는 유튜브 클립을 찾아 영상으로 뒤따라 보낸다.
    if (url.pathname === "/today") {
      if (!isAdmin) return new Response("forbidden", { status: 403 });
      const [last, subs] = await Promise.all([
        getLastSent(env.DB),
        listSubscribers(env.DB),
      ]);
      if (!last) return Response.json({ ok: false, reason: "발송 기록 없음" });
      return Response.json({ ok: true, ...last, targets: subs });
    }

    // 로컬 PC(scripts/daily_clip.py)가 찾아 잘라 온 클립을 구독자 전원에게
    // 보낸다. 유튜브가 GitHub 러너 IP 를 봇으로 막아(2026-09-02) 클립 작업은
    // 집 PC 에서 돌고, 봇 토큰은 여기만 갖고 있으니 전송은 워커가 맡는다.
    //   multipart: video(mp4, 선택) · caption · text(영상 없을 때 보낼 한 줄)
    // 보내고 나면 오늘 것 처리됨(clip_sent)으로 표시해 두 번 보내지 않는다.
    if (url.pathname === "/clip" && request.method === "POST") {
      if (!isAdmin) return new Response("forbidden", { status: 403 });
      const form = await request.formData();
      const video = form.get("video");
      const caption = String(form.get("caption") || "");
      const text = String(form.get("text") || "");
      const bytes = video && typeof video !== "string" ? await video.arrayBuffer() : null;
      if (!bytes && !text) return Response.json({ ok: false, reason: "video 또는 text 필요" });
      const subs = await listSubscribers(env.DB);
      let sent = 0;
      const errors = [];
      for (const chatId of subs) {
        try {
          if (bytes) await tg.sendVideo(chatId, bytes, { caption });
          else await tg.sendMessage(chatId, text);
          sent += 1;
        } catch (e) {
          errors.push(`${chatId}: ${e.message}`);
        }
      }
      if (sent > 0) await markClipDone(env.DB);
      return Response.json({ ok: sent > 0, sent, errors });
    }

    if (url.pathname === "/status") {
      if (!isAdmin) return new Response("forbidden", { status: 403 });
      const [me, hook, subs, prog, wordProg] = await Promise.all([
        tg.getMe(),
        tg.getWebhookInfo(),
        listSubscribers(env.DB),
        getProgress(env.DB),
        getWordProgress(env.DB),
      ]);
      // 각 수신처가 채널인지 개인 대화인지 보여준다.
      // 채널로 옮긴 뒤 개인 알림이 남아 있는지 한눈에 확인하기 위함이다.
      const targets = await Promise.all(
        subs.map(async (id) => {
          try {
            const chat = await tg.getChat(id);
            const kind =
              chat.type === "channel"
                ? "채널"
                : chat.type === "private"
                  ? "개인"
                  : chat.type;
            return { chat_id: String(id), kind, title: chat.title || chat.username || "" };
          } catch (e) {
            return { chat_id: String(id), kind: "확인불가", error: e.description || e.message };
          }
        }),
      );

      return Response.json({
        bot: me.username,
        webhook_url: hook.url,
        pending_updates: hook.pending_update_count,
        last_error: hook.last_error_message || null,
        subscribers: subs.length,
        targets,
        progress: `문장 ${prog.seen.size}/${TOTAL} (${prog.round}회차) · 단어 ${wordProg.seen.size}/${WORD_TOTAL} (${wordProg.round}회차)`,
        interval_hours: cfg.intervalHours,
        quiet: cfg.quietEnabled
          ? `${cfg.quietStart}시~${cfg.quietEnd}시`
          : "사용 안 함",
        now_hour_kst: hourInTimezone(cfg.tz),
        send_voice: cfg.sendVoice,
      });
    }

    // 발송 대상 관리.
    //   GET /subs                    → 현재 대상 목록 (제목·유형 포함)
    //   GET /subs?add=@채널이름      → 대상 추가
    //   GET /subs?remove=<chat_id>   → 대상 제거 (알림 끄기)
    //   GET /subs?only=<chat_id>     → 이것만 남기고 나머지 전부 해제
    if (url.pathname === "/subs") {
      if (!isAdmin) return new Response("forbidden", { status: 403 });

      const add = url.searchParams.get("add");
      const remove = url.searchParams.get("remove");
      const only = url.searchParams.get("only");
      const actions = [];

      if (add) {
        // 채널 이름(@name)이든 숫자 id 든 getChat 으로 실체를 확인한 뒤 등록한다.
        try {
          const chat = await tg.getChat(add);
          await addSubscriber(env.DB, chat.id);
          actions.push({
            added: String(chat.id),
            title: chat.title || chat.username || null,
            type: chat.type,
          });
        } catch (e) {
          return Response.json(
            {
              ok: false,
              error: `추가 실패: ${e.message}`,
              hint: "채널에 봇을 관리자로 초대했는지, 이름을 @포함해 정확히 넣었는지 확인해주세요.",
            },
            { status: 400 },
          );
        }
      }

      if (remove) {
        await removeSubscriber(env.DB, remove);
        actions.push({ removed: String(remove) });
      }

      if (only) {
        // 지정한 대상만 남긴다. 오타로 전체가 꺼지는 걸 막기 위해
        // 먼저 대상을 등록해 두고, 그 외를 해제한다.
        await addSubscriber(env.DB, only);
        const current = await listSubscribers(env.DB);
        for (const id of current) {
          if (String(id) !== String(only)) {
            await removeSubscriber(env.DB, id);
            actions.push({ removed: String(id) });
          }
        }
        actions.push({ kept: String(only) });
      }

      // 남은 대상들의 실제 정보를 붙여서 돌려준다
      const ids = await listSubscribers(env.DB);
      const targets = await Promise.all(
        ids.map(async (id) => {
          try {
            const c = await tg.getChat(id);
            return {
              chat_id: String(id),
              type: c.type,
              title: c.title || c.username || c.first_name || null,
            };
          } catch (e) {
            return { chat_id: String(id), error: e.message };
          }
        }),
      );

      return Response.json({ ok: true, actions, count: ids.length, targets });
    }

    // 조용한 시간을 무시하고 무조건 발송 (테스트용)
    // 특정 수신처만 끄기/켜기. 채널로 옮긴 뒤 개인 알림을 정리할 때 쓴다.
    //   /unsubscribe?key=...&chat_id=123456   개인 알림 끄기
    //   /unsubscribe?key=...&chat_id=123456&on=1   다시 켜기
    if (url.pathname === "/unsubscribe") {
      if (!isAdmin) return new Response("forbidden", { status: 403 });

      const chatId = url.searchParams.get("chat_id");
      if (!chatId) {
        return Response.json(
          { ok: false, error: "chat_id 가 필요합니다." },
          { status: 400 },
        );
      }

      const turnOn = url.searchParams.get("on") === "1";
      if (turnOn) {
        await addSubscriber(env.DB, chatId);
      } else {
        await removeSubscriber(env.DB, chatId);
      }

      const remaining = await listSubscribers(env.DB);
      return Response.json({
        ok: true,
        chat_id: chatId,
        active: turnOn,
        remaining: remaining.length,
      });
    }

    // 즉시 발송. ?rate=+20% 처럼 음성 속도를 그때그때 지정해
    // 어느 속도가 편한지 직접 들어보고 고를 수 있다.
    if (url.pathname === "/send" && isAdmin) {
      const rate = url.searchParams.get("rate");
      const voice = url.searchParams.get("voice");
      const override = {
        ...cfg,
        ...(rate ? { voiceRate: rate } : {}),
        ...(voice ? { voiceName: voice } : {}),
      };
      const res = await broadcast(env, override, tg);
      return Response.json({
        ok: true,
        rate: override.voiceRate,
        voice: override.voiceName,
        ...res,
      });
    }

    // 외부 스케줄러가 매시간 호출하는 정기 발송 엔드포인트.
    // 스케줄러가 멈추거나 Cloudflare Cron 트리거가 늦어도 이 경로로 수동
    // 발송을 밀어 넣거나 별도 스케줄러를 추가로 붙일 수 있다.
    //
    // 일부러 키를 요구하지 않는다. 아래 두 가지 때문에 안전하다.
    //   1. 시간 슬롯 선점(sent_slots) 때문에 한 시간에 최대 한 번만 발송된다.
    //      즉 아무리 많이 호출해도 문장이 빨리 소모되거나 도배되지 않는다.
    //   2. 응답에 슬롯 정보 외에 어떤 데이터도 담기지 않는다.
    // 대신 스케줄러 쪽에 비밀값을 넣을 필요가 없어져서 설정이 훨씬 단순해진다.
    if (url.pathname === "/cron") {
      const hour = hourInTimezone(cfg.tz);
      if (inQuietHours(cfg, hour)) {
        return Response.json({
          ok: true,
          skipped: "quiet_hours",
          hour,
        });
      }

      // 스케줄러가 여러 번 호출해도 같은 시간엔 한 번만 보낸다
      const slot = currentSlot(cfg.tz);
      if (!(await claimSlot(env.DB, slot))) {
        return Response.json({ ok: true, skipped: "already_sent", slot });
      }

      const res = await broadcast(env, cfg, tg);
      return Response.json({ ok: true, slot, ...res });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "🇪🇸 생활 스페인어 텔레그램 봇이 돌아가고 있습니다.\n" +
          "텔레그램에서 봇에게 /start 를 보내보세요.",
        { headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }

    return new Response("not found", { status: 404 });
  },

  // --- Cron 정기 발송 ---
  async scheduled(event, env, ctx) {
    const cfg = readConfig(env);
    if (!cfg.token) {
      console.error("TELEGRAM_BOT_TOKEN 이 없어 발송을 건너뜁니다.");
      return;
    }

    const hour = hourInTimezone(cfg.tz);
    if (inQuietHours(cfg, hour)) {
      console.log(`조용한 시간(${hour}시)이라 이번 발송을 건너뜁니다.`);
      return;
    }

    const tg = new Telegram(cfg.token);
    ctx.waitUntil(
      broadcast(env, cfg, tg).catch((e) =>
        console.error("정기 발송 오류:", e.stack || e.message),
      ),
    );
  },
};
