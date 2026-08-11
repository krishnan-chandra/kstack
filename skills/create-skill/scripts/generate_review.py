#!/usr/bin/env python3
"""Generate a self-contained static HTML review page for one iteration.

Usage:
  python3 generate_review.py <iteration-dir>
      [--skill-name <name>]
      [--benchmark <iteration-dir>/benchmark.json]
      [--previous-workspace <iteration-(N-1)-dir>]
      [--out /tmp/review.html]

The page has two tabs:
  - Outputs: one test case at a time — prompt, with-skill vs baseline outputs
    (rendered inline where possible), formal grades, timing/tokens, and a
    feedback box per run. Feedback is exported as feedback.json and can be
    imported again later.
  - Benchmark: pass rates, time, and tokens per configuration from
    benchmark.json, plus the analyst notes.

No server is needed; open the generated file directly in a browser.
"""

import argparse
import base64
import json
import mimetypes
import sys
from pathlib import Path

TEXT_EXTS = {".txt", ".md", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".toml",
             ".py", ".js", ".ts", ".sh", ".html", ".css", ".sql", ".xml", ".log"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
MAX_INLINE_TEXT = 60_000
MAX_INLINE_IMAGE = 2_000_000


def iter_runs(config_dir: Path) -> list[Path]:
    runs = sorted(config_dir.glob("run-*"))
    return runs if runs else [config_dir]


def render_file(path: Path) -> dict:
    ext = path.suffix.lower()
    if ext in TEXT_EXTS and path.stat().st_size <= MAX_INLINE_TEXT:
        try:
            return {"name": path.name, "kind": "text",
                    "content": path.read_text(encoding="utf-8", errors="replace")}
        except OSError:
            pass
    if ext in IMAGE_EXTS and path.stat().st_size <= MAX_INLINE_IMAGE:
        try:
            b64 = base64.b64encode(path.read_bytes()).decode("ascii")
            return {"name": path.name, "kind": "image", "content": f"data:image/{ext[1:]};base64,{b64}"}
        except OSError:
            pass
    return {"name": path.name, "kind": "file", "content": str(path.resolve())}


def collect_run(run_dir: Path) -> dict:
    files = []
    outputs = run_dir / "outputs"
    if outputs.is_dir():
        files = [render_file(p) for p in sorted(outputs.iterdir()) if p.is_file()]
    timing = {}
    if (run_dir / "timing.json").exists():
        timing = json.loads((run_dir / "timing.json").read_text(encoding="utf-8"))
    grading = None
    if (run_dir / "grading.json").exists():
        grading = json.loads((run_dir / "grading.json").read_text(encoding="utf-8"))
    return {"files": files, "timing": timing, "grading": grading}


def collect_eval(edir: Path, prev_root: Path | None) -> dict:
    meta = {}
    if (edir / "eval_metadata.json").exists():
        meta = json.loads((edir / "eval_metadata.json").read_text(encoding="utf-8"))
    name = meta.get("eval_name", edir.name.removeprefix("eval-"))
    configs = {}
    for config in sorted(p.name for p in edir.iterdir() if p.is_dir() and p.name != "work"):
        runs = []
        for run_dir in iter_runs(edir / config):
            run = collect_run(run_dir)
            run["run_dir"] = str(run_dir)
            runs.append(run)
        configs[config] = runs

    prev = None
    if prev_root is not None:
        prev_eval = prev_root / edir.name
        if prev_eval.is_dir():
            prev = {}
            for config in sorted(p.name for p in prev_eval.iterdir() if p.is_dir() and p.name != "work"):
                runs = []
                for run_dir in iter_runs(prev_eval / config):
                    run = collect_run(run_dir)
                    run["run_dir"] = str(run_dir)
                    runs.append(run)
                prev[config] = runs

    return {"id": meta.get("eval_id", 0), "name": name,
            "prompt": meta.get("prompt", "(prompt not recorded)"),
            "expected_output": meta.get("expected_output", ""),
            "configs": configs, "previous": prev}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("iteration_dir")
    ap.add_argument("--skill-name", default=None)
    ap.add_argument("--benchmark", default=None, help="path to benchmark.json")
    ap.add_argument("--previous-workspace", default=None, help="previous iteration dir for diff view")
    ap.add_argument("--out", default=None, help="output html path (default: /tmp/review-<name>.html)")
    args = ap.parse_args()

    root = Path(args.iteration_dir)
    eval_dirs = sorted(root.glob("eval-*"))
    if not eval_dirs:
        print(f"error: no eval-* directories in {root}", file=sys.stderr)
        return 2
    prev_root = Path(args.previous_workspace) if args.previous_workspace else None

    evals = [collect_eval(e, prev_root) for e in eval_dirs]
    benchmark = None
    if args.benchmark:
        try:
            benchmark = json.loads(Path(args.benchmark).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"warning: cannot read benchmark: {exc}", file=sys.stderr)

    skill_name = args.skill_name or root.name
    out = Path(args.out) if args.out else Path(f"/tmp/review-{skill_name}-{root.name}.html")
    data = {"skill_name": skill_name, "iteration": root.name, "evals": evals, "benchmark": benchmark}

    # Escape `</` so user/agent output inside the embedded JSON cannot break the page
    template = TEMPLATE.replace("__TITLE__", f"Skill review — {skill_name} ({root.name})")
    template = template.replace("__DATA__", json.dumps(data).replace("</", "<\\/"))
    out.write_text(template, encoding="utf-8")
    print(f"wrote {out}")
    return 0


TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>__TITLE__</title>
<style>
  :root { --fg:#1f2328; --muted:#656d76; --bg:#ffffff; --accent:#0969da; --border:#d0d7de; --pass:#1a7f37; --fail:#cf222e; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--fg); margin: 0; background: #f6f8fa; }
  header { background: var(--bg); border-bottom: 1px solid var(--border); padding: 12px 20px; display: flex; align-items: center; gap: 16px; position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 16px; margin: 0; }
  header .sub { color: var(--muted); font-size: 12px; }
  .tabs { display: flex; gap: 4px; margin-left: auto; }
  .tab { padding: 6px 14px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); cursor: pointer; font-size: 13px; }
  .tab.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  main { max-width: 1100px; margin: 0 auto; padding: 20px; }
  .card { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; }
  .nav { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; }
  .nav button { padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); cursor: pointer; }
  h2 { font-size: 15px; margin: 0 0 8px; }
  h3 { font-size: 13px; margin: 12px 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .prompt { background: #f6f8fa; border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; white-space: pre-wrap; font-size: 13px; }
  .config { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 900px) { .config { grid-template-columns: 1fr; } }
  .col { border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
  .col h4 { margin: 0 0 8px; font-size: 13px; }
  .col.ws { border-color: #1a7f37; } .col.baseline { border-color: #9a6700; }
  .meta { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
  .files { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  .file-chip { font-size: 12px; padding: 2px 8px; background: #eff2f5; border-radius: 10px; }
  pre { background: #0d1117; color: #e6edf3; padding: 12px; border-radius: 6px; overflow: auto; max-height: 420px; font-size: 12px; }
  img { max-width: 100%; border-radius: 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
  .pass { color: var(--pass); font-weight: 600; } .fail { color: var(--fail); font-weight: 600; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .badge.pass { background: #dafbe1; color: var(--pass); } .badge.fail { background: #ffebe9; color: var(--fail); }
  textarea { width: 100%; min-height: 70px; border: 1px solid var(--border); border-radius: 6px; padding: 8px; font-family: inherit; font-size: 13px; resize: vertical; }
  details { border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; margin-top: 8px; }
  summary { cursor: pointer; font-size: 13px; color: var(--muted); }
  .empty { color: var(--muted); font-size: 12px; font-style: italic; }
  .btn { padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); cursor: pointer; font-size: 13px; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .run-select { font-size: 12px; margin-bottom: 6px; color: var(--muted); }
  .note { font-size: 12px; color: var(--muted); margin: 4px 0; }
</style>
</head>
<body>
<header>
  <h1 id="title">Skill review</h1>
  <span class="sub" id="subtitle"></span>
  <div class="tabs">
    <button class="tab active" id="tab-outputs" onclick="showTab('outputs')">Outputs</button>
    <button class="tab" id="tab-benchmark" onclick="showTab('benchmark')">Benchmark</button>
  </div>
</header>
<main>
  <section id="view-outputs"></section>
  <section id="view-benchmark" style="display:none"></section>
</main>
<script>
const DATA = __DATA__;
const feedback = {};   // run_id -> text
const runIds = new Set();
let idx = 0;

function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function fmtBytes(n) { return n > 1048576 ? (n/1048576).toFixed(1)+' MB' : n > 1024 ? (n/1024).toFixed(1)+' KB' : n+' B'; }
function runId(evalName, config, i, j) { return evalName + '-' + config + (i > 0 ? '-run'+(i+1) : '') + '-' + j; }

function renderFiles(files) {
  if (!files || !files.length) return '<div class="empty">no output files</div>';
  let chips = '<div class="files">' + files.map(f => '<span class="file-chip">' + esc(f.name) + '</span>').join('') + '</div>';
  let bodies = '';
  files.forEach(f => {
    if (f.kind === 'text') bodies += '<details><summary>' + esc(f.name) + '</summary><pre>' + esc(f.content) + '</pre></details>';
    else if (f.kind === 'image') bodies += '<details><summary>' + esc(f.name) + '</summary><img src="' + f.content + '" alt="' + esc(f.name) + '"></details>';
    else bodies += '<details><summary>' + esc(f.name) + ' (' + fmtBytes((f.content||'').length) + '…path)</summary><div class="note">' + esc(f.content) + '</div></details>';
  });
  return chips + bodies;
}

function renderGrading(grading) {
  if (!grading) return '<div class="empty">no formal grades</div>';
  const ex = grading.expectations || [];
  if (!ex.length) return '<div class="empty">no formal grades</div>';
  let rows = ex.map(e => {
    const badge = e.passed === true ? '<span class="badge pass">pass</span>' : e.passed === false ? '<span class="badge fail">fail</span>' : '<span class="badge">pending</span>';
    return '<tr><td>' + badge + '</td><td>' + esc(e.text) + '</td><td>' + esc(e.evidence || '') + '</td></tr>';
  }).join('');
  return '<table><tr><th></th><th>Assertion</th><th>Evidence</th></tr>' + rows + '</table>';
}

function renderColumn(evalName, config, runs, cls, label, j) {
  if (!runs || !runs.length) return '<div class="col ' + cls + '"><h4>' + esc(label) + '</h4><div class="empty">no runs</div></div>';
  let out = '<div class="col ' + cls + '"><h4>' + esc(label) + '</h4>';
  runs.forEach((run, i) => {
    const id = runId(evalName, config, i, j);
    runIds.add(id);
    const t = run.timing || {};
    out += '<div class="run-select">' + (runs.length > 1 ? 'run ' + (i+1) + ' — ' : '') + 'tokens ' + (t.total_tokens ?? '?') +
           ' · ' + (t.total_duration_seconds ?? '?') + 's · model ' + esc(t.model || '?') +
           (t.triggered === false ? ' · <b style="color:#9a6700">SKILL NOT TRIGGERED</b>' : '') + '</div>';
    out += renderFiles(run.files);
    out += '<h3>Formal grades</h3>' + renderGrading(run.grading);
    out += '<h3>Feedback</h3><textarea id="fb-' + id + '" placeholder="Anything to change? Leave empty if it looks good."></textarea>';
  });
  out += '</div>';
  return out;
}

function renderEval(e, j) {
  let cols = '';
  const order = Object.keys(e.configs).sort((a, b) => {
    const ka = (a === 'with_skill' || a === 'old_skill') ? 0 : 1;
    const kb = (b === 'with_skill' || b === 'old_skill') ? 0 : 1;
    return ka - kb || a.localeCompare(b);
  });
  order.forEach((config, ci) => {
    const label = config === 'with_skill' ? 'With skill' : config === 'old_skill' ? 'Old skill (baseline)' : config === 'without_skill' ? 'Without skill (baseline)' : config;
    const cls = (config === 'with_skill' || config === 'old_skill') ? 'ws' : 'baseline';
    cols += renderColumn(e.name, config, e.configs[config], cls, label, j);
  });
  let prev = '';
  if (e.previous) {
    let prevHtml = '';
    order.forEach(config => {
      const runs = e.previous[config] || [];
      runs.forEach((run, i) => { prevHtml += renderFiles(run.files); });
    });
    prev = '<details><summary>Previous iteration outputs</summary>' + prevHtml + '</details>';
  }
  return '<div class="card"><h2>' + esc(e.name) + '</h2>' +
    '<h3>Prompt</h3><div class="prompt">' + esc(e.prompt) + '</div>' +
    (e.expected_output ? '<h3>Expected</h3><div class="prompt">' + esc(e.expected_output) + '</div>' : '') +
    '<h3>Comparison</h3><div class="config">' + cols + '</div>' + prev + '</div>';
}

function renderOutputs() {
  const html = '<div class="nav"><button onclick="nav(-1)">← Prev</button><span id="counter"></span><button onclick="nav(1)">Next →</button></div>' +
    '<div id="eval-card">' + renderEval(DATA.evals[0], 0) + '</div>';
  document.getElementById('view-outputs').innerHTML = html;
  update();
  loadFeedback();
}

function nav(d) {
  idx = Math.max(0, Math.min(DATA.evals.length - 1, idx + d));
  saveFeedback();
  document.getElementById('eval-card').innerHTML = renderEval(DATA.evals[idx], idx);
  update();
  loadFeedback();
}

function update() {
  document.getElementById('counter').textContent = (idx + 1) + ' / ' + DATA.evals.length;
}

function fmtStat(s) { return s ? (s.mean ?? 0).toFixed(2) + ' ± ' + (s.stddev ?? 0).toFixed(2) : '—'; }

function renderBenchmark() {
  const b = DATA.benchmark;
  let html = '<div class="card"><h2>Benchmark</h2>';
  if (!b) { html += '<div class="empty">No benchmark.json provided.</div></div>'; document.getElementById('view-benchmark').innerHTML = html; return; }
  const rs = b.run_summary || {};
  let rows = '';
  Object.keys(rs).forEach(k => {
    if (k === 'delta') return;
    const s = rs[k];
    rows += '<tr><td>' + esc(k) + '</td><td>' + fmtStat(s.pass_rate) + '</td><td>' + fmtStat(s.time_seconds) + '</td><td>' + fmtStat(s.tokens) + '</td></tr>';
  });
  if (rs.delta) rows += '<tr><td><b>delta</b></td><td>' + esc(rs.delta.pass_rate ?? '') + '</td><td>' + esc(rs.delta.time_seconds ?? '') + '</td><td>' + esc(rs.delta.tokens ?? '') + '</td></tr>';
  html += '<table><tr><th>Configuration</th><th>Pass rate</th><th>Time (s)</th><th>Tokens</th></tr>' + rows + '</table>';
  const runs = b.runs || [];
  if (runs.length) {
    html += '<h3>Per eval</h3><table><tr><th>Eval</th><th>Config</th><th>Passed</th><th>Time</th><th>Tokens</th></tr>' +
      runs.map(r => '<tr><td>' + esc(r.eval_name ?? r.eval_id) + '</td><td>' + esc(r.configuration) + '</td><td>' + (r.result ? (r.result.passed + '/' + r.result.total) : '—') + '</td><td>' + (r.result ? r.result.time_seconds : '—') + '</td><td>' + (r.result ? r.result.tokens : '—') + '</td></tr>').join('') + '</table>';
  }
  const notes = b.notes || [];
  if (notes.length) html += '<h3>Analyst notes</h3><ul>' + notes.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>';
  html += '</div>';
  document.getElementById('view-benchmark').innerHTML = html;
}

function showTab(name) {
  document.getElementById('view-outputs').style.display = name === 'outputs' ? '' : 'none';
  document.getElementById('view-benchmark').style.display = name === 'benchmark' ? '' : 'none';
  document.getElementById('tab-outputs').classList.toggle('active', name === 'outputs');
  document.getElementById('tab-benchmark').classList.toggle('active', name === 'benchmark');
}

function collectFeedback() {
  const reviews = [];
  runIds.forEach(id => {
    const el = document.getElementById('fb-' + id);
    if (el) reviews.push({ run_id: id, feedback: el.value, timestamp: new Date().toISOString() });
  });
  return { reviews, status: 'complete' };
}

function saveFeedback() {
  const data = collectFeedback();
  try { localStorage.setItem('review-feedback-' + DATA.iteration, JSON.stringify(data)); } catch (e) {}
}

function loadFeedback() {
  try {
    const saved = JSON.parse(localStorage.getItem('review-feedback-' + DATA.iteration) || 'null');
    if (saved && saved.reviews) saved.reviews.forEach(r => {
      const el = document.getElementById('fb-' + r.run_id);
      if (el) el.value = r.feedback;
    });
  } catch (e) {}
}

function exportFeedback() {
  saveFeedback();
  const blob = new Blob([JSON.stringify(collectFeedback(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'feedback.json';
  a.click();
}

function importFeedback(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      (data.reviews || []).forEach(r => {
        const el = document.getElementById('fb-' + r.run_id);
        if (el) el.value = r.feedback;
        runIds.add(r.run_id);
      });
      saveFeedback();
    } catch (e) { alert('Could not parse feedback.json: ' + e); }
  };
  reader.readAsText(file);
}

document.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') nav(-1);
  if (e.key === 'ArrowRight') nav(1);
});
window.addEventListener('beforeunload', saveFeedback);

document.getElementById('title').textContent = 'Skill review — ' + DATA.skill_name;
document.getElementById('subtitle').textContent = DATA.iteration;
renderOutputs();
renderBenchmark();
</script>
</body>
</html>
"""


if __name__ == "__main__":
    sys.exit(main())
