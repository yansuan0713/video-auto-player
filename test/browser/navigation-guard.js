// Installed before navigation-confirmation captures dom.click; all new frames start guarded.
(() => {
  const api = window.AutoNext;
  const click = api.dom.click;
  api.dom.click = async element => {
    const text = api.dom.normalize(api.dom.textOf(element));
    const unsafe = /测验|测试|作业|考试|提交|验证|上一|返回/.test(text)
      || element.closest('form') || !/下一|下个|任务点\d|任务\d/.test(text);
    if (unsafe) { api.addEvent('QA_NAVIGATION_BLOCKED', { reason: 'non-video-navigation' }); return; }
    const result = await chrome.runtime.sendMessage({ type: 'QA_CLAIM' }).catch(() => null);
    if (!result?.allowed) { api.addEvent('QA_NAVIGATION_BLOCKED', { reason: 'navigation-budget' }); return; }
    return click(element);
  };
})();
