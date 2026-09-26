// Dependency-free helpers shared by entry.js and the app. Unlike api.js, this
// module does no network work on import, so the startup error path can use it.
export const LOGIN_URL = "/.auth/login/aad?post_login_redirect_uri=%2F";
export const LOGOUT_URL = "/.auth/logout?post_logout_redirect_uri=%2F";

// Fades the notice out after `delay` ms; returns a function that cancels it.
export function scheduleNoticeFade(notice, delay) {
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
