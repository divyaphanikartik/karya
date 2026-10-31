# One image = the API + the web version of the app + the speech models, served from the same URL.
# Build:  docker build -t karya .        Run: docker run -p 8000:8000 -e ANTHROPIC_API_KEY=... karya

# 1) Export the Expo app for the web
FROM node:22-slim AS web
WORKDIR /mobile
COPY mobile/package.json mobile/package-lock.json mobile/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY mobile/ ./
RUN npx expo export --platform web --output-dir /web

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
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
