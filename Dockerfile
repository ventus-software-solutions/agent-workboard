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

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server

VOLUME ["/data"]
EXPOSE 8080
CMD ["npm", "start"]
