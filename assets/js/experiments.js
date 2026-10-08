// Experiments page: renders every scenario in data/results.json, grouped by
// category, with status and category filter chips. Failures are never hidden.
import { el, clear, fetchJSON, get, isNum, fmtSeconds, fmtDate, shortSha, statusKey, statusBadge,
  evChip, categoryLabel, str, STATUS } from "./lib.js";

const CATEGORY_ORDER = ["live", "replay", "unsupported"];
const CATEGORY_DESC = {
  live: "Run against the kind lab: real MCP tool calls and kubectl actions, scored against an independent watch of the cluster.",
  replay: "Recorded observation streams replayed offline with delays, reordering, corruption or different windows.",
  unsupported: "Scenarios EffectTrace v0.1 does not support. They are reported as unsupported rather than silently skipped.",
};

const state = { category: "all", status: "all" };
let scenarios = [];
let replayByScenario = new Map();

function chip(label, value, count, group) {
  const pressed = state[group] === value;
  const b = el("button", { type: "button", class: "chip-btn", "aria-pressed": String(pressed), dataset: { group, value } }, [
    label, el("span", { class: "cnt", text: String(count) }),
  ]);
  b.addEventListener("click", () => {
    state[group] = value;
    renderFilters();
    renderList();
  });
  return b;
}

function renderFilters() {
  const box = document.getElementById("exp-filters");
  clear(box);
  const cats = orderedCategories();
  const catGroup = el("div", { class: "filter-group", role: "group", "aria-label": "Category" }, [
    el("span", { class: "fg-label", text: "Category" }),
    chip("All", "all", scenarios.length, "category"),
    ...cats.map((c) => chip(categoryLabel(c), c, scenarios.filter((s) => catOf(s) === c).length, "category")),
  ]);
  const statuses = [...STATUS];
  for (const s of scenarios) {
    const k = statusKey(s.status);
    if (!statuses.includes(k)) statuses.push(k);
  }
  const stGroup = el("div", { class: "filter-group", role: "group", "aria-label": "Status" }, [
    el("span", { class: "fg-label", text: "Status" }),
    chip("All", "all", scenarios.length, "status"),
    ...statuses.map((k) => chip(k, k, scenarios.filter((s) => statusKey(s.status) === k).length, "status")),
  ]);
  box.appendChild(catGroup);
  box.appendChild(stGroup);
}

function catOf(s) {
  return typeof s.category === "string" && s.category ? s.category : "uncategorized";
}

function orderedCategories() {
  const found = [...new Set(scenarios.map(catOf))];
  const ordered = CATEGORY_ORDER.filter((c) => found.includes(c));
  for (const c of found) if (!ordered.includes(c)) ordered.push(c);
  // Always show the three standard groups, even when a run has none of them.
  for (const c of CATEGORY_ORDER) if (!ordered.includes(c)) ordered.push(c);
  return ordered;
}

function scenarioCard(s) {
  const k = statusKey(s.status);
  const id = str(s.id);
  const checks = Array.isArray(s.checks) ? s.checks : [];
  const passed = checks.filter((c) => c && c.pass === true).length;
  const card = el("article", { class: `exp st-${k}`, id: /^[A-Za-z0-9_-]+$/.test(id) ? id : null });
  card.appendChild(el("div", { class: "exp-head" }, [
    el("span", { class: "exp-id", text: id || "?" }),
    el("h3", { class: "exp-title", text: str(s.title) || "Untitled scenario" }),
    statusBadge(s.status),
  ]));
  const meta = [];
  meta.push(el("span", { text: categoryLabel(catOf(s)) }));
  if (isNum(s.durationSeconds)) meta.push(el("span", { text: `ran ${fmtSeconds(s.durationSeconds)}` }));
  if (s.concurrent === true) meta.push(el("span", { text: "concurrent" }));
  if (typeof s.separated === "boolean") meta.push(el("span", { text: s.separated ? "graphs separated" : "graphs not separated" }));
  if (checks.length) meta.push(el("span", { text: `${passed}/${checks.length} checks passed` }));
  const rep = replayByScenario.get(id);
  if (rep) meta.push(el("a", { href: `replay.html#${rep}`, text: "Open in replay →" }));
  card.appendChild(el("div", { class: "exp-meta" }, meta));
  if (s.description) card.appendChild(el("p", { class: "desc", text: str(s.description) }));
  if (s.error) card.appendChild(el("p", { class: "err", text: `Error: ${str(s.error)}` }));
  if (Array.isArray(s.notes) && s.notes.length) {
    card.appendChild(el("ul", { class: "notes", "aria-label": "Notes" }, s.notes.map((n) => el("li", { text: str(n) }))));
  }
  const actions = Array.isArray(s.actions) ? s.actions : [];
  if (actions.length) {
    const box = el("div", { class: "exp-actions", "aria-label": "Actions observed" });
    for (const a of actions) {
      const counts = get(a, "evaluation.edgeCounts") || {};
      const row = el("div", { class: "exp-action" }, [
        el("span", { class: "al", text: str(a.label) || str(a.actionId) }),
        isNum(a.completeSeconds) ? el("span", { text: `complete ${fmtSeconds(a.completeSeconds)}` }) : null,
        ...Object.entries(counts).filter(([, v]) => isNum(v) && v > 0).map(([ev, v]) => evChip(ev, v)),
      ]);
      box.appendChild(row);
    }
    card.appendChild(box);
  }
  if (checks.length) {
    const failing = checks.length - passed;
    const det = el("details", { open: failing > 0 && k !== "pass" ? true : null }, [
      el("summary", { text: `Checks (${passed} passed${failing ? `, ${failing} failed` : ""})` }),
      el("ul", { class: "checks" }, checks.map((c) => {
        const ok = c && c.pass === true;
        return el("li", { class: ok ? "ok" : "bad" }, [
          el("span", { class: "mk", "aria-label": ok ? "passed" : "failed", text: ok ? "✓" : "✗" }),
          el("span", {}, [str(c && c.name), c && c.detail ? el("span", { class: "cd", text: str(c.detail) }) : null]),
        ]);
      })),
    ]);
    card.appendChild(det);
  } else if (k !== "unsupported") {
    card.appendChild(el("p", { class: "exp-meta", text: "No checks were recorded for this scenario." }));
  }
  return card;
}

function renderList() {
  const list = document.getElementById("exp-list");
  const count = document.getElementById("exp-count");
  clear(list);
  const visible = scenarios.filter((s) =>
    (state.category === "all" || catOf(s) === state.category) &&
    (state.status === "all" || statusKey(s.status) === state.status));
  count.textContent = `Showing ${visible.length} of ${scenarios.length} scenarios.`;
  for (const c of orderedCategories()) {
    if (state.category !== "all" && state.category !== c) continue;
    const items = visible.filter((s) => catOf(s) === c);
    const all = scenarios.filter((s) => catOf(s) === c);
    const block = el("section", { class: "cat-block", "aria-label": categoryLabel(c) });
    const counts = {};
    for (const s of all) counts[statusKey(s.status)] = (counts[statusKey(s.status)] || 0) + 1;
    block.appendChild(el("h2", {}, [categoryLabel(c), el("span", { class: "badge plain", text: `${all.length} scenario${all.length === 1 ? "" : "s"}` })]));
    if (CATEGORY_DESC[c]) block.appendChild(el("p", { text: CATEGORY_DESC[c] }));
    if (!all.length) {
      block.appendChild(el("p", { class: "faint", text: "No scenarios in this category in this run." }));
    } else if (!items.length) {
      block.appendChild(el("p", { class: "faint", text: "No scenarios match the current filter." }));
    } else {
      block.appendChild(el("div", { class: "exp-list" }, items.map(scenarioCard)));
    }
    list.appendChild(block);
  }
  if (location.hash.length > 1) {
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target && !target.dataset.scrolled) { target.dataset.scrolled = "1"; target.scrollIntoView(); }
  }
}

async function main() {
  const [res, rep] = await Promise.all([fetchJSON("data/results.json"), fetchJSON("data/replays.json")]);
  const count = document.getElementById("exp-count");
  if (!res.ok) {
    clear(count);
    count.appendChild(el("span", { class: "error-box", text: `Experiment results (data/results.json) are not available in this build (${res.error}).` }));
    return;
  }
  scenarios = Array.isArray(get(res.data, "scenarios")) ? res.data.scenarios.filter((s) => s && typeof s === "object") : [];
  if (rep.ok && Array.isArray(get(rep.data, "replays"))) {
    for (const r of rep.data.replays) if (r && r.scenario && r.id) replayByScenario.set(str(r.scenario), str(r.id));
  }
  // Deep link: experiments.html#L07 should not be hidden by a filter.
  renderFilters();
  renderList();
  const foot = document.getElementById("exp-foot");
  foot.appendChild(el("span", { text: "Generated from test-results at commit " }));
  foot.appendChild(el("code", { text: shortSha(get(res.data, "commit")) + (get(res.data, "dirty") === true ? " (dirty)" : "") }));
  foot.appendChild(el("span", { text: `on ${fmtDate(get(res.data, "generatedAt"))}.` }));
}

main();
