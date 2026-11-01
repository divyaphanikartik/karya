# One image = the API + the web version of the app + the speech models, served from the same URL.
# Build:  docker build -t karya .        Run: docker compose up (reads backend/.env)

# 1) Export the Expo app for the web
FROM node:22-slim AS web
WORKDIR /mobile
COPY mobile/package.json mobile/package-lock.json mobile/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY mobile/ ./
RUN npx expo export --platform web --output-dir /web && node scripts/make-offline-manifest.js /web

# 2) Speech models for server-side transcription (IndicConformer te/hi, NeMo en; ~470 MB)
FROM python:3.12-slim AS models
WORKDIR /tools
COPY tools/speech_models/download_models.py tools/speech_models/models.json ./
RUN python download_models.py --lang te hi en --publish /models

# 3) FastAPI backend serving /api/* and the exported app for everything else
FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY --from=web /web ./web
COPY --from=models /models ./models
ENV KARYA_WEB_DIR=/app/web KARYA_DATA_DIR=/app/data KARYA_SPEECH_MODELS_DIR=/app/models
# Non-secret defaults. ANTHROPIC_API_KEY is deliberately NOT here: an image holding a key leaks it to
# anyone who can pull the image. Supply it at run time (backend/.env via compose, or the host's secrets).
ENV CLAUDE_MODEL=claude-sonnet-5-5 KARYA_RATE_LIMIT_PER_MINUTE=12 KARYA_TOKEN_DAYS=30
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
