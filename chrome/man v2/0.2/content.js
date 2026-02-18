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
        sendMessage: promisify(chrome.runtime, "sendMessage"),
        onMessage: chrome.runtime.onMessage
      }
    };
  }
  return null;
})();

var defaultConfig = {
  enabled: false,
  timeoutMs: 10000,
  checkIntervalMs: 1000,
  muteOnReload: true,
  reloadOnPauseStop: false,
  autoplayOnStart: false
};

var config = {
  enabled: defaultConfig.enabled,
  timeoutMs: defaultConfig.timeoutMs,
  checkIntervalMs: defaultConfig.checkIntervalMs,
  muteOnReload: defaultConfig.muteOnReload,
  reloadOnPauseStop: defaultConfig.reloadOnPauseStop,
  autoplayOnStart: defaultConfig.autoplayOnStart
};

var trackers = new WeakMap();
var observer = null;
var intervalId = null;

function applyConfig(res) {
  if (!res) return;
  if (typeof res.enabled === "boolean") config.enabled = res.enabled;
  if (typeof res.timeoutMs === "number" && res.timeoutMs > 0) config.timeoutMs = res.timeoutMs;
  if (typeof res.checkIntervalMs === "number" && res.checkIntervalMs > 0) {
    config.checkIntervalMs = res.checkIntervalMs;
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = setInterval(tick, config.checkIntervalMs);
    }
  }
  if (typeof res.muteOnReload === "boolean") config.muteOnReload = res.muteOnReload;
  if (typeof res.reloadOnPauseStop === "boolean") config.reloadOnPauseStop = res.reloadOnPauseStop;
  if (typeof res.autoplayOnStart === "boolean") config.autoplayOnStart = res.autoplayOnStart;
  updateActiveState();
}

function refreshConfigOnce() {
  try {
    rb.runtime.sendMessage({ type: "rebuffer_getConfig" }).then(function (response) {
      if (response && typeof response === "object") {
        applyConfig(response);
      } else {
        updateActiveState();
      }
    }).catch(function () {
      updateActiveState();
    });
  } catch (e) {
    updateActiveState();
  }
}

function updateActiveState() {
  if (config.enabled) {
    if (!observer) {
      scanForVideos();
      try {
        observer = new MutationObserver(function (mutations) {
          for (var i = 0; i < mutations.length; i++) {
            var m = mutations[i];
            if (m.type === "childList") {
              scanForVideos();
            }
          }
        });
        observer.observe(document.documentElement || document.body, {
          childList: true,
          subtree: true
        });
      } catch (e) {}
    }
    if (intervalId === null) {
      intervalId = setInterval(tick, config.checkIntervalMs);
    }
  } else {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    detachTrackers();
  }
}

rb.runtime.onMessage.addListener(function (message) {
  if (!message || typeof message.type !== "string") return;
  if (message.type === "rebuffer_updateConfig" && message.config) {
    applyConfig(message.config);
  }
});

function VideoTracker(video) {
  this.video = video;
  this.lastTime = video.currentTime || 0;
  this.lastProgressTs = Date.now();
  this.isBuffering = false;
  this.bufferingSince = null;
  this.pauseSince = video.paused ? Date.now() : null;
  this.pipModeActive = false;
  this.pipHangStartTs = null;

  this.onTimeUpdate = this.onTimeUpdate.bind(this);
  this.onPlay = this.onPlay.bind(this);
  this.onPause = this.onPause.bind(this);
  this.onEnded = this.onEnded.bind(this);
  this.onWaiting = this.onWaiting.bind(this);
  this.onStalled = this.onStalled.bind(this);
  this.onCanPlay = this.onCanPlay.bind(this);

  video.addEventListener("timeupdate", this.onTimeUpdate);
  video.addEventListener("play", this.onPlay);
  video.addEventListener("pause", this.onPause);
  video.addEventListener("ended", this.onEnded);
  video.addEventListener("waiting", this.onWaiting);
  video.addEventListener("stalled", this.onStalled);
  video.addEventListener("canplay", this.onCanPlay);
  video.addEventListener("canplaythrough", this.onCanPlay);
}

VideoTracker.prototype.onTimeUpdate = function () {
  var t = this.video.currentTime;
  var now = Date.now();
  if (t !== this.lastTime) {
    this.lastTime = t;
    this.lastProgressTs = now;
    this.isBuffering = false;
    this.bufferingSince = null;
    this.pipModeActive = false;
    this.pipHangStartTs = null;
  }
};

VideoTracker.prototype.onPlay = function () {
  this.pauseSince = null;
  this.isBuffering = false;
  this.bufferingSince = null;
  this.lastProgressTs = Date.now();
  this.lastTime = this.video.currentTime || this.lastTime;
  this.pipModeActive = false;
  this.pipHangStartTs = null;
};

VideoTracker.prototype.onPause = function () {
  if (!this.video.ended) {
    this.pauseSince = Date.now();
  }
  this.isBuffering = false;
  this.bufferingSince = null;
};

VideoTracker.prototype.onEnded = function () {
  this.pauseSince = null;
  this.isBuffering = false;
  this.bufferingSince = null;
  this.pipModeActive = false;
  this.pipHangStartTs = null;
};

VideoTracker.prototype.onWaiting = function () {
  var now = Date.now();
  if (!this.isBuffering) {
    this.isBuffering = true;
    this.bufferingSince = now;
  }
};

VideoTracker.prototype.onStalled = function () {
  var now = Date.now();
  if (!this.isBuffering) {
    this.isBuffering = true;
    this.bufferingSince = now;
  }
};

VideoTracker.prototype.onCanPlay = function () {
  this.isBuffering = false;
  this.bufferingSince = null;
};

VideoTracker.prototype.isHungNormal = function (now, timeoutMs) {
  if (!config.enabled) return false;
  if (this.video.ended) return false;

  var paused = this.video.paused;
  if (paused) {
    if (!config.reloadOnPauseStop) return false;
    if (!this.pauseSince) this.pauseSince = now;
    if (now - this.pauseSince >= timeoutMs) return true;
    return false;
  } else {
    if (this.pauseSince) {
      this.pauseSince = null;
      this.lastProgressTs = now;
    }
  }

  var sinceLastProgress = now - this.lastProgressTs;
  if (sinceLastProgress >= timeoutMs) {
    return true;
  }

  if (this.isBuffering && this.bufferingSince != null) {
    var bufferingFor = now - this.bufferingSince;
    if (bufferingFor >= timeoutMs) {
      return true;
    }
  }

  return false;
};

VideoTracker.prototype.isHungPiP = function (now, timeoutMs) {
  if (!config.enabled) return false;
  if (this.video.ended) return false;

  var sinceLastProgress = now - this.lastProgressTs;
  if (sinceLastProgress >= timeoutMs) {
    return true;
  }

  if (this.isBuffering && this.bufferingSince != null) {
    var bufferingFor = now - this.bufferingSince;
    if (bufferingFor >= timeoutMs) {
      return true;
    }
  }

  return false;
};

VideoTracker.prototype.shouldReloadNormal = function (now) {
  return this.isHungNormal(now, config.timeoutMs);
};

VideoTracker.prototype.handlePiP = function (now) {
  var pipDetectMs = config.timeoutMs;
  if (pipDetectMs < 3000) pipDetectMs = 3000;
  var pipMaxMs = pipDetectMs * 4;
  if (pipMaxMs < 25000) pipMaxMs = 25000;

  if (!this.pipModeActive) {
    if (!this.isHungPiP(now, pipDetectMs)) return false;
    this.pipModeActive = true;
    this.pipHangStartTs = now;
    this.resetPiP();
    return false;
  } else {
    if (!this.isHungPiP(now, pipDetectMs)) {
      this.pipModeActive = false;
      this.pipHangStartTs = null;
      return false;
    }
    if (this.pipHangStartTs == null) {
      this.pipHangStartTs = now;
      return false;
    }
    if (now - this.pipHangStartTs >= pipMaxMs) {
      this.pipModeActive = false;
      this.pipHangStartTs = null;
      return true;
    }
    return false;
  }
};

VideoTracker.prototype.resetPiP = function () {
  var v = this.video;
  if (!v) return;

  var self = this;
  var now = Date.now();

  // Remember currentTime so we can nudge/seek back to it.
  var currentTime = 0;
  try {
    currentTime = v.currentTime || 0;
  } catch (e) {}

  // Do NOT call load() immediately. On many MSE/HLS players it can stop playback permanently.
  // Instead, try a light nudge: seek + play.
  function tryPlayNudge() {
    try {
      // Nudge seek: some players resume if you re-assign currentTime.
      if (!isNaN(currentTime) && currentTime >= 0) {
        v.currentTime = currentTime;
      }
    } catch (e1) {}

    try {
      if (typeof v.play === "function") {
        var p = v.play();
        if (p && typeof p.catch === "function") {
          p.catch(function () {});
        }
      }
    } catch (e2) {}
  }

  // First attempt: play/nudge right away.
  tryPlayNudge();

  // Second attempt shortly after, in case the first call was ignored.
  try {
    setTimeout(function () {
      try {
        if (v && v.paused) {
          tryPlayNudge();
        }
      } catch (e3) {}
    }, 800);
  } catch (e4) {}

  // Last resort: if still paused after a bit AND load() exists, try load() then play.
  // Still do not update lastProgressTs here: we want hung detection to remain true until we see real progress.
  try {
    setTimeout(function () {
      try {
        if (!v) return;
        if (!v.paused) return;

        if (typeof v.load === "function") {
          v.load();
        }

        // Re-seek after metadata or canplay.
        function restoreAfterLoad() {
          try {
            v.removeEventListener("canplay", restoreAfterLoad);
            v.removeEventListener("loadedmetadata", restoreAfterLoad);
          } catch (e5) {}

          try {
            if (!isNaN(currentTime) && currentTime > 0) {
              v.currentTime = currentTime;
            }
          } catch (e6) {}

          tryPlayNudge();
        }

        try {
          v.addEventListener("canplay", restoreAfterLoad, { once: true });
          v.addEventListener("loadedmetadata", restoreAfterLoad, { once: true });
        } catch (e7) {}

        tryPlayNudge();
      } catch (e8) {}
    }, 2000);
  } catch (e9) {}

  // Clear buffering flags so we can observe fresh waiting/stalled signals.
  this.isBuffering = false;
  this.bufferingSince = null;
  this.pauseSince = null;

  // IMPORTANT:
  // Do not touch lastProgressTs here.
  // If we update lastProgressTs without real playback progress, PiP hang detection will stop triggering,
  // and the tab reload fallback will never happen.
};


VideoTracker.prototype.detach = function () {
  this.video.removeEventListener("timeupdate", this.onTimeUpdate);
  this.video.removeEventListener("play", this.onPlay);
  this.video.removeEventListener("pause", this.onPause);
  this.video.removeEventListener("ended", this.onEnded);
  this.video.removeEventListener("waiting", this.onWaiting);
  this.video.removeEventListener("stalled", this.onStalled);
  this.video.removeEventListener("canplay", this.onCanPlay);
  this.video.removeEventListener("canplaythrough", this.onCanPlay);
};

function setupVideo(video) {
  if (trackers.has(video)) return;
  trackers.set(video, new VideoTracker(video));
}

function ensureAutoplayOnStart() {
  if (!config.autoplayOnStart) return;
  var videos = document.querySelectorAll("video");
  if (!videos || videos.length === 0) return;
  var v = videos[0];
  if (!v) return;
  if (v.__rebufferAutoplayHook) return;
  v.__rebufferAutoplayHook = true;
  function doPlay() {
    try {
      if (config.muteOnReload) {
        v.muted = true;
        v.volume = 0;
      }
    } catch (e1) {}
    try {
      if (typeof v.play === "function") {
        var p = v.play();
        if (p && typeof p.catch === "function") {
          p.catch(function () {});
        }
      }
    } catch (e2) {}
  }
  try {
    v.addEventListener("canplay", function () {
      doPlay();
    }, { once: true });
    v.addEventListener("loadeddata", function () {
      doPlay();
    }, { once: true });
  } catch (e3) {}
  doPlay();
  config.autoplayOnStart = false;
}

function scanForVideos() {
  var videos = document.querySelectorAll("video");
  for (var i = 0; i < videos.length; i++) {
    setupVideo(videos[i]);
  }
  ensureAutoplayOnStart();
}

function detachTrackers() {
  var videos = document.querySelectorAll("video");
  for (var i = 0; i < videos.length; i++) {
    var v = videos[i];
    var tracker = trackers.get(v);
    if (tracker) {
      tracker.detach();
      trackers.delete(v);
    }
  }
}

function tick() {
  if (!config.enabled) return;

  var now = Date.now();
  var pipEl = null;
  try {
    pipEl = document.pictureInPictureElement || null;
  } catch (e0) {
    pipEl = null;
  }

  var videos = document.querySelectorAll("video");
  for (var i = 0; i < videos.length; i++) {
    var video = videos[i];
    var tracker = trackers.get(video);
    if (!tracker) continue;

    var isPiP = pipEl && pipEl === video;
    var shouldReload = false;

    if (isPiP) {
      shouldReload = tracker.handlePiP(now);
    } else {
      shouldReload = tracker.shouldReloadNormal(now);
    }

    if (!shouldReload) continue;

    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }

    if (config.muteOnReload) {
      try {
        video.muted = true;
        video.volume = 0;
      } catch (e) {}
    }

    try {
      rb.runtime.sendMessage({ type: "rebuffer_hung" });
    } catch (e2) {}

    break;
  }
}

refreshConfigOnce();
