#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""오늘 나간 스페인어 문장(또는 단어)이 실제로 들리는 유튜브 클립을 찾아 보낸다.

집 PC 의 예약작업(매일 12:05 KST, scripts/clip_task.ps1)으로 돈다.
GitHub Actions 에서 돌리려 했으나 유튜브가 러너 IP 를 봇으로 막아
자막·영상을 한 건도 못 받았다(2026-09-02). 집 IP 는 잘 된다.

흐름:
  1. 워커의 /today 로 오늘 문장을 받는다 (12:00 발송이 아직이면 잠시 기다린다)
  2. 유튜브에서 그 문장을 검색해 후보 영상들의 스페인어 자막만 내려받는다
  3. 자막에서 문장(또는 핵심 구문)이 나오는 시각을 찾는다
  4. 그 부분만 잘라 받아 워커 POST /clip 으로 넘긴다 — 봇 토큰은 워커만
     갖고 있으니 텔레그램 전송은 워커가 한다. 여기엔 ADMIN_KEY 만 있으면 된다.

전체 문장이 자막에 그대로 나오는 영상은 드물다. 그래서 문장 → parts 의
긴 조각 순서로 눈높이를 낮춰가며 찾는다. 그래도 없으면 못 찾았다고 한 줄만
알린다 — TTS 로 되돌아가지 않는다(mp3 는 그만 보내기로 했다).

ADMIN_KEY 는 환경변수 또는 저장소의 .dev.vars(ADMIN_KEY=...) 에서 읽는다.
"""

import datetime
import glob
import html
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
import urllib.parse
import urllib.request

WORKER = "https://spanish-teacher-bot.imissyou55aa.workers.dev"
SEARCH_CANDIDATES = 12   # 검색 결과에서 자막을 확인할 영상 수
MAX_VIDEO_MINUTES = 90   # 이보다 긴 영상은 건너뛴다 (생방송·통합본 배제)
PAD_BEFORE = 1.5         # 대사 앞 여유(초)
PAD_AFTER = 2.0          # 대사 뒤 여유(초)
MIN_CLIP = 4.0           # 클립 최소 길이(초)
MAX_CLIP = 20.0          # 클립 최대 길이(초)
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKDIR = os.path.join(REPO, "state", "clip_work")
WAIT_FOR_CARD_MIN = 20   # 12:00 카드가 아직 안 나갔으면 이만큼 기다린다(분)
KST = datetime.timezone(datetime.timedelta(hours=9))


def log(*a):
    print(*a, flush=True)


def admin_key():
    key = os.environ.get("ADMIN_KEY", "").strip()
    if key:
        return key
    try:
        for line in open(os.path.join(REPO, ".dev.vars"), encoding="utf-8"):
            if line.startswith("ADMIN_KEY="):
                return line.split("=", 1)[1].strip()
    except OSError:
        pass
    raise SystemExit("ADMIN_KEY 가 없습니다 (환경변수 또는 .dev.vars)")


def api(path, data=None, files=None):
    """워커 관리 엔드포인트 호출. files 는 {필드: (파일명, bytes)} → multipart POST."""
    sep = "&" if "?" in path else "?"
    url = "%s%s%skey=%s" % (WORKER, path, sep, urllib.parse.quote(admin_key()))
    # Cloudflare 가 Python-urllib 기본 UA 를 봇 서명으로 막는다(403, error 1010)
    headers = {"User-Agent": "spanish-clip-bot/1.0"}
    body = None
    if files or data:
        boundary = "----clipbound7259"
        parts = []
        for k, v in (data or {}).items():
            parts.append(
                ("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n"
                 % (boundary, k, v)).encode()
            )
        for k, (fname, blob) in (files or {}).items():
            parts.append(
                ("--%s\r\nContent-Disposition: form-data; name=\"%s\"; "
                 "filename=\"%s\"\r\nContent-Type: video/mp4\r\n\r\n"
                 % (boundary, k, fname)).encode() + blob + b"\r\n"
            )
        parts.append(("--%s--\r\n" % boundary).encode())
        body = b"".join(parts)
        headers["Content-Type"] = "multipart/form-data; boundary=" + boundary
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)


# ------------------------------------------------------------------ 문자 정규화

def norm(s):
    """자막 대조용 정규화: 소문자, 악센트 제거, 문장부호 제거, 공백 하나로.

    자동 자막은 악센트·구두점이 들쑥날쑥이라(¿quieres → quieres, más → mas)
    둘 다 벗겨야 같은 대사를 같다고 볼 수 있다.
    """
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"[^0-9a-zñA-ZÑ ]+", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def search_terms(content):
    """찾을 구문을 눈높이 순서로. 전체 문장 → parts 중 긴 것 순.

    단어 카드(kind=word)는 es 가 한 단어뿐이고 parts 가 없다. 그 단어가
    실제로 들리는 자리를 찾는 게 목적이므로 한 단어 그대로 찾는다 —
    find_in_cues 가 단어 경계로 대조하니 'rebaja' 가 'rebajas' 에 걸리지 않는다.
    """
    terms = []
    es = (content.get("es") or "").strip()
    if es:
        terms.append(es)
    parts = sorted(
        (p.get("es", "") for p in content.get("parts", [])),
        key=lambda x: -len(norm(x)),
    )
    for p in parts:
        # 두 단어 이상인 조각만 — 한 단어는 아무 영상에나 있어서 뜻이 없다
        if len(norm(p).split()) >= 2 and p not in terms:
            terms.append(p)
    return terms


# ------------------------------------------------------------------ 자막 검색

def run(cmd, timeout=180):
    return subprocess.run(cmd, capture_output=True, timeout=timeout)


def yt_search(query, n):
    """유튜브 검색 → [{id, duration}] (긴 영상 제외)."""
    r = run([
        "yt-dlp", "--flat-playlist", "--dump-json",
        "ytsearch%d:%s" % (n, query),
    ])
    if r.returncode != 0:
        log("  검색 실패:", r.stderr.decode("utf-8", "replace")[-400:])
    out = []
    for line in r.stdout.decode("utf-8", "replace").splitlines():
        try:
            j = json.loads(line)
        except ValueError:
            continue
        dur = j.get("duration") or 0
        if dur and dur > MAX_VIDEO_MINUTES * 60:
            continue
        if j.get("id"):
            out.append({"id": j["id"], "duration": dur, "title": j.get("title", "")})
    return out


def fetch_subs(video_id):
    """스페인어 자막(vtt)을 내려받아 경로를 돌려준다. 없으면 None."""
    for f in glob.glob(os.path.join(WORKDIR, video_id + "*.vtt")):
        os.remove(f)
    r = run([
        "yt-dlp", "--skip-download",
        "--write-subs", "--write-auto-subs",
        "--sub-langs", "es.*,es",
        "--sub-format", "vtt",
        "-o", os.path.join(WORKDIR, "%(id)s"),
        "https://www.youtube.com/watch?v=" + video_id,
    ], timeout=120)
    hits = glob.glob(os.path.join(WORKDIR, video_id + "*.vtt"))
    if not hits:
        err = r.stderr.decode("utf-8", "replace").strip().splitlines()
        log("  자막 없음: %s %s" % (video_id, err[-1][-200:] if err else ""))
    return hits[0] if hits else None


TS = re.compile(r"(\d+):(\d\d):(\d\d)\.(\d\d\d)\s*-->\s*(\d+):(\d\d):(\d\d)\.(\d\d\d)")


def parse_vtt(path):
    """[(start초, end초, 정규화 텍스트)] 목록."""
    cues = []
    try:
        raw = open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return cues
    for block in raw.split("\n\n"):
        m = TS.search(block)
        if not m:
            continue
        g = [int(x) for x in m.groups()]
        start = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000.0
        end = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000.0
        text = re.sub(r"<[^>]+>", "", block[m.end():])
        text = html.unescape(re.sub(r"\s+", " ", text)).strip()
        if text:
            cues.append((start, end, norm(text)))
    return cues


def find_in_cues(cues, needle):
    """이웃 큐 두세 개를 이어붙여도 찾는다 — 대사가 줄로 쪼개져 있는 게 보통이다.

    단어 경계로 대조한다: 정규화된 텍스트는 공백 구분뿐이라 양쪽에 공백을
    붙여 보면 된다.

    묶음 크기를 1 → 2 → 3 순으로 넓혀 가며 본다. 전에는 시작 큐를 바깥 고리로
    두고 그 자리에서 1~3개를 이어붙였는데, 그러면 **한 큐에 다 들어 있는 말도
    두세 큐 앞에서 먼저 걸려** 시작 시각이 몇 초씩 앞으로 밀렸다(일본어판 실측:
    5.4초짜리 대사가 2.0초로 보고됨). 클립이 대사보다 일찍 시작해 앞에 엉뚱한
    말이 붙는다. 작은 묶음을 먼저 보면 그 말이 실제로 나오는 큐가 잡힌다.
    """
    if not needle:
        return None
    pad = " " + needle + " "
    for span in (1, 2, 3):
        for i in range(len(cues) - span + 1):
            joined = " ".join(c[2] for c in cues[i:i + span])
            if pad in " " + joined + " ":
                return cues[i][0], cues[i + span - 1][1]
    return None


# ------------------------------------------------------------------ 클립 추출

def cut_clip(video_id, start, end, out_path):
    a = max(0.0, start - PAD_BEFORE)
    b = end + PAD_AFTER
    if b - a < MIN_CLIP:
        b = a + MIN_CLIP
    if b - a > MAX_CLIP:
        b = a + MAX_CLIP
    r = run([
        "yt-dlp",
        "-f", "bv*[height<=720]+ba/b[height<=720]/b",
        "--download-sections", "*%.1f-%.1f" % (a, b),
        "--force-keyframes-at-cuts",
        "--merge-output-format", "mp4",
        "-o", out_path,
        "https://www.youtube.com/watch?v=" + video_id,
    ], timeout=300)
    if not os.path.exists(out_path):
        log("  다운로드 실패:", r.stderr.decode("utf-8", "replace")[-300:])
        return False
    return os.path.getsize(out_path) > 10_000


# ------------------------------------------------------------------ 메인

def wait_for_today_card():
    """오늘(KST) 12:00 카드가 나갔는지 /today 로 확인. 아직이면 잠시 기다린다.

    워커 cron 이 몇 분 늦을 수 있고, 예약작업이 정각보다 먼저 뜰 수도 있다.
    """
    today_kst = datetime.datetime.now(KST).date()
    deadline = time.time() + WAIT_FOR_CARD_MIN * 60
    while True:
        today = api("/today")
        sent = today.get("sent_at") if today.get("ok") else None
        if sent:
            # D1 의 datetime('now') 는 UTC
            d = datetime.datetime.strptime(sent, "%Y-%m-%d %H:%M:%S")
            d = d.replace(tzinfo=datetime.timezone.utc).astimezone(KST).date()
            if d == today_kst or os.environ.get("FORCE_CLIP"):
                return today
        if time.time() > deadline:
            log("오늘 카드가 아직 안 나갔습니다 (마지막 발송: %s). 포기." % sent)
            return None
        log("오늘 카드를 기다리는 중 (마지막 발송: %s)" % sent)
        time.sleep(60)


def main():
    os.makedirs(WORKDIR, exist_ok=True)

    today = wait_for_today_card()
    if not today:
        return 1
    if today.get("clip_at") and not os.environ.get("FORCE_CLIP"):
        # 예약작업이 재시도로 여러 번 떠도 한 번만 보낸다
        log("오늘 클립은 이미 보냈습니다:", today["clip_at"])
        return 0
    content = today["content"]
    es = content.get("es", "")
    # 문장 카드는 ko, 단어 카드는 ko_reading 에 뜻이 있다
    ko = content.get("ko") or content.get("ko_reading") or ""
    log("오늘의 %s:" % ("단어" if today.get("kind") == "word" else "문장"), es)
    if not es:
        log("문장이 비어 있어 종료")
        return 0

    terms = search_terms(content)
    log("찾을 구문:", terms)

    found = None  # (video_id, start, end, matched_term)
    checked = set()
    for term in terms:
        # 대사가 그대로 들리는 영상을 노린다. 검색어에 따옴표를 붙여
        # 정확 매치를 우선시키되, 유튜브가 무시해도 자막 확인이 거른다.
        for video in yt_search('"%s"' % term, SEARCH_CANDIDATES):
            vid = video["id"]
            if vid in checked:
                continue
            checked.add(vid)
            sub = fetch_subs(vid)
            if not sub:
                continue
            hit = find_in_cues(parse_vtt(sub), norm(term))
            if hit:
                log("일치: %s (%s) %.1f~%.1f초 [%s]"
                    % (vid, video["title"][:40], hit[0], hit[1], term))
                found = (vid, hit[0], hit[1], term)
                break
        if found:
            break

    if not found:
        log("자막에서 구문을 찾지 못했습니다. 오늘은 영상 없이 넘어갑니다.")
        # 개인 채널이므로 실패도 짧게 알린다 — 조용히 사라지면 영상이 왜
        # 안 왔는지 알 수 없다.
        try:
            r = api("/clip", {"text": "🎬 오늘 문장이 나오는 클립을 못 찾았습니다: %s" % es})
            log("알림:", r)
        except Exception as e:
            log("실패 알림 전송 실패:", e)
        return 0

    vid, start, end, term = found
    out = os.path.join(WORKDIR, "clip.mp4")
    if os.path.exists(out):
        os.remove(out)
    if not cut_clip(vid, start, end, out):
        log("클립 추출 실패")
        return 1

    size = os.path.getsize(out)
    log("클립 %.1fKB" % (size / 1024))
    if size > 49_000_000:
        log("50MB 초과라 전송 불가")
        return 1

    blob = open(out, "rb").read()
    caption = "🎬 %s\n%s" % (es, ko)
    try:
        r = api("/clip", {"caption": caption}, files={"video": ("clip.mp4", blob)})
        log("전송:", r)
        return 0 if r.get("ok") else 1
    except Exception as e:
        log("전송 실패:", e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
