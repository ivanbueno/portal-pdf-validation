import base64
from urllib.parse import parse_qs, urlsplit
from azure.storage.blob import UserDelegationKey
from portal.config import Settings
from portal.storage import Storage


def test_upload_grants_reuse_the_user_delegation_key():
    # Pinned empty: the compose runtime exports an emulator connection string, which signs with the account key.
    settings = Settings(
        _env_file=None, environment="test", storage_account="account", storage_connection_string=""
    )
    store = Storage(settings)
    fetched = []

    def get_user_delegation_key(start, expiry):
        key = UserDelegationKey()
        key.signed_oid = key.signed_tid = "00000000-0000-0000-0000-000000000000"
        key.signed_start, key.signed_expiry = start.isoformat(), expiry.isoformat()
        key.signed_service, key.signed_version = "b", "2025-01-05"
        key.value = base64.b64encode(b"k" * 32).decode()
        fetched.append(expiry)
        return key

    store.blobs.get_user_delegation_key = get_user_delegation_key
    url, expires = store.upload_url("owner/doc/input.pdf")
    store.upload_url("owner/other/input.pdf")
    assert len(fetched) == 1 and fetched[0].timestamp() > expires
    assert parse_qs(urlsplit(url).query)["sig"]
    # A grant outliving the cached key gets a fresh one.
    settings.upload_ttl = 3 * 3600
    _, expires = store.upload_url("owner/later/input.pdf")
    assert len(fetched) == 2 and fetched[1].timestamp() > expires
