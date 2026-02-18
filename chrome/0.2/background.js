var rb = (function () {
  if (typeof browser !== "undefined") {
    return browser;
  }

  if (typeof chrome !== "undefined") {
    function promisify(target, method) {
      return function () {
        var args = Array.prototype.slice.call(arguments);
        return new Promise(function (resolve, reject) {
          args.push(function (result) {
            if (chrome.runtime && chrome.runtime.lastError) {
              reject(chrome.runtime.lastError);
            } else {
              resolve(result);
            }
          });
          target[method].apply(target, args);
        });
      };
    }

    return {
      storage: {
        local: {
          get: promisify(chrome.storage.local, "get"),
          set: promisify(chrome.storage.local, "set")
        }
      },
      tabs: {
        update: promisify(chrome.tabs, "update"),
        reload: promisify(chrome.tabs, "reload"),
        sendMessage: promisify(chrome.tabs, "sendMessage"),
        query: promisify(chrome.tabs, "query")
      },
      runtime: {
        sendMessage: promisify(chrome.runtime, "sendMessage"),
        onMessage: chrome.runtime.onMessage,
        onInstalled: chrome.runtime.onInstalled,
        onStartup: chrome.runtime.onStartup
      },
      contextMenus: {
        create: promisify(chrome.contextMenus, "create"),
        removeAll: promisify(chrome.contextMenus, "removeAll"),
        update: promisify(chrome.contextMenus, "update"),
        onClicked: chrome.contextMenus.onClicked,
        refresh: chrome.contextMenus.refresh
          ? function () {
              chrome.contextMenus.refresh();
              return Promise.resolve();
            }
          : function () {
              return Promise.resolve();
            }
      }
    };
  }

  return null;
})();

var isChromeLike = (typeof browser === "undefined") && (typeof chrome !== "undefined");

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

function safeAddListener(evt, fn) {
  try {
    if (evt && typeof evt.addListener === "function") {
      evt.addListener(fn);
      return true;
    }
  } catch (e) {}
  return false;
}

async function getGlobalConfig() {
  const res = await rb.storage.local.get("global_config");
  const cfg = res.global_config || {};
  return {
    timeoutMs:
      typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0
        ? cfg.timeoutMs
        : DEFAULT_GLOBAL_CONFIG.timeoutMs,
    muteOnReload:
      typeof cfg.muteOnReload === "boolean"
        ? cfg.muteOnReload
        : DEFAULT_GLOBAL_CONFIG.muteOnReload,
    reloadOnPauseStop:
      typeof cfg.reloadOnPauseStop === "boolean"
        ? cfg.reloadOnPauseStop
        : DEFAULT_GLOBAL_CONFIG.reloadOnPauseStop,
    pageContextMenu:
      typeof cfg.pageContextMenu === "boolean"
        ? cfg.pageContextMenu
        : DEFAULT_GLOBAL_CONFIG.pageContextMenu
  };
}

async function setGlobalConfig(cfg) {
  const current = await getGlobalConfig();
  const next = {
    timeoutMs:
      typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0
        ? cfg.timeoutMs
        : current.timeoutMs,
    muteOnReload:
      typeof cfg.muteOnReload === "boolean"
        ? cfg.muteOnReload
        : current.muteOnReload,
    reloadOnPauseStop:
      typeof cfg.reloadOnPauseStop === "boolean"
        ? cfg.reloadOnPauseStop
        : current.reloadOnPauseStop,
    pageContextMenu:
      typeof cfg.pageContextMenu === "boolean"
        ? cfg.pageContextMenu
        : current.pageContextMenu
  };
  await rb.storage.local.set({ global_config: next });
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
  const res = await rb.storage.local.get(key);
  let tabCfg = res[key];

  if (!tabCfg) {
    const g = await getGlobalConfig();
    tabCfg = {
      enabled: DEFAULT_TAB_CONFIG.enabled,
      timeoutMs: g.timeoutMs,
      muteOnReload: g.muteOnReload,
      reloadOnPauseStop: g.reloadOnPauseStop
    };
    await rb.storage.local.set({ [key]: tabCfg });
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
    await rb.storage.local.set({ [key]: tabCfg });
  }

  return tabCfg;
}

async function setTabConfig(tabId, cfg) {
  if (tabId == null) {
    return null;
  }

  const key = storageKeyForTab(tabId);
  const current = await getTabConfig(tabId);

  const next = {
    enabled:
      typeof cfg.enabled === "boolean" ? cfg.enabled : current.enabled,
    timeoutMs:
      typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0
        ? cfg.timeoutMs
        : current.timeoutMs,
    muteOnReload:
      typeof cfg.muteOnReload === "boolean"
        ? cfg.muteOnReload
        : current.muteOnReload,
    reloadOnPauseStop:
      typeof cfg.reloadOnPauseStop === "boolean"
        ? cfg.reloadOnPauseStop
        : current.reloadOnPauseStop
  };

  await rb.storage.local.set({ [key]: next });
  return next;
}

async function getActiveTabIdFallback() {
  try {
    const tabs = await rb.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0] && typeof tabs[0].id === "number") {
      return tabs[0].id;
    }
  } catch (e) {}
  return null;
}

async function resolveClickTabId(tab) {
  if (tab && typeof tab.id === "number") {
    return tab.id;
  }
  // Some Chrome builds do not pass tab for browser_action context menu clicks.
  return await getActiveTabIdFallback();
}

safeAddListener(rb.runtime && rb.runtime.onMessage, function (message, sender, sendResponse) {
  (async function () {
    try {
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
              await rb.tabs.update(tabId, { muted: false });
            } catch (e) {}
          }
          try {
            await rb.tabs.sendMessage(tabId, {
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
            await rb.tabs.update(tabId, { muted: true });
          } catch (e) {}
        }
        autoplayTabs[tabId] = true;
        await rb.tabs.reload(tabId);
        sendResponse({ ok: true });
      }
    } catch (e) {}
  })();

  return true;
});

function contextsForMenus(globalCfg) {
  // Chrome MV2 here: valid contexts include "page" and "browser_action". No "tab".
  // Requirement: Chrome must always expose webpage right click menu.
  if (isChromeLike) {
    return ["page", "browser_action"];
  }

  var ctx = ["tab"];
  if (globalCfg && globalCfg.pageContextMenu) {
    ctx.push("page");
  }
  return ctx;
}

async function createContextMenus() {
  try {
    const cfg = await getGlobalConfig();
    const ctx = contextsForMenus(cfg);

    await rb.contextMenus.removeAll();

    await rb.contextMenus.create({
      id: "rebuffer_root",
      title: "ReBuffer",
      contexts: ctx
    });

    await rb.contextMenus.create({
      id: "rebuffer_enable",
      parentId: "rebuffer_root",
      title: "Enable ReBuffer",
      contexts: ctx
    });

    await rb.contextMenus.create({
      id: "rebuffer_disable",
      parentId: "rebuffer_root",
      title: "Disable ReBuffer",
      contexts: ctx
    });

    await rb.contextMenus.create({
      id: "rebuffer_toggle_mute",
      parentId: "rebuffer_root",
      title: "Toggle Reload Mute",
      contexts: ctx
    });

    await rb.contextMenus.create({
      id: "rebuffer_unmute_now",
      parentId: "rebuffer_root",
      title: "Unmute Tab",
      contexts: ctx
    });
  } catch (e) {
    // Never crash background on menu creation errors.
  }
}

safeAddListener(rb.contextMenus && rb.contextMenus.onClicked, function (info, tab) {
  (async function () {
    try {
      var tabId = await resolveClickTabId(tab);
      if (tabId == null) {
        return;
      }

      if (info.menuItemId === "rebuffer_enable") {
        var updated1 = await setTabConfig(tabId, { enabled: true });
        try {
          await rb.tabs.sendMessage(tabId, { type: "rebuffer_updateConfig", config: updated1 });
        } catch (e) {}
      } else if (info.menuItemId === "rebuffer_disable") {
        var updated2 = await setTabConfig(tabId, { enabled: false });
        try {
          await rb.tabs.sendMessage(tabId, { type: "rebuffer_updateConfig", config: updated2 });
        } catch (e) {}
      } else if (info.menuItemId === "rebuffer_toggle_mute") {
        var current = await getTabConfig(tabId);
        var updated3 = await setTabConfig(tabId, { muteOnReload: !current.muteOnReload });
        if (updated3 && updated3.muteOnReload === false) {
          try {
            await rb.tabs.update(tabId, { muted: false });
          } catch (e) {}
        }
        try {
          await rb.tabs.sendMessage(tabId, { type: "rebuffer_updateConfig", config: updated3 });
        } catch (e) {}
      } else if (info.menuItemId === "rebuffer_unmute_now") {
        try {
          await rb.tabs.update(tabId, { muted: false });
        } catch (e) {}
      }
    } catch (e) {}
  })();
});

safeAddListener(rb.runtime && rb.runtime.onInstalled, function () {
  createContextMenus();
});

safeAddListener(rb.runtime && rb.runtime.onStartup, function () {
  createContextMenus();
});

try {
  createContextMenus();
} catch (e) {}
