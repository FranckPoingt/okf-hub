export const SERVICE = import.meta.env.VITE_OKF_SERVICE ||
  globalThis.location.origin;

export const conceptPath = (id: string) =>
  `/api/concepts/${encodeURIComponent(id)}`;

export function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${SERVICE}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
}
