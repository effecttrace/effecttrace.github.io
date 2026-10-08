// Shared behaviour for every page: theme toggle, navigation menus,
// theme-aware <picture> sources and copy buttons. No innerHTML anywhere.

const root = document.documentElement;
const STORAGE_KEY = "effecttrace-theme";

function currentTheme() {
  return root.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function syncPictures(theme) {
  // <source data-theme-src="dark"> follows the toggle, not only the OS setting.
  document.querySelectorAll("source[data-theme-src]").forEach((src) => {
    src.media = src.dataset.themeSrc === theme ? "all" : "not all";
  });
}

function syncToggle(theme) {
  document.querySelectorAll(".theme-toggle").forEach((btn) => {
    const next = theme === "dark" ? "light" : "dark";
    btn.setAttribute("aria-label", `Switch to ${next} theme`);
    btn.setAttribute("title", `Switch to ${next} theme`);
  });
}

function setTheme(theme, persist) {
  root.setAttribute("data-theme", theme);
  if (persist) {
    try { window.localStorage.setItem(STORAGE_KEY, theme); } catch (e) { /* storage unavailable */ }
  }
  syncPictures(theme);
  syncToggle(theme);
  document.dispatchEvent(new CustomEvent("themechange", { detail: { theme } }));
}

function initTheme() {
  syncPictures(currentTheme());
  syncToggle(currentTheme());
  document.querySelectorAll(".theme-toggle").forEach((btn) => {
    btn.addEventListener("click", () => setTheme(currentTheme() === "dark" ? "light" : "dark", true));
  });
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (e) => {
      let saved = null;
      try { saved = window.localStorage.getItem(STORAGE_KEY); } catch (err) { saved = null; }
      if (!saved) setTheme(e.matches ? "light" : "dark", false);
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
  }
}

function initNav() {
  const header = document.querySelector(".site-header");
  if (!header) return;
  const groups = Array.from(header.querySelectorAll(".nav-group"));
  const closeAll = (except) => {
    groups.forEach((g) => {
      if (g === except) return;
      g.classList.remove("is-open");
      const t = g.querySelector(".nav-trigger");
      if (t) t.setAttribute("aria-expanded", "false");
    });
  };
  groups.forEach((g) => {
    const trigger = g.querySelector(".nav-trigger");
    if (!trigger) return;
    trigger.addEventListener("click", () => {
      const open = !g.classList.contains("is-open");
      closeAll(g);
      g.classList.toggle("is-open", open);
      trigger.setAttribute("aria-expanded", String(open));
    });
    g.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && g.classList.contains("is-open")) {
        g.classList.remove("is-open");
        trigger.setAttribute("aria-expanded", "false");
        trigger.focus();
      }
    });
    g.addEventListener("focusout", (e) => {
      if (!g.contains(e.relatedTarget)) {
        g.classList.remove("is-open");
        trigger.setAttribute("aria-expanded", "false");
      }
    });
  });
  document.addEventListener("click", (e) => {
    if (!header.contains(e.target)) closeAll(null);
  });

  const menuBtn = header.querySelector(".menu-toggle");
  if (menuBtn) {
    menuBtn.addEventListener("click", () => {
      const open = !header.classList.contains("nav-open");
      header.classList.toggle("nav-open", open);
      menuBtn.setAttribute("aria-expanded", String(open));
      menuBtn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    });
    header.querySelectorAll(".nav a").forEach((a) => {
      a.addEventListener("click", () => {
        header.classList.remove("nav-open");
        menuBtn.setAttribute("aria-expanded", "false");
        menuBtn.setAttribute("aria-label", "Open menu");
      });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && header.classList.contains("nav-open")) {
        header.classList.remove("nav-open");
        menuBtn.setAttribute("aria-expanded", "false");
        menuBtn.focus();
      }
    });
  }
}

function initCopy() {
  document.querySelectorAll("[data-copy-target]").forEach((btn) => {
    const target = document.getElementById(btn.dataset.copyTarget);
    if (!target || !navigator.clipboard) {
      btn.hidden = true;
      return;
    }
    btn.addEventListener("click", async () => {
      const lines = Array.from(target.querySelectorAll("[data-cmd]")).map((l) => l.dataset.cmd);
      const text = lines.length ? lines.join("\n") : target.textContent;
      const label = btn.querySelector(".copy-label");
      try {
        await navigator.clipboard.writeText(text);
        if (label) label.textContent = "Copied";
      } catch (e) {
        if (label) label.textContent = "Copy failed";
      }
      window.setTimeout(() => { if (label) label.textContent = "Copy"; }, 1800);
    });
  });
}

initTheme();
initNav();
initCopy();
