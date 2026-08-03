// 텔레그램 Bot API 래퍼 (Cloudflare Workers 용)

const API_ROOT = "https://api.telegram.org";

export class Telegram {
  constructor(token) {
    if (!token) throw new Error("봇 토큰이 없습니다.");
    this.token = token;
  }

  get base() {
    return `${API_ROOT}/bot${this.token}`;
  }

  async call(method, payload) {
    const res = await fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) {
      const desc = body.description || `HTTP ${res.status}`;
      const err = new Error(`${method} 실패: ${desc}`);
      err.description = desc;
      err.code = res.status;
      throw err;
    }
    return body.result;
  }

  getMe() {
    return this.call("getMe");
  }

  sendMessage(chatId, text) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }

  /**
   * 발음 음성 전송.
   *
   * sendVoice(파형 말풍선)와 sendAudio(오디오 플레이어) 둘 다 텔레그램이
   * 같은 채팅의 재생 가능한 미디어를 하나의 재생목록으로 묶어서, 중간
   * 메시지를 눌러도 그 뒤의 관련 없는 메시지까지 이어 재생해버린다
   * (실사용 확인 결과 sendAudio 도 동일 현상). 일반 파일(document)로
   * 보내면 이 재생목록 대상이 아니라서 누른 것만 재생된다.
   */
  async sendDocument(chatId, mp3Bytes, { caption = "" } = {}) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) {
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
    }
    form.append(
      "document",
      new Blob([mp3Bytes], { type: "audio/mpeg" }),
      "pron.mp3",
    );

    const res = await fetch(`${this.base}/sendDocument`, {
      method: "POST",
      body: form,
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) {
      throw new Error(`sendDocument 실패: ${body.description || res.status}`);
    }
    return body.result;
  }

  setWebhook(url, secretToken) {
    return this.call("setWebhook", {
      url,
      secret_token: secretToken,
      // channel_post 를 받아야 채널에 쓴 글에도 반응할 수 있다.
      // (채널 글은 message 가 아니라 channel_post 로 들어온다)
      allowed_updates: ["message", "channel_post", "my_chat_member"],
      drop_pending_updates: false,
    });
  }

  /** 채팅 정보 조회 (채널 제목·유형 확인용) */
  getChat(chatId) {
    return this.call("getChat", { chat_id: String(chatId) });
  }

  deleteWebhook() {
    return this.call("deleteWebhook", {});
  }

  getWebhookInfo() {
    return this.call("getWebhookInfo");
  }

  setMyCommands(commands) {
    return this.call("setMyCommands", { commands });
  }
}
