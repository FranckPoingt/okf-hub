import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", ["OKF_", "PORTLESS_"]);
  const target = env.OKF_DEV_PROXY_TARGET ?? "http://localhost:8788";
  // `PORTLESS_TAILSCALE=1 deno task dev:portless`: the hub trusts only
  // *.okf-hub.localhost origins and scopes cookies to okf-hub.localhost, so
  // tailnet requests are presented as this dev server's local Portless origin.
  const tailnet = env.PORTLESS_TAILSCALE_URL;
  const local = env.PORTLESS_URL;
  const tailnetProxy: ProxyOptions = tailnet && local
    ? {
      cookieDomainRewrite: "",
      configure(proxy) {
        const tailnetOrigin = new URL(tailnet).origin;
        const localOrigin = new URL(local).origin;
        const asLocal = (
          proxyReq: {
            getHeader(name: string): unknown;
            setHeader(name: string, value: string): void;
          },
        ) => {
          if (proxyReq.getHeader("origin") === tailnetOrigin) {
            proxyReq.setHeader("origin", localOrigin);
          }
        };
        proxy.on("proxyReq", asLocal);
        proxy.on("proxyReqWs", asLocal);
      },
    }
    : {};
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": new URL("./src", import.meta.url).pathname,
      },
    },
    server: {
      host: "127.0.0.1",
      ...(tailnet && { allowedHosts: [new URL(tailnet).hostname] }),
      proxy: {
        "/api": {
          target,
          changeOrigin: true,
          ...tailnetProxy,
        },
        "/app-files": {
          target,
          changeOrigin: true,
          ...tailnetProxy,
        },
        "/collab": {
          target,
          changeOrigin: true,
          ws: true,
          ...tailnetProxy,
        },
      },
    },
    define: {
      __VUE_OPTIONS_API__: false,
      __VUE_PROD_DEVTOOLS__: false,
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
    },
  };
});
