# COMPANY_OS panel — минимальный образ (без зависимостей). Слушает $PORT.
FROM node:20-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV PORT=8130
# Порт реально назначает диспетчер и пробрасывает через process.env.PORT.
EXPOSE 8130
CMD ["node", "server.js"]
