import time
from azure.core.exceptions import AzureError
from azure.storage.blob import CorsRule
from portal.config import Settings
from portal.storage import Storage

settings = Settings()
if settings.environment == "production":
    raise RuntimeError("Provision production storage using Bicep")
store = Storage(settings)
for attempt in range(30):
    try:
        store.initialize()
        store.blobs.set_service_properties(
            cors=[
                CorsRule(
                    allowed_origins=[
                        "http://127.0.0.1:8000",
                        "http://localhost:8000",
                        "http://127.0.0.1:5173",
                    ],
                    allowed_methods=["PUT", "OPTIONS"],
                    allowed_headers=["*"],
                    exposed_headers=["ETag"],
                    max_age_in_seconds=3600,
                )
            ]
        )
        break
    except AzureError:
        if attempt == 29:
            raise
        time.sleep(2)
