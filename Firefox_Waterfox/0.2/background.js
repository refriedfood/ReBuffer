const DEFAULT_GLOBAL_CONFIG = {
  timeoutMs: 10000,
  muteOnReload: true,
  reloadOnPauseStop: false,
  pageContextMenu: true
};

const DEFAULT_TAB_CONFIG = {
  enabled: false,
  timeoutMs: null,
  muteOnReload: null,
  reloadOnPauseStop: null
};

const autoplayTabs = {};

function storageKeyForTab(tabId) {
  return "tab_" + tabId;
}

async function getGlobalConfig() {
  const res = await browser.storage.local.get("global_config");
  const cfg = res.global_config || {};
  return {
    timeoutMs: typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_GLOBAL_CONFIG.timeoutMs,
    muteOnReload: typeof cfg.muteOnReload === "boolean" ? cfg.muteOnReload : DEFAULT_GLOBAL_CONFIG.muteOnReload,
    reloadOnPauseStop: typeof cfg.reloadOnPauseStop === "boolean" ? cfg.reloadOnPauseStop : DEFAULT_GLOBAL_CONFIG.reloadOnPauseStop,
    pageContextMenu: typeof cfg.pageContextMenu === "boolean" ? cfg.pageContextMenu : DEFAULT_GLOBAL_CONFIG.pageContextMenu
  };
}

async function setGlobalConfig(cfg) {
  const current = await getGlobalConfig();
  const next = {
    timeoutMs: typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : current.timeoutMs,
    muteOnReload: typeof cfg.muteOnReload === "boolean" ? cfg.muteOnReload : current.muteOnReload,
    reloadOnPauseStop: typeof cfg.reloadOnPauseStop === "boolean" ? cfg.reloadOnPauseStop : current.reloadOnPauseStop,
    pageContextMenu: typeof cfg.pageContextMenu === "boolean" ? cfg.pageContextMenu : current.pageContextMenu
  };
  await browser.storage.local.set({ global_config: next });
  return next;
}

async function getTabConfig(tabId) {
  if (tabId == null) {
    const g = await getGlobalConfig();
    return {
      enabled: DEFAULT_TAB_CONFIG.enabled,
      timeoutMs: g.timeoutMs,
      muteOnReload: g.muteOnReload,
      reloadOnPauseStop: g.reloadOnPauseStop
    };
  }

  const key = storageKeyForTab(tabId);
  const res = await browser.storage.local.get(key);
  let tabCfg = res[key];

  if (!tabCfg) {
    const g = await getGlobalConfig();
    tabCfg = {
      enabled: DEFAULT_TAB_CONFIG.enabled,
      timeoutMs: g.timeoutMs,
      muteOnReload: g.muteOnReload,
      reloadOnPauseStop: g.reloadOnPauseStop
    };
    await browser.storage.local.set({ [key]: tabCfg });
  } else {
    if (typeof tabCfg.enabled !== "boolean") {
      tabCfg.enabled = DEFAULT_TAB_CONFIG.enabled;
    }
    if (typeof tabCfg.timeoutMs !== "number" || tabCfg.timeoutMs <= 0) {
      const g = await getGlobalConfig();
      tabCfg.timeoutMs = g.timeoutMs;
    }
    if (typeof tabCfg.muteOnReload !== "boolean") {
      const g = await getGlobalConfig();
      tabCfg.muteOnReload = g.muteOnReload;
    }
    if (typeof tabCfg.reloadOnPauseStop !== "boolean") {
      const g = await getGlobalConfig();
      tabCfg.reloadOnPauseStop = g.reloadOnPauseStop;
    }
    await browser.storage.local.set({ [key]: tabCfg });
  }

  return tabCfg;
}

async function setTabConfig(tabId, cfg) {
  if (tabId == null) return null;
  const key = storageKeyForTab(tabId);
  const current = await getTabConfig(tabId);
  const next = {
    enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : current.enabled,
    timeoutMs: typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : current.timeoutMs,
    muteOnReload: typeof cfg.muteOnReload === "boolean" ? cfg.muteOnReload : current.muteOnReload,
    reloadOnPauseStop: typeof cfg.reloadOnPauseStop === "boolean" ? cfg.reloadOnPauseStop : current.reloadOnPauseStop
  };
  await browser.storage.local.set({ [key]: next });
  return next;
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === "rebuffer_getConfig") {
      const tabId = sender.tab && sender.tab.id;
      const cfg = await getTabConfig(tabId);
      const extra = {};
      if (tabId != null && autoplayTabs[tabId]) {
        extra.autoplayOnStart = true;
        delete autoplayTabs[tabId];
      }
      sendResponse(Object.assign({}, cfg, extra));
    } else if (message.type === "rebuffer_popupGetConfig") {
      const tabId = message.tabId;
      const cfg = await getTabConfig(tabId);
      sendResponse(cfg);
    } else if (message.type === "rebuffer_popupSetConfig") {
      const tabId = message.tabId;
      const cfg = message.config || {};
      if (tabId != null) {
        const updated = await setTabConfig(tabId, cfg);
        if (updated && updated.muteOnReload === false) {
          try {
            await browser.tabs.update(tabId, { muted: false });
          } catch (e) {}
        }
        try {
          await browser.tabs.sendMessage(tabId, {
            type: "rebuffer_updateConfig",
            config: updated
          });
        } catch (e) {}
      }
      sendResponse({ ok: true });
    } else if (message.type === "rebuffer_getGlobalConfig") {
      const cfg = await getGlobalConfig();
      sendResponse(cfg);
    } else if (message.type === "rebuffer_setGlobalConfig") {
      const cfg = message.config || {};
      const next = await setGlobalConfig(cfg);
      createContextMenus();
      sendResponse(next);
    } else if (message.type === "rebuffer_hung") {
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) {
        sendResponse({ ok: false });
        return;
      }
      const cfg = await getTabConfig(tabId);
      if (cfg.muteOnReload) {
        try {
          await browser.tabs.update(tabId, { muted: true });
        } catch (e) {}
      }
      autoplayTabs[tabId] = true;
      await browser.tabs.reload(tabId);
      sendResponse({ ok: true });
    }
  })();
  return true;
});

function createContextMenus() {
  getGlobalConfig().then(cfg => {
    const contexts = ["tab"];
    if (cfg.pageContextMenu) {
      contexts.push("page");
    }
    browser.contextMenus.removeAll().then(() => {
      browser.contextMenus.create({
        id: "rebuffer_toggle_tab",
        title: "Enable ReBuffer (this tab)",
        contexts: contexts
      });
      browser.contextMenus.create({
        id: "rebuffer_toggle_mute_tab",
        title: "Mute on reload (this tab)",
        contexts: contexts
      });
    }).catch(() => {});
  }).catch(() => {});
}

browser.contextMenus.onShown.addListener(async (info, tab) => {
  try {
    if (!tab || tab.id == null) return;
    const cfg = await getTabConfig(tab.id);
    const enabledDot = cfg.enabled ? "•" : "◦";
    const muteDot = cfg.muteOnReload ? "•" : "◦";
    const enabledLabel = cfg.enabled ? "\u00A0\u00A0Disable ReBuffer" : "\u00A0\u00A0Enable ReBuffer";
    const muteLabel = cfg.muteOnReload ? "\u00A0\u00A0Disable Mute" : "\u00A0\u00A0Enable Mute";
    browser.contextMenus.update("rebuffer_toggle_tab", {
      title: enabledDot + enabledLabel
    });
    browser.contextMenus.update("rebuffer_toggle_mute_tab", {
      title: muteDot + muteLabel
    });
    browser.contextMenus.refresh();
  } catch (e) {}
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id == null) return;
  const tabId = tab.id;
  const cfg = await getTabConfig(tabId);
  if (info.menuItemId === "rebuffer_toggle_tab") {
    const updated = await setTabConfig(tabId, { enabled: !cfg.enabled });
    try {
      await browser.tabs.sendMessage(tabId, {
        type: "rebuffer_updateConfig",
        config: updated
      });
    } catch (e) {}
  } else if (info.menuItemId === "rebuffer_toggle_mute_tab") {
    const updated = await setTabConfig(tabId, { muteOnReload: !cfg.muteOnReload });
    if (updated.muteOnReload === false) {
      try {
        await browser.tabs.update(tabId, { muted: false });
      } catch (e) {}
    }
    try {
      await browser.tabs.sendMessage(tabId, {
        type: "rebuffer_updateConfig",
        config: updated
      });
    } catch (e) {}
  }
});

browser.runtime.onInstalled.addListener(createContextMenus);
browser.runtime.onStartup.addListener(createContextMenus);
