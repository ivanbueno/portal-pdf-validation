// Dependency-free helpers shared by entry.js, the app, and the sign-in page. Unlike
// api.js, this module does no network work on import, so the startup error path can use it.
import { setIconLabel } from "./icons.js";

export const LOGIN_URL = "/.auth/login/aad?post_login_redirect_uri=%2F";
export const LOGOUT_URL =
  "/.auth/logout?post_logout_redirect_uri=%2F%3Fsigned-out";

// Startup stopped because the visitor cannot use the workspace; the sign-in card says why.
export class SignInRequired extends Error {}

// Keeps the workspace blurred and inert under the sign-in card showing `screen`.
export function showSignIn(screen) {
  for (const section of document.querySelectorAll(".login-screen"))
    section.hidden = section.id !== `${screen}-screen`;
  document.getElementById("gate").hidden = false;
  document.querySelector(".login-action:not([hidden])")?.focus();
}

// Uncovers the workspace; startup failures do this too, so their notice can be read.
export function openWorkspace() {
  document.getElementById("gate").hidden = true;
  document.querySelector("main").inert = false;
  document.body.classList.remove("gated");
}

// Whether the visitor asked the system for less motion; scripted animations
// check this, as the stylesheet's reduced-motion rules do not reach them.
export const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

// A motion token from the stylesheet in milliseconds, e.g. motion("--dur-base").
export const motion = (token) =>
  parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(token),
  );

// Resolves once the CSS keyframe animations running in `element` finish; at
// once when none are. Transitions are not waited for: one inside a closed
// menu never advances. Nor are looping indicators, which never end.
export const settled = (element) =>
  Promise.allSettled(
    element
      .getAnimations({ subtree: true })
      .filter(
        (a) =>
          a instanceof CSSAnimation &&
          a.effect.getTiming().iterations !== Infinity,
      )
      .map((a) => a.finished),
  );

// Adds `className`, which starts an exit animation, and resolves once it ends.
export function exit(element, className = "is-leaving") {
  element.classList.add(className);
  return settled(element);
}

// Runs `change`, then slides each of `elements` that moved from its old place
// to its new one, so a list closes up over a removed item instead of jumping.
export function reflow(elements, change) {
  const before = new Map();
  for (const element of elements) {
    const box = element.getBoundingClientRect();
    if (box.height) before.set(element, box.top);
  }
  change();
  if (reducedMotion()) return;
  for (const [element, top] of before) {
    if (!element.isConnected) continue;
    const delta = top - element.getBoundingClientRect().top;
    if (Math.abs(delta) < 1) continue;
    element.animate(
      [{ transform: `translateY(${delta}px)` }, { transform: "none" }],
      {
        duration: motion("--dur-base"),
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    );
  }
}

// Pins the notices just under the header, aligned to its right edge; once the
// header has scrolled away they fall back to the viewport's top corner.
function placeNotices(stack) {
  const header = document
    .querySelector("main > header")
    .getBoundingClientRect();
  stack.style.top = `${Math.max(20, header.bottom + 12)}px`;
  stack.style.right = `${Math.max(20, document.documentElement.clientWidth - header.right)}px`;
}

const NOTICE_LIMIT = 3;
const noticeStack = () => document.getElementById("notice");
const liveNotices = () =>
  [...noticeStack().children].filter(
    (n) => !n.classList.contains("is-leaving"),
  );

// Fades `notice` out and removes it; its onDismiss runs once, whatever closed it.
function dismissNotice(notice) {
  if (notice.classList.contains("is-leaving")) return;
  notice.stopTimer();
  notice.onDismiss?.();
  const stack = noticeStack();
  exit(notice).then(() =>
    reflow(liveNotices(), () => {
      notice.remove();
      stack.hidden = !stack.childElementCount;
    }),
  );
}

// Dismisses `notice` after `delay` ms, paused while the pointer or focus is on it.
function startTimer(notice, delay) {
  let timer,
    remaining = delay,
    started,
    holds = 0;
  const run = () => {
    started = Date.now();
    timer = setTimeout(() => dismissNotice(notice), remaining);
  };
  const hold = () => {
    if (holds++) return;
    clearTimeout(timer);
    remaining -= Date.now() - started;
  };
  const release = () => {
    if (holds && !--holds) run();
  };
  notice.onpointerenter = hold;
  notice.onpointerleave = release;
  notice.onfocusin = (event) => {
    if (!notice.contains(event.relatedTarget)) hold();
  };
  notice.onfocusout = (event) => {
    if (!notice.contains(event.relatedTarget)) release();
  };
  notice.stopTimer = () => clearTimeout(timer);
  run();
}

// Shows `text` in a notice stacked above the earlier ones. A notice with the
// same `key`, or the same text, is updated in place rather than repeated.
// `action` adds a button ({ label, handler }) that also dismisses the notice;
// `onDismiss` runs when the notice goes, however it goes. Returns the notice.
export function notify(
  text,
  error = false,
  { key, action, onDismiss, duration = error ? 8000 : 5000 } = {},
) {
  const stack = noticeStack();
  if (!text) {
    liveNotices().forEach(dismissNotice);
    return;
  }
  placeNotices(stack);
  stack.hidden = false;
  let notice = liveNotices().find((n) =>
    key ? n.dataset.key === key : n.dataset.text === text,
  );
  if (notice) {
    notice.stopTimer();
    notice.onDismiss?.();
  } else {
    notice = document.createElement("div");
    if (key) notice.dataset.key = key;
    reflow(liveNotices(), () => stack.prepend(notice));
    liveNotices().slice(NOTICE_LIMIT).forEach(dismissNotice);
  }
  notice.dataset.text = text;
  notice.className = `notice-item${error ? " error" : ""}`;
  // Errors interrupt; everything else waits its turn in the polite stack.
  if (error) notice.setAttribute("role", "alert");
  else notice.removeAttribute("role");
  notice.onDismiss = onDismiss;
  const message = document.createElement("p");
  message.textContent = text;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-button notice-close";
  setIconLabel(close, "x", "Dismiss notification");
  close.onclick = () => dismissNotice(notice);
  notice.replaceChildren(message);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "notice-action";
    button.textContent = action.label;
    button.onclick = () => {
      action.handler();
      dismissNotice(notice);
    };
    notice.append(button);
  }
  notice.append(close);
  startTimer(notice, duration);
  return notice;
}
