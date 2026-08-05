FROM denoland/deno:2.9.0 AS build

WORKDIR /app
COPY deno.json deno.lock package.json tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN deno ci
RUN deno task build

FROM denoland/deno:2.9.0

ENV DENO_NO_PROMPT=1
WORKDIR /app
COPY deno.json deno.lock package.json ./
RUN deno ci --prod --skip-types
COPY server ./server
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown -R deno:deno /app /data
USER deno

EXPOSE 8788
CMD ["deno", "run", "--cached-only", "--allow-net", "--allow-env=OKF_HOST,OKF_PORT,OKF_DATA_DIR,OKF_STATIC_DIR,OKF_BASE_URL,OKF_AUTH_SECRET,OKF_OPENFGA_URL,OKF_OPENFGA_KEY,PRODUCTION,NODE_ENV,NODE_DISABLE_COLORS,BETTER_AUTH_TELEMETRY,BETTER_AUTH_TELEMETRY_DEBUG,BETTER_AUTH_TELEMETRY_ENDPOINT,BETTER_AUTH_TRUSTED_ORIGINS,TEST", "--allow-read=/data,/app/dist", "--allow-write=/data", "server/main.ts"]
