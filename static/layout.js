/* Drag, resize, and remember the workspace panels. */
const PanelLayout = (() => {
  const STORAGE_KEY = "capture-app-layout";
  const MIN_WIDTH = 240;
  const MIN_HEIGHT = 140;
  const MIN_SIDEBAR = 200;
  const MAX_SIDEBAR = 520;

  let workspace = null;
  let layoutEl = null;
  let onResize = () => {};
  let saved = load();
  let resizeFrame = 0;

  function load() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return {
        sidebarWidth: Number(parsed.sidebarWidth) || null,
        order: Array.isArray(parsed.order) ? parsed.order : [],
        sizes: parsed.sizes && typeof parsed.sizes === "object" ? parsed.sizes : {},
      };
    } catch {
      return { sidebarWidth: null, order: [], sizes: {} };
    }
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  }

  function init(options) {
    workspace = options.workspace;
    layoutEl = options.layout;
    onResize = options.onResize || (() => {});
    if (saved.sidebarWidth && layoutEl) {
      layoutEl.style.setProperty("--sidebar-w", `${saved.sidebarWidth}px`);
    }
    workspace.querySelectorAll(":scope > .workspace-panel").forEach(decorate);
    applyOrder();
    bindSidebarResize(options.resizer);
    options.resetButton?.addEventListener("click", reset);
  }

  function decorate(panel) {
    if (!panel || panel.dataset.layoutBound === "1") return panel;
    panel.dataset.layoutBound = "1";
    ensureGrip(panel);
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "panel-resize-handle";
    handle.title = "Drag to resize";
    handle.setAttribute("aria-label", "Resize panel");
    panel.append(handle);
    applySize(panel);
    handle.addEventListener("pointerdown", (event) => startResize(event, panel));
    return panel;
  }

  function ensureGrip(panel) {
    const toolbar = panel.querySelector(".panel-toolbar");
    const title = panel.querySelector(".card-label, h3");
    const host = toolbar || title;
    if (!host || host.querySelector(".panel-grip") || host.parentElement?.querySelector(".panel-grip")) return;
    const grip = document.createElement("button");
    grip.type = "button";
    grip.className = "panel-grip";
    grip.title = "Drag to move";
    grip.setAttribute("aria-label", "Move panel");
    grip.textContent = "⋮⋮";
    if (!toolbar && title) {
      const bar = document.createElement("div");
      bar.className = "panel-toolbar";
      title.parentNode.insertBefore(bar, title);
      bar.append(grip, title);
    } else {
      host.prepend(grip);
    }
    grip.addEventListener("pointerdown", (event) => startMove(event, panel));
  }

  function applySize(panel) {
    const size = saved.sizes[panel.dataset.panel];
    if (!size) return;
    panel.style.flex = "0 0 auto";
    if (size.w) panel.style.width = `${size.w}px`;
    if (size.h) panel.style.height = `${size.h}px`;
  }

  function applyOrder() {
    if (!workspace) return;
    const panels = [...workspace.querySelectorAll(":scope > .workspace-panel")];
    const byId = new Map(panels.map((panel) => [panel.dataset.panel, panel]));
    const seen = new Set();
    for (const id of saved.order) {
      const key = id === "video" ? "video:phone-video" : id;
      const panel = byId.get(key);
      if (!panel || seen.has(key)) continue;
      workspace.append(panel);
      seen.add(key);
    }
    for (const panel of panels) {
      const key = panel.dataset.panel;
      if (seen.has(key)) continue;
      if (key?.startsWith("video:")) {
        const anchor = [...workspace.querySelectorAll(":scope > .workspace-panel")]
          .reverse()
          .find((item) => item.dataset.panel?.startsWith("video:"));
        if (anchor) anchor.after(panel);
        else workspace.prepend(panel);
      } else {
        workspace.append(panel);
      }
      seen.add(key);
    }
  }

  function rememberOrder() {
    saved.order = [...workspace.querySelectorAll(":scope > .workspace-panel")].map(
      (panel) => panel.dataset.panel,
    );
    persist();
  }

  function startMove(event, panel) {
    if (event.button !== 0) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic events have no active pointer. Window listeners still track the drag.
    }
    const originX = event.clientX;
    const originY = event.clientY;
    let dragging = false;

    const step = (ev) => {
      if (Math.hypot(ev.clientX - originX, ev.clientY - originY) < 4) return;
      dragging = true;
      panel.classList.add("is-dragging");
      const target = panelAt(ev.clientX, ev.clientY, panel);
      if (!target || target === panel) return;
      const rect = target.getBoundingClientRect();
      const dx = (ev.clientX - (rect.left + rect.width / 2)) / rect.width;
      const dy = (ev.clientY - (rect.top + rect.height / 2)) / rect.height;
      const placeAfter = Math.abs(dx) > Math.abs(dy) ? dx > 0 : dy > 0;
      workspace.insertBefore(panel, placeAfter ? target.nextSibling : target);
    };

    const stop = (ev) => {
      step(ev);
      panel.classList.remove("is-dragging");
      window.removeEventListener("pointermove", step);
      window.removeEventListener("pointerup", stop);
      if (dragging) rememberOrder();
    };

    window.addEventListener("pointermove", step);
    window.addEventListener("pointerup", stop);
  }

  function panelAt(x, y, ignore) {
    for (const element of document.elementsFromPoint(x, y)) {
      const panel = element.closest?.(".workspace-panel");
      if (panel && panel !== ignore && workspace.contains(panel)) return panel;
    }
    return null;
  }

  function startResize(event, panel) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic events have no active pointer. Window listeners still track the drag.
    }
    const startW = panel.offsetWidth;
    const startH = panel.offsetHeight;
    const originX = event.clientX;
    const originY = event.clientY;
    panel.classList.add("is-resizing");

    const move = (ev) => {
      const width = Math.max(MIN_WIDTH, Math.round(startW + ev.clientX - originX));
      const height = Math.max(MIN_HEIGHT, Math.round(startH + ev.clientY - originY));
      const maxWidth = workspace.clientWidth;
      panel.style.flex = "0 0 auto";
      panel.style.width = `${Math.min(width, maxWidth)}px`;
      panel.style.height = `${height}px`;
      scheduleResize();
    };

    const stop = () => {
      panel.classList.remove("is-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      saved.sizes[panel.dataset.panel] = {
        w: panel.offsetWidth,
        h: panel.offsetHeight,
      };
      persist();
      scheduleResize();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function scheduleResize() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      onResize();
    });
  }

  function bindSidebarResize(resizer) {
    if (!resizer || !layoutEl) return;
    resizer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startW = layoutEl.querySelector(".sidebar")?.offsetWidth || 280;
      const move = (ev) => {
        const width = Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, Math.round(startW + ev.clientX - startX)));
        layoutEl.style.setProperty("--sidebar-w", `${width}px`);
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        const width = layoutEl.querySelector(".sidebar")?.offsetWidth;
        if (width) {
          saved.sidebarWidth = width;
          persist();
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
    });
  }

  function reset() {
    saved = { sidebarWidth: null, order: [], sizes: {} };
    localStorage.removeItem(STORAGE_KEY);
    layoutEl?.style.removeProperty("--sidebar-w");
    const panels = [...workspace.querySelectorAll(":scope > .workspace-panel")];
    const rank = (panel) => {
      const id = panel.dataset.panel || "";
      if (id === "video:phone-video" || id === "video") return 0;
      if (id.startsWith("video:")) return 1;
      if (id === "map") return 2;
      if (id === "audio") return 3;
      return 4;
    };
    panels.sort((a, b) => rank(a) - rank(b));
    for (const panel of panels) {
      panel.style.flex = "";
      panel.style.width = "";
      panel.style.height = "";
      workspace.append(panel);
    }
    scheduleResize();
  }

  function setWidth(panel, width) {
    if (!panel) return;
    const maxWidth = workspace?.clientWidth || width;
    const w = Math.min(maxWidth, Math.max(Math.min(MIN_WIDTH, maxWidth), Math.round(width)));
    panel.style.flex = "0 0 auto";
    panel.style.width = `${w}px`;
    saved.sizes[panel.dataset.panel] = {
      w,
      h: panel.offsetHeight,
    };
    persist();
    scheduleResize();
  }

  return { init, decorate, applyOrder, setWidth };
})();
