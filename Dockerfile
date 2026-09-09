# One-command run: builds the production bundle and serves it with Vite's preview server.
#
# Preview rather than a static file server, because the mock extraction stream is a Vite
# middleware — behind a plain static host the workspace would fall back to generating the
# stream inside the worker instead of receiving it over the network.
FROM node:22-alpine
WORKDIR /app

# Playwright is a dev dependency used for tests and the performance scripts; its browser
# download is several hundred megabytes and nothing in the image needs it.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 4173
CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "4173", "--strictPort"]
