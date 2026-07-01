# COMPANY_OS panel — минимальный образ (без npm-зависимостей). Слушает $PORT.
FROM node:20-alpine
WORKDIR /app
# self-signed сертификат для HTTPS внутри контейнера (внутренний инструмент; домена нет → CN/SAN = IP)
RUN apk add --no-cache openssl && mkdir -p /app/certs && \
    openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
      -keyout /app/certs/key.pem -out /app/certs/cert.pem \
      -subj "/CN=178.104.7.103" -addext "subjectAltName=IP:178.104.7.103"
COPY server.js ./
COPY public ./public
ENV PORT=8130
# Порт реально назначает диспетчер и пробрасывает через process.env.PORT.
EXPOSE 8130
CMD ["node", "server.js"]
