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
      runtime: {
        sendMessage: promisify(chrome.runtime, "sendMessage")
      },
      tabs: {
        query: promisify(chrome.tabs, "query")
      }
    };
  }
  return null;
})();

var enabledCheckbox = document.getElementById("enabled");
var muteCheckbox = document.getElementById("muteOnReload");
var reloadPauseCheckbox = document.getElementById("reloadOnPause");
var timeoutInput = document.getElementById("timeout");
var saveButton = document.getElementById("save");
var statusSpan = document.getElementById("status");

var currentTabId = null;

function showStatus(text) {
  statusSpan.textContent = text;
  if (text) {
    setTimeout(function () {
      statusSpan.textContent = "";
    }, 1200);
  }
}

function loadSettings() {
  rb.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
    if (!tabs || !tabs.length) {
      showStatus("No active tab");
      return;
    }
    currentTabId = tabs[0].id;

    return rb.runtime.sendMessage({
      type: "rebuffer_popupGetConfig",
      tabId: currentTabId
    });
  }).then(function (cfg) {
    if (!cfg) {
      enabledCheckbox.checked = false;
      muteCheckbox.checked = true;
      reloadPauseCheckbox.checked = false;
      timeoutInput.value = 10;
      return;
    }

    var enabled = (typeof cfg.enabled === "boolean") ? cfg.enabled : false;
    var muteOnReload = (typeof cfg.muteOnReload === "boolean") ? cfg.muteOnReload : true;
    var reloadOnPauseStop = (typeof cfg.reloadOnPauseStop === "boolean") ? cfg.reloadOnPauseStop : false;
    var timeoutMs = (typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0) ? cfg.timeoutMs : 10000;

    enabledCheckbox.checked = enabled;
    muteCheckbox.checked = muteOnReload;
    reloadPauseCheckbox.checked = reloadOnPauseStop;
    timeoutInput.value = Math.round(timeoutMs / 1000);
  }).catch(function () {
    enabledCheckbox.checked = false;
    muteCheckbox.checked = true;
    reloadPauseCheckbox.checked = false;
    timeoutInput.value = 10;
  });
}

function saveSettings() {
  if (currentTabId == null) {
    showStatus("No tab");
    return;
  }

  var timeoutSeconds = parseInt(timeoutInput.value, 10);
  if (isNaN(timeoutSeconds) || timeoutSeconds < 3) timeoutSeconds = 3;
  if (timeoutSeconds > 600) timeoutSeconds = 600;

  var config = {
    enabled: enabledCheckbox.checked,
    muteOnReload: muteCheckbox.checked,
    reloadOnPauseStop: reloadPauseCheckbox.checked,
    timeoutMs: timeoutSeconds * 1000
  };

  rb.runtime.sendMessage({
    type: "rebuffer_popupSetConfig",
    tabId: currentTabId,
    config: config
  }).then(function () {
    showStatus("Saved");
  }).catch(function () {
    showStatus("Error");
  });
}

document.addEventListener("DOMContentLoaded", function () {
  loadSettings();
});

saveButton.addEventListener("click", function () {
  saveSettings();
});
