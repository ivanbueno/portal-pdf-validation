// Dependency-free helpers shared by entry.js, the app, and the sign-in page. Unlike
// api.js, this module does no network work on import, so the startup error path can use it.
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

// Fades the notice out after `delay` ms; returns a function that cancels it.
function scheduleNoticeFade(notice, delay) {
  let fade;
  const timer = setTimeout(() => {
    notice.classList.add("notice-leaving");
    fade = setTimeout(() => {
      notice.hidden = true;
    }, 250);
  }, delay);
  return () => {
    clearTimeout(timer);
    clearTimeout(fade);
  };
}

// Pins the notice just under the header, aligned to its right edge; once the
// header has scrolled away the notice falls back to the viewport's top corner.
function placeNotice(notice) {
  const header = document
    .querySelector("main > header")
    .getBoundingClientRect();
  notice.style.top = `${Math.max(20, header.bottom + 12)}px`;
  notice.style.right = `${Math.max(20, document.documentElement.clientWidth - header.right)}px`;
}

let cancelNoticeFade;
// Shows `text` in the page notice, replacing any current one; returns the notice.
export function notify(text, error = false) {
  const notice = document.getElementById("notice");
  cancelNoticeFade?.();
  if (text) placeNotice(notice);
  notice.classList.remove("notice-leaving");
  notice.hidden = !text;
  notice.textContent = text;
  notice.classList.toggle("error", error);
  notice.setAttribute("role", error ? "alert" : "status");
  if (text) cancelNoticeFade = scheduleNoticeFade(notice, error ? 8000 : 5000);
  return notice;
}
