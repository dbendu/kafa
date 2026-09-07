# Зависимостей у проекта нет, собирать нечего — один слой поверх alpine.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_FILE=/data/data.sqlite

WORKDIR /app

COPY package.json server.js storage.js ./
COPY public ./public

# SQLite хранится в /data вместе со служебными файлами транзакций.
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data

USER node
EXPOSE 3000

# fetch встроен в Node 18+, ставить curl незачем
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/log').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
