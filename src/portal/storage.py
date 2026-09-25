"""Azure adapters. ETags fence every metadata mutation; PDFs never live in table entities."""

import json
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit
from azure.core import MatchConditions
from azure.core.exceptions import ResourceExistsError, ResourceModifiedError, ResourceNotFoundError
from azure.data.tables import TableServiceClient, UpdateMode
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient, BlobSasPermissions, generate_blob_sas, ContentSettings
from azure.storage.queue import QueueClient


class Conflict(Exception):
    pass


class Storage:
    def __init__(self, settings):
        self.settings = settings
        if settings.storage_connection_string:
            self.blobs = BlobServiceClient.from_connection_string(settings.storage_connection_string)
            self.tables = TableServiceClient.from_connection_string(settings.storage_connection_string)
            self.queue = QueueClient.from_connection_string(
                settings.storage_connection_string, settings.queue
            )
        else:
            credential = DefaultAzureCredential()
            account = settings.storage_account
            self.blobs = BlobServiceClient(f"https://{account}.blob.core.windows.net", credential)
            self.tables = TableServiceClient(f"https://{account}.table.core.windows.net", credential)
            self.queue = QueueClient(f"https://{account}.queue.core.windows.net", settings.queue, credential)
        self.table = self.tables.get_table_client(settings.table)
        self.container = self.blobs.get_container_client(settings.container)

    def initialize(self):
        # Production infrastructure is provisioned by Bicep, not by application requests.
        if self.settings.environment != "production":
            self.tables.create_table_if_not_exists(self.settings.table)
            for create in (self.container.create_container, self.queue.create_queue):
                try:
                    create()
                except ResourceExistsError:
                    pass

    def get(self, owner, key):
        try:
            entity = self.table.get_entity(owner, key)
            return dict(entity) | {"_etag": entity.metadata["etag"]}
        except ResourceNotFoundError:
            return None

    def insert(self, entity):
        try:
            self.table.create_entity(entity)
        except ResourceExistsError:
            raise Conflict()
        return self.get(entity["PartitionKey"], entity["RowKey"])

    def save(self, entity):
        body = {k: v for k, v in entity.items() if not k.startswith("_") and v is not None}
        try:
            self.table.update_entity(
                body,
                mode=UpdateMode.REPLACE,
                etag=entity["_etag"],
                match_condition=MatchConditions.IfNotModified,
            )
        except (ResourceModifiedError, ResourceNotFoundError):
            raise Conflict()
        return self.get(entity["PartitionKey"], entity["RowKey"])

    def remove(self, entity):
        try:
            self.table.delete_entity(
                entity["PartitionKey"],
                entity["RowKey"],
                etag=entity["_etag"],
                match_condition=MatchConditions.IfNotModified,
            )
        except ResourceNotFoundError:
            pass
        except ResourceModifiedError:
            raise Conflict()

    def rows(self, owner=None):
        if owner:
            entities = self.table.query_entities("PartitionKey eq @owner", parameters={"owner": owner})
        else:
            entities = self.table.list_entities()
        for entity in entities:
            yield dict(entity) | {"_etag": entity.metadata["etag"]}

    def blob(self, name, snapshot=None):
        return self.container.get_blob_client(name, snapshot=snapshot)

    def upload_url(self, name):
        now = datetime.now(timezone.utc)
        expiry = now + timedelta(seconds=self.settings.upload_ttl)
        args = dict(
            account_name=self.blobs.account_name,
            container_name=self.settings.container,
            blob_name=name,
            permission=BlobSasPermissions(create=True, write=True),
            start=now - timedelta(minutes=5),
            expiry=expiry,
            protocol="https",
        )
        if self.settings.storage_connection_string:
            args.update(account_key=self.blobs.credential.account_key, protocol="https,http")
        else:
            args["user_delegation_key"] = self.blobs.get_user_delegation_key(
                now - timedelta(minutes=5), expiry
            )
        base = self.blob(name).url
        if self.settings.public_blob_endpoint:
            base = self.settings.public_blob_endpoint.rstrip("/") + urlsplit(base).path
        return base + "?" + generate_blob_sas(**args), expiry.timestamp()

    def snapshot(self, name, expected_size):
        blob = self.blob(name)
        props = blob.get_blob_properties()
        if props.size != expected_size:
            raise ValueError("Uploaded size does not match the reserved file size")
        if (
            not blob.download_blob(
                offset=0,
                length=min(props.size, 1024),
                etag=props.etag,
                match_condition=MatchConditions.IfNotModified,
            )
            .readall()
            .lstrip()
            .startswith(b"%PDF-")
        ):
            raise ValueError("File is not a PDF")
        return blob.create_snapshot(etag=props.etag, match_condition=MatchConditions.IfNotModified)[
            "snapshot"
        ]

    def download(self, name, target, snapshot=None):
        with open(target, "wb") as stream:
            self.blob(name, snapshot).download_blob().readinto(stream)

    def stream(self, name, snapshot):
        return self.blob(name, snapshot).download_blob().chunks()

    def put(self, name, data, content_type="application/json"):
        self.blob(name).upload_blob(
            data, overwrite=True, content_settings=ContentSettings(content_type=content_type)
        )

    def read(self, name):
        return self.blob(name).download_blob().readall()

    def purge(self, prefix):
        for blob in self.container.list_blobs(name_starts_with=prefix):
            try:
                self.blob(blob.name).delete_blob(delete_snapshots="include")
            except ResourceNotFoundError:
                pass

    def enqueue(self, owner, doc_id):
        self.queue.send_message(json.dumps({"owner": owner, "document_id": doc_id}))
