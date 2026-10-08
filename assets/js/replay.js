// Interactive replay of recorded effect graphs (data/replays.json + data/graphs/*.json).
// All graph content is untrusted and rendered with textContent / setAttribute only.
import { el, svg, clear, fetchJSON, get, isNum, str, fmtOffset, fmtDate, fmtNum, shortId, shortSha,
  statusBadge, statusKey, evidenceInfo, evChip, prefersReducedMotion } from "./lib.js";

const SAFE_ID = /^[A-Za-z0-9_.-]{1,80}$/;
const NODE_W = 156;
const NODE_H = 56;
const GAP_X = 64;
const GAP_Y = 16;
const PAD = 16;
const TOP = 34;
const MAX_LANE_ROWS = 2;
const PLAY_MS = 12000;

const COLS = [
  { key: "action", label: "ACTION" },
  { key: "request", label: "REQUEST" },
  { key: "workload", label: "OBJECT" },
  { key: "replicaset", label: "REPLICASET" },
  { key: "pod", label: "POD" },
  { key: "side", label: "EVENTS · SIGNALS" },
];

let replays = [];
let scenarioById = new Map();
const graphCache = new Map();
let current = null; // { replay, graphs: [{id, res}], active }
let renderSeq = 0;

// ---------- helpers ----------
function truncMiddle(s, max) {
  s = str(s);
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}

function truncEnd(s, max) {
  s = str(s);
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function commonPrefix(names) {
  if (!names.length) return "";
  let p = names[0];
  for (const n of names) {
    let i = 0;
    while (i < p.length && i < n.length && p[i] === n[i]) i++;
    p = p.slice(0, i);
  }
  const cut = p.lastIndexOf("-");
  return cut > 0 ? p.slice(0, cut + 1) + "*" : (p ? p + "*" : "*");
}

function fmtMetric(v, unit) {
  if (!isNum(v)) return "n/a";
  if (unit === "seconds") return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`;
  if (unit === "ratio") return `${(v * 100).toFixed(v < 0.01 && v > 0 ? 2 : 1)}%`;
  return `${Math.round(v * 1000) / 1000}${unit ? " " + unit : ""}`;
}

function objKind(n) {
  return str(get(n, "object.kind")) || "";
}

function columnOf(n) {
  switch (n.type) {
    case "ACTION": return "action";
    case "KUBERNETES_REQUEST":
    case "TRACE_SPAN": return "request";
    case "KUBERNETES_EVENT":
    case "METRIC_OBSERVATION": return "side";
    case "KUBERNETES_OBJECT": {
      const k = objKind(n);
      if (k === "Pod") return "pod";
      if (k === "ReplicaSet" || k === "ControllerRevision") return "replicaset";
      return "workload";
    }
    default: return "workload";
  }
}

// ---------- model ----------
function buildModel(g, opts) {
  const t0 = parseT(get(g, "action.startedAt"));
  const offset = (iso) => {
    const t = parseT(iso);
    return t === null || t0 === null ? null : t - t0;
  };
  const rawNodes = Array.isArray(g.nodes) ? g.nodes.filter((n) => n && typeof n.id === "string") : [];
  const rawEdges = Array.isArray(g.edges) ? g.edges.filter((e) => e && typeof e.from === "string" && typeof e.to === "string") : [];
  const byId = new Map(rawNodes.map((n) => [n.id, n]));
  const incoming = new Map();
  for (const e of rawEdges) {
    if (!incoming.has(e.to)) incoming.set(e.to, []);
    incoming.get(e.to).push(e);
  }

  // 1. visual node for every raw node (pods may be stacked, events grouped).
  const vOf = new Map(); // raw id -> visual id
  const vnodes = new Map();
  const addV = (vid, data) => {
    if (!vnodes.has(vid)) vnodes.set(vid, Object.assign({ id: vid, members: [], col: "workload", t: null }, data));
    return vnodes.get(vid);
  };

  for (const n of rawNodes) {
    if (n.type === "KUBERNETES_EVENT") continue;
    let vid = n.id;
    let kind = "single";
    if (opts.stack && n.type === "KUBERNETES_OBJECT" && objKind(n) === "Pod") {
      const parentEdge = (incoming.get(n.id) || []).find((e) => e.evidence === "STRUCTURAL");
      const ct = str(get(n, "change.type")) || "OBSERVED";
      const life = get(n, "change.deletedAt") ? "CREATED+DELETED" : ct;
      if (parentEdge) {
        vid = `stack:${parentEdge.from}:${life}`;
        kind = "stack";
      }
    }
    const v = addV(vid, { col: columnOf(n), kind, life: str(get(n, "change.type")) });
    v.members.push(n);
    vOf.set(n.id, vid);
  }
  // collapse stacks of one back to single nodes
  for (const [vid, v] of [...vnodes]) {
    if (v.kind === "stack" && v.members.length < 2) {
      vnodes.delete(vid);
      const n = v.members[0];
      v.id = n.id;
      v.kind = "single";
      vnodes.set(n.id, v);
      vOf.set(n.id, n.id);
    }
  }
  // events: grouped by the visual node that references them
  for (const n of rawNodes) {
    if (n.type !== "KUBERNETES_EVENT") continue;
    const ref = (incoming.get(n.id) || [])[0];
    const owner = ref ? vOf.get(ref.from) || ref.from : "unlinked";
    const vid = `events:${owner}`;
    const v = addV(vid, { col: "side", kind: "events", owner });
    v.members.push(n);
    vOf.set(n.id, vid);
  }

  // 2. visual edges aggregated by (from, to, evidence)
  const vedges = new Map();
  for (const e of rawEdges) {
    const f = vOf.get(e.from) || e.from;
    const t = vOf.get(e.to) || e.to;
    if (!vnodes.has(f) || !vnodes.has(t)) continue;
    const key = `${f}|${t}|${e.evidence}`;
    if (!vedges.has(key)) vedges.set(key, { id: `ve${vedges.size}`, from: f, to: t, evidence: str(e.evidence), members: [], t: null });
    vedges.get(key).members.push(e);
  }

  // 3. times
  for (const v of vnodes.values()) {
    const ts = v.members.map((m) => (m.type === "ACTION" ? 0 : offset(m.observedAt))).filter(isNum);
    v.times = ts.sort((a, b) => a - b);
    v.t = v.times.length ? Math.max(0, v.times[0]) : 0;
  }
  for (const ve of vedges.values()) {
    const ts = ve.members.map((m) => offset(m.observedAt)).filter(isNum).sort((a, b) => a - b);
    ve.times = ts;
    ve.t = ts.length ? Math.max(0, ts[0]) : 0;
    // an edge cannot appear before both of its endpoints
    ve.t = Math.max(ve.t, vnodes.get(ve.from).t, vnodes.get(ve.to).t);
  }

  // 4. grade + accent per visual node
  for (const v of vnodes.values()) {
    const grades = v.members.map((m) => str(m.grade));
    v.grade = grades.includes("ATTRIBUTED") ? "ATTRIBUTED" : grades.includes("CORRELATED") ? "CORRELATED" : grades.find((x) => x) || "";
    const inc = [...vedges.values()].filter((e) => e.to === v.id);
    const order = ["DIRECT", "TRACE_LINK", "STRUCTURAL", "EVENT_REFERENCE", "TEMPORAL_CORRELATION"];
    inc.sort((a, b) => order.indexOf(a.evidence) - order.indexOf(b.evidence));
    v.accent = v.members[0].type === "ACTION" ? "trace" : inc.length ? evidenceInfo(inc[0].evidence).key : "excluded";
    if (v.grade === "CORRELATED") v.accent = "temporal";
    if (!v.grade && v.members[0].type !== "ACTION") v.accent = "excluded";
  }

  // 5. outside lane: exclusions + ambiguities
  const outside = [];
  for (const x of Array.isArray(g.exclusions) ? g.exclusions : []) {
    if (x && typeof x === "object") outside.push({ kind: "exc", data: x, t: Math.max(0, offset(x.at) ?? 0) });
  }
  for (const x of Array.isArray(g.ambiguities) ? g.ambiguities : []) {
    if (x && typeof x === "object") outside.push({ kind: "amb", data: x, t: Math.max(0, offset(x.at) ?? 0) });
  }
  outside.sort((a, b) => a.t - b.t);

  const windows = (Array.isArray(g.windows) ? g.windows : []).filter((w) => w && typeof w === "object").map((w) => ({
    data: w, start: offset(w.start), end: offset(w.end),
  }));

  return { g, t0, offset, vnodes, vedges, outside, windows, rawNodes, rawEdges, byId };
}

function parseT(iso) {
  if (typeof iso !== "string" || !iso || iso.startsWith("0001-")) return null;
  const t = Date.parse(iso.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(t) ? null : t;
}

// ---------- layout ----------
function layout(model) {
  const present = COLS.filter((c) => [...model.vnodes.values()].some((v) => v.col === c.key));
  const colIndex = new Map(present.map((c, i) => [c.key, i]));
  const perCol = present.map((c) => [...model.vnodes.values()].filter((v) => v.col === c.key));
  const pos = new Map();
  const preds = new Map();
  for (const e of model.vedges.values()) {
    if (!preds.has(e.to)) preds.set(e.to, []);
    preds.get(e.to).push(e.from);
  }
  const kindRank = (v) => {
    const n = v.members[0];
    if (n.type === "METRIC_OBSERVATION") return 2 + (n.grade ? 0 : 1);
    if (v.kind === "events") return 1;
    return 0;
  };
  perCol.forEach((nodes, ci) => {
    const bary = (v) => {
      const ps = (preds.get(v.id) || []).map((p) => pos.get(p)).filter(Boolean);
      return ps.length ? ps.reduce((a, b) => a + b.row, 0) / ps.length : 999;
    };
    nodes.sort((a, b) => kindRank(a) - kindRank(b) || bary(a) - bary(b) || a.t - b.t || a.id.localeCompare(b.id));
    nodes.forEach((v, row) => pos.set(v.id, { col: ci, row }));
  });
  const maxRows = Math.max(1, ...perCol.map((n) => n.length));
  const colH = (n) => n * NODE_H + (n - 1) * GAP_Y;
  const graphH = colH(maxRows);
  for (const [vid, p] of pos) {
    const n = perCol[p.col].length;
    const off = (graphH - colH(n)) / 2;
    p.x = PAD + p.col * (NODE_W + GAP_X);
    p.y = TOP + off + p.row * (NODE_H + GAP_Y);
  }
  const width = PAD * 2 + present.length * NODE_W + (present.length - 1) * GAP_X;
  // outside lane
  const laneTop = TOP + graphH + 44;
  const perRow = Math.max(1, Math.floor((width - PAD * 2 + 12) / (NODE_W + 12)));
  const capacity = perRow * MAX_LANE_ROWS;
  const shown = model.outside.length > capacity ? model.outside.slice(0, capacity - 1) : model.outside;
  const laneRows = model.outside.length ? Math.ceil((shown.length + (model.outside.length > shown.length ? 1 : 0)) / perRow) : 0;
  const laneH = laneRows ? 36 + laneRows * 50 : 0;
  const height = laneRows ? laneTop + laneH + PAD : TOP + graphH + PAD + 8;
  return { present, pos, width, height, laneTop, laneH, perRow, shown, graphH };
}

function bez(P, t) {
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [0, 1].map((k) => w.reduce((acc, wi, i) => acc + wi * P[i][k], 0));
}

function edgePath(a, b) {
  const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
  const x2 = b.x, y2 = b.y + NODE_H / 2;
  if (b.col > a.col) {
    const dx = Math.max(30, (x2 - x1) / 2);
    const P = [[x1, y1], [x1 + dx, y1], [x2 - dx, y2], [x2 - 6, y2]];
    const span = b.col - a.col;
    // adjacent columns: label at the middle; longer edges: label in the last gap, which carries no other labels
    const t = span === 1 ? 0.5 : 1 - (GAP_X * 0.55) / (x2 - x1);
    const pt = bez(P, Math.max(0.5, Math.min(0.95, t)));
    return { d: `M${x1} ${y1}C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2 - 6} ${y2}`, mx: span === 1 ? (x1 + x2) / 2 : pt[0], my: span === 1 ? (y1 + y2) / 2 : pt[1], x2, y2 };
  }
  // same or earlier column: loop out to the right
  const rx = Math.max(a.x, b.x) + NODE_W + 26;
  return { d: `M${x1} ${y1}C${rx} ${y1} ${rx} ${y2} ${b.x + NODE_W + 6} ${y2}`, mx: rx - 6, my: (y1 + y2) / 2, x2: b.x + NODE_W, y2 };
}

// ---------- node text ----------
function nodeTexts(v, model) {
  const n = v.members[0];
  const off = model.offset;
  if (v.kind === "stack") {
    const names = v.members.map((m) => str(get(m, "object.name")));
    const life = v.members[0] && get(v.members[0], "change.deletedAt") ? "CREATED+DELETED" : str(get(n, "change.type")) || "PODS";
    const ready = v.members.filter((m) => get(m, "change.readyAt")).length;
    return {
      kind: `${v.members.length} PODS · ${life}`,
      name: truncMiddle(commonPrefix(names), 19),
      sub: str(get(n, "change.type")) === "CREATED" ? `${ready}/${v.members.length} reported ready` : `ns ${truncEnd(get(n, "object.namespace"), 16)}`,
    };
  }
  if (v.kind === "events") {
    const reasons = new Map();
    let warn = 0;
    for (const m of v.members) {
      const r = str(get(m, "event.reason")) || str(m.label) || "Event";
      reasons.set(r, (reasons.get(r) || 0) + 1);
      if (str(get(m, "event.type")) === "Warning") warn++;
    }
    v.warn = warn > 0;
    const owner = model.vnodes.get(v.owner);
    const ownerName = owner ? (owner.kind === "stack" ? `${owner.members.length} Pods` : str(get(owner.members[0], "object.kind")) || "object") : "unlinked";
    return {
      kind: `${v.members.length} EVENT${v.members.length === 1 ? "" : "S"} · ${ownerName.toUpperCase()}`,
      name: truncEnd([...reasons.keys()].join(", "), 20),
      sub: warn ? `${warn} warning${warn === 1 ? "" : "s"}` : "all Normal",
    };
  }
  switch (n.type) {
    case "ACTION": {
      const a = model.g.action || {};
      return {
        kind: a.kind === "MCP_TOOL_CALL" ? "MCP TOOL CALL" : a.kind === "KUBERNETES_API_CALL" ? "KUBERNETES API CALL" : "ACTION",
        name: truncMiddle(str(a.tool) || str(a.name) || str(n.label), 19),
        sub: truncEnd(str(a.actor) || str(a.service), 24),
      };
    }
    case "KUBERNETES_REQUEST":
    case "TRACE_SPAN": {
      const r = n.request || {};
      const src = Array.isArray(r.sources) ? r.sources : [];
      return {
        kind: n.type === "TRACE_SPAN" ? "SPAN" : "KUBERNETES REQUEST",
        name: truncMiddle(`${str(r.verb).toUpperCase()} ${str(r.resource)}${r.subresource ? "/" + str(r.subresource) : ""}`.trim() || str(n.label), 19),
        sub: src.length ? truncEnd(src.map((s) => (s === "kubernetes-audit" ? "audit" : s === "otlp-client-span" ? "client span" : s)).join(" + "), 24) : truncEnd(r.name, 24),
      };
    }
    case "METRIC_OBSERVATION": {
      const m = n.metric || {};
      return {
        kind: m.changed ? "SIGNAL · CHANGED" : "SIGNAL · UNCHANGED",
        name: truncMiddle(str(m.signal) || str(n.label), 19),
        sub: m.changed ? truncEnd(`${fmtMetric(m.baseline, m.unit)} → ${fmtMetric(m.observed, m.unit)}`, 24) : `${truncEnd(m.workload, 12)} · not attached`,
      };
    }
    default: {
      const c = n.change || {};
      const kind = `${objKind(n).toUpperCase() || "OBJECT"}${c.type ? " · " + str(c.type) : ""}`;
      let sub = `ns ${truncEnd(get(n, "object.namespace"), 18)}`;
      if (isNum(c.generationFrom) && isNum(c.generationTo)) sub = `generation ${c.generationFrom} → ${c.generationTo}`;
      else if (isNum(c.replicasFrom) && isNum(c.replicasTo)) sub = `replicas ${c.replicasFrom} → ${c.replicasTo}`;
      else if (c.readyAt) sub = `ready ${fmtOffset(off(c.readyAt))}`;
      else if (c.deletedAt) sub = `deleted ${fmtOffset(off(c.deletedAt))}`;
      else if (c.revision) sub = `revision ${str(c.revision)}`;
      return { kind: truncEnd(kind, 22), name: truncMiddle(get(n, "object.name") || n.label, 19), sub: truncEnd(sub, 26) };
    }
  }
}

// ---------- details (tooltip + inspector) ----------
function row(k, v) {
  if (v === null || v === undefined || v === "") return null;
  return el("div", { class: "tt-row" }, [el("span", { class: "tt-k", text: k }), el("span", { class: "tt-v", text: str(v) })]);
}

function nodeDetail(v, model) {
  const off = model.offset;
  const n = v.members[0];
  const out = [];
  const title = v.kind === "stack" ? `${v.members.length} Pods (${str(get(n, "change.type"))})`
    : v.kind === "events" ? `${v.members.length} Kubernetes Event${v.members.length === 1 ? "" : "s"}` : str(n.label) || str(n.id);
  out.push(el("div", { class: "tt-title", text: title }));
  if (v.kind === "stack" || v.kind === "events") {
    out.push(row("grade", v.grade || "not graded"));
    const list = el("ul", { class: "tt-list" });
    v.members.slice(0, 10).forEach((m) => {
      const t = off(m.observedAt);
      const txt = v.kind === "events"
        ? `${str(get(m, "event.type"))} ${str(get(m, "event.reason"))}${isNum(get(m, "event.count")) && m.event.count > 1 ? " ×" + m.event.count : ""} · ${fmtOffset(t)} · ${truncEnd(get(m, "event.note"), 70)}`
        : `${str(get(m, "object.name"))} · ${str(get(m, "change.type"))} ${fmtOffset(t)}${get(m, "change.readyAt") ? " · ready " + fmtOffset(off(m.change.readyAt)) : ""}`;
      list.appendChild(el("li", { text: txt }));
    });
    if (v.members.length > 10) list.appendChild(el("li", { text: `and ${v.members.length - 10} more` }));
    out.push(list);
    return out;
  }
  out.push(row("type", n.type));
  if (n.type === "ACTION") {
    const a = model.g.action || {};
    out.push(row("kind", a.kind), row("actor", a.actor), row("service", a.service), row("tool", a.tool),
      row("started", fmtDate(a.startedAt)), row("trace", get(a, "trace.traceId")), row("audit id", a.auditId), row("outcome", a.outcome));
  }
  if (n.object) out.push(row("object", `${str(n.object.kind)} ${str(n.object.namespace)}/${str(n.object.name)}`), row("uid", n.object.uid));
  if (n.change) {
    const c = n.change;
    out.push(row("change", c.type));
    if (isNum(c.generationFrom) || isNum(c.generationTo)) out.push(row("generation", `${fmtNum(c.generationFrom)} → ${fmtNum(c.generationTo)}`));
    if (isNum(c.replicasFrom) || isNum(c.replicasTo)) out.push(row("replicas", `${fmtNum(c.replicasFrom)} → ${fmtNum(c.replicasTo)}`));
    out.push(row("revision", c.revision), row("resourceVer", c.resourceVersion));
    if (c.at) out.push(row("changed", fmtOffset(off(c.at))));
    if (c.readyAt) out.push(row("ready", fmtOffset(off(c.readyAt))));
    if (c.deletedAt) out.push(row("deleted", fmtOffset(off(c.deletedAt))));
  }
  if (n.request) {
    const r = n.request;
    out.push(row("request", `${str(r.verb)} ${str(r.resource)}${r.subresource ? "/" + str(r.subresource) : ""} ${str(r.namespace)}/${str(r.name)}`),
      row("audit id", r.auditId), row("user", r.user), row("user agent", r.userAgent), row("status", r.statusCode),
      row("sources", Array.isArray(r.sources) ? r.sources.join(", ") : ""));
  }
  if (n.metric) {
    const m = n.metric;
    out.push(row("signal", m.signal), row("workload", m.workload), row("baseline", fmtMetric(m.baseline, m.unit)),
      row("observed", fmtMetric(m.observed, m.unit)), row("direction", m.direction), row("changed", m.changed ? "yes" : "no"), row("samples", m.samples));
  }
  if (n.span) out.push(row("span", `${shortId(n.span.traceId, 12)} / ${str(n.span.spanId)}`));
  out.push(row("observed", fmtOffset(off(n.observedAt))));
  out.push(row("grade", n.grade || (n.type === "ACTION" ? "" : "not graded (not reachable from the action)")));
  if (n.type === "METRIC_OBSERVATION" && !n.grade) {
    out.push(el("div", { class: "tt-reason", text: "Evaluated, but it did not change beyond the threshold, so it is not attached." }));
  }
  return out;
}

function edgeDetail(ve, model) {
  const info = evidenceInfo(ve.evidence);
  const e = ve.members[0];
  const from = model.vnodes.get(ve.from);
  const to = model.vnodes.get(ve.to);
  const name = (v) => (v ? (v.kind === "stack" ? `${v.members.length} Pods` : v.kind === "events" ? `${v.members.length} events` : str(v.members[0].label)) : "?");
  const out = [el("div", { class: "tt-title", text: `${name(from)} → ${name(to)}` })];
  out.push(row("evidence", info.label), row("relation", e.relationship), row("rule", e.rule), row("source", e.source));
  if (ve.members.length === 1) {
    out.push(row("observed", fmtOffset(model.offset(e.observedAt))));
    for (const f of Array.isArray(e.facts) ? e.facts.slice(0, 8) : []) out.push(row(str(f && f.key), str(f && f.value)));
    if (e.reason) out.push(el("div", { class: "tt-reason", text: str(e.reason) }));
  } else {
    out.push(row("edges", `${ve.members.length} edges grouped`));
    out.push(row("first", fmtOffset(ve.times[0])), row("last", fmtOffset(ve.times[ve.times.length - 1])));
    const list = el("ul", { class: "tt-list" });
    ve.members.slice(0, 4).forEach((m) => list.appendChild(el("li", { text: truncEnd(m.reason, 180) })));
    if (ve.members.length > 4) list.appendChild(el("li", { text: `and ${ve.members.length - 4} more` }));
    out.push(list);
  }
  if (ve.evidence === "TEMPORAL_CORRELATION") out.push(el("div", { class: "tt-reason", text: "Temporal correlation does not prove causation." }));
  return out;
}

function outsideDetail(o, model, names) {
  const x = o.data;
  const out = [el("div", { class: "tt-title", text: str(x.label) })];
  out.push(row(o.kind === "exc" ? "excluded" : "ambiguous", o.kind === "exc" ? str(x.kind) : "attributed to no action"));
  if (x.object) out.push(row("object", `${str(x.object.kind)} ${str(x.object.namespace)}/${str(x.object.name)}`), row("uid", x.object.uid));
  out.push(row("at", fmtOffset(model.offset(x.at))));
  if (x.claimedBy) out.push(row("claimed by", names(x.claimedBy)));
  if (Array.isArray(x.candidates)) out.push(row("candidates", x.candidates.map(names).join(" · ")));
  if (x.reason) out.push(el("div", { class: "tt-reason", text: str(x.reason) }));
  return out;
}

// ---------- graph view ----------
function renderGraphView(container, g, ctx) {
  clear(container);
  const opts = { stack: true, labels: true };
  const viewId = `gv${++renderSeq}`;
  const names = (id) => {
    const s = str(id);
    const hit = ctx.actionNames.get(s);
    return hit ? hit : shortId(s, 22);
  };

  // action card
  const a = g.action || {};
  const evCounts = {};
  for (const e of Array.isArray(g.edges) ? g.edges : []) if (e && e.evidence) evCounts[e.evidence] = (evCounts[e.evidence] || 0) + 1;
  const gradeCounts = { ATTRIBUTED: 0, CORRELATED: 0, none: 0 };
  for (const n of Array.isArray(g.nodes) ? g.nodes : []) {
    if (!n || n.type === "ACTION") continue;
    if (n.grade === "ATTRIBUTED" || n.grade === "CORRELATED") gradeCounts[n.grade]++;
    else gradeCounts.none++;
  }
  const kv = (k, v) => (v ? el("div", {}, [el("dt", { text: k }), el("dd", { text: str(v) })]) : null);
  container.appendChild(el("section", { class: "card action-card", "aria-label": "Initiating action" }, [
    el("div", { class: "ac-title" }, [
      el("span", { class: "badge plain", text: a.kind === "MCP_TOOL_CALL" ? "MCP tool call" : a.kind === "KUBERNETES_API_CALL" ? "Kubernetes API call" : str(a.kind) || "action" }),
      el("strong", { text: str(a.name) || "unnamed action" }),
      el("span", { class: "badge plain", text: `graph ${str(g.status) || "unknown"}` }),
    ]),
    el("dl", { class: "kv" }, [
      kv("Actor", a.actor), kv("Service", a.service), kv("Tool", a.tool), kv("Started", fmtDate(a.startedAt)),
      kv("Trace ID", get(a, "trace.traceId")), kv("Audit ID", a.auditId), kv("Outcome", a.outcome),
      kv("Targets", Array.isArray(a.targets) ? a.targets.map((t) => `${str(t && t.kind)} ${str(t && t.namespace)}/${str(t && t.name)}`).join(", ") : ""),
    ]),
    el("div", { class: "ev-counts", "aria-label": "Edges by evidence class" }, [
      ...Object.entries(evCounts).map(([ev, c]) => evChip(ev, c)),
      el("span", { class: "grade attributed", text: `${gradeCounts.ATTRIBUTED} ATTRIBUTED` }),
      el("span", { class: "grade correlated", text: `${gradeCounts.CORRELATED} CORRELATED` }),
      el("span", { class: "grade none", text: `${gradeCounts.none} not graded` }),
    ]),
  ]));

  // shell
  const shell = el("div", { class: "graph-shell mt-md" });
  const stackBox = el("input", { type: "checkbox", id: `${viewId}-stack` });
  const labelBox = el("input", { type: "checkbox", id: `${viewId}-labels`, checked: true });
  const toolbar = el("div", { class: "graph-toolbar" }, [
    evChip("TRACE_LINK"), evChip("DIRECT"), evChip("STRUCTURAL"), evChip("EVENT_REFERENCE"), evChip("TEMPORAL_CORRELATION"),
    el("span", { class: "grade-legend" }, [
      el("span", {}, [el("i", { class: "gl g-attr", "aria-hidden": "true" }), "attributed"]),
      el("span", {}, [el("i", { class: "gl g-corr", "aria-hidden": "true" }), "correlated"]),
      el("span", {}, [el("i", { class: "gl g-none", "aria-hidden": "true" }), "not graded"]),
    ]),
    el("span", { class: "spacer" }),
    el("label", { for: `${viewId}-stack` }, [stackBox, "Show every Pod"]),
    el("label", { for: `${viewId}-labels` }, [labelBox, "Edge labels"]),
  ]);
  const scroll = el("div", { class: "graph-scroll", tabindex: "0", role: "region", "aria-label": "Effect graph. Tab to move between nodes and edges; details appear in a tooltip and below the graph." });
  const tooltip = el("div", { class: "tooltip", role: "tooltip", id: `${viewId}-tt`, hidden: true });
  const hint = el("p", { class: "faint graph-hint", text: "Scroll sideways to see the whole graph." });
  const timeline = el("div", { class: "timeline" });
  shell.appendChild(toolbar);
  shell.appendChild(scroll);
  shell.appendChild(timeline);
  container.appendChild(shell);
  container.appendChild(hint);

  // panels below
  const inspector = el("section", { class: "panel inspector", "aria-live": "polite", "aria-label": "Selected element" }, [
    el("h3", { text: "Inspector" }),
    el("p", { text: "Hover or focus a node, edge or excluded chip to see its evidence. Click or press Enter to pin it here." }),
  ]);
  const outsidePanels = el("div", { class: "below-graph" });
  const metaPanels = el("div", { class: "below-graph" });
  const infoPanels = el("div", { class: "below-graph wide" });
  container.appendChild(outsidePanels);
  container.appendChild(metaPanels);
  container.appendChild(infoPanels);

  let model, lay, svgRoot, nodeEls, edgeEls, laneEls, currentT = Infinity;

  function showDetail(target, parts) {
    clear(target);
    for (const p of parts) if (p) target.appendChild(p);
  }

  function placeTooltip(elm) {
    const sr = scroll.getBoundingClientRect();
    const r = elm.getBoundingClientRect();
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    let x = r.right - sr.left + scroll.scrollLeft + 10;
    if (x + tw > scroll.scrollLeft + scroll.clientWidth - 8) x = r.left - sr.left + scroll.scrollLeft - tw - 10;
    if (x < scroll.scrollLeft + 8) x = scroll.scrollLeft + 8;
    let y = r.top - sr.top + scroll.scrollTop;
    const maxY = scroll.scrollTop + Math.max(scroll.clientHeight, svgRoot ? svgRoot.getBoundingClientRect().height : 0) - th - 8;
    if (y > maxY) y = Math.max(scroll.scrollTop + 8, maxY);
    tooltip.style.setProperty("--tx", `${Math.round(x)}px`);
    tooltip.style.setProperty("--ty", `${Math.round(y)}px`);
  }

  function highlight(ids, edgeIds) {
    svgRoot.classList.add("has-hl");
    for (const [id, node] of nodeEls) node.classList.toggle("is-hl", ids.has(id));
    for (const [id, node] of edgeEls) node.classList.toggle("is-hl", edgeIds.has(id));
  }
  function unhighlight() {
    if (!svgRoot) return;
    svgRoot.classList.remove("has-hl");
    for (const node of nodeEls.values()) node.classList.remove("is-hl");
    for (const node of edgeEls.values()) node.classList.remove("is-hl");
  }
  function ancestors(vid) {
    const ids = new Set([vid]);
    const eids = new Set();
    const stack = [vid];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of model.vedges.values()) {
        if (e.to === cur && !eids.has(e.id)) {
          eids.add(e.id);
          if (!ids.has(e.from)) { ids.add(e.from); stack.push(e.from); }
        }
      }
    }
    return { ids, eids };
  }

  function wire(elm, detailFn, hl) {
    const show = () => {
      showDetail(tooltip, detailFn());
      placeTooltip(elm);
      if (hl) hl();
    };
    const hide = () => { tooltip.hidden = true; unhighlight(); };
    const pin = () => {
      showDetail(inspector, [el("h3", { text: "Inspector" }), ...detailFn()]);
    };
    elm.addEventListener("mouseenter", show);
    elm.addEventListener("mouseleave", hide);
    elm.addEventListener("focus", show);
    elm.addEventListener("blur", hide);
    elm.addEventListener("click", () => { pin(); show(); });
    elm.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pin(); }
      if (ev.key === "Escape") hide();
    });
  }

  function draw() {
    model = buildModel(g, opts);
    lay = layout(model);
    clear(scroll);
    nodeEls = new Map();
    edgeEls = new Map();
    laneEls = [];
    svgRoot = svg("svg", {
      class: "graph-svg", viewBox: `0 0 ${lay.width} ${lay.height}`, width: lay.width, height: lay.height,
      role: "group", "aria-label": `Effect graph for ${str(a.name)}: ${model.vnodes.size} nodes, ${model.vedges.size} edge groups`,
    });
    svgRoot.style.setProperty("--min-w", `${Math.round(lay.width * 0.82)}px`);
    svgRoot.style.setProperty("--max-w", `${Math.round(lay.width * 1.08)}px`);
    const defs = svg("defs");
    for (const k of ["direct", "trace", "struct", "event", "temporal", "inferred"]) {
      defs.appendChild(svg("marker", { id: `${viewId}-ar-${k}`, viewBox: "0 0 8 8", refX: "6", refY: "4", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" },
        svg("path", { d: "M0 0L8 4L0 8z", class: `g-arrow c-${k}` })));
    }
    svgRoot.appendChild(defs);
    // column labels + rules
    lay.present.forEach((c, i) => {
      const x = PAD + i * (NODE_W + GAP_X);
      svgRoot.appendChild(svg("text", { class: "col-label", x: x + 2, y: 18, text: c.label }));
    });
    // edges
    const edgeLayer = svg("g", { class: "edges" });
    const labelLayer = svg("g", { class: "labels" });
    // draw weaker / background edges first so attributing edges and their labels stay on top
    const drawOrder = { TEMPORAL_CORRELATION: 0, EVENT_REFERENCE: 1 };
    const sortedEdges = [...model.vedges.values()].sort((p, q) => (drawOrder[p.evidence] ?? 2) - (drawOrder[q.evidence] ?? 2));
    for (const ve of sortedEdges) {
      const pa = lay.pos.get(ve.from);
      const pb = lay.pos.get(ve.to);
      if (!pa || !pb) continue;
      const info = evidenceInfo(ve.evidence);
      const p = edgePath(pa, pb);
      const wrap = svg("g", { class: `g-edge-wrap c-${info.key}`, tabindex: "0", role: "button",
        "aria-label": `${info.label} edge, ${ve.members.length > 1 ? ve.members.length + " grouped edges, " : ""}from ${str(model.vnodes.get(ve.from).members[0].label)} to ${str(model.vnodes.get(ve.to).members[0].label)}` });
      wrap.appendChild(svg("path", { class: `g-edge${info.dashed ? " dashed" : ""}`, d: p.d, "marker-end": `url(#${viewId}-ar-${info.key})` }));
      wrap.appendChild(svg("path", { class: "g-edge-hit", d: p.d }));
      edgeLayer.appendChild(wrap);
      if (opts.labels && ve.evidence !== "EVENT_REFERENCE") {
        const text = info.short + (ve.members.length > 1 ? ` ×${ve.members.length}` : "");
        const w = text.length * 5.5 + 10;
        const lab = svg("g", { class: `g-elabel c-${info.key}`, "aria-hidden": "true" }, [
          svg("rect", { x: (p.mx - w / 2).toFixed(1), y: p.my - 7, width: w.toFixed(1), height: 14, rx: 7 }),
          svg("text", { x: p.mx.toFixed(1), y: p.my + 3, "text-anchor": "middle", text }),
        ]);
        wrap.appendChild(lab);
      }
      wire(wrap, () => edgeDetail(ve, model), () => {
        const anc = ancestors(ve.from);
        anc.ids.add(ve.to);
        anc.eids.add(ve.id);
        highlight(anc.ids, anc.eids);
      });
      edgeEls.set(ve.id, wrap);
    }
    svgRoot.appendChild(edgeLayer);
    svgRoot.appendChild(labelLayer);
    // nodes
    for (const v of model.vnodes.values()) {
      const p = lay.pos.get(v.id);
      const n = v.members[0];
      const tx = nodeTexts(v, model);
      const cls = ["g-node", `c-${v.accent}`];
      if (!v.grade && n.type !== "ACTION") cls.push("grade-none");
      if (n.type === "ACTION") cls.push("is-action");
      if (v.kind === "single" && str(get(n, "change.type")) === "DELETED") cls.push("is-deleted");
      if (v.warn) cls.push("warn");
      const gnode = svg("g", { class: cls.join(" "), tabindex: "0", role: "button", transform: `translate(${p.x} ${p.y})`,
        "aria-label": `${tx.kind}: ${v.kind === "single" ? str(n.label) : tx.name}. Grade ${v.grade || "none"}.` });
      if (v.kind === "stack") {
        gnode.appendChild(svg("rect", { class: "nb-stack", x: 6, y: -6, width: NODE_W, height: NODE_H, rx: 9 }));
        gnode.appendChild(svg("rect", { class: "nb-stack", x: 3, y: -3, width: NODE_W, height: NODE_H, rx: 9 }));
      }
      gnode.appendChild(svg("rect", { class: "nb", width: NODE_W, height: NODE_H, rx: 9 }));
      gnode.appendChild(svg("rect", { class: "na", x: 0, y: 10, width: 3, height: NODE_H - 20, rx: 1.5 }));
      tx.kind = truncEnd(tx.kind, 22);
      const kindText = svg("text", { class: "nk", x: 12, y: 16, text: tx.kind });
      gnode.appendChild(kindText);
      gnode.appendChild(svg("text", { class: "nn", x: 12, y: 33, text: tx.name }));
      gnode.appendChild(svg("text", { class: "ns", x: 12, y: 48, text: tx.sub }));
      if (n.type !== "ACTION") {
        const gk = v.grade === "ATTRIBUTED" ? "attr" : v.grade === "CORRELATED" ? "corr" : "none";
        gnode.appendChild(svg("circle", { class: `gdot g-${gk}`, cx: NODE_W - 3, cy: 3, r: 4.5 }));
      }
      v.kindText = kindText;
      v.kindBase = tx.kind;
      wire(gnode, () => nodeDetail(v, model), () => {
        const anc = ancestors(v.id);
        highlight(anc.ids, anc.eids);
      });
      nodeEls.set(v.id, gnode);
      svgRoot.appendChild(gnode);
    }
    // outside lane
    if (model.outside.length) {
      const top = lay.laneTop;
      const lane = svg("g", { class: "lane" });
      lane.appendChild(svg("rect", { class: "lane-box", x: PAD - 6, y: top - 6, width: lay.width - 2 * PAD + 12, height: lay.laneH, rx: 12 }));
      const exc = model.outside.filter((o) => o.kind === "exc").length;
      const amb = model.outside.length - exc;
      lane.appendChild(svg("text", { class: "col-label", x: PAD + 6, y: top + 13,
        text: `NOT ATTACHED · ${exc} EXCLUDED · ${amb} AMBIGUOUS · NO EDGES BY DESIGN` }));
      lay.shown.forEach((o, i) => {
        const cx = PAD + (i % lay.perRow) * (NODE_W + 12);
        const cy = top + 24 + Math.floor(i / lay.perRow) * 50;
        const x = o.data;
        const chip = svg("g", { class: `lane-chip ${o.kind}`, tabindex: "0", role: "button", transform: `translate(${cx} ${cy})`,
          "aria-label": `${o.kind === "exc" ? "Excluded" : "Ambiguous"}: ${str(x.label)}` }, [
          svg("rect", { width: NODE_W, height: 40, rx: 8 }),
          svg("text", { class: "lc-k", x: 10, y: 15, text: o.kind === "exc" ? `EXCLUDED · ${truncEnd(x.kind, 10)}` : `AMBIGUOUS · ${Array.isArray(x.candidates) ? x.candidates.length : "?"} CLAIMANTS` }),
          svg("text", { class: "lc-n", x: 10, y: 31, text: truncMiddle(x.label, 22) }),
        ]);
        wire(chip, () => outsideDetail(o, model, names), null);
        o.el = chip;
        laneEls.push(o);
        lane.appendChild(chip);
      });
      if (model.outside.length > lay.shown.length) {
        const i = lay.shown.length;
        const cx = PAD + (i % lay.perRow) * (NODE_W + 12);
        const cy = top + 24 + Math.floor(i / lay.perRow) * 50;
        lane.appendChild(svg("text", { class: "lc-more", x: cx + 10, y: cy + 25, text: `+${model.outside.length - lay.shown.length} more, listed below` }));
      }
      svgRoot.appendChild(lane);
    }
    scroll.appendChild(svgRoot);
    scroll.appendChild(tooltip);
    buildTimeline();
    applyTime(currentT);
  }

  // ---------- timeline ----------
  let range, timeLabel, head, ticks = [], domain = { min: 0, max: 1 }, playing = null, playBtn;
  function buildTimeline() {
    clear(timeline);
    const times = [];
    for (const v of model.vnodes.values()) times.push(...v.times);
    for (const e of model.vedges.values()) times.push(...e.times);
    for (const o of model.outside) times.push(o.t);
    const wEnds = model.windows.map((w) => w.end).filter(isNum);
    const wStarts = model.windows.map((w) => w.start).filter(isNum);
    const tMax = Math.max(1, ...times.filter(isNum), ...wEnds);
    const tMin = Math.max(Math.min(0, ...wStarts), -0.2 * tMax);
    domain = { min: tMin, max: tMax };
    const pct = (t) => `${((t - tMin) / (tMax - tMin)) * 100}%`;

    playBtn = el("button", { class: "btn btn-ghost btn-sm", type: "button", "aria-label": "Play the timeline" });
    setPlayIcon(false);
    range = el("input", { type: "range", min: "0", max: "1000", step: "1", value: "1000", "aria-label": "Time after the action started" });
    timeLabel = el("span", { class: "tl-time", "aria-live": "off" });
    timeline.appendChild(el("div", { class: "tl-controls" }, [playBtn, range, timeLabel]));
    const track = el("div", { class: "tl-track", "aria-hidden": "true" });
    model.windows.forEach((w, i) => {
      if (!isNum(w.start) || !isNum(w.end)) return;
      const nm = str(w.data.name);
      const cls = nm === "baseline" ? "w-baseline" : nm === "telemetry" ? "w-telemetry" : nm.startsWith("reconcile") ? "w-reconcile" : "w-other";
      const s0 = Math.max(w.start, tMin);
      const e0 = Math.min(w.end, tMax);
      if (e0 <= s0) return;
      const rowTop = cls === "w-reconcile" || cls === "w-other" ? 0 : 16;
      track.appendChild(el("span", { class: `tl-win ${cls}${w.start < tMin ? " clipped" : ""}`, title: `${nm}: ${fmtOffset(w.start)} to ${fmtOffset(w.end)}`,
        vars: { "--l": pct(s0), "--w": `${((e0 - s0) / (tMax - tMin)) * 100}%`, "--t": `${rowTop}px` } }));
    });
    track.appendChild(el("span", { class: "tl-zero", vars: { "--l": pct(0) } }));
    ticks = [];
    for (const e of model.vedges.values()) {
      for (const t of e.times) {
        const tick = el("span", { class: `tl-tick c-${evidenceInfo(e.evidence).key}`, vars: { "--l": pct(Math.max(0, t)) } });
        ticks.push({ el: tick, t: Math.max(0, t) });
        track.appendChild(tick);
      }
    }
    head = el("span", { class: "tl-head", vars: { "--l": pct(tMax) } });
    track.appendChild(head);
    timeline.appendChild(track);
    timeline.appendChild(el("div", { class: "tl-legend" }, [
      el("span", {}, [el("i", { class: "w-baseline" }), "baseline window"]),
      el("span", {}, [el("i", { class: "w-reconcile" }), "reconcile window"]),
      el("span", {}, [el("i", { class: "w-telemetry" }), "telemetry window"]),
      el("span", { text: "ticks: edges by evidence, at observedAt relative to the action start" }),
    ]));
    range.addEventListener("input", () => {
      stopPlay();
      applyTime((Number(range.value) / 1000) * tMax);
    });
    playBtn.addEventListener("click", () => (playing ? stopPlay() : startPlay()));
    head.dataset.pct = "";
    timeline.pct = pct;
  }

  function setPlayIcon(isPlaying) {
    clear(playBtn);
    const s = svg("svg", { viewBox: "0 0 20 20", "aria-hidden": "true", focusable: "false" },
      svg("path", { fill: "currentColor", d: isPlaying ? "M5.5 4h3v12h-3zM11.5 4h3v12h-3z" : "M6 4.2v11.6L15.5 10z" }));
    playBtn.appendChild(s);
    playBtn.appendChild(document.createTextNode(isPlaying ? "Pause" : "Play"));
    playBtn.setAttribute("aria-label", isPlaying ? "Pause the timeline" : "Play the timeline from the action start");
  }

  function startPlay() {
    const tMax = domain.max;
    let startT = currentT >= tMax ? 0 : currentT;
    const t0 = performance.now() - (startT / tMax) * PLAY_MS;
    const reduce = prefersReducedMotion();
    setPlayIcon(true);
    const stepFn = (now) => {
      let t = ((now - t0) / PLAY_MS) * tMax;
      if (t >= tMax) { applyTime(tMax); stopPlay(); return; }
      applyTime(t);
      playing = reduce ? window.setTimeout(() => stepFn(performance.now()), 500) : window.requestAnimationFrame(stepFn);
    };
    playing = reduce ? window.setTimeout(() => stepFn(performance.now()), 0) : window.requestAnimationFrame(stepFn);
  }
  function stopPlay() {
    if (playing !== null) {
      window.cancelAnimationFrame(playing);
      window.clearTimeout(playing);
    }
    playing = null;
    if (playBtn) setPlayIcon(false);
  }

  function applyTime(t) {
    const tMax = domain.max;
    currentT = Math.min(t, tMax);
    const done = currentT >= tMax;
    if (range) range.value = String(Math.round((currentT / tMax) * 1000));
    if (timeLabel) timeLabel.textContent = done ? "full graph" : fmtOffset(currentT);
    if (head && timeline.pct) head.style.setProperty("--l", timeline.pct(Math.max(0, currentT)));
    for (const v of model.vnodes.values()) {
      const node = nodeEls.get(v.id);
      const vis = done || v.t <= currentT;
      node.classList.toggle("is-future", !vis);
      if (v.kind === "stack" || v.kind === "events") {
        const seen = done ? v.members.length : v.times.filter((x) => x <= currentT).length;
        const base = v.kindBase;
        v.kindText.textContent = seen === v.members.length ? base : base.replace(/^\d+/, `${seen}/${v.members.length}`);
      }
    }
    for (const e of model.vedges.values()) {
      edgeEls.get(e.id).classList.toggle("is-future", !(done || e.t <= currentT));
    }
    for (const o of laneEls) o.el.classList.toggle("is-future", !(done || o.t <= currentT));
    for (const tk of ticks) tk.el.classList.toggle("is-future", !(done || tk.t <= currentT));
  }

  stackBox.addEventListener("change", () => { opts.stack = !stackBox.checked; draw(); });
  labelBox.addEventListener("change", () => { opts.labels = labelBox.checked; draw(); });

  draw();
  renderPanels();

  function renderPanels() {
    // Outside the graph: exclusions and ambiguities, always listed in full.
    const exc = Array.isArray(g.exclusions) ? g.exclusions.filter((x) => x && typeof x === "object") : [];
    const amb = Array.isArray(g.ambiguities) ? g.ambiguities.filter((x) => x && typeof x === "object") : [];
    const chipList = (items, kind) => {
      const ul = el("ul", { class: "chips-out" });
      items.forEach((x, i) => {
        const li = el("li", { class: `chip-out ${kind}`, hidden: i >= 8 ? true : null }, [
          el("div", { class: "co-top" }, [
            el("span", { class: "co-kind", text: kind === "exc" ? str(x.kind) || "excluded" : "ambiguous" }),
            el("span", { class: "co-label", text: str(x.label) }),
          ]),
          x.reason ? el("div", { class: "co-reason", text: str(x.reason) }) : null,
          el("div", { class: "co-meta", text: [
            x.at ? `at ${fmtOffset(model.offset(x.at))}` : "",
            x.claimedBy ? `claimed by ${names(x.claimedBy)}` : "",
            Array.isArray(x.candidates) && x.candidates.length ? `candidates: ${x.candidates.map(names).join(" · ")}` : "",
          ].filter(Boolean).join(" · ") }),
        ]);
        ul.appendChild(li);
      });
      const wrap = el("div", {}, ul);
      if (items.length > 8) {
        const btn = el("button", { type: "button", class: "btn btn-ghost btn-sm show-more", "aria-expanded": "false", text: `Show all ${items.length}` });
        btn.addEventListener("click", () => {
          const open = btn.getAttribute("aria-expanded") !== "true";
          ul.querySelectorAll("li").forEach((li, i) => { if (i >= 8) li.hidden = !open; });
          btn.setAttribute("aria-expanded", String(open));
          btn.textContent = open ? "Show fewer" : `Show all ${items.length}`;
        });
        wrap.appendChild(btn);
      }
      return wrap;
    };
    clear(outsidePanels);
    outsidePanels.appendChild(el("section", { class: "panel outside", "aria-label": "Excluded observations" }, [
      el("h3", {}, ["Excluded: observed nearby, deliberately not attached", el("span", { class: "count", text: `(${exc.length})` })]),
      el("p", { text: "Changes and signals EffectTrace noticed inside the window but could not connect: no ownership path, claimed by another action, or a workload outside this action's scope." }),
      exc.length ? chipList(exc, "exc") : el("p", { class: "faint", text: "No exclusions recorded for this graph." }),
    ]));
    outsidePanels.appendChild(el("section", { class: "panel outside", "aria-label": "Ambiguous changes" }, [
      el("h3", {}, ["Ambiguous: attributed to no action", el("span", { class: "count", text: `(${amb.length})` })]),
      el("p", { text: "Changes inside the windows of more than one action. Rather than guess, EffectTrace attributes them to none of the candidates." }),
      amb.length ? chipList(amb, "amb") : el("p", { class: "faint", text: "No ambiguous changes recorded for this graph." }),
    ]));

    clear(metaPanels);
    metaPanels.appendChild(inspector);
    // notes
    const notes = Array.isArray(g.notes) ? g.notes.map(str).filter(Boolean) : [];
    const hasTemporal = (Array.isArray(g.edges) ? g.edges : []).some((e) => e && e.evidence === "TEMPORAL_CORRELATION");
    const causal = "Temporal correlation does not prove causation.";
    if (hasTemporal && !notes.some((n) => n.includes("does not prove causation"))) notes.push(causal);
    metaPanels.appendChild(el("section", { class: "panel", "aria-label": "Notes" }, [
      el("h3", { text: "Notes" }),
      notes.length ? el("ul", { class: "notes-list" }, notes.map((n) => el("li", { class: n.includes("does not prove causation") ? "causal" : null, text: n })))
        : el("p", { class: "faint", text: "No notes on this graph." }),
    ]));
    // coverage
    const cov = Array.isArray(g.coverage) ? g.coverage.filter((c) => c && typeof c === "object") : [];
    clear(infoPanels);
    infoPanels.appendChild(el("section", { class: "panel", "aria-label": "Source coverage" }, [
      el("h3", { text: "Coverage" }),
      cov.length ? el("div", { class: "table-wrap" }, el("table", {}, [
        el("thead", {}, el("tr", {}, [el("th", { scope: "col", text: "Source" }), el("th", { scope: "col", text: "Status" }), el("th", { scope: "col", text: "Detail" })])),
        el("tbody", {}, cov.map((c) => el("tr", {}, [
          el("td", { class: "mono", text: str(c.source) }),
          el("td", {}, el("span", { class: c.available ? "cov-ok" : "cov-miss", text: c.available ? "available" : "missing" })),
          el("td", { text: str(c.detail) }),
        ]))),
      ])) : el("p", { class: "faint", text: "No coverage information recorded." }),
    ]));
    // windows
    infoPanels.appendChild(el("section", { class: "panel", "aria-label": "Observation windows" }, [
      el("h3", { text: "Observation windows" }),
      model.windows.length ? el("div", { class: "table-wrap" }, el("table", {}, [
        el("thead", {}, el("tr", {}, [el("th", { scope: "col", text: "Window" }), el("th", { scope: "col", text: "From" }), el("th", { scope: "col", text: "To" }), el("th", { scope: "col", text: "Reason" })])),
        el("tbody", {}, model.windows.map((w) => el("tr", {}, [
          el("td", { class: "mono", text: str(w.data.name) + (w.data.open ? " (open)" : "") }),
          el("td", { class: "num", text: fmtOffset(w.start) }),
          el("td", { class: "num", text: fmtOffset(w.end) }),
          el("td", { text: str(w.data.reason) }),
        ]))),
      ])) : el("p", { class: "faint", text: "No windows recorded." }),
    ]));
    // edge list (accessible alternative to the drawing)
    const rawEdges = model.rawEdges.slice().sort((p, q) => (model.offset(p.observedAt) ?? 0) - (model.offset(q.observedAt) ?? 0));
    const label = (id) => str(get(model.byId.get(id) || {}, "label")) || id;
    container.appendChild(el("details", { class: "panel raw mt-md" }, [
      el("summary", { text: `All ${rawEdges.length} edges as a table` }),
      el("div", { class: "table-wrap mt-md" }, el("table", { class: "edge-table" }, [
        el("thead", {}, el("tr", {}, ["When", "From", "To", "Evidence", "Rule"].map((h) => el("th", { scope: "col", text: h })))),
        el("tbody", {}, rawEdges.map((e) => el("tr", {}, [
          el("td", { class: "num", text: fmtOffset(model.offset(e.observedAt)) }),
          el("td", { class: "mono", text: label(e.from) }),
          el("td", { class: "mono", text: label(e.to) }),
          el("td", {}, evChip(e.evidence)),
          el("td", { class: "mono", text: str(e.rule) }),
        ]))),
      ])),
    ]));
  }

  return { stop: stopPlay };
}

// ---------- replay selection ----------
async function loadGraph(id) {
  if (!SAFE_ID.test(id)) return { ok: false, error: "invalid graph id" };
  if (!graphCache.has(id)) graphCache.set(id, fetchJSON(`data/graphs/${id}.json`));
  return graphCache.get(id);
}

let activeView = null;

async function selectReplay(id, focusPicker) {
  const replay = replays.find((r) => r.id === id) || replays[0];
  if (!replay) return;
  document.querySelectorAll("#replay-picker .chip-btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === replay.id)));
  if (location.hash !== `#${replay.id}`) history.replaceState(null, "", `#${replay.id}`);
  const root = document.getElementById("replay-root");
  if (activeView) activeView.stop();
  clear(root);
  root.appendChild(el("p", { class: "loading", text: "Loading recorded graphs…" }));

  const graphIds = Array.isArray(replay.graphs) ? replay.graphs.map(str).filter(Boolean) : [];
  const results = await Promise.all(graphIds.map(loadGraph));
  clear(root);

  // scenario header
  const sc = scenarioById.get(str(replay.scenario));
  const head = el("div", { class: "scenario-head" }, [
    el("h2", { text: str(replay.title) || str(replay.id) }),
    sc ? statusBadge(sc.status) : el("span", { class: "badge plain", text: "no result recorded" }),
    replay.scenario ? el("a", { class: "badge plain", href: `experiments.html#${SAFE_ID.test(str(replay.scenario)) ? str(replay.scenario) : ""}`, text: `${str(replay.scenario)}${sc && sc.title ? " · " + str(sc.title) : ""}` }) : null,
  ]);
  root.appendChild(head);
  if (sc && sc.description) root.appendChild(el("p", { class: "scenario-desc", text: str(sc.description) }));
  if (sc && Array.isArray(sc.notes) && sc.notes.length) root.appendChild(el("ul", { class: "notes-list muted" }, sc.notes.map((n) => el("li", { text: str(n) }))));
  if (sc && statusKey(sc.status) !== "pass") {
    const failing = (Array.isArray(sc.checks) ? sc.checks : []).filter((c) => c && c.pass !== true);
    root.appendChild(el("div", { class: "callout c-fail mt-md" }, [
      el("p", {}, [
        el("strong", { text: `This scenario is recorded as ${str(sc.status) || "unknown"}. ` }),
        failing.length ? `Failed check${failing.length === 1 ? "" : "s"}: ${failing.map((c) => `${str(c.name)}${c.detail ? " (" + truncEnd(c.detail, 120) + ")" : ""}`).join("; ")}.` : (sc.error ? `Error: ${str(sc.error)}` : "See the experiments page for details."),
        " The graph below is shown exactly as recorded.",
      ]),
    ]));
  }

  if (!graphIds.length) {
    root.appendChild(el("p", { class: "error-box mt-md", text: "This replay lists no graph files." }));
    return;
  }
  // tab names, also used to resolve claimedBy/candidates
  const actionNames = new Map();
  results.forEach((r, i) => {
    if (r.ok) {
      const aid = str(get(r.data, "action.id"));
      if (aid) actionNames.set(aid, `Action ${i + 1} (${str(get(r.data, "action.name"))})`);
    }
  });
  const ctx = { actionNames };
  const viewBox = el("div", { class: "graph-view" });

  const show = (i) => {
    if (activeView) activeView.stop();
    const r = results[i];
    clear(viewBox);
    if (!r.ok || !r.data || typeof r.data !== "object") {
      viewBox.appendChild(el("p", { class: "error-box mt-md", text: `The recorded graph data/graphs/${graphIds[i]}.json is not available in this build (${r.error || "invalid"}). The scenario result is still listed on the experiments page.` }));
      activeView = null;
      return;
    }
    activeView = renderGraphView(viewBox, r.data, ctx);
  };

  if (graphIds.length > 1) {
    const tabs = el("div", { class: "tabs", role: "tablist", "aria-label": "Actions in this replay" });
    const tabEls = graphIds.map((gid, i) => {
      const r = results[i];
      const nm = r.ok ? str(get(r.data, "action.name")) : `${gid} (missing)`;
      const t = el("button", { class: "tab", role: "tab", type: "button", id: `tab-${gid}`, "aria-selected": String(i === 0), "aria-controls": "graph-panel", tabindex: i === 0 ? "0" : "-1" }, [
        el("span", { class: "tab-k", text: `Action ${i + 1}` }), truncEnd(nm, 48),
      ]);
      t.addEventListener("click", () => activate(i));
      t.addEventListener("keydown", (ev) => {
        if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
          ev.preventDefault();
          const j = (i + (ev.key === "ArrowRight" ? 1 : -1) + graphIds.length) % graphIds.length;
          activate(j);
          tabEls[j].focus();
        }
      });
      return t;
    });
    const activate = (i) => {
      tabEls.forEach((t, j) => { t.setAttribute("aria-selected", String(i === j)); t.tabIndex = i === j ? 0 : -1; });
      viewBox.setAttribute("aria-labelledby", tabEls[i].id);
      show(i);
    };
    tabEls.forEach((t) => tabs.appendChild(t));
    root.appendChild(el("p", { class: "muted mt-md", text: `This replay recorded ${graphIds.length} actions. Each has its own effect graph; switch between them to see what each one claims, and what it leaves to the other.` }));
    root.appendChild(tabs);
    viewBox.setAttribute("role", "tabpanel");
    viewBox.id = "graph-panel";
    root.appendChild(viewBox);
    activate(0);
  } else {
    root.appendChild(viewBox);
    viewBox.classList.add("mt-md");
    show(0);
  }
  if (focusPicker) {
    const b = document.querySelector(`#replay-picker .chip-btn[aria-pressed="true"]`);
    if (b) b.focus();
  }
}

async function main() {
  const picker = document.getElementById("replay-picker");
  const [rep, res] = await Promise.all([fetchJSON("data/replays.json"), fetchJSON("data/results.json")]);
  clear(picker);
  if (!rep.ok || !Array.isArray(get(rep.data, "replays"))) {
    picker.appendChild(el("p", { class: "error-box", text: `The replay index (data/replays.json) is not available in this build (${rep.error || "invalid"}).` }));
    return;
  }
  replays = rep.data.replays.filter((r) => r && typeof r === "object" && SAFE_ID.test(str(r.id)));
  if (res.ok && Array.isArray(get(res.data, "scenarios"))) {
    for (const s of res.data.scenarios) if (s && s.id) scenarioById.set(str(s.id), s);
  }
  if (!replays.length) {
    picker.appendChild(el("p", { class: "error-box", text: "No replays are listed in this build." }));
    return;
  }
  for (const r of replays) {
    const sc = scenarioById.get(str(r.scenario));
    const b = el("button", { type: "button", class: "chip-btn", "aria-pressed": "false", dataset: { value: r.id } }, [
      str(r.title) || r.id,
      sc ? el("span", { class: `badge st-${statusKey(sc.status)}`, text: str(sc.status) }) : null,
    ]);
    b.addEventListener("click", () => selectReplay(r.id, false));
    picker.appendChild(b);
  }
  const fromHash = decodeURIComponent(location.hash.slice(1));
  await selectReplay(replays.some((r) => r.id === fromHash) ? fromHash : replays[0].id, false);
  const meta = el("p", { class: "data-foot" }, [
    el("span", { text: "Recorded at commit " }),
    el("code", { text: shortSha(get(res.ok ? res.data : {}, "commit")) }),
    el("span", { text: `· results generated ${fmtDate(get(res.ok ? res.data : {}, "generatedAt"))}` }),
  ]);
  document.getElementById("replay-root").after(meta);
  window.addEventListener("hashchange", () => {
    const h = decodeURIComponent(location.hash.slice(1));
    if (replays.some((r) => r.id === h)) selectReplay(h, false);
  });
}

main();
