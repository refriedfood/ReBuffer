// ReBuffer content script

var defaultConfig = {
  enabled: false,       // extension OFF by default
  timeoutMs: 10000,     // 10 seconds
  checkIntervalMs: 1000,
  muteOnReload: true    // when enabled, mute on reload is default
};

var config = {
  enabled: defaultConfig.enabled,
  timeoutMs: defaultConfig.timeoutMs,
  checkIntervalMs: defaultConfig.checkIntervalMs,
  muteOnReload: defaultConfig.muteOnReload
};

// Load config for this tab
browser.runtime.sendMessage({ type: "rebuffer_getConfig" })
  .then(function (res) {
    if (!res) return;
    if (typeof res.enabled === "boolean") config.enabled = res.enabled;
    if (typeof res.timeoutMs === "number" && res.timeoutMs > 0) config.timeoutMs = res.timeoutMs;
    if (typeof res.muteOnReload === "boolean") config.muteOnReload = res.muteOnReload;
  })
  .catch(function () {});

// Listen for config updates
browser.runtime.onMessage.addListener(function (message) {
  if (!message || typeof message.type !== "string") return;
  if (message.type === "rebuffer_updateConfig" && message.config) {
    var cfg = message.config;
    if (typeof cfg.enabled === "boolean") config.enabled = cfg.enabled;
    if (typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0) config.timeoutMs = cfg.timeoutMs;
    if (typeof cfg.muteOnReload === "boolean") config.muteOnReload = cfg.muteOnReload;
  }
});

// Video tracker

function VideoTracker(video) {
  this.video = video;
  this.lastTime = video.currentTime || 0;
  this.lastProgressTs = Date.now();
  this.isPlaying = !video.paused && !video.ended;

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
  }
};

VideoTracker.prototype.onPlay = function () {
  this.isPlaying = true;
};

VideoTracker.prototype.onPause = function () {
  this.isPlaying = false;
};

VideoTracker.prototype.onEnded = function () {
  this.isPlaying = false;
};

VideoTracker.prototype.onWaiting = function () {
  // no-op, we rely on time not advancing
};

VideoTracker.prototype.onStalled = function () {
  // no-op
};

VideoTracker.prototype.onCanPlay = function () {
  // no-op
};

VideoTracker.prototype.shouldReload = function (now) {
  if (!config.enabled) return false;
  if (!this.isPlaying) return false;
  if (this.video.ended) return false;

  var noProgressFor = now - this.lastProgressTs;
  return noProgressFor >= config.timeoutMs;
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

var trackers = new WeakMap();

function setupVideo(video) {
  if (trackers.has(video)) return;
  trackers.set(video, new VideoTracker(video));
}

function scanForVideos() {
  var videos = document.querySelectorAll("video");
  for (var i = 0; i < videos.length; i++) {
    setupVideo(videos[i]);
  }
}

// Initial scan
scanForVideos();

// Watch for new videos in this frame
var observer = new MutationObserver(function () {
  scanForVideos();
});

observer.observe(document.documentElement || document.body, {
  childList: true,
  subtree: true
});

// Periodic check
setInterval(function () {
  if (!config.enabled) return;

  var now = Date.now();
  var videos = document.querySelectorAll("video");
  for (var i = 0; i < videos.length; i++) {
    var video = videos[i];
    var tracker = trackers.get(video);
    if (!tracker) continue;
    if (tracker.shouldReload(now)) {
      observer.disconnect();

      if (config.muteOnReload) {
        try {
          video.muted = true;
          video.volume = 0;
        } catch (e) {}
      }

      browser.runtime.sendMessage({ type: "rebuffer_hung" });
      break;
    }
  }
}, defaultConfig.checkIntervalMs);
