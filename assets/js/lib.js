// Small DOM and formatting helpers. Every value from data/*.json is untrusted:
// it is only ever written with textContent or setAttribute on safe attributes.

const SVG_NS = "http://www.w3.org/2000/svg";
const BLOCKED_ATTRS = /^(on|style$|srcdoc$)/i;

function applyAttrs(node, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "text") { node.textContent = String(v); continue; }
    if (k === "class") { node.setAttribute("class", String(v)); continue; }
    if (k === "vars") {
      for (const [name, val] of Object.entries(v)) node.style.setProperty(name, String(val));
      continue;
    }
    if (k === "dataset") {
      for (const [name, val] of Object.entries(v)) node.dataset[name] = String(val);
      continue;
    }
    if (BLOCKED_ATTRS.test(k)) continue;
    if ((k === "href" || k === "src") && !/^(https:\/\/|#|[a-z0-9_./-]+(\.html|\.json|\.svg)?(#[\w-]*)?$)/i.test(String(v))) continue;
    node.setAttribute(k, v === true ? "" : String(v));
  }
}

function append(node, children) {
  if (children === null || children === undefined) return;
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    if (typeof c === "string" || typeof c === "number") node.appendChild(document.createTextNode(String(c)));
    else node.appendChild(c);
  }
}

export function el(tag, attrs, children) {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  append(node, children);
  return node;
}

export function svg(tag, attrs, children) {
  const node = document.createElementNS(SVG_NS, tag);
  applyAttrs(node, attrs);
  append(node, children);
  return node;
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

export async function fetchJSON(path) {
  try {
    const res = await fetch(path, { cache: "no-cache", credentials: "same-origin" });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, path };
    const data = await res.json();
    return { ok: true, data, path };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : "request failed", path };
  }
}

export function get(obj, path, fallback = null) {
  let cur = obj;
  for (const key of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object" || !(key in cur)) return fallback;
    cur = cur[key];
  }
  return cur === undefined ? fallback : cur;
}

export const NA = "n/a";

export function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

export function fmtNum(v, digits = 0) {
  if (!isNum(v)) return NA;
  return v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function fmtFixed(v, digits) {
  if (!isNum(v)) return NA;
  return v.toFixed(digits);
}

export function fmtPct(v) {
  if (!isNum(v)) return NA;
  const p = v * 100;
  return (Number.isInteger(p) ? p.toFixed(0) : p.toFixed(1)) + "%";
}

export function fmtRatio(v) {
  if (!isNum(v)) return NA;
  return v.toFixed(3).replace(/\.?0+$/, "") || "0";
}

export function fmtSeconds(v) {
  if (!isNum(v)) return NA;
  if (Math.abs(v) < 1) return `${Math.round(v * 1000)} ms`;
  if (Math.abs(v) < 100) return `${v.toFixed(1)} s`;
  return `${Math.round(v)} s`;
}

export function fmtOffset(ms) {
  if (!isNum(ms)) return NA;
  const sign = ms < 0 ? "−" : "+";
  const a = Math.abs(ms);
  if (a < 1000) return `${sign}${Math.round(a)} ms`;
  return `${sign}${(a / 1000).toFixed(a < 10000 ? 2 : 1)} s`;
}

export function fmtBytes(v) {
  if (!isNum(v)) return NA;
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KiB`;
  return `${(v / 1024 / 1024).toFixed(1)} MiB`;
}

export function fmtDate(iso) {
  if (typeof iso !== "string" || !iso) return NA;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC").replace(/Z$/, " UTC");
}

export function parseTime(iso) {
  if (typeof iso !== "string" || !iso || iso.startsWith("0001-")) return null;
  // Date only keeps milliseconds; keep sub-millisecond digits out of the parse.
  const t = Date.parse(iso.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(t) ? null : t;
}

export function shortSha(commit) {
  if (typeof commit !== "string" || !commit) return "unknown";
  return /^[0-9a-f]{13,}$/i.test(commit) ? commit.slice(0, 12) : commit.slice(0, 40);
}

export function shortId(id, n = 8) {
  if (typeof id !== "string") return "";
  return id.length > n + 1 ? id.slice(0, n) + "…" : id;
}

export function str(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try { return JSON.stringify(v); } catch (e) { return ""; }
}

export const STATUS = ["pass", "fail", "error", "unsupported"];

export function statusKey(s) {
  const k = typeof s === "string" ? s.toLowerCase() : "";
  return STATUS.includes(k) ? k : "unknown";
}

export function statusBadge(s) {
  const k = statusKey(s);
  return el("span", { class: `badge st-${k}`, text: typeof s === "string" && s ? s : "unknown" });
}

export const EVIDENCE = {
  DIRECT: { key: "direct", label: "DIRECT", short: "DIRECT", dashed: false },
  TRACE_LINK: { key: "trace", label: "TRACE_LINK", short: "TRACE", dashed: false },
  STRUCTURAL: { key: "struct", label: "STRUCTURAL", short: "STRUCT", dashed: false },
  EVENT_REFERENCE: { key: "event", label: "EVENT_REFERENCE", short: "EVENT", dashed: false },
  TEMPORAL_CORRELATION: { key: "temporal", label: "TEMPORAL_CORRELATION", short: "CORRELATED", dashed: true },
  INFERRED: { key: "inferred", label: "INFERRED", short: "INFERRED", dashed: true },
};

export function evidenceInfo(ev) {
  return EVIDENCE[ev] || { key: "inferred", label: str(ev) || "UNKNOWN", short: str(ev) || "?", dashed: true };
}

export function evChip(ev, count) {
  const info = evidenceInfo(ev);
  return el("span", { class: `ev-chip c-${info.key}${info.dashed ? " dashed" : ""}` }, [
    el("span", { class: "sw", "aria-hidden": "true" }),
    info.label,
    count !== undefined ? el("span", { class: "n", text: `×${count}` }) : null,
  ]);
}

export const CATEGORY_LABEL = {
  live: "Live kind experiments",
  replay: "Offline replays",
  unsupported: "Unsupported scenarios",
};

export function categoryLabel(c) {
  return CATEGORY_LABEL[c] || (typeof c === "string" && c ? c : "Uncategorized");
}

export function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}
