const ua = navigator.userAgent || "";
const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
const hasTouch = (navigator.maxTouchPoints ?? 0) > 0 || "ontouchstart" in window;
const mobileUa = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS|MiuiBrowser|MicroMessenger/i.test(ua);
const smallViewport = Math.min(window.innerWidth, window.innerHeight) <= 820;
const params = new URLSearchParams(window.location.search);
const qualityOverride = params.get("quality");

export const DEVICE = Object.freeze({
  isTouch: coarsePointer || hasTouch,
  isMobile: mobileUa || (coarsePointer && smallViewport),
  isStandalone: window.matchMedia?.("(display-mode: standalone)")?.matches ?? false,
  quality: qualityOverride === "high"
    ? "high"
    : qualityOverride === "low"
      ? "low"
      : (mobileUa || (coarsePointer && smallViewport) ? "low" : "high"),
});

export function isTouchDevice() {
  return DEVICE.isTouch;
}
