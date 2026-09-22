/**
 * Cancellable click-and-confirm transaction. Old polls cannot finish a newer request.
 * DOM snapshot interpretation belongs to the caller; this module owns timing only.
 */
(function () {
  'use strict';
  /**
   * @param {{capture: function(): object, check: function(object): (string|false),
   *   click: function(Element): void}} dependencies
   * @returns {{cancel: function(): void, start: function(Element,
   *   {onConfirm: function(string, object): void, onTimeout: function(): void}): boolean}}
   * start returns false for a concurrent request. cancel is idempotent and silent.
   */
  window.AutoNext.createNavigationConfirmation = function ({ capture, check, click }) {
    let active = null;
    function cancel() {
      if (active && active.timer !== null) clearTimeout(active.timer);
      active = null;
    }
    return {
      cancel,
      start(button, { onConfirm, onTimeout }) {
        // A second caller must not dispatch another click while confirmation is pending.
        if (active) return false;
        const request = { snapshot: capture(), timer: null, started: Date.now() };
        active = request;
        const finish = (confirmed) => {
          if (active !== request) return;
          cancel();
          if (confirmed) onConfirm(confirmed, request.snapshot);
          else onTimeout();
        };
        const poll = () => {
          if (active !== request) return;
          let confirmed;
          try { confirmed = check(request.snapshot); }
          catch (_) { finish(false); return; }
          if (confirmed) return finish(confirmed);
          if (Date.now() - request.started >= 2000) return finish(false);
          request.timer = setTimeout(poll, 250);
        };
        try { click(button); }
        catch (_) { finish(false); return false; }
        poll();
        return true;
      }
    };
  };
})();
