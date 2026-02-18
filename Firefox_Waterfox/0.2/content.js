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
    browser.runtime.sendMessage({ type: "rebuffer_getConfig" }).then(function (response) {
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

browser.runtime.onMessage.addListener(function (message) {
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
  var currentTime = 0;
  try {
    currentTime = v.currentTime || 0;
  } catch (e) {}
  try {
    if (typeof v.pause === "function") {
      v.pause();
    }
  } catch (e1) {}
  try {
    if (typeof v.load === "function") {
      v.load();
    }
  } catch (e2) {}
  var self = this;
  function restoreAndPlay() {
    try {
      v.removeEventListener("canplay", restoreAndPlay);
      v.removeEventListener("loadedmetadata", restoreAndPlay);
    } catch (e0) {}
    try {
      if (currentTime > 0 && !isNaN(currentTime)) {
        v.currentTime = currentTime;
      }
    } catch (e3) {}
    try {
      if (typeof v.play === "function") {
        var p = v.play();
        if (p && typeof p.catch === "function") {
          p.catch(function () {});
        }
      }
    } catch (e4) {}
    self.lastProgressTs = Date.now();
    self.lastTime = v.currentTime || self.lastTime;
  }
  try {
    v.addEventListener("canplay", restoreAndPlay, { once: true });
    v.addEventListener("loadedmetadata", restoreAndPlay, { once: true });
  } catch (e5) {}
  this.isBuffering = false;
  this.bufferingSince = null;
  this.pauseSince = null;
  this.lastTime = currentTime;
  this.lastProgressTs = Date.now();
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
      browser.runtime.sendMessage({ type: "rebuffer_hung" });
    } catch (e2) {}

    break;
  }
}

refreshConfigOnce();
