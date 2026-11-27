#!/usr/bin/env python3
"""Read a UX bench run (ux.mjs results per panel) and list what looks wrong.

  report.py <run-dir> [--sheets]   # issues.json + report.md; --sheets: contact sheets per panel

What it flags, per scene and panel:
- render: an error frame, an out-of-memory, log errors, a blank picture;
- keys and edge swipes that did not do what the frame's event map says
  (a held arrow walks the scenes, Home opens the scene list, a swipe up from
  the bottom opens the scene list, ...), or that switched or opened something
  the map does not ask for;
- pressable regions off the panel, or outside a round glass; content drawn in
  a round glass's invisible corners;
- a scene whose whole view scrolls (content below the fold) on a panel where
  that is not a list;
- taps on pressable regions that changed nothing, and slow steps;
- the keys' walk (Next is Tab, Action is Enter: docs/jsx-ui.md "Keys"): an
  element to press the ring never reaches, a ring on an element the panel
  does not show, a Next that leaves the scene or does nothing, Action on
  three ringed elements that changes nothing; on a board with keys and no
  touch, elements that take a tap where no key ever stops;
- texts (the wasm runtime's text report): under the size a person reads,
  cut by the panel's edge or a box that clips them, broken inside a word,
  printed over each other, cut by a round glass;
- a tap or an Action that went to another page of the scene, and the
  frame's Back did not bring the page before back (docs/buttons.md);
- a box that scrolls and does not move under a finger, or ends with what it
  cannot show;
- a round panel's scene that leaves the ring around its inscribed square empty.

  report.py <run-dir> --baseline <earlier-run-dir>   # also: interactions slower than the earlier run's
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

SWITCHER = "system/sceneSwitcher"
SETTINGS = "system/sceneSettings"
SLOW_STEP_MS = 250  # in wasm on this machine; an ESP32 is 10-40x slower


def rule_for(event_map, event, match):
    for rule in event_map or []:
        if rule.get("event") != event:
            continue
        m = rule.get("match") or {}
        if all(match.get(k) == v for k, v in m.items()):
            return rule
    return None


def resolve_role(role, rotate):
    """A direction key's role as the scene hears it (docs/buttons.md): next is
    towards the right or bottom of the picture as the frame shows it."""
    if role not in ("left", "right", "up", "down"):
        return role
    # The key's direction on the unturned panel, turned by the frame's rotation.
    vec = {"left": (-1, 0), "right": (1, 0), "up": (0, -1), "down": (0, 1)}[role]
    x, y = vec
    # panelToScenePoint (utils/image.nim) applied to a direction.
    r = rotate % 360
    if r == 90:
        x, y = y, -x
    elif r == 180:
        x, y = -x, -y
    elif r == 270:
        x, y = -y, x
    return "next" if (x > 0 or y > 0) else "prev"


def expected_after(panel, rec, step):
    """What the scene should be after a key or swipe step: a scene id, or a
    set of acceptable ones."""
    me = rec["scene"]
    order = rec.get("order") or [me]
    em = panel.get("eventMap") or []
    rotate = panel.get("rotate", 0)
    emit = None
    as_ = {}
    if step["kind"] == "key":
        label, action = step["label"].rsplit("-", 1)
        action = {"press": "press", "hold": "longPress"}[action]
        if "+" in label:
            rule = rule_for(em, "button", {"role": "back", "action": action})
        else:
            key = next((k for k in panel["keys"] if k["label"] == label), {})
            role = resolve_role(key.get("role", ""), rotate)
            rule = rule_for(em, "button", {"label": label, "role": role, "action": action})
        if rule:
            emit, as_ = rule.get("emit"), rule.get("as") or {}
    elif step["kind"] == "swipe":
        rule = rule_for(em, "edgeSwipe", {"edge": step["label"]})
        if rule:
            emit, as_ = rule.get("emit"), rule.get("as") or {}
    else:
        return None
    if emit == "sceneSwitcher":
        return {SWITCHER}
    if emit == "sceneSettings":
        return {SETTINGS, f"{SETTINGS}#{me}"}
    if emit == "setCurrentScene":
        i = order.index(me) if me in order else 0
        if as_.get("direction") == "next":
            return {order[(i + 1) % len(order)]}
        if as_.get("direction") == "prev":
            return {order[(i - 1) % len(order)], me}
    return {me}


def analyze_panel(panel_dir: Path):
    data = json.loads((panel_dir / "results.json").read_text())
    key = panel_dir.name.split("@")[0]
    data["panel"] = panel_dir.name
    panel = json.loads((Path(__file__).parent / "panels.json").read_text())[key]
    issues = []

    def add(rec, kind, severity, detail, shot=None):
        issues.append({"panel": data["panel"], "scene": rec.get("folder"), "kind": kind, "severity": severity,
                       "detail": detail, **({"shot": str(panel_dir / shot)} if shot else {})})

    for rec in data["results"]:
        if rec.get("error"):
            add(rec, "error", "fail", rec["error"][:300])
            continue
        r = rec.get("render") or {}
        a = r.get("analysis") or {}
        if r.get("code"):
            add(rec, "render-error", "fail", f"code {r.get('code')}: {r.get('error', '')[:200]}", r.get("shot"))
        if r.get("logErrors"):
            add(rec, "log-error", "note", " | ".join(r["logErrors"][:3])[:300], r.get("shot"))
        if a.get("blank"):
            add(rec, "blank", "fail", "the picture is one colour", r.get("shot"))
        if panel.get("round") and a.get("outsideCircle", 0) > 0.05:
            add(rec, "round-corners", "slow", f"{a['outsideCircle']:.0%} of the invisible corners hold content", r.get("shot"))
        for p in rec.get("elementProblems") or []:
            kind = p["kind"]
            if kind in ("elementPastCanvas", "elementOffCanvas"):
                what = "a pressable element" if p.get("takes") else "an element"
                detail = f"{what} at {p['box']} reaches {p['past']}px past the panel, in no box that scrolls"
            elif kind == "elementCutByCircle":
                detail = f"a pressable element at {p['box']} is {p['shown']:.0%} inside the round glass"
            else:
                detail = f"pressable elements {p['a']} and {p['b']} overlap ({p['share']:.0%})"
            add(rec, kind, "slow", detail, r.get("shot"))
        for p in rec.get("pressProblems") or []:
            add(rec, "press-" + p["kind"], "slow", f"pressable {p['x0']},{p['y0']}-{p['x1']},{p['y1']}", r.get("shot"))
        dead_taps = 0
        taps = 0
        for s in rec.get("steps", []):
            if s.get("aborted"):
                add(rec, "abort", "crash", f"{s['kind']} {s['label']}: {s.get('error')}")
            if s.get("code") not in (0, None):
                add(rec, "step-error", "fail", f"{s['kind']} {s['label']}: code {s['code']} {s.get('error', '')[:200]}", s.get("shot"))
            # The scene's own complaint again (a key it has no value for) is no news.
            if s.get("logErrors") and not set(s["logErrors"]) <= set(r.get("logErrors") or []) and \
                    not all(any(e.split('"error":')[-1] == x.split('"error":')[-1] for x in (r.get("logErrors") or [])) for e in s["logErrors"]):
                add(rec, "step-log-error", "note", f"{s['kind']} {s['label']}: " + " | ".join(s["logErrors"][:2])[:300], s.get("shot"))
            exp = expected_after(panel, rec, s)
            if exp is not None and s["after"] not in exp:
                add(rec, "unexpected-" + s["kind"], "fail",
                    f"{s['kind']} {s['label']}: ended on {s['after']}, expected {sorted(exp)}", s.get("shot"))
            if s["kind"] == "tap":
                taps += 1
                if s["changed"] == 0 and s["after"] == rec["scene"]:
                    dead_taps += 1
                if s["after"] != rec["scene"] and not s["after"].startswith("system/"):
                    add(rec, "tap-switched", "note", f"tap {s['label']} switched to {s['after']}", s.get("shot"))
            if s["kind"] == "scroll" and s.get("scrolls"):
                dist = max((abs(v[2]) for t in s["scrolls"] for v in t), default=0)
                if dist > 0 and s["after"] == rec["scene"]:
                    add(rec, "scrolls", "note", f"a drag up scrolled {dist:.0f}px (content past the panel)", s.get("shot"))
            if s.get("renderMs", 0) + s.get("inputMs", 0) - s.get("fetchMs", 0) > SLOW_STEP_MS:
                add(rec, "slow-step", "slow", f"{s['kind']} {s['label']}: input {s.get('inputMs')} ms + render {s.get('renderMs')} ms"
                    + (f" ({s['fetchMs']} ms of it fetching)" if s.get("fetchMs") else ""), s.get("shot"))
        tap_only = rec.get("tapOnly")
        if tap_only and not panel.get("touch") and tap_only["count"] >= max(3, tap_only["stops"]):
            # A keys-only board: what only a tap reaches is out of reach here.
            add(rec, "keys-tap-only", "slow", f"{tap_only['count']} elements take a tap but no key stops at them "
                f"({tap_only['stops']} the keys do): {', '.join(str(b) for b in tap_only['boxes'])}")
        walk = rec.get("focusWalk")
        if walk:
            # The keys' walk (docs/jsx-ui.md "Keys"): Next rings each element
            # to press in turn, where it can be seen, without leaving the scene.
            n = walk["takers"]
            if walk.get("left"):
                add(rec, "keys-left-scene", "fail", f"Next on a scene with {n} elements to press went to {walk['left']}")
            elif not walk["seen"] and not walk.get("tookKeys"):
                add(rec, "keys-reach-nothing", "fail", f"Next rings none of the {n} elements to press, and the scene does not take the key")
            else:
                un = walk.get("unreached") or []
                if un:
                    boxes = ", ".join(str(u["box"]) for u in un[:4])
                    add(rec, "keys-unreached", "slow", f"Next never rings {len(un)} of {n} elements to press ({len(walk['stops'])} stops, then round again): {boxes}")
                elif walk["seen"] and not walk.get("wrapped"):
                    add(rec, "keys-no-wrap", "note", f"after {walk['presses']} presses of Next the ring had not come round ({len(walk['stops'])} stops of {n} elements)")
                for o in (walk.get("offscreen") or [])[:1]:
                    add(rec, "keys-ring-offscreen", "slow", f"Next rang an element {o['shown']:.0%} on the panel at {o['box']}")
                acts = walk.get("actions") or []
                if acts and all(a["changed"] == 0 and a["after"] == rec["scene"] for a in acts):
                    add(rec, "keys-action-dead", "slow", f"Action on {len(acts)} ringed elements ({', '.join(str(a['ring']) for a in acts)}) changed nothing")
        if taps >= 2 and dead_taps == taps:
            add(rec, "dead-taps", "slow", f"none of {taps} taps on pressable regions changed the picture")
        t = rec.get("texts") or {}
        for p in t.get("problems") or []:
            k = p["kind"]
            if k == "textTiny":
                ex = ", ".join(f"\"{e['text']}\" {e['size']}px" for e in p["examples"])
                add(rec, "text-tiny", "slow", f"{p['count']} of {p['of']} texts under the readable size, smallest {p['smallest']} px: {ex}", r.get("shot"))
            elif k == "textPastCanvas":
                add(rec, "text-past-panel", "slow", f"\"{p['text']}\" reaches {p['past']}px past the panel at {p['box']}", r.get("shot"))
            elif k == "textClipped":
                add(rec, "text-clipped", "slow", f"\"{p['text']}\" cut by the box around it ({p['shown']:.0%} shows) at {p['box']}", r.get("shot"))
            elif k == "textBrokenWord":
                add(rec, "text-broken-word", "slow", f"\"{p['text']}\" broken inside a word at {p['box']}", r.get("shot"))
            elif k == "textsOverlap":
                add(rec, "texts-overlap", "slow", f"\"{p['a']}\" and \"{p['b']}\" printed over each other ({p['share']:.0%}) at {p['boxes']}", r.get("shot"))
            elif k == "textCutByCircle":
                add(rec, "text-cut-by-circle", "slow", f"\"{p['text']}\" {p['shown']:.0%} inside the round glass at {p['box']}", r.get("shot"))
        if t.get("cut"):
            add(rec, "text-ellipsis", "note", f"{t['cut']} of {t['texts']} texts cut with an ellipsis", r.get("shot"))
        if panel.get("round") and a.get("content", 0) > 0.05 and a.get("ring", 1) < 0.03:
            add(rec, "round-square-only", "note", f"the ring around the inscribed square is {a.get('ring', 0):.1%} used: a square in the middle", r.get("shot"))
        taps_ = rec.get("taps") or []
        dead = [x for x in taps_ if x["changed"] == 0 and x["after"] == rec["scene"]]
        if taps_ and dead and len(dead) < len(taps_):
            add(rec, "tap-dead-elements", "note", f"{len(dead)} of {len(taps_)} pressed elements changed nothing: {', '.join(str(x['at']) for x in dead[:5])}")
        backs = [x for x in taps_ if x.get("back")] + [x for x in ((rec.get("focusWalk") or {}).get("actions") or []) if x.get("back")]
        for x in backs:
            b = x["back"]
            if b["after"] != rec["scene"]:
                add(rec, "back-left-scene", "fail", f"Back ({b['how']}) on a page of the scene went to {b['after']}")
            elif not b["returned"]:
                what = f"tap at {x['at']}" if "at" in x else f"Action on {x.get('ring')}"
                add(rec, "back-no-return", "slow", f"{what} went to another page; Back ({b['how']}) did not bring the page before back (changed {b['changed']:.1%})")
                break
        for sc in rec.get("scrollers") or []:
            if sc.get("left"):
                add(rec, "scroll-left-scene", "fail", f"a drag in the box at {sc['box']} went to {sc['left']}")
            elif sc["drags"] == 0 and sc.get("from", 0) == 0:
                add(rec, "scroll-stuck", "slow", f"the box at {sc['box']} scrolls but did not move under a finger")
            elif sc.get("endShown") is False or sc.get("lastElementShown") is False:
                add(rec, "scroll-end-hidden", "slow", f"scrolled to its end ({sc['scrolled']}px), the box at {sc['box']} does not show its last item whole (\"{sc.get('lastText', '')}\")")
        if (r.get("coldMs") or 0) - 0 > 1500:
            add(rec, "slow-cold", "note", f"first render {r['coldMs']} ms in wasm ({r.get('fetches')} fetches, {r.get('fetchMs')} ms of them)")
    return data, panel, issues


def collect_timings(run: Path):
    """Per panel and scene: the first and a warm render, and the median and
    worst of what each kind of input took to show (input + render, fetching
    left out), in wasm on this machine."""
    out = {}
    for panel_dir in sorted(p for p in run.iterdir() if (p / "results.json").exists()):
        data = json.loads((panel_dir / "results.json").read_text())
        for rec in data["results"]:
            r = rec.get("render") or {}
            kinds = defaultdict(list)
            for s in rec.get("steps", []):
                kinds[s["kind"]].append(max(0, s.get("renderMs", 0) + s.get("inputMs", 0) - s.get("fetchMs", 0)))
            row = {"cold": (r.get("coldMs") or 0) - (r.get("fetchMs") or 0) if r.get("coldMs") is not None else None, "warm": r.get("warmMs")}
            for k, v in kinds.items():
                v.sort()
                row[k] = {"n": len(v), "median": v[len(v) // 2], "max": v[-1]}
            out[f"{panel_dir.name}|{rec.get('folder')}"] = row
    return out


def compare_timings(now, base):
    """What got slower than the earlier run: a median at least 1.5 times and
    20 ms over the earlier one's, or a first render 1.5 times and 100 ms."""
    issues = []
    for key, row in now.items():
        b = base.get(key)
        if not b:
            continue
        panel, scene = key.split("|", 1)
        for k in ("tap", "key", "focus", "swipe", "scroll", "scrollall"):
            if k in row and k in b and row[k]["median"] >= 1.5 * b[k]["median"] + 20:
                issues.append({"panel": panel, "scene": scene, "kind": "slower-than-baseline", "severity": "slow",
                               "detail": f"{k}: median {row[k]['median']} ms, was {b[k]['median']} ms"})
        if row.get("cold") and b.get("cold") and row["cold"] >= 1.5 * b["cold"] + 100:
            issues.append({"panel": panel, "scene": scene, "kind": "slower-than-baseline", "severity": "slow",
                           "detail": f"first render {row['cold']} ms, was {b['cold']} ms"})
    return issues


def contact_sheet(panel_dir: Path, data, out: Path, tag="0-render", cols=8, thumb=260, round_=False):
    from PIL import Image, ImageDraw

    items = [(rec["folder"], panel_dir / (rec.get("render") or {}).get("shot", "")) for rec in data["results"]
             if (rec.get("render") or {}).get("shot")] if tag == "0-render" else []
    if not items:
        return []
    first = Image.open(items[0][1])
    w, h = first.size
    scale = thumb / max(w, h)
    tw, th = max(1, int(w * scale)), max(1, int(h * scale))
    per = cols * 6
    sheets = []
    for page in range(0, len(items), per):
        chunk = items[page:page + per]
        rows = (len(chunk) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * (tw + 6), rows * (th + 20)), (128, 128, 128))
        d = ImageDraw.Draw(sheet)
        for i, (name, f) in enumerate(chunk):
            im = Image.open(f).convert("RGB").resize((tw, th))
            x = (i % cols) * (tw + 6)
            y = (i // cols) * (th + 20)
            if round_:
                # What the round glass shows: the circle inside the square.
                mask = Image.new("L", (tw, th), 0)
                ImageDraw.Draw(mask).ellipse((0, 0, tw - 1, th - 1), fill=255)
                sheet.paste(im, (x, y + 16), mask)
            else:
                sheet.paste(im, (x, y + 16))
            d.text((x + 2, y + 2), name[:34], fill=(255, 255, 255))
        f = out / f"{data['panel']}-{page // per + 1}.png"
        sheet.save(f)
        sheets.append(str(f))
    return sheets


def main():
    run = Path(sys.argv[1])
    all_issues = []
    sheets_dir = run / "sheets"
    for panel_dir in sorted(p for p in run.iterdir() if (p / "results.json").exists()):
        data, panel, issues = analyze_panel(panel_dir)
        all_issues.extend(issues)
        if "--sheets" in sys.argv:
            sheets_dir.mkdir(exist_ok=True)
            contact_sheet(panel_dir, data, sheets_dir, round_=bool(panel.get("round")))
    timings = collect_timings(run)
    (run / "timings.json").write_text(json.dumps(timings, indent=1))
    if "--baseline" in sys.argv:
        base = collect_timings(Path(sys.argv[sys.argv.index("--baseline") + 1]))
        all_issues.extend(compare_timings(timings, base))
    (run / "issues.json").write_text(json.dumps(all_issues, indent=1))
    by_kind = defaultdict(list)
    for i in all_issues:
        by_kind[i["kind"]].append(i)
    lines = [f"# UX bench {run.name}", ""]
    for kind, items in sorted(by_kind.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        lines.append(f"## {kind} ({len(items)})")
        scenes = defaultdict(list)
        for i in items:
            scenes[i["scene"]].append(i)
        for scene, its in sorted(scenes.items(), key=lambda kv: -len(kv[1])):
            panels = sorted({i["panel"] for i in its})
            lines.append(f"- **{scene}** on {', '.join(panels)}: {its[0]['detail']}")
        lines.append("")
    # The slowest interactions (wasm on this machine; an ESP32 is 10-40x slower).
    worst = []
    for key, row in timings.items():
        for k, v in row.items():
            if isinstance(v, dict):
                worst.append((v["median"], v["max"], k, key))
    worst.sort(reverse=True)
    lines.append("## Slowest interactions (median ms, worst ms, in wasm)")
    for med, mx, k, key in worst[:30]:
        lines.append(f"- {key.replace('|', ' / ')}: {k} median {med}, worst {mx}")
    lines.append("")
    (run / "report.md").write_text("\n".join(lines))
    print("\n".join(lines[:200]))


if __name__ == "__main__":
    main()
