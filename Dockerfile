FROM node:22-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine

ENV NODE_ENV=production
ENV PORT=8080
ENV WORKBOARD_DATA_DIR=/data
ENV WORKBOARD_REPO_DIR=/workspace
ENV WORKBOARD_CLEANUP_MUTATIONS=false

WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache git sqlite \
  && git config --system --add safe.directory /workspace
RUN npm ci --omit=dev
# Keep the runtime image allow-listed and small; CI boots it to catch omitted runtime directories.
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared

VOLUME ["/data", "/workspace"]
EXPOSE 8080
CMD ["npm", "start"]
