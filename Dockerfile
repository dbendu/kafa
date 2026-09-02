# Зависимостей у проекта нет, собирать нечего — один слой поверх alpine.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_FILE=/data/data.json

WORKDIR /app

COPY package.json server.js ./
COPY public ./public

# Данные держим в /data. Важно, что и data.json, и временный data.json.tmp
# лежат в одной точке монтирования: persist() делает rename, а он не работает
# между разными файловыми системами (EXDEV).
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data

USER node
EXPOSE 3000

# fetch встроен в Node 18+, ставить curl незачем
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/log').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
