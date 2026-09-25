FROM node:22.16.0-bookworm-slim AS frontend
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM eclipse-temurin:21.0.11_10-jre-jammy AS java
FROM python:3.12.11-slim-bookworm AS runtime
ENV JAVA_HOME=/opt/java/openjdk PATH=/opt/java/openjdk/bin:$PATH PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY --from=java /opt/java/openjdk /opt/java/openjdk
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip libfontconfig1 && rm -rf /var/lib/apt/lists/*
COPY scripts/install-verapdf.sh /tmp/install-verapdf.sh
RUN sh /tmp/install-verapdf.sh && rm /tmp/install-verapdf.sh
WORKDIR /app
COPY pyproject.toml requirements.lock ./
COPY src/ src/
RUN pip install --no-cache-dir -r requirements.lock && pip install --no-cache-dir --no-deps .
COPY profiles/ profiles/
COPY licenses/ licenses/
COPY scripts/ scripts/
COPY --from=frontend /build/dist frontend/dist
RUN useradd --uid 10001 --create-home portal
USER 10001
EXPOSE 8000
CMD ["uvicorn", "portal.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
