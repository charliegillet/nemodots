"""Self-contained HTML scoreboard for Ratchet (owner: I3).

`render_report(history)` turns runs/history.json into one HTML page with inline CSS and inline SVG (no
scripts, no external requests). `write_report(store)` gathers the extra texts the page shows (playbooks,
diffs, the LLM call ledger) and writes runs/report.html atomically.

Choices made where the plan is silent:

* ``render_report`` takes an optional keyword-only ``artifacts`` mapping
  ``{version: {"playbook": str, "diff": str, "diff_href": str}}``; without it the diff/playbook panels
  say the text is unavailable and diff links are derived from ``diff_path``.
* ``llm_calls`` (lines of runs/llm_calls.jsonl) adds a "Crusoe usage by model" table that includes calls
  outside versions (bench-check, ping, failed reviews); the header's total cost uses it when present.
* Passed/runs in the per-task grid is reconstructed as ``round(rate * repeats)`` / ``repeats``.
"""
from __future__ import annotations

import json
import logging
import os
from html import escape
from pathlib import Path
from typing import Any

from ratchet.types import Usage, utcnow

log = logging.getLogger("ratchet.report")

ACCEPTED = ("incumbent", "superseded", "accepted")


def _e(x: Any) -> str:
    return escape(str(x), quote=True)


def _usage(d: Any) -> Usage:
    if isinstance(d, Usage):
        return d
    return Usage.from_dict(d or {})


def _pct(x: float | None, digits: int = 1) -> str:
    if x is None or x < 0:
        return "—"
    return f"{x * 100:.{digits}f}%"


def _signed_pct(x: float | None) -> str:
    if x is None:
        return "—"
    return f"{x * 100:+.1f}%"


def _fmt_int(n: int) -> str:
    return f"{int(n):,}"


def _money(x: float) -> str:
    return f"${x:.4f}"


CSS = """
:root{--bg:#f7f7f4;--panel:#ffffff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e2e1dc;--accent:#0f7b5f;
--accent-soft:#d7efe6;--reject:#c2410c;--reject-soft:#fde7dc;--pending:#8a8a84;--add:#e3f5ea;--add-ink:#11643f;
--del:#fbe4e4;--del-ink:#9b1c1c;--grid:#ecebe6;--bar-prompt:#7aa6c2;--bar-cached:#2f6f95;--bar-out:#e0a458}
@media (prefers-color-scheme: dark){:root{--bg:#141413;--panel:#1d1d1b;--ink:#ecebe6;--muted:#a3a29c;
--line:#33332f;--accent:#3fbf94;--accent-soft:#16372c;--reject:#f08a55;--reject-soft:#3a2117;--pending:#8a8a84;
--add:#15301f;--add-ink:#8fe0b0;--del:#3a1b1b;--del-ink:#f3a3a3;--grid:#2a2a27;--bar-prompt:#5b88a6;
--bar-cached:#9cc9e6;--bar-out:#d39a4f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",
Helvetica,Arial,sans-serif}
main{max-width:1100px;margin:0 auto;padding:28px 16px 64px}
h1{font-size:28px;margin:0 0 4px;letter-spacing:-0.01em}
h2{font-size:18px;margin:36px 0 12px}
.sub{color:var(--muted);margin:0 0 20px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.tile .k{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.tile .v{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums}
.tile .v small{font-size:13px;font-weight:500;color:var(--muted)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto}
svg text{fill:var(--ink);font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
svg .muted{fill:var(--muted)}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.pill.incumbent{background:var(--accent);color:var(--panel)}
.pill.superseded,.pill.accepted{background:var(--accent-soft);color:var(--accent)}
.pill.rejected{background:var(--reject-soft);color:var(--reject)}
.pill.candidate,.pill.failed{background:var(--grid);color:var(--muted)}
.bar{display:flex;height:12px;min-width:2px;border-radius:3px;overflow:hidden;background:var(--grid)}
.bar span{display:block;height:100%}
.legend{display:flex;flex-wrap:wrap;gap:14px;color:var(--muted);font-size:12.5px;margin-top:8px}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
pre{margin:0;font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;
word-break:break-word}
.diff span{display:block;min-height:1.45em}
.diff .add{background:var(--add);color:var(--add-ink)}
.diff .del{background:var(--del);color:var(--del-ink)}
.diff .hunk{color:var(--muted)}
.twocol{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:820px){.twocol{grid-template-columns:1fr}}
.grid td.cell{text-align:center;color:#fff;font-weight:600;font-variant-numeric:tabular-nums;min-width:44px;
border:2px solid var(--panel)}
.up{color:var(--accent);font-weight:600}.down{color:var(--reject);font-weight:600}
.ids{font-size:12px;color:var(--muted)}
.why{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:0 0 12px}
.why p{margin:4px 0}
.grid td.empty{color:var(--muted);text-align:center}
.grid th.v{text-align:center}
details summary{cursor:pointer;color:var(--muted)}
a{color:var(--accent)}
.note{color:var(--muted);font-size:13px}
.live{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:999px;background:var(--reject);
color:var(--panel);font-size:12px;font-weight:700;vertical-align:4px}
"""


# --------------------------------------------------------------------------- scoreboard


def _scoreboard_svg(versions: list[dict]) -> str:
    W, H = 900, 330
    ml, mr, mt, mb = 52, 40, 34, 44
    pw, ph = W - ml - mr, H - mt - mb
    if not versions:
        return (f'<svg viewBox="0 0 {W} {H}" width="100%" role="img" aria-label="Scoreboard (empty)">'
                f'<text x="{W / 2}" y="{H / 2}" text-anchor="middle" class="muted">No versions yet. '
                f'Run <tspan font-family="monospace">python -m ratchet run</tspan> to evaluate v0.</text></svg>')
    vs = sorted(versions, key=lambda v: v["version"])
    max_v = max(v["version"] for v in vs)
    by_v = {v["version"]: v for v in vs}

    def x(ver: int) -> float:
        pad = 24  # keep end points and their labels clear of the y axis labels
        return ml + pad + ((pw - 2 * pad) / 2 if max_v == 0 else (pw - 2 * pad) * ver / max_v)

    def y(s: float) -> float:
        return mt + ph * (1 - max(0.0, min(1.0, s)))

    out = [f'<svg viewBox="0 0 {W} {H}" width="100%" role="img" aria-label="Holdout score per playbook version">']
    for g in (0, 0.25, 0.5, 0.75, 1.0):
        out.append(f'<line x1="{ml}" x2="{W - mr}" y1="{y(g):.1f}" y2="{y(g):.1f}" stroke="var(--grid)" stroke-width="1"/>')
        out.append(f'<text x="{ml - 8}" y="{y(g) + 4:.1f}" text-anchor="end" class="muted">{int(g * 100)}%</text>')
    step = max(1, (max_v + 1) // 20)
    for ver in range(0, max_v + 1):
        if ver % step == 0 or ver == max_v:
            out.append(f'<text x="{x(ver):.1f}" y="{H - mb + 18}" text-anchor="middle" class="muted">v{ver}</text>')
    out.append(f'<text x="{ml + pw / 2:.1f}" y="{H - 6}" text-anchor="middle" class="muted">playbook version</text>')
    out.append(f'<text x="14" y="{mt + ph / 2:.1f}" text-anchor="middle" class="muted" '
               f'transform="rotate(-90 14 {mt + ph / 2:.1f})">holdout pass rate</text>')

    acc = [v for v in vs if v.get("status") in ACCEPTED and v.get("holdout_score", -1) >= 0]
    if acc:
        d = f"M{x(acc[0]['version']):.1f},{y(acc[0]['holdout_score']):.1f}"
        for v in acc[1:]:
            d += f" H{x(v['version']):.1f} V{y(v['holdout_score']):.1f}"
        d += f" H{x(max_v):.1f}"
        out.append(f'<path d="{d}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linejoin="round"/>')

    for v in vs:
        ver, st, s = v["version"], v.get("status", ""), v.get("holdout_score", -1.0)
        tip = f"v{ver} · {st}"
        if s is not None and s >= 0:
            tip += f" · holdout {_pct(s)}"
        if v.get("gate_reason"):
            tip += f"\n{v['gate_reason']}"
        if v.get("rationale") and ver > 0:
            tip += f"\n{v['rationale']}"
        cx = x(ver)
        if st == "rejected" and s is not None and s >= 0:
            ps = v.get("incumbent_score")
            if ps is None and v.get("parent") in by_v:
                ps = by_v[v["parent"]].get("holdout_score")
            g = [f'<g><title>{_e(tip)}</title>']
            if ps is not None and ps >= 0:
                g.append(f'<line x1="{cx:.1f}" x2="{cx:.1f}" y1="{y(ps):.1f}" y2="{y(s):.1f}" stroke="var(--reject)" '
                         f'stroke-width="1.5" stroke-dasharray="4 3"/>')
            g.append(f'<circle cx="{cx:.1f}" cy="{y(s):.1f}" r="7" fill="var(--panel)" stroke="var(--reject)" stroke-width="2.5"/>')
            g.append(f'<text x="{cx + 10:.1f}" y="{y(s) - 10:.1f}" text-anchor="start" class="muted">{_pct(s, 0)}</text></g>')
            out.append("".join(g))
        elif st in ACCEPTED and s is not None and s >= 0:
            r = 8 if st == "incumbent" else 6.5
            out.append(f'<g><title>{_e(tip)}</title><circle cx="{cx:.1f}" cy="{y(s):.1f}" r="{r}" fill="var(--accent)" '
                       f'stroke="var(--panel)" stroke-width="2"/>'
                       f'<text x="{cx:.1f}" y="{y(s) - 13:.1f}" text-anchor="middle">{_pct(s, 0)}</text></g>')
        else:  # candidate being evaluated, or failed
            label = "evaluating" if st == "candidate" else st
            out.append(f'<g><title>{_e(tip)}</title><circle cx="{cx:.1f}" cy="{y(0) - 8:.1f}" r="6" fill="none" '
                       f'stroke="var(--pending)" stroke-width="2" stroke-dasharray="3 2"/>'
                       f'<text x="{cx:.1f}" y="{y(0) - 20:.1f}" text-anchor="middle" class="muted">{_e(label)}</text></g>')
    out.append("</svg>")
    return "".join(out)


# --------------------------------------------------------------------------- sections


def _short_model(model: str) -> str:
    return model.rsplit("/", 1)[-1]


def cached_by_model(by_model: dict[str, Usage]) -> tuple[list[tuple[str, Usage]], list[str]]:
    """Split per-model usage into (models that report cached tokens, models that never do).

    Cached tokens must be read per model: Crusoe reports ``prompt_tokens_details.cached_tokens`` for some
    models (Nemotron Super, the reviewer) and not for others (Lightning, the worker). Summed into one
    version total, one reporting reviewer call would make millions of worker prompt tokens look uncached."""
    reporting = [(m, u) for m, u in sorted(by_model.items()) if u.cached_reported]
    silent = [m for m, u in sorted(by_model.items()) if not u.cached_reported and u.requests]
    return reporting, silent


def cached_summary(by_model: dict[str, Usage]) -> str:
    """Plain-text cached-token summary, e.g. '2,304 of 2,880 cached on X; not reported by Y'."""
    reporting, silent = cached_by_model(by_model)
    parts = [f"{u.cached_tokens:,} of {u.prompt_tokens:,} cached on {_short_model(m)}" for m, u in reporting]
    if silent:
        parts.append("not reported by " + ", ".join(_short_model(m) for m in silent))
    return "; ".join(parts) or "cached tokens not reported"


def _cached_cell(v: dict, u: Usage) -> tuple[int, str]:
    """(cached tokens to draw, cell HTML) for one version, per model when usage_by_model is stored."""
    by_model = {k: _usage(x) for k, x in (v.get("usage_by_model") or {}).items()}
    if not by_model:  # histories written before usage_by_model existed
        cached = min(u.cached_tokens, u.prompt_tokens) if u.cached_reported else 0
        txt = (f"{_fmt_int(u.cached_tokens)} <small class='note'>({100 * u.cached_tokens / u.prompt_tokens:.0f}%)</small>"
               if u.cached_reported and u.prompt_tokens else ("0" if u.cached_reported else "n/a"))
        return cached, txt
    reporting, silent = cached_by_model(by_model)
    lines = [f"{_fmt_int(mu.cached_tokens)} of {_fmt_int(mu.prompt_tokens)}"
             f"{f' ({100 * mu.cached_tokens / mu.prompt_tokens:.0f}%)' if mu.prompt_tokens else ''} "
             f"<small class='note'>{_e(_short_model(m))}</small>" for m, mu in reporting]
    if silent:
        lines.append("<small class='note'>n/a: " + ", ".join(_e(_short_model(m)) for m in silent) + "</small>")
    cached = min(sum(mu.cached_tokens for _, mu in reporting), u.prompt_tokens)
    return cached, "<br>".join(lines) or "n/a"


def _cost_table(vs: list[dict]) -> str:
    if not vs:
        return '<p class="note">No versions yet.</p>'
    usages = {v["version"]: _usage(v.get("usage")) for v in vs}
    max_tok = max([u.prompt_tokens + u.completion_tokens for u in usages.values()] + [1])
    rows = []
    for v in vs:
        u = usages[v["version"]]
        cached, cached_txt = _cached_cell(v, u)
        fresh = u.prompt_tokens - cached
        w = lambda n: f"{100 * n / max_tok:.2f}%"  # noqa: E731
        phases = v.get("usage_by_phase") or {}
        tip = " · ".join(f"{k}: {_fmt_int(_usage(p).prompt_tokens + _usage(p).completion_tokens)} tok, "
                         f"{_money(_usage(p).cost_usd)}" for k, p in sorted(phases.items())) or "no usage recorded"
        rows.append(
            f'<tr><td>v{v["version"]}</td><td><span class="pill {_e(v.get("status", ""))}">{_e(v.get("status", ""))}</span></td>'
            f'<td style="min-width:200px" title="{_e(tip)}"><div class="bar" style="width:{w(u.prompt_tokens + u.completion_tokens)}">'
            f'<span style="width:{100 * fresh / max(1, u.prompt_tokens + u.completion_tokens):.2f}%;background:var(--bar-prompt)"></span>'
            f'<span style="width:{100 * cached / max(1, u.prompt_tokens + u.completion_tokens):.2f}%;background:var(--bar-cached)"></span>'
            f'<span style="width:{100 * u.completion_tokens / max(1, u.prompt_tokens + u.completion_tokens):.2f}%;background:var(--bar-out)"></span>'
            f'</div></td><td class="num">{_fmt_int(u.requests)}</td><td class="num">{_fmt_int(u.prompt_tokens)}</td>'
            f'<td class="num">{cached_txt}</td><td class="num">{_fmt_int(u.completion_tokens)}</td>'
            f'<td class="num">{_money(u.cost_usd)}</td></tr>')
    legend = ('<div class="legend"><span><span class="sw" style="background:var(--bar-prompt)"></span>prompt tokens</span>'
              '<span><span class="sw" style="background:var(--bar-cached)"></span>cached prompt tokens (Crusoe prefix cache)</span>'
              '<span><span class="sw" style="background:var(--bar-out)"></span>completion tokens</span>'
              '<span>Cached is per model: "n/a" means that model (Lightning, the worker) never reports cached '
              'tokens, not that the cache missed</span></div>')
    return ('<table><thead><tr><th>Version</th><th>Status</th><th>Tokens</th><th class="num">Requests</th>'
            '<th class="num">Prompt</th><th class="num">Cached</th><th class="num">Completion</th><th class="num">Cost</th>'
            '</tr></thead><tbody>' + "".join(rows) + "</tbody></table>" + legend)


def _calls_table(llm_calls: list[dict]) -> str:
    agg: dict[str, dict[str, Any]] = {}
    for c in llm_calls:
        m = str(c.get("model", "?"))
        a = agg.setdefault(m, {"n": 0, "p": 0, "c": 0, "k": 0, "rep": False, "cost": 0.0, "lat": 0})
        a["n"] += 1
        a["p"] += int(c.get("prompt_tokens") or 0)
        a["c"] += int(c.get("completion_tokens") or 0)
        a["k"] += int(c.get("cached_tokens") or 0)
        a["rep"] = a["rep"] or bool(c.get("cached_reported"))
        a["cost"] += float(c.get("cost_usd") or 0.0)
        a["lat"] += int(c.get("latency_ms") or 0)
    rows = []
    for m, a in sorted(agg.items()):
        cached = (f"{_fmt_int(a['k'])} ({100 * a['k'] / a['p']:.0f}%)" if a["rep"] and a["p"] else
                  ("0" if a["rep"] else "n/a"))
        rows.append(f'<tr><td>{_e(m)}</td><td class="num">{_fmt_int(a["n"])}</td><td class="num">{_fmt_int(a["p"])}</td>'
                    f'<td class="num">{cached}</td><td class="num">{_fmt_int(a["c"])}</td>'
                    f'<td class="num">{a["lat"] / max(1, a["n"]) / 1000:.1f}s</td><td class="num">{_money(a["cost"])}</td></tr>')
    return ('<table><thead><tr><th>Model (Crusoe Managed Inference)</th><th class="num">Calls</th><th class="num">Prompt</th>'
            '<th class="num">Cached</th><th class="num">Completion</th><th class="num">Avg latency</th>'
            '<th class="num">Cost</th></tr></thead><tbody>' + "".join(rows) + "</tbody></table>"
            '<p class="note">Every call in runs/llm_calls.jsonl (cumulative across all runs in this runs directory, '
            'including bench-check (bug planter), ping, reviewer retries and earlier or aborted runs), so it can '
            'exceed the per-version totals above.</p>')


def _diff_href(v: dict, artifacts: dict) -> str | None:
    art = artifacts.get(v["version"]) or artifacts.get(str(v["version"])) or {}
    if art.get("diff_href"):
        return art["diff_href"]
    p = v.get("diff_path")
    if not p:
        return None
    return p[len("runs/"):] if p.startswith("runs/") else p


def _versions_table(vs: list[dict], artifacts: dict) -> str:
    if not vs:
        return '<p class="note">No versions yet.</p>'
    rows = []
    for v in sorted(vs, key=lambda v: v["version"], reverse=True):
        s = v.get("holdout_score", -1.0)
        href = _diff_href(v, artifacts)
        link = f'<a href="{_e(href)}">diff</a>' if href else "—"
        regs, imps = list(v.get("regressions") or []), list(v.get("improvements") or [])
        if v["version"] == 0 or v.get("holdout_score", -1) < 0:
            changes = "—"
        else:
            changes = (f'<span class="up">▲ {len(imps)}</span> <span class="down">▼ {len(regs)}</span>'
                       + "".join(f'<div class="ids"><span class="up">▲</span> {_e(t)}</div>' for t in imps)
                       + "".join(f'<div class="ids"><span class="down">▼</span> {_e(t)}</div>' for t in regs))
        rationale = _e(v.get("rationale") or "")
        diag = v.get("diagnosis") or ""
        gate = v.get("gate_reason") or ""
        detail = ""
        if diag or gate:
            detail = ('<details><summary>diagnosis &amp; gate</summary>'
                      + (f"<p>{_e(diag)}</p>" if diag else "") + (f"<p><b>Gate:</b> {_e(gate)}</p>" if gate else "")
                      + "</details>")
        parent = f"v{v['parent']}" if v.get("parent") is not None else "—"
        rows.append(
            f'<tr><td>v{v["version"]}</td><td><span class="pill {_e(v.get("status", ""))}">{_e(v.get("status", ""))}</span></td>'
            f'<td class="num">{_e(v.get("round", 0))}</td><td>{parent}</td><td class="num">{_pct(s)}</td>'
            f'<td class="num">{_signed_pct(v.get("delta")) if v["version"] > 0 else "—"}</td>'
            f'<td style="white-space:nowrap">{changes}</td><td style="min-width:240px">{rationale}{detail}</td><td>{link}</td></tr>')
    return ('<table><thead><tr><th>Version</th><th>Status</th><th class="num">Round</th><th>Parent</th>'
            '<th class="num">Holdout</th><th class="num">Δ vs incumbent</th><th>Tasks improved / regressed</th>'
            '<th>Rationale</th><th>Diff</th></tr></thead><tbody>' + "".join(rows) + "</tbody></table>")


def _render_diff(diff: str) -> str:
    lines = []
    for ln in diff.splitlines():
        if ln.startswith("+++") or ln.startswith("---"):
            lines.append(f'<span class="hunk">{_e(ln)}</span>')
        elif ln.startswith("@@"):
            lines.append(f'<span class="hunk">{_e(ln)}</span>')
        elif ln.startswith("+"):
            lines.append(f'<span class="add">{_e(ln)}</span>')
        elif ln.startswith("-"):
            lines.append(f'<span class="del">{_e(ln)}</span>')
        else:
            lines.append(f'<span class="ctx">{_e(ln)}</span>')
    return '<pre class="diff">' + "".join(lines) + "</pre>"


def _latest_diff_section(vs: list[dict], incumbent: int | None, artifacts: dict) -> str:
    def art(ver: int) -> dict:
        return artifacts.get(ver) or artifacts.get(str(ver)) or {}

    accepted = [v for v in vs if v["version"] > 0 and v.get("status") in ACCEPTED]
    cumulative = ""
    cur_ver = incumbent if incumbent is not None else (vs[0]["version"] if vs else None)
    playbook = art(cur_ver).get("playbook") if cur_ver is not None else None
    pb_html = (f"<pre>{_e(playbook)}</pre>" if playbook else '<p class="note">Playbook text unavailable.</p>')
    if accepted:
        latest = max(accepted, key=lambda v: v["version"])
        diff = art(latest["version"]).get("diff")
        head = (f'<p class="sub">v{latest["version"]} (from v{latest.get("parent")}): {_e(latest.get("gate_reason", ""))}</p>'
                '<div class="why">'
                + (f'<p><b>Diagnosis:</b> {_e(latest["diagnosis"])}</p>' if latest.get("diagnosis") else "")
                + (f'<p><b>Rationale:</b> {_e(latest["rationale"])}</p>' if latest.get("rationale") else "")
                + "</div>")
        seed = art(0).get("playbook")
        if seed and playbook and latest["version"] != (vs[0]["version"] if vs else 0) and \
                latest.get("parent") not in (None, 0):
            from ratchet.reviewer import unified_diff

            cum = unified_diff(seed, playbook, old_name="v0/playbook.md", new_name=f"v{cur_ver}/playbook.md")
            cumulative = (f'<details style="margin-top:12px"><summary>Cumulative change v0 → v{cur_ver}</summary>'
                          f'<div class="panel" style="margin-top:8px">{_render_diff(cum)}</div></details>')
        diff_html = _render_diff(diff) if diff else '<p class="note">Diff text unavailable.</p>'
        left_title = f"Diff v{latest.get('parent')} → v{latest['version']}"
    else:
        rejected = [v for v in vs if v.get("status") == "rejected"]
        head = '<p class="sub">No edit has been accepted yet: the seed playbook is still the incumbent.</p>'
        if rejected:
            last = max(rejected, key=lambda v: v["version"])
            diff = art(last["version"]).get("diff")
            left_title = f"Most recent rejected diff (v{last['version']})"
            diff_html = (_render_diff(diff) if diff else '<p class="note">Diff text unavailable.</p>') + \
                f'<p class="note">{_e(last.get("gate_reason", ""))}</p>'
        else:
            left_title = "Diff"
            diff_html = '<p class="note">No candidate edits yet.</p>'
    title_pb = f"Current playbook (v{cur_ver})" if cur_ver is not None else "Current playbook"
    return (head + '<div class="twocol">'
            f'<div class="panel"><h3 style="margin:0 0 8px;font-size:14px">{_e(left_title)}</h3>{diff_html}</div>'
            f'<div class="panel"><h3 style="margin:0 0 8px;font-size:14px">{_e(title_pb)}</h3>{pb_html}</div></div>'
            + cumulative)


def _rate_color(rate: float) -> str:
    hue = 4 + 146 * max(0.0, min(1.0, rate))
    return f"hsl({hue:.0f},58%,40%)"


def _task_grid(history: dict, vs: list[dict]) -> str:
    evaluated = [v for v in vs if v.get("holdout_score", -1) is not None and v.get("holdout_score", -1) >= 0]
    task_ids = list(history.get("holdout_task_ids") or [])
    for v in evaluated:
        for t in (v.get("per_task") or {}):
            if t not in task_ids:
                task_ids.append(t)
    if not evaluated or not task_ids:
        return '<p class="note">No holdout evaluations yet.</p>'
    head = "".join(f'<th class="v">v{v["version"]}<br><span class="pill {_e(v.get("status", ""))}" '
                   f'style="font-size:10px">{_e(v.get("status", ""))}</span></th>' for v in evaluated)
    rows = []
    for t in task_ids:
        cells = []
        for v in evaluated:
            pt = v.get("per_task") or {}
            if t not in pt:
                cells.append('<td class="empty">·</td>')
                continue
            rate = float(pt[t])
            reps = int(v.get("repeats") or 1)
            passed = round(rate * reps)
            cells.append(f'<td class="cell" style="background:{_rate_color(rate)}" '
                         f'title="{_e(t)} · v{v["version"]}: {passed}/{reps} passed">{passed}/{reps}</td>')
        rows.append(f"<tr><td>{_e(t)}</td>{''.join(cells)}</tr>")
    return ('<table class="grid"><thead><tr><th>Holdout task</th>' + head + '</tr></thead><tbody>'
            + "".join(rows) + "</tbody></table>")


# --------------------------------------------------------------------------- page


def _split_calls(llm_calls: list[dict], since: str | None) -> tuple[list[dict], list[dict]]:
    """(calls of this history, bench-check calls). This history = ledger lines stamped at or after v0 was
    created (the ledger is append-only and survives --fresh, so it also holds earlier/aborted runs)."""
    bench = [c for c in llm_calls if str(c.get("tag", "")).startswith("bench-check")]
    if not since:
        return [c for c in llm_calls if not str(c.get("tag", "")).startswith("bench-check")], bench
    mine = [c for c in llm_calls if str(c.get("ts", "")) >= since and not str(c.get("tag", "")).startswith("bench-check")]
    return mine, bench


def _sandbox_note(counts: dict[str, int] | None) -> str:
    if not counts:
        return ""
    names = {"docker": "docker, network off", "seatbelt": "macOS seatbelt", "unsandboxed": "UNSANDBOXED",
             "": "not recorded"}
    order = ["docker", "seatbelt", "unsandboxed", ""]
    parts = [f"{names.get(k, k)} {counts[k]}" for k in order + sorted(set(counts) - set(order)) if counts.get(k)]
    return " · hidden tests ran in: " + ", ".join(parts)


def render_report(history: dict, *, llm_calls: list[dict] | None = None, now: str | None = None,
                  artifacts: dict | None = None, sandbox_counts: dict[str, int] | None = None) -> str:
    history = history or {}
    artifacts = artifacts or {}
    vs = sorted([v for v in history.get("versions", []) if isinstance(v, dict) and "version" in v],
                key=lambda v: v["version"])
    by_v = {v["version"]: v for v in vs}
    inc = history.get("incumbent")
    if inc is None:
        inc_rows = [v for v in vs if v.get("status") == "incumbent"]
        inc = inc_rows[-1]["version"] if inc_rows else None
    inc_rec = by_v.get(inc) if inc is not None else None
    tried = [v for v in vs if v["version"] > 0]
    n_acc = sum(1 for v in tried if v.get("status") in ACCEPTED)
    n_rej = sum(1 for v in tried if v.get("status") == "rejected")
    n_pending = sum(1 for v in tried if v.get("status") in ("candidate", "failed"))
    version_cost = sum(_usage(v.get("usage")).cost_usd for v in vs)
    total_tokens = sum(_usage(v.get("usage")).prompt_tokens + _usage(v.get("usage")).completion_tokens for v in vs)
    v0 = by_v.get(0)
    all_cost = None
    if llm_calls:
        mine, bench = _split_calls(llm_calls, (v0 or {}).get("created_at"))
        all_cost = sum(float(c.get("cost_usd") or 0.0) for c in mine)
        bench_cost = sum(float(c.get("cost_usd") or 0.0) for c in bench)
        ledger_cost = sum(float(c.get("cost_usd") or 0.0) for c in llm_calls)
    gain = None
    if inc_rec and v0 and inc_rec.get("holdout_score", -1) >= 0 and v0.get("holdout_score", -1) >= 0:
        gain = inc_rec["holdout_score"] - v0["holdout_score"]
    cfg = history.get("config") or {}
    live = bool(history.get("live"))
    now = now or utcnow()

    title = f"Ratchet — playbook v{inc}" if inc is not None else "Ratchet — no incumbent yet"
    tiles = [
        ("Incumbent holdout score", _pct(inc_rec.get("holdout_score")) if inc_rec else "—",
         f"v0 {_pct(v0.get('holdout_score'))}" if v0 else ""),
        ("Gain over seed", _signed_pct(gain) if gain is not None else "—", ""),
        ("Versions tried", str(len(tried)), f"{n_acc} accepted · {n_rej} rejected" + (f" · {n_pending} pending" if n_pending else "")),
        ("Cost (versions)", _money(version_cost), f"{_fmt_int(total_tokens)} tokens"),
    ]
    if all_cost is not None:
        tiles.append(("Cost (all Crusoe calls, this history)", _money(all_cost),
                      f"{_fmt_int(len(mine))} calls since v0 · test-the-tests {_money(bench_cost)} · "
                      f"ledger total {_money(ledger_cost)}"))
    tiles_html = "".join(f'<div class="tile"><div class="k">{_e(k)}</div><div class="v">{_e(v)}</div>'
                         f'<div class="note">{_e(sub)}</div></div>' for k, v, sub in tiles)
    sub = (f"Holdout: {len(history.get('holdout_task_ids') or [])} sealed tasks × {_e(cfg.get('repeats', '?'))} repeats · "
           f"config {_e(cfg.get('name', '?'))} · worker host {_e(history.get('worker', '?'))} · "
           f"rounds completed {_e(history.get('rounds_completed', 0))}{_e(_sandbox_note(sandbox_counts))} · "
           f"generated {_e(now)}")
    legend = ('<div class="legend">'
              '<span><svg width="26" height="12"><line x1="0" x2="26" y1="6" y2="6" stroke="var(--accent)" stroke-width="3"/>'
              '<circle cx="13" cy="6" r="4.5" fill="var(--accent)"/></svg> accepted versions (the ratchet: only goes up)</span>'
              '<span><svg width="14" height="14"><circle cx="7" cy="7" r="5" fill="none" stroke="var(--reject)" '
              'stroke-width="2"/></svg> rejected candidate (rolled back; dashed line = distance from its parent)</span>'
              '<span><svg width="14" height="14"><circle cx="7" cy="7" r="5" fill="none" stroke="var(--pending)" '
              'stroke-width="2" stroke-dasharray="3 2"/></svg> being evaluated / failed</span></div>')
    refresh = '<meta http-equiv="refresh" content="20">' if live else ""
    live_badge = '<span class="live">LIVE</span>' if live else ""
    calls_html = (f"<h2>Crusoe usage by model</h2><div class=\"panel\">{_calls_table(llm_calls)}</div>"
                  if llm_calls else "")
    min_delta = cfg.get("min_delta")
    gate_rule = ("A candidate is kept only if it beats the incumbent on the sealed holdout by at least "
                 f"{_pct(min_delta) if isinstance(min_delta, (int, float)) and min_delta > 1e-6 else 'one net run'} "
                 "and no holdout task scores lower than it did under the incumbent; otherwise it is rolled back.")
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
{refresh}<title>Ratchet scoreboard</title><style>{CSS}</style></head>
<body><main>
<h1>{_e(title)}{live_badge}</h1>
<p class="sub">{sub}</p>
<div class="tiles">{tiles_html}</div>
<h2>Scoreboard</h2>
<div class="panel">{_scoreboard_svg(vs)}{legend}<p class="note">{_e(gate_rule)}</p></div>
<h2>Cost per version</h2>
<div class="panel">{_cost_table(vs)}</div>
{calls_html}
<h2>Versions</h2>
<div class="panel">{_versions_table(vs, artifacts)}</div>
<h2>Latest accepted change</h2>
{_latest_diff_section(vs, inc, artifacts)}
<h2>Per-task holdout results</h2>
<div class="panel">{_task_grid(history, vs)}</div>
</main></body></html>
"""


def _read_llm_calls(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    try:
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if isinstance(d, dict):
                    out.append(d)
    except OSError as exc:
        log.warning("could not read %s: %s", path, exc)
    return out


def write_report(store: Any, out: Path | None = None) -> Path:
    from ratchet.store import write_text_atomic

    out = Path(out) if out else store.runs_dir / "report.html"
    if store.exists():
        history = store.load_history()
    else:
        history = {"schema": 1, "versions": [], "incumbent": None, "holdout_task_ids": [], "train_task_ids": []}
    artifacts: dict[int, dict[str, str]] = {}
    for v in history.get("versions", []):
        ver = v.get("version")
        if ver is None:
            continue
        vdir = store.version_dir(ver)
        art: dict[str, str] = {}
        pb, df = vdir / "playbook.md", vdir / "diff.patch"
        if pb.exists():
            art["playbook"] = pb.read_text(encoding="utf-8")
        if df.exists():
            art["diff"] = df.read_text(encoding="utf-8")
            art["diff_href"] = Path(os.path.relpath(df, out.resolve().parent)).as_posix()
        artifacts[ver] = art
    sandbox_counts: dict[str, int] = {}
    for v in history.get("versions", []):
        ver = v.get("version")
        if ver is None:
            continue
        try:
            for r in store.load_runs(ver, "holdout") + store.load_runs(ver, "train"):
                key = getattr(r, "sandbox", "") or ""
                sandbox_counts[key] = sandbox_counts.get(key, 0) + 1
        except Exception:  # noqa: BLE001 - the report must render even if a result file is odd
            pass
    html = render_report(history, llm_calls=_read_llm_calls(store.runs_dir / "llm_calls.jsonl"), artifacts=artifacts,
                         sandbox_counts=sandbox_counts)
    write_text_atomic(out, html)
    return out
