# One image = the API + the web version of the app, served from the same URL.
# Build:  docker build -t karya .        Run: docker run -p 8000:8000 -e ANTHROPIC_API_KEY=... karya

# 1) Export the Expo app for the web
FROM node:22-slim AS web
WORKDIR /mobile
COPY mobile/package.json mobile/package-lock.json mobile/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY mobile/ ./
RUN npx expo export --platform web --output-dir /web

# 2) FastAPI backend serving /api/* and the exported app for everything else
FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY --from=web /web ./web
ENV KARYA_WEB_DIR=/app/web KARYA_DATA_DIR=/app/data
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
