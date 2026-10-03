// UI behaviour for the component kit. No inline scripts or handlers anywhere in the views (CSP),
// so everything interactive is wired here:
//  - Alpine.js CSP-build components (tabs, dismissible) — registered before Alpine starts, because this
//    file is loaded with `defer` ahead of the Alpine script.
//  - Native <dialog> modals via data-modal-open / data-modal-close.
//  - Toasts: dispatch `toast` on window, or send an HX-Trigger header from the server:
//      HX-Trigger: {"toast":{"message":"Saved","tone":"success"}}

document.addEventListener('alpine:init', () => {
  const Alpine = window.Alpine;

  // Accessible tabs (WAI-ARIA tabs pattern): arrow keys move between tabs, Home/End jump.
  Alpine.data('tabs', () => ({
    active: null,
    init() {
      this.active = this.$el.dataset.initial;
    },
    select(event) {
      this.active = event.currentTarget.dataset.tab;
    },
    get isSelected() {
      return String(this.active === this.$el.dataset.tab);
    },
    get tabIndex() {
      return this.active === this.$el.dataset.tab ? '0' : '-1';
    },
    get isActivePanel() {
      return this.active === this.$el.dataset.panel;
    },
    keydown(event) {
      const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      const tabs = Array.from(event.currentTarget.querySelectorAll('[role="tab"]'));
      const current = tabs.indexOf(document.activeElement);
      if (current === -1) return;
      let next = current;
      if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      event.preventDefault();
      tabs[next].focus();
      this.active = tabs[next].dataset.tab;
    },
  }));

  Alpine.data('dismissible', () => ({
    open: true,
    close() {
      this.open = false;
    },
  }));
});

document.addEventListener('click', (event) => {
  const toaster = event.target.closest('[data-toast-message]');
  if (toaster) {
    showToast({ message: toaster.dataset.toastMessage, tone: toaster.dataset.toastTone });
    return;
  }
  const opener = event.target.closest('[data-modal-open]');
  if (opener) {
    const dialog = document.getElementById(opener.dataset.modalOpen);
    if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
    return;
  }
  const closer = event.target.closest('[data-modal-close]');
  if (closer) {
    const dialog = closer.closest('dialog');
    if (dialog) dialog.close();
    return;
  }
  // A click on the backdrop lands on the <dialog> element itself.
  if (event.target instanceof HTMLDialogElement && event.target.open) event.target.close();
});

function showToast({ message, tone = 'info' }) {
  const region = document.querySelector('[data-toast-region]');
  if (!region || !message) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.dataset.tone = tone;
  toast.textContent = String(message); // textContent, never innerHTML: messages may carry user data
  region.append(toast);
  setTimeout(() => toast.remove(), 6000);
}

window.addEventListener('toast', (event) => showToast(event.detail ?? {}));

// htmx and the signed-in app: every htmx request carries the page's CSRF token (the <meta name="csrf-token"> the app
// layout writes), and a request that comes back 401 means the session ended, so the page reloads into sign-in
// instead of showing an error fragment where a table should be.
document.addEventListener('htmx:configRequest', (event) => {
  const meta = document.querySelector('meta[name="csrf-token"]');
  if (meta && meta.content) event.detail.headers['X-CSRF-Token'] = meta.content;
});
document.addEventListener('htmx:responseError', (event) => {
  if (event.detail.xhr && event.detail.xhr.status === 401) window.location.reload();
});

// The free audit's live page (UI_DESIGN A8). The server renders the whole feed, so the page is complete without
// this script; with it, the feed is swapped for the server's newer rendering as steps finish (server-sent events,
// /audit/:id/events) and the visitor is sent to the report when it is ready. The HTML is our own server's output,
// built from escaped templates; the destination comes from the page, never from the stream.
(function () {
  const root = document.querySelector('[data-audit-progress]');
  if (!root || typeof window.EventSource === 'undefined') return;
  const source = new window.EventSource(root.dataset.events);
  source.addEventListener('progress', (event) => {
    try {
      root.innerHTML = JSON.parse(event.data).html;
    } catch {
      // A garbled update is skipped: the next one replaces it.
    }
  });
  source.addEventListener('done', () => {
    source.close();
    window.location.assign(root.dataset.report);
  });
  source.addEventListener('error', () => {
    // The browser retries by itself; if it gave up (the connection was refused, say), reload to try again.
    if (source.readyState === window.EventSource.CLOSED)
      setTimeout(() => window.location.reload(), 8000);
  });
})();

// Pages that wait for a job (a project being read, a first check running) set `refreshSeconds`, and the app layout
// writes a [data-auto-refresh] bar. The page reloads itself every few seconds, with three guards: the visitor can stop
// it (WCAG 2.2.1: a timed refresh must be switchable), it waits while the tab is in the background, and it never
// reloads over something the visitor has typed but not yet saved. Without this script the page is still correct.
(function () {
  const root = document.querySelector('[data-auto-refresh]');
  if (!root) return;
  const seconds = Number(root.dataset.autoRefresh);
  if (!(seconds >= 3 && seconds <= 120)) return;

  const edited = (field) => {
    if (field.type === 'checkbox' || field.type === 'radio')
      return field.checked !== field.defaultChecked;
    if (field.tagName === 'SELECT')
      return Array.from(field.options).some((o) => o.selected !== o.defaultSelected);
    return field.value !== field.defaultValue;
  };
  const typing = () =>
    Array.from(
      document.querySelectorAll('input:not([type=hidden]):not([type=submit]), textarea, select'),
    ).some(edited);

  let timer;
  const tick = () => {
    if (document.hidden || typing()) {
      timer = setTimeout(tick, seconds * 1000);
      return;
    }
    window.location.reload();
  };
  timer = setTimeout(tick, seconds * 1000);

  const stop = root.querySelector('[data-auto-refresh-stop]');
  if (stop)
    stop.addEventListener('click', () => {
      clearTimeout(timer);
      stop.hidden = true;
      const text = root.querySelector('[data-auto-refresh-text]');
      if (text) text.textContent = 'Updating is stopped. Reload the page to see the latest.';
    });
})();
