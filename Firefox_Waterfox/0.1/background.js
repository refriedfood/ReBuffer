const DEFAULT_CONFIG = {
  enabled: false,      // OFF by default
  timeoutMs: 10000,    // 10 seconds
  muteOnReload: true   // when enabled, mute-on-reload is ON by default
};

function storageKeyForTab(tabId) {
  return "tab_" + tabId;
}

async function getConfigForTab(tabId) {
  if (tabId == null) return { ...DEFAULT_CONFIG };
  const key = storageKeyForTab(tabId);
  const res = await browser.storage.local.get(key);
  const tabCfg = res[key] || {};
  return {
    enabled: typeof tabCfg.enabled === "boolean" ? tabCfg.enabled : DEFAULT_CONFIG.enabled,
    timeoutMs: typeof tabCfg.timeoutMs === "number" && tabCfg.timeoutMs > 0 ? tabCfg.timeoutMs : DEFAULT_CONFIG.timeoutMs,
    muteOnReload: typeof tabCfg.muteOnReload === "boolean" ? tabCfg.muteOnReload : DEFAULT_CONFIG.muteOnReload
  };
}

async function setConfigForTab(tabId, cfg) {
  if (tabId == null) return;
  const key = storageKeyForTab(tabId);
  const current = await getConfigForTab(tabId);
  const newCfg = {
    enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : current.enabled,
    timeoutMs: typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : current.timeoutMs,
    muteOnReload: typeof cfg.muteOnReload === "boolean" ? cfg.muteOnReload : current.muteOnReload
  };
  await browser.storage.local.set({ [key]: newCfg });
  return newCfg;
}

// Messages from content and popup
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || typeof message.type !== "string") return;

    if (message.type === "rebuffer_getConfig") {
      const tabId = sender.tab && sender.tab.id;
      const cfg = await getConfigForTab(tabId);
      sendResponse(cfg);

    } else if (message.type === "rebuffer_popupGetConfig") {
      const tabId = message.tabId;
      const cfg = await getConfigForTab(tabId);
      sendResponse(cfg);

    } else if (message.type === "rebuffer_popupSetConfig") {
      const tabId = message.tabId;
      const cfg = message.config || {};
      const newCfg = await setConfigForTab(tabId, cfg);

      try {
        await browser.tabs.sendMessage(tabId, {
          type: "rebuffer_updateConfig",
          config: newCfg
        });
      } catch (e) {
        // content script may not be loaded yet
      }

      sendResponse({ ok: true });

    } else if (message.type === "rebuffer_hung") {
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) {
        sendResponse({ ok: false });
        return;
      }

      const cfg = await getConfigForTab(tabId);

      if (cfg.muteOnReload) {
        await browser.tabs.update(tabId, { muted: true });
      }
      await browser.tabs.reload(tabId);
      sendResponse({ ok: true });
    }
  })();

  return true; // async sendResponse
});

// Context menus

function createContextMenus() {
  browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: "rebuffer_toggle_tab",
      title: "ReBuffer on this tab",
      contexts: ["page", "tab"]
    });

    browser.contextMenus.create({
      id: "rebuffer_toggle_mute_tab",
      title: "Mute on reload (this tab)",
      contexts: ["page", "tab"]
    });
  }).catch(() => {});
}

// Show state with • / ·
browser.contextMenus.onShown.addListener(async (info, tab) => {
  try {
    if (!tab || tab.id == null) return;
    const cfg = await getConfigForTab(tab.id);

    // • = ON, · = OFF
    const enabledDot = cfg.enabled ? "•" : "◦";
    const muteDot    = cfg.muteOnReload ? "•" : "◦";

    const enabledLabel = cfg.enabled
      ? "\u00A0\u00A0Disable ReBuffer"
      : "\u00A0\u00A0Enable ReBuffer";

    const muteLabel = cfg.muteOnReload
      ? "\u00A0\u00A0Disable Mute"
      : "\u00A0\u00A0Enable Mute";

    await browser.contextMenus.update("rebuffer_toggle_tab", {
      title: enabledDot + " " + enabledLabel
    });

    await browser.contextMenus.update("rebuffer_toggle_mute_tab", {
      title: muteDot + " " + muteLabel
    });

    browser.contextMenus.refresh();
  } catch (e) {
    // ignore
  }
});

// Click handler
browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id == null) return;
  const tabId = tab.id;
  const cfg = await getConfigForTab(tabId);

  if (info.menuItemId === "rebuffer_toggle_tab") {
    const newCfg = await setConfigForTab(tabId, { enabled: !cfg.enabled });
    try {
      await browser.tabs.sendMessage(tabId, {
        type: "rebuffer_updateConfig",
        config: newCfg
      });
    } catch (e) {}

  } else if (info.menuItemId === "rebuffer_toggle_mute_tab") {
    const newCfg = await setConfigForTab(tabId, { muteOnReload: !cfg.muteOnReload });
    try {
      await browser.tabs.sendMessage(tabId, {
        type: "rebuffer_updateConfig",
        config: newCfg
      });
    } catch (e) {}
  }
});

browser.runtime.onInstalled.addListener(createContextMenus);
browser.runtime.onStartup.addListener(createContextMenus);
