chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("app.html");
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => tab.url?.startsWith(url));
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId)
      await chrome.windows.update(existing.windowId, { focused: true });
  } else await chrome.tabs.create({ url });
});
