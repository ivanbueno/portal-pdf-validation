import "./style.css";
import("./app.js").catch((error) => {
  const notice = document.getElementById("notice");
  notice.hidden = false;
  notice.classList.add("error");
  notice.setAttribute("role", "alert");
  const denied =
    error.message === "Your account is not authorized for this workspace.";
  notice.textContent = denied
    ? "Your account needs access to this workspace. Ask your administrator to assign the Validation.User role. "
    : "The workspace could not start. Check your connection and reload this page.";
  if (denied) {
    const logout = document.createElement("a");
    logout.href = "/.auth/logout?post_logout_redirect_uri=%2F";
    logout.textContent = "Sign out";
    notice.append(logout);
  }
  setTimeout(() => {
    notice.classList.add("notice-leaving");
    setTimeout(() => {
      notice.hidden = true;
    }, 250);
  }, 8000);
});
