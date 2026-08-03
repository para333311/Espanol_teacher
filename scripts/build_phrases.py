#!/usr/bin/env python3
"""data/phrases.json → src/phrases.js 변환."""
import json
import re
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
src = json.loads((BASE / "data/phrases.json").read_text(encoding="utf-8"))
phrases = src["phrases"]

# 조각 합성 검증 시 무시할 문자(공백·구두점). 문장부호는 조각에 담지 않는다.
_NOISE = re.compile(r"[¿¡?!.,;:　\s]")


def _norm(s: str) -> str:
    return _NOISE.sub("", s).lower()


def validate(phrases) -> list[str]:
    """낱말 조각이 원문을 그대로 복원하는지 검사한다.

    조각을 이어 붙였을 때 발음/원문과 달라지면 학습자가 잘못 외우게 되므로
    빌드 단계에서 막는다.
    """
    errs = []
    for i, p in enumerate(phrases):
        parts = p.get("parts") or []
        if not parts:
            errs.append(f"[{i}] parts 없음: {p['kr_read']}")
            continue
        kr = _norm("".join(x["kr"] for x in parts))
        if kr != _norm(p["kr_read"]):
            errs.append(f"[{i}] 발음 조각 불일치: {_norm(p['kr_read'])} != {kr}")
        if all(x.get("es") for x in parts):
            es = _norm("".join(x["es"] for x in parts))
            if es != _norm(p["es"]):
                errs.append(f"[{i}] 스페인어 조각 불일치: {_norm(p['es'])} != {es}")
    return errs


problems = validate(phrases)
if problems:
    print("문장 데이터 검증 실패:\n" + "\n".join(problems), file=sys.stderr)
    raise SystemExit(1)

def esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


def parts_literal(parts) -> str:
    """낱말 쪼개기 배열을 JS 리터럴 한 줄로 만든다.

    한글 발음(kr)이 1순위이므로 항상 먼저 쓰고, 스페인어(es)는 보조 표기라
    없어도 통과시킨다.
    """
    if not parts:
        return None
    items = []
    for x in parts:
        fields = [f'kr: "{esc(x["kr"])}"']
        if x.get("es"):
            fields.append(f'es: "{esc(x["es"])}"')
        fields.append(f'ko: "{esc(x["ko"])}"')
        items.append("{ " + ", ".join(fields) + " }")
    return "[" + ", ".join(items) + "]"

out = [
    "// 생활 스페인어 문장 데이터 (자동 생성: data/phrases.json → 이 파일)",
    "// 수정은 data/phrases.json 을 고친 뒤 `npm run build:phrases` 로 재생성하세요.",
    "",
    "export const PHRASES = [",
]
for p in phrases:
    out += [
        "  {",
        f'    es: "{esc(p["es"])}",',
        f'    kr: "{esc(p["kr_read"])}",',
        f'    ko: "{esc(p["ko"])}",',
        f'    scene: "{esc(p["scene"])}",',
        f'    tip: "{esc(p["tip"])}",',
    ]
    lit = parts_literal(p.get("parts"))
    if lit:
        out.append(f"    parts: {lit},")
    out += [
        f'    level: {p["level"]},',
        "  },",
    ]
out += ["];", "", "export const TOTAL = PHRASES.length;", ""]

(BASE / "src/phrases.js").write_text("\n".join(out), encoding="utf-8")
print(f"src/phrases.js 생성 완료: {len(phrases)}문장")
