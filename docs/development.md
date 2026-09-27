# Development and testing

[← Back to overview](../README.md)

## Run locally with Docker

Requirements: Docker Engine with Compose. The local service binds to loopback and uses an explicit development identity; production rejects development authentication.

```sh
docker compose up --build -d
```

Open [the portal](http://127.0.0.1:8000) or [API documentation](http://127.0.0.1:8000/docs). The Compose stack includes Azurite, storage initialization, API, worker, and maintenance. The first build downloads the checksum-verified veraPDF 1.30.2 installer. Stop with `docker compose down`; append `-v` only to erase local emulator data.

## Develop without containers

```sh
python3.12 -m venv .venv
. .venv/bin/activate
pip install -r requirements.lock
pip install --no-deps -e .
npm ci --prefix frontend
npm run build --prefix frontend
cp .env.example .env
# Set PDF_VERAPDF_JAR in .env to the official installed CLI jar.
docker compose up -d azurite
python scripts/init_storage.py
uvicorn portal.app:create_app --factory --host 127.0.0.1 --port 8000 --no-access-log
# Separate terminals: pdf-worker --loop; pdf-maintenance --loop
```

For frontend hot reload, run `npm run dev --prefix frontend` and use `http://127.0.0.1:5173`. Stop the Compose API first if using the Python API on port 8000.

Supported browsers: Chrome and Edge 123, Safari 17.5, and Firefox 120 or later. The frontend's colors use CSS `light-dark()`, and its scripts target ES2022.

## Test

```sh
ruff check src tests scripts
ruff format --check src tests scripts
pytest -q -m 'not integration'
RUN_AZURE_INTEGRATION=1 pytest -q -m integration
cd frontend
npx playwright install chromium
npm test
```

The real-engine tests skip when `PDF_VERAPDF_JAR` is unavailable. The emulator test requires running Azurite and a real engine. CI runs the application tests inside the production Python 3.12/Java container, plus emulator and browser acceptance tests. See the [verification record](verification.md) for what was actually run in this workspace.

## Deploy

See [Azure deployment](azure-ci.md) for Entra registration, infrastructure, permissions, OIDC deployment, observability, and smoke tests. Deployment templates and workflows are included; no Azure resources are provisioned by creating this project.
