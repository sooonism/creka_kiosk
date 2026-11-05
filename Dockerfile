FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
# captures are written here at runtime and served statically by the node server; mount a volume on it
ENV HOST=0.0.0.0 PORT=80 CAPTURES_DIR=/app/dist/client/captures/demo/camwithnkob BACKEND_URL=https://creka.online
CMD ["node", "dist/server/entry.mjs"]
