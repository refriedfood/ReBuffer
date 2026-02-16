var enabledCheckbox = document.getElementById("enabled");
var muteCheckbox = document.getElementById("muteOnReload");
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
  browser.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
    if (!tabs || !tabs.length) {
      showStatus("No active tab");
      return;
    }
    currentTabId = tabs[0].id;

    return browser.runtime.sendMessage({
      type: "rebuffer_popupGetConfig",
      tabId: currentTabId
    });
  }).then(function (cfg) {
    if (!cfg) {
      enabledCheckbox.checked = false;
      muteCheckbox.checked = true;
      timeoutInput.value = 10;
      return;
    }

    var enabled = (typeof cfg.enabled === "boolean") ? cfg.enabled : false;
    var muteOnReload = (typeof cfg.muteOnReload === "boolean") ? cfg.muteOnReload : true;
    var timeoutMs = (typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0) ? cfg.timeoutMs : 10000;

    enabledCheckbox.checked = enabled;
    muteCheckbox.checked = muteOnReload;
    timeoutInput.value = Math.round(timeoutMs / 1000);
  }).catch(function (err) {
    console.error("ReBuffer popup load error", err);
    enabledCheckbox.checked = false;
    muteCheckbox.checked = true;
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
    timeoutMs: timeoutSeconds * 1000
  };

  browser.runtime.sendMessage({
    type: "rebuffer_popupSetConfig",
    tabId: currentTabId,
    config: config
  }).then(function () {
    showStatus("Saved");
  }).catch(function (err) {
    console.error("ReBuffer popup save error", err);
    showStatus("Error");
  });
}

document.addEventListener("DOMContentLoaded", function () {
  loadSettings();
});

saveButton.addEventListener("click", function () {
  saveSettings();
});
