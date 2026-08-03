// 스페인어 발음 음성 생성.
//
// 두 개의 제공자를 순서대로 시도한다.
//   1. Edge TTS  — 뉴럴 음성, 말하기 속도 조절 가능 (기본)
//   2. Google 번역 TTS — 위가 실패했을 때의 대비책
//
// 음성은 부가 기능이므로 둘 다 실패하면 null 만 돌려주고 본 흐름을 막지 않는다.
//
// 왜 Edge TTS 를 먼저 쓰나:
// Google 번역 TTS 의 ttsspeed 파라미터는 1 을 넘겨도 서버가 무시한다
// (여러 값으로 받아본 mp3 가 바이트 단위로 동일). 즉 "느리게"만 되고
// "원어민 속도"로는 못 올린다. Edge TTS 는 SSML 의 rate 가 실제로 반영되고
// 뉴럴 음성이라 발음도 더 자연스럽다.

// ------------------------------------------------------------ Edge TTS
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
// Workers 의 fetch 는 wss:// 스킴을 받지 않는다. https:// 로 요청하고
// Upgrade: websocket 헤더로 승격시켜야 한다.
const EDGE_WSS =
  "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1" +
  `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;

const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;

// Windows 파일시간 에폭(1601-01-01)과 유닉스 에폭의 차이(초)
const WIN_EPOCH = 11644473600;

const EDGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  `(KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 ` +
  `Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`;

/**
 * Edge TTS 가 요구하는 Sec-MS-GEC 토큰을 만든다.
 *
 * 현재 시각을 5분 단위로 내림한 Windows 파일시간(100나노초 단위)에
 * 고정 토큰을 이어붙여 SHA-256 을 구한 뒤 대문자 hex 로 돌려준다.
 */
async function generateSecMsGec() {
  let ticks = Math.floor(Date.now() / 1000) + WIN_EPOCH;
  ticks -= ticks % 300; // 5분 단위로 내림
  // 초 → 100나노초 단위. 2^53 를 넘기므로 BigInt 로 계산한다.
  const value = BigInt(ticks) * 10000000n;
  const data = new TextEncoder().encode(`${value}${TRUSTED_CLIENT_TOKEN}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** SSML 에 들어갈 텍스트를 이스케이프한다. */
function escapeSsml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function randomHex32() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Edge TTS 바이너리 프레임에서 오디오 부분만 떼어낸다.
 *
 * 프레임 구조: [2바이트 헤더길이(big-endian)][헤더][오디오]
 * 오디오는 (2 + 헤더길이) 위치에서 시작한다.
 */
function extractAudio(bytes) {
  if (bytes.length < 2) return null;
  const headerLength = (bytes[0] << 8) | bytes[1];
  const start = 2 + headerLength;
  if (headerLength <= 0 || start >= bytes.length) return null;

  // 오디오 프레임인지 헤더로 확인한다 (turn.start 등 제어 프레임 제외)
  const header = new TextDecoder().decode(bytes.subarray(2, start));
  if (!header.includes("Path:audio")) return null;

  return bytes.subarray(start);
}

/**
 * Edge TTS(WebSocket)로 mp3 를 받아온다.
 *
 * @param {string} text 스페인어 원문
 * @param {object} opts
 * @param {string} opts.voice SSML 음성 이름
 * @param {string} opts.rate  SSML rate (예: "+0%", "+25%")
 * @param {number} opts.timeoutMs 전체 제한 시간
 * @returns {Promise<Uint8Array|null>}
 */
async function synthesizeWithEdge(text, { voice, rate, timeoutMs = 12000 }) {
  const gec = await generateSecMsGec();
  const url =
    `${EDGE_WSS}&Sec-MS-GEC=${gec}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${randomHex32()}`;

  // Workers 는 fetch + Upgrade 헤더로 WebSocket 을 연다.
  const res = await fetch(url, {
    headers: {
      Upgrade: "websocket",
      "User-Agent": EDGE_UA,
      Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
    },
  });

  const ws = res.webSocket;
  if (!ws) {
    throw new Error(`WebSocket 승격 실패 (status ${res.status})`);
  }
  ws.accept();

  return await new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      finish(new Error("Edge TTS 응답 시간 초과"));
    }, timeoutMs);

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* 이미 닫혔으면 무시 */
      }
      err ? reject(err) : resolve(value);
    }

    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        // 텍스트 프레임: turn.start / turn.end 같은 제어 메시지
        if (ev.data.includes("Path:turn.end")) {
          if (!chunks.length) return finish(new Error("오디오 데이터 없음"));
          let total = 0;
          for (const c of chunks) total += c.length;
          const out = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) {
            out.set(c, off);
            off += c.length;
          }
          finish(null, out);
        }
        return;
      }

      // 바이너리 프레임: [2바이트 헤더길이][헤더][오디오]
      const audio = extractAudio(new Uint8Array(ev.data));
      if (audio && audio.length) chunks.push(audio);
    });

    ws.addEventListener("error", () => finish(new Error("WebSocket 오류")));
    ws.addEventListener("close", () => {
      // turn.end 없이 닫히면 실패로 본다
      finish(new Error("연결이 먼저 닫힘"));
    });

    const reqId = randomHex32();
    const ts = new Date().toString();

    ws.send(
      `X-Timestamp:${ts}\r\n` +
        "Content-Type:application/json; charset=utf-8\r\n" +
        "Path:speech.config\r\n\r\n" +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: {
                  sentenceBoundaryEnabled: "false",
                  wordBoundaryEnabled: "false",
                },
                outputFormat: "audio-24khz-48kbitrate-mono-mp3",
              },
            },
          },
        }),
    );

    ws.send(
      `X-RequestId:${reqId}\r\n` +
        "Content-Type:application/ssml+xml\r\n" +
        `X-Timestamp:${ts}Z\r\n` +
        "Path:ssml\r\n\r\n" +
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='es-ES'>` +
        `<voice name='${voice}'>` +
        `<prosody rate='${rate}' pitch='+0Hz'>${escapeSsml(text)}</prosody>` +
        `</voice></speak>`,
    );
  });
}

// -------------------------------------------------- Google 번역 TTS (대비책)
const GOOGLE_TTS_URL = "https://translate.google.com/translate_tts";

const GOOGLE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Referer: "https://translate.google.com/",
};

/**
 * Google 번역 TTS 로 mp3 를 받아온다.
 *
 * 속도는 올릴 수 없지만(서버가 ttsspeed>1 을 무시함) 구두점을 빼면
 * 문장 중간·끝의 긴 정지가 사라져 체감 속도가 눈에 띄게 빨라진다.
 */
async function synthesizeWithGoogle(text, { trimPauses = true } = {}) {
  const q = trimPauses ? stripPausePunctuation(text) : text;

  const params = new URLSearchParams({
    ie: "UTF-8",
    q,
    tl: "es",
    client: "tw-ob",
    total: "1",
    idx: "0",
    textlen: String(q.length),
  });

  const res = await fetch(`${GOOGLE_TTS_URL}?${params}`, {
    headers: GOOGLE_HEADERS,
  });
  if (!res.ok) throw new Error(`응답 코드 ${res.status}`);

  const type = res.headers.get("content-type") || "";
  if (!type.startsWith("audio")) throw new Error(`오디오가 아님: ${type}`);

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength < 512) {
    throw new Error(`응답이 비정상적으로 작음(${buf.byteLength} bytes)`);
  }
  return buf;
}

/**
 * 발화를 멈추게 하는 구두점을 없앤다.
 *
 * 스페인어 문장부호(¿¡.,;:!?…)는 Google TTS 에서 정지를 만든다.
 * 뜻은 그대로이므로 빼는 편이 따라 말하기에 낫다.
 */
function stripPausePunctuation(text) {
  return String(text)
    .replace(/[¿¡.,;:!?…‥・]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ------------------------------------------------------------------ 공개 API

/** rate 옵션 값을 SSML 이 받는 형식("+25%")으로 정규화한다. */
function normalizeRate(rate) {
  if (rate === undefined || rate === null || rate === "") return "+0%";
  const s = String(rate).trim();
  if (/^[+-]\d+%$/.test(s)) return s; // 이미 올바른 형식
  const n = Number(s.replace("%", ""));
  if (!Number.isFinite(n)) return "+0%";
  // 안전 범위로 제한 (너무 빠르면 알아듣기 어렵다)
  const clamped = Math.max(-50, Math.min(100, Math.round(n)));
  return `${clamped >= 0 ? "+" : ""}${clamped}%`;
}

/**
 * 스페인어 발음 음성을 만든다.
 *
 * @param {string} text 스페인어 원문
 * @param {object} [opts]
 * @param {boolean} [opts.slow]  천천히 듣기 (배우기 시작할 때)
 * @param {string|number} [opts.rate] 보통 속도일 때의 말하기 속도 (기본 "+0%")
 * @param {string} [opts.voice] Edge TTS 음성 이름
 * @returns {Promise<Uint8Array|null>} mp3 바이트, 모두 실패하면 null
 */
export async function synthesizeSpanish(text, opts = {}) {
  if (!text || !text.trim()) return null;

  const { slow = false, voice = "es-MX-DaliaNeural" } = opts;
  const rate = slow ? "-25%" : normalizeRate(opts.rate);

  // 1순위: Edge TTS (속도 조절이 실제로 반영됨)
  try {
    const mp3 = await synthesizeWithEdge(text, { voice, rate });
    if (mp3 && mp3.byteLength >= 512) return mp3;
    console.warn("Edge TTS 결과가 비어 있음 — Google TTS 로 대체");
  } catch (err) {
    console.warn(`Edge TTS 실패(${err.message}) — Google TTS 로 대체`);
  }

  // 2순위: Google 번역 TTS
  try {
    // 빠르게 요청받은 경우엔 구두점을 빼서 정지 구간을 줄인다
    return await synthesizeWithGoogle(text, { trimPauses: !slow });
  } catch (err) {
    console.warn("Google TTS 도 실패(음성 없이 진행):", err.message);
    return null;
  }
}
