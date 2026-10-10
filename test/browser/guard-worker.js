// Used only in the instrumented real-course test build, never in the shipped manifest.
importScripts('background.js');
let queue = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || !['QA_ARM', 'QA_CLAIM', 'QA_STATE', 'QA_STOP'].includes(message.type)) return false;
  const task = async () => {
    const state = (await chrome.storage.session.get('qaBudget')).qaBudget || { remaining: 0, claims: 0, hosts: [] };
    const fromPopup = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
    if (message.type === 'QA_ARM' && fromPopup) {
      const limit = Math.min(2, Math.max(0, Number(message.limit) || 0));
      const armed = { remaining: limit, claims: 0, hosts: message.hosts || [] };
      await chrome.storage.session.set({ qaBudget: armed });
      return armed;
    }
    if (message.type === 'QA_STOP' && fromPopup) {
      state.remaining = 0;
      await chrome.storage.session.set({ qaBudget: state });
      return state;
    }
    if (message.type === 'QA_STATE' && fromPopup) return state;
    if (message.type === 'QA_CLAIM' && sender.tab) {
      let host = '';
      try { host = new URL(sender.url).hostname; } catch (_) {}
      if (!state.hosts.includes(host) || state.remaining < 1) return { allowed: false };
      state.remaining--;
      state.claims++;
      await chrome.storage.session.set({ qaBudget: state });
      return { allowed: true };
    }
    return { allowed: false };
  };
  queue = queue.then(task).then(reply, () => reply({ allowed: false }));
  return true;
});
