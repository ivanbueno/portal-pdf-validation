import { LOGIN_URL, LOGOUT_URL } from "./common.js";
export const config = await fetch("/api/config").then((r) => {
  if (!r.ok) throw new Error("Configuration unavailable");
  return r.json();
});
const session = config.local
  ? { name: "Local workspace", kind: "user" }
  : await fetch("/api/session", { credentials: "same-origin" }).then(
      async (response) => {
        if (response.status === 401) return null;
        if (!response.ok)
          throw new Error("Your account is not authorized for this workspace.");
        return response.json();
      },
    );
export const account = () => session;
export const signIn = () => location.assign(LOGIN_URL);
export const signOut = () => location.assign(LOGOUT_URL);
export async function api(path, options = {}) {
  if (!account()) throw new Error("Sign in to access your workspace.");
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    "X-Requested-With": "PDFValidationPortal",
    ...options.headers,
  };
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  if (response.status === 401) {
    signIn();
    throw new Error("Your session expired. Sign in again.");
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const failure = new Error(
      typeof error.detail === "string"
        ? error.detail
        : `Request failed (${response.status})`,
    );
    failure.status = response.status;
    failure.idempotencyKey = response.headers.get("Idempotency-Key");
    throw failure;
  }
  if (options.download) return response.blob();
  return response.status === 204 ? null : response.json();
}
export function upload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("x-ms-blob-type", "BlockBlob");
    xhr.setRequestHeader("Content-Type", "application/pdf");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((100 * event.loaded) / event.total));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(
            new Error(`Upload failed (${xhr.status}). Retry to continue.`),
          );
    xhr.onerror = () =>
      reject(new Error("Upload interrupted. Retry to continue."));
    xhr.timeout = 1800000;
    xhr.ontimeout = () =>
      reject(new Error("Upload timed out. Retry to continue."));
    xhr.send(file);
  });
}
export async function download(id, format, profile) {
  const blob = await api(
    `/documents/${id}/reports/${format}${profile ? `?profile=${encodeURIComponent(profile)}` : ""}`,
    { download: true },
  );
  const url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${id}${profile ? "-" + profile : ""}.${format}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
