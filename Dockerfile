# Build the console, then assemble the runtime image with only prod deps.
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY --from=web /web/dist ./web/dist
EXPOSE 3000
CMD ["node", "src/index.js"]
