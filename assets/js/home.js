// Home page: hero animation controls, live summary strip, weakest-link playground.
import { el, clear, fetchJSON, get, fmtPct, fmtNum, isNum, shortSha, fmtDate, prefersReducedMotion } from "./lib.js";

// ---------- hero animation ----------
function initHero() {
  const fig = document.getElementById("hero-diagram");
  if (!fig) return;
  if (prefersReducedMotion()) { fig.classList.remove("is-pending"); return; } // final frame is the default state
  fig.classList.remove("is-pending");
  fig.classList.add("is-waiting");
  const controls = fig.querySelector(".hd-controls");
  const btn = document.getElementById("hd-toggle");
  const label = btn ? btn.querySelector(".hd-label") : null;
  const TOTAL_MS = 8200;
  let timer = null;
  let startedAt = 0;
  let remaining = TOTAL_MS;
  let state = "idle";

  const setButton = (mode) => {
    if (!btn || !label) return;
    const icon = btn.querySelector("svg");
    if (icon) icon.remove();
    const paths = {
      pause: "M5.5 4h3v12h-3zM11.5 4h3v12h-3z",
      play: "M6 4.2v11.6L15.5 10z",
      replay: "M4 10a6 6 0 106-6H7M7 1.5L4.5 4 7 6.5",
    };
    const ns = "http://www.w3.org/2000/svg";
    const s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 20 20");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("focusable", "false");
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", paths[mode]);
    if (mode === "replay") {
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", "currentColor");
      p.setAttribute("stroke-width", "2");
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
    } else {
      p.setAttribute("fill", "currentColor");
    }
    s.appendChild(p);
    btn.insertBefore(s, label);
    label.textContent = mode === "pause" ? "Pause" : mode === "play" ? "Resume" : "Replay";
  };

  const finish = () => {
    state = "done";
    fig.classList.remove("is-playing", "is-paused");
    setButton("replay");
  };

  const play = () => {
    fig.classList.remove("is-playing", "is-paused", "is-waiting");
    void fig.getBoundingClientRect(); // restart CSS animations
    fig.classList.add("is-playing");
    state = "playing";
    remaining = TOTAL_MS;
    startedAt = performance.now();
    window.clearTimeout(timer);
    timer = window.setTimeout(finish, remaining);
    setButton("pause");
  };

  if (controls) controls.hidden = false;
  if (btn) {
    btn.addEventListener("click", () => {
      if (state === "playing") {
        fig.classList.add("is-paused");
        window.clearTimeout(timer);
        remaining -= performance.now() - startedAt;
        state = "paused";
        setButton("play");
      } else if (state === "paused") {
        fig.classList.remove("is-paused");
        startedAt = performance.now();
        timer = window.setTimeout(finish, Math.max(0, remaining));
        state = "playing";
        setButton("pause");
      } else {
        play();
      }
    });
  }

  // Start when the diagram first scrolls into view (it is usually visible at load).
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        play();
      }
    }, { threshold: 0.25 });
    io.observe(fig);
  } else {
    play();
  }
}

// ---------- live summary strip ----------
function stat(label, value, sub, cls) {
  return el("div", { class: `stat ${cls || ""}${value === "n/a" ? " is-na" : ""}` }, [
    el("div", { class: "label", text: label }),
    el("div", { class: "value", text: value }),
    sub ? el("div", { class: "sub", text: sub }) : null,
  ]);
}

async function initStats() {
  const box = document.getElementById("home-stats");
  const foot = document.getElementById("home-stats-foot");
  if (!box || !foot) return;
  const res = await fetchJSON("data/summary.json");
  clear(foot);
  if (!res.ok) {
    foot.appendChild(el("span", { class: "error-box", text: `The experiment summary (data/summary.json) is not available in this build (${res.error}).` }));
    return;
  }
  const s = res.data;
  const total = get(s, "scenarios.total");
  const pass = get(s, "scenarios.pass");
  const notPass = ["fail", "error", "unsupported"].map((k) => get(s, `scenarios.${k}`)).filter(isNum).reduce((a, b) => a + b, 0);
  const sep = get(s, "attribution.concurrentSeparated");
  const sepTotal = get(s, "attribution.concurrentScenarios");
  box.appendChild(stat("Scenarios passing", isNum(pass) && isNum(total) ? `${pass}/${total}` : "n/a",
    isNum(total) ? `${fmtNum(notPass)} did not pass, shown as they are` : null, notPass > 0 ? "st-fail-c" : "st-pass-c"));
  box.appendChild(stat("DIRECT precision", fmtPct(get(s, "attribution.direct.precision")),
    `recall ${fmtPct(get(s, "attribution.direct.recall"))}`, "c-direct"));
  box.appendChild(stat("STRUCTURAL precision", fmtPct(get(s, "attribution.structural.precision")),
    `recall ${fmtPct(get(s, "attribution.structural.recall"))}`, "c-struct"));
  box.appendChild(stat("False attachments", fmtNum(get(s, "attribution.falseAttachments")),
    `unrelated telemetry attached: ${fmtNum(get(s, "attribution.unrelatedTelemetryAttachments"))}`, "c-temporal"));
  box.appendChild(stat("Concurrent separation", isNum(sep) && isNum(sepTotal) ? `${sep}/${sepTotal}` : "n/a",
    "concurrent scenarios kept apart", "c-trace"));
  foot.appendChild(el("span", { text: "Generated from test-results at commit " }));
  foot.appendChild(el("code", { text: shortSha(get(s, "commit")) + (get(s, "dirty") === true ? " (dirty)" : "") }));
  foot.appendChild(el("span", { text: `on ${fmtDate(get(s, "generatedAt"))}.` }));
  foot.appendChild(el("a", { href: "results.html", text: "All results →" }));
}

// ---------- weakest-link playground ----------
const WL_OPTIONS = [
  ["TRACE_LINK", "trace"], ["DIRECT", "direct"], ["STRUCTURAL", "struct"],
  ["EVENT_REFERENCE", "event"], ["TEMPORAL_CORRELATION", "temporal"],
];

function initWeakestLink() {
  const grade = document.getElementById("wl-grade");
  const why = document.getElementById("wl-why");
  if (!grade || !why) return;
  const defaults = ["TRACE_LINK", "DIRECT", "STRUCTURAL"];
  const selects = [0, 1, 2].map((i) => document.getElementById(`wl-e${i}`));
  selects.forEach((sel, i) => {
    if (!sel) return;
    for (const [v] of WL_OPTIONS) sel.appendChild(el("option", { value: v, text: v }));
    sel.value = defaults[i];
    sel.addEventListener("change", update);
  });
  function update() {
    let weak = null;
    selects.forEach((sel, i) => {
      const wrap = sel.closest(".wl-edge");
      const opt = WL_OPTIONS.find((o) => o[0] === sel.value);
      wrap.className = `wl-edge c-${opt ? opt[1] : "struct"}${sel.value === "TEMPORAL_CORRELATION" ? " dashed" : ""}`;
      if (sel.value === "TEMPORAL_CORRELATION" && weak === null) weak = i + 1;
    });
    if (weak === null) {
      grade.textContent = "ATTRIBUTED";
      grade.className = "grade attributed";
      why.textContent = "Every edge on the path attributes.";
    } else {
      grade.textContent = "CORRELATED";
      grade.className = "grade correlated";
      why.textContent = `Edge ${weak} is only temporal, so everything after it is a correlation, even if later edges are DIRECT or STRUCTURAL.`;
    }
  }
  update();
}

initHero();
initStats();
initWeakestLink();
