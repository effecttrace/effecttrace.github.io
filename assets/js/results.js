// Results page: stat tiles from data/summary.json, environment table and the
// synthetic benchmark chart. Every value is read from data; null shows "n/a".
import { el, clear, fetchJSON, get, isNum, fmtNum, fmtPct, fmtFixed, fmtBytes, fmtDate, shortSha,
  categoryLabel, statusKey, str, NA } from "./lib.js";

function stat(label, value, sub, cls, meter) {
  const na = value === NA;
  return el("div", { class: `stat ${cls || ""}${na ? " is-na" : ""}` }, [
    el("div", { class: "label", text: label }),
    el("div", { class: "value", text: value }),
    sub ? el("div", { class: "sub", text: sub }) : null,
    meter !== undefined && isNum(meter)
      ? el("div", { class: "meter", "aria-hidden": "true" }, el("span", { vars: { "--w": `${Math.max(0, Math.min(1, meter)) * 100}%` } }))
      : null,
  ]);
}

function errorBox(target, file, error) {
  clear(target);
  target.appendChild(el("p", { class: "error-box", text: `${file} is not available in this build (${error}).` }));
}

function tpfn(o) {
  if (!o || typeof o !== "object") return null;
  return `tp ${fmtNum(o.tp)} · fp ${fmtNum(o.fp)} · fn ${fmtNum(o.fn)}`;
}

function renderSummary(s) {
  // Scenarios
  const sc = document.getElementById("r-scenarios");
  clear(sc);
  const total = get(s, "scenarios.total");
  const keys = ["pass", "fail", "error", "unsupported"];
  const grid = el("div", { class: "stat-grid" }, [
    stat("Experiments", fmtNum(total), "scenarios in this run", "c-struct"),
    ...keys.map((k) => stat(k, fmtNum(get(s, `scenarios.${k}`)), null, `st-${k}-c`)),
  ]);
  sc.appendChild(grid);
  if (isNum(total) && total > 0) {
    const bar = el("div", { class: "status-bar", role: "img", "aria-label": keys.map((k) => `${k} ${fmtNum(get(s, `scenarios.${k}`))}`).join(", ") });
    const legend = el("div", { class: "status-legend" });
    for (const k of keys) {
      const v = get(s, `scenarios.${k}`);
      if (!isNum(v) || v <= 0) continue;
      bar.appendChild(el("span", { vars: { "--w": `${(v / total) * 100}%`, "--c": `var(--st-${k})` } }));
    }
    for (const k of keys) {
      legend.appendChild(el("span", {}, [el("i", { vars: { "--c": `var(--st-${k})` } }), `${k} ${fmtNum(get(s, `scenarios.${k}`))}`]));
    }
    sc.appendChild(el("div", { class: "mt-md" }, [bar, legend]));
  }
  const byCat = get(s, "byCategory");
  if (byCat && typeof byCat === "object" && Object.keys(byCat).length) {
    const rows = Object.entries(byCat).map(([cat, counts]) => el("tr", {}, [
      el("th", { scope: "row", text: categoryLabel(cat) }),
      ...keys.map((k) => el("td", { class: "num", text: fmtNum(get(counts || {}, k, 0)) })),
    ]));
    sc.appendChild(el("div", { class: "table-wrap mt-md" }, el("table", {}, [
      el("caption", { class: "visually-hidden", text: "Scenarios by category and status" }),
      el("thead", {}, el("tr", {}, [el("th", { scope: "col", text: "Category" }), ...keys.map((k) => el("th", { scope: "col", class: "num", text: k }))])),
      el("tbody", {}, rows),
    ])));
  }

  // Attribution
  const scope = document.getElementById("r-scope");
  scope.textContent = get(s, "attribution.scope") ? `Scope: ${str(get(s, "attribution.scope"))}.` : "";
  const at = document.getElementById("r-attribution");
  clear(at);
  const a = get(s, "attribution") || {};
  const sep = get(a, "concurrentSeparated");
  const sepN = get(a, "concurrentScenarios");
  at.appendChild(el("div", { class: "stat-grid" }, [
    stat("DIRECT precision", fmtPct(get(a, "direct.precision")), tpfn(get(a, "direct")), "c-direct", get(a, "direct.precision")),
    stat("DIRECT recall", fmtPct(get(a, "direct.recall")), tpfn(get(a, "direct")), "c-direct", get(a, "direct.recall")),
    stat("STRUCTURAL precision", fmtPct(get(a, "structural.precision")), tpfn(get(a, "structural")), "c-struct", get(a, "structural.precision")),
    stat("STRUCTURAL recall", fmtPct(get(a, "structural.recall")), tpfn(get(a, "structural")), "c-struct", get(a, "structural.recall")),
    stat("False attachments", fmtNum(get(a, "falseAttachments")), "changes attached that ground truth says are unrelated", "c-temporal"),
    stat("Unrelated telemetry attached", fmtNum(get(a, "unrelatedTelemetryAttachments")), "injected unrelated signals attached to an action", "c-temporal"),
    stat("Concurrent separation", isNum(sep) && isNum(sepN) ? `${sep}/${sepN}` : NA,
      isNum(get(a, "concurrentSeparationAccuracy")) ? `accuracy ${fmtPct(get(a, "concurrentSeparationAccuracy"))}` : "concurrent scenarios kept apart", "c-trace",
      get(a, "concurrentSeparationAccuracy")),
    stat("Ambiguous claims", fmtNum(get(a, "ambiguousClaims")), `attributed claims on changes ground truth calls ambiguous · ${fmtNum(get(a, "ambiguitiesReported"))} ambiguities reported`, "c-event"),
    stat("Actions scored", fmtNum(get(a, "actions")), "actions in scope", "c-struct"),
  ]));

  // Operational
  const op = get(s, "operational") || {};
  document.getElementById("r-opnote").textContent = str(get(op, "note"));
  const ot = document.getElementById("r-operational");
  clear(ot);
  const sec = (v) => (isNum(v) ? fmtFixed(v, 1) : NA);
  const ms = (v) => (isNum(v) ? fmtFixed(v, 1) : NA);
  const withUnit = (label, value, unit, sub, cls) => {
    const node = stat(label, value, sub, cls);
    if (value !== NA) node.querySelector(".value").appendChild(el("span", { class: "unit", text: unit }));
    return node;
  };
  ot.appendChild(el("div", { class: "stat-grid" }, [
    withUnit("Graph query p50", ms(get(op, "graphQueryMilliseconds.p50")), "ms", `p95 ${ms(get(op, "graphQueryMilliseconds.p95"))} ms · n=${fmtNum(get(op, "graphQueryMilliseconds.n"))}`, "c-trace"),
    withUnit("Graph query p95", ms(get(op, "graphQueryMilliseconds.p95")), "ms", `max ${ms(get(op, "graphQueryMilliseconds.max"))} ms`, "c-trace"),
    withUnit("Graph complete p50", sec(get(op, "graphCompleteSeconds.p50")), "s", `includes settle and telemetry windows · p95 ${sec(get(op, "graphCompleteSeconds.p95"))} s`, "c-temporal"),
  ]));

  // Failed list
  const failed = get(s, "failed");
  const fb = document.getElementById("r-failed");
  clear(fb);
  if (Array.isArray(failed) && failed.length) {
    fb.appendChild(el("h3", { text: `Scenarios that did not pass (${failed.length})` }));
    fb.appendChild(el("p", { class: "muted", text: "Listed as recorded. Each links to its checks on the experiments page." }));
    fb.appendChild(el("ul", { class: "list-check" }, failed.map((f) => {
      const text = str(f);
      const id = (text.match(/^([A-Za-z]+\d+)\b/) || [])[1];
      return el("li", { vars: { "--c": "var(--st-fail)" } }, id ? el("a", { href: `experiments.html#${id}`, text }) : text);
    })));
  } else if (Array.isArray(failed)) {
    fb.appendChild(el("p", { class: "muted", text: "Every scenario in this run passed." }));
  }

  const foot = document.getElementById("r-foot");
  clear(foot);
  foot.appendChild(el("span", { text: "Generated from test-results at commit " }));
  foot.appendChild(el("code", { text: shortSha(get(s, "commit")) + (get(s, "dirty") === true ? " (dirty)" : "") }));
  foot.appendChild(el("span", { text: `on ${fmtDate(get(s, "generatedAt"))}.` }));
  foot.appendChild(el("a", { href: "experiments.html", text: "Per-scenario details →" }));
}

function renderEnv(env) {
  const box = document.getElementById("r-env");
  clear(box);
  const rows = [];
  const comps = get(env, "components");
  if (comps && typeof comps === "object") {
    for (const [k, v] of Object.entries(comps)) rows.push([k, str(v)]);
  }
  const host = get(env, "host");
  if (host && typeof host === "object") {
    for (const [k, v] of Object.entries(host)) rows.push([`host.${k}`, str(v)]);
  }
  rows.push(["commit", shortSha(get(env, "commit"))]);
  rows.push(["capturedAt", fmtDate(get(env, "capturedAt"))]);
  box.appendChild(el("div", { class: "table-wrap" }, el("table", {}, [
    el("caption", { class: "visually-hidden", text: "Experiment environment" }),
    el("thead", {}, el("tr", {}, [el("th", { scope: "col", text: "Component" }), el("th", { scope: "col", text: "Version" })])),
    el("tbody", {}, rows.map(([k, v]) => el("tr", {}, [el("th", { scope: "row", class: "mono", text: k }), el("td", { class: "mono", text: v || NA })]))),
  ])));
}

function renderBench(b) {
  document.getElementById("b-desc").textContent = str(get(b, "description"));
  const box = document.getElementById("r-bench");
  clear(box);
  const list = Array.isArray(get(b, "benchmarks")) ? b.benchmarks.filter((x) => x && typeof x === "object") : [];
  if (!list.length) {
    box.appendChild(el("p", { class: "muted", text: "No benchmark entries in this build." }));
    return;
  }
  const groups = new Map();
  for (const x of list) {
    const name = str(x.name) || "unnamed";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(x);
  }
  const charts = el("div", { class: "grid grid-3" });
  for (const [name, items] of groups) {
    items.sort((p, q) => (p.concurrentActions || 0) - (q.concurrentActions || 0));
    const max = Math.max(...items.map((x) => (isNum(x.msPerOp) ? x.msPerOp : 0)), 0);
    const bars = el("div", { class: "bars", role: "list" });
    for (const x of items) {
      const v = x.msPerOp;
      bars.appendChild(el("div", { class: "bar-row", role: "listitem" }, [
        el("span", { class: "bl", text: `${fmtNum(x.concurrentActions)} action${x.concurrentActions === 1 ? "" : "s"}` }),
        el("span", { class: "bar-track", "aria-hidden": "true" }, el("span", { class: "bar-fill", vars: { "--w": max > 0 && isNum(v) ? `${(v / max) * 100}%` : "0%" } })),
        el("span", { class: "bv", text: isNum(v) ? `${v < 1 ? v.toFixed(3) : v.toFixed(2)} ms` : NA }),
      ]));
    }
    charts.appendChild(el("div", { class: "card bench-group" }, [
      el("h4", { text: name }),
      el("p", { class: "faint", text: "milliseconds per operation, by concurrent actions" }),
      bars,
    ]));
  }
  box.appendChild(charts);

  const rows = list.map((x) => el("tr", {}, [
    el("td", { class: "mono", text: str(x.name) }),
    el("td", { class: "num", text: fmtNum(x.concurrentActions) }),
    el("td", { class: "num", text: fmtNum(x.records) }),
    el("td", { class: "num", text: fmtNum(x.nsPerOp) }),
    el("td", { class: "num", text: fmtBytes(x.bytesPerOp) }),
    el("td", { class: "num", text: fmtNum(x.allocsPerOp) }),
    el("td", { class: "num", text: isNum(x.recordsPerSecond) ? fmtNum(x.recordsPerSecond) : "–" }),
  ]));
  box.appendChild(el("div", { class: "table-wrap mt-md" }, el("table", {}, [
    el("caption", { class: "visually-hidden", text: "Synthetic benchmark measurements" }),
    el("thead", {}, el("tr", {}, ["Benchmark", "Actions", "Records", "ns/op", "Bytes/op", "Allocs/op", "Records/s"].map((h, i) =>
      el("th", { scope: "col", class: i ? "num" : null, text: h })))),
    el("tbody", {}, rows),
  ])));

  const heap = get(b, "retainedHeapBytesPerAction");
  if (heap && typeof heap === "object" && Object.keys(heap).length) {
    const entries = Object.entries(heap).sort((p, q) => Number(p[0]) - Number(q[0]));
    box.appendChild(el("h3", { class: "mt-lg", text: "Retained heap per action" }));
    box.appendChild(el("div", { class: "table-wrap" }, el("table", {}, [
      el("caption", { class: "visually-hidden", text: "Retained heap bytes per action by concurrent actions" }),
      el("thead", {}, el("tr", {}, [el("th", { scope: "col", text: "Concurrent actions" }), el("th", { scope: "col", class: "num", text: "Retained heap per action" })])),
      el("tbody", {}, entries.map(([k, v]) => el("tr", {}, [el("td", { text: k }), el("td", { class: "num", text: fmtBytes(v) })]))),
    ])));
  }
  const foot = el("p", { class: "data-foot" }, [
    el("span", { text: "Benchmark commit " }), el("code", { text: shortSha(get(b, "commit")) }),
    el("span", { text: `· generated ${fmtDate(get(b, "generatedAt"))}` }),
    get(b, "host") ? el("span", { text: `· host ${Object.entries(get(b, "host")).map(([k, v]) => `${k}=${str(v)}`).join(" ")}` }) : null,
  ]);
  box.appendChild(foot);
}

async function main() {
  const [sum, env, bench] = await Promise.all([
    fetchJSON("data/summary.json"), fetchJSON("data/environment.json"), fetchJSON("data/benchmarks.json"),
  ]);
  if (sum.ok && sum.data && typeof sum.data === "object") renderSummary(sum.data);
  else {
    errorBox(document.getElementById("r-scenarios"), "data/summary.json", sum.error || "invalid");
    errorBox(document.getElementById("r-attribution"), "data/summary.json", sum.error || "invalid");
    errorBox(document.getElementById("r-operational"), "data/summary.json", sum.error || "invalid");
  }
  if (env.ok && env.data && typeof env.data === "object") renderEnv(env.data);
  else errorBox(document.getElementById("r-env"), "data/environment.json", env.error || "invalid");
  if (bench.ok && bench.data && typeof bench.data === "object") renderBench(bench.data);
  else errorBox(document.getElementById("r-bench"), "data/benchmarks.json", bench.error || "invalid");
}

main();
