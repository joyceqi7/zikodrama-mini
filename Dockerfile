FROM node:24-alpine AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS development
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

FROM dependencies AS build
COPY . .

ARG MINIS_API_BASE_URL
ARG MINIS_TIKTOK_APP_ID
ARG MINIS_APP_NAME="Drama Minis"
ARG MINIS_APP_LOGO_URL=""
ARG MINIS_TIKTOK_CLIENT_KEY=replace_with_tiktok_client_key

RUN MINIS_TIKTOK_APP_ID="$MINIS_TIKTOK_APP_ID" \
    MINIS_API_BASE_URL="$MINIS_API_BASE_URL" \
    MINIS_TIKTOK_CLIENT_KEY="$MINIS_TIKTOK_CLIENT_KEY" \
    node scripts/validate-web-build.mjs && \
    VITE_TIKTOK_APP_ID="$MINIS_TIKTOK_APP_ID" \
    VITE_APP_NAME="$MINIS_APP_NAME" \
    VITE_APP_LOGO_URL="$MINIS_APP_LOGO_URL" \
    VITE_API_BASE_URL="$MINIS_API_BASE_URL" \
    VITE_TIKTOK_CLIENT_KEY="$MINIS_TIKTOK_CLIENT_KEY" \
    VITE_DEMO_MODE=false \
    VITE_PLATFORM_MODE=tiktok \
    npm run build:web

FROM nginx:1.29-alpine AS production
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
