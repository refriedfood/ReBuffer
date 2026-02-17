var muteCheckbox = document.getElementById("muteOnReload");
var reloadPauseCheckbox = document.getElementById("reloadOnPause");
var pageMenuCheckbox = document.getElementById("pageMenu");
var timeoutInput = document.getElementById("timeout");
var saveButton = document.getElementById("save");
var statusSpan = document.getElementById("status");

function showStatus(text) {
  statusSpan.textContent = text;
  if (text) {
    setTimeout(function () {
      statusSpan.textContent = "";
    }, 1200);
  }
}

function loadGlobalSettings() {
  browser.runtime.sendMessage({
    type: "rebuffer_getGlobalConfig"
  }).then(function (cfg) {
    if (!cfg) {
      muteCheckbox.checked = true;
      reloadPauseCheckbox.checked = false;
      pageMenuCheckbox.checked = true;
      timeoutInput.value = 10;
      return;
    }

    var muteOnReload = typeof cfg.muteOnReload === "boolean" ? cfg.muteOnReload : true;
    var reloadOnPauseStop = typeof cfg.reloadOnPauseStop === "boolean" ? cfg.reloadOnPauseStop : false;
    var timeoutMs = typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : 10000;
    var pageMenu = typeof cfg.pageContextMenu === "boolean" ? cfg.pageContextMenu : true;

    muteCheckbox.checked = muteOnReload;
    reloadPauseCheckbox.checked = reloadOnPauseStop;
    pageMenuCheckbox.checked = pageMenu;
    timeoutInput.value = Math.round(timeoutMs / 1000);
  }).catch(function () {
    muteCheckbox.checked = true;
    reloadPauseCheckbox.checked = false;
    pageMenuCheckbox.checked = true;
    timeoutInput.value = 10;
  });
}

function saveGlobalSettings() {
  var timeoutSeconds = parseInt(timeoutInput.value, 10);
  if (isNaN(timeoutSeconds) || timeoutSeconds < 3) timeoutSeconds = 3;
  if (timeoutSeconds > 600) timeoutSeconds = 600;

  var config = {
    muteOnReload: muteCheckbox.checked,
    reloadOnPauseStop: reloadPauseCheckbox.checked,
    pageContextMenu: pageMenuCheckbox.checked,
    timeoutMs: timeoutSeconds * 1000
  };

  browser.runtime.sendMessage({
    type: "rebuffer_setGlobalConfig",
    config: config
  }).then(function () {
    showStatus("Saved");
  }).catch(function () {
    showStatus("Error");
  });
}

document.addEventListener("DOMContentLoaded", function () {
  loadGlobalSettings();
});

saveButton.addEventListener("click", function () {
  saveGlobalSettings();
});
