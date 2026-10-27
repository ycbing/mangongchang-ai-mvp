FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=4173 HOST=0.0.0.0 LOCAL_STORAGE_DIR=/data/assets
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /data/assets && chown -R node:node /app /data
COPY --chown=node:node . .
USER node
EXPOSE 4173
CMD ["npm", "start"]
