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
