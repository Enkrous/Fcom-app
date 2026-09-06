/* Fcom launch splash — intentionally independent from app routing/state. */
'use strict';

const Splash = (() => {
  const ANIMATION_PATH = 'assets/splash.json';
  const MAX_VISIBLE_MS = 2500;
  const FADE_MS = 700;

  let animation = null;
  let timeoutId = null;
  let finished = false;

  function removeSplash(splash) {
    if (splash?.parentNode) splash.parentNode.removeChild(splash);
  }

  function finish(reason = 'complete') {
    if (finished) return;
    finished = true;
    if (timeoutId) window.clearTimeout(timeoutId);

    const splash = document.getElementById('app-splash');
    if (animation) {
      try {
        animation.destroy();
      } catch {
        // Cleanup must never block the application launch.
      }
      animation = null;
    }

    if (!splash) return;
    splash.dataset.dismissReason = reason;
    splash.classList.add('is-hidden');
    window.setTimeout(() => removeSplash(splash), FADE_MS + 50);
  }

  function start() {
    const splash = document.getElementById('app-splash');
    const container = document.getElementById('app-splash-animation');
    if (!splash || !container) return;

    timeoutId = window.setTimeout(() => finish('timeout'), MAX_VISIBLE_MS);

    const reducedMotion = window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      finish('reduced-motion');
      return;
    }

    if (typeof window.lottie?.loadAnimation !== 'function') {
      finish('player-unavailable');
      return;
    }

    try {
      animation = window.lottie.loadAnimation({
        container,
        renderer: 'svg',
        loop: false,
        autoplay: true,
        path: ANIMATION_PATH,
        rendererSettings: {
          progressiveLoad: true,
          preserveAspectRatio: 'xMidYMid meet',
        },
      });

      animation.addEventListener('complete', () => finish('complete'));
      animation.addEventListener('data_failed', () => finish('data-failed'));
      animation.addEventListener('error', () => finish('error'));
    } catch {
      finish('load-error');
    }
  }

  return { start, finish };
})();
