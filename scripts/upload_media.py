#!/usr/bin/env python3
"""Upload sample artwork to the WhatsApp Cloud API media endpoint and record
the returned media IDs in Postgres.

WhatsApp cannot fetch a Google Drive share link (Drive returns an HTML preview,
not the raw bytes with a correct content-type). Files must be pushed through
Meta's media endpoint, which returns a media ID we then reuse when sending.

The script is idempotent: a file already uploaded and not past its expiry hint
is skipped. Media IDs do expire, so the send path in n8n must still handle an
invalid-id error by triggering a re-upload.

Config comes from the environment (see .env.example):
    MEDIA_SOURCE            local | drive
    MEDIA_DIR               folder to read when MEDIA_SOURCE=local
    GOOGLE_DRIVE_FOLDER_ID  folder id when MEDIA_SOURCE=drive
    GOOGLE_SERVICE_ACCOUNT_JSON  path to the service account key file
    WHATSAPP_TOKEN
    WHATSAPP_PHONE_NUMBER_ID
    GRAPH_API_VERSION
    APP_DATABASE_URL

File naming convention decides the service_key: name files like
    logo_design__sample1.jpg
    branding__brochure.pdf
The part before the double underscore is the service_key.
"""

import mimetypes
import os
import pathlib
import sys
import tempfile

import psycopg2
import requests

GRAPH_VERSION = os.environ.get("GRAPH_API_VERSION", "v21.0")
TOKEN = os.environ.get("WHATSAPP_TOKEN", "")
PHONE_NUMBER_ID = os.environ.get("WHATSAPP_PHONE_NUMBER_ID", "")
DB_URL = os.environ.get("APP_DATABASE_URL", "")

IMAGE_TYPES = {".jpg", ".jpeg", ".png"}
DOC_TYPES = {".pdf"}


def media_type_for(ext):
    if ext.lower() in IMAGE_TYPES:
        return "image"
    if ext.lower() in DOC_TYPES:
        return "document"
    return None


def service_key_from_name(filename):
    stem = pathlib.Path(filename).stem
    if "__" in stem:
        return stem.split("__", 1)[0]
    return "general"


def already_uploaded(cur, service_key, filename):
    cur.execute(
        """
        SELECT meta_media_id, expires_hint
        FROM media_assets
        WHERE service_key = %s AND filename = %s AND active = true
        """,
        (service_key, filename),
    )
    row = cur.fetchone()
    if not row:
        return False
    media_id, expires_hint = row
    if not media_id:
        return False
    # If we recorded an expiry hint and it has passed, re-upload.
    if expires_hint is not None:
        cur.execute("SELECT now() < %s", (expires_hint,))
        return cur.fetchone()[0]
    return True


def upload_to_meta(path, mime):
    url = f"https://graph.facebook.com/{GRAPH_VERSION}/{PHONE_NUMBER_ID}/media"
    with open(path, "rb") as fh:
        files = {"file": (os.path.basename(path), fh, mime)}
        data = {"messaging_product": "whatsapp", "type": mime}
        resp = requests.post(
            url,
            headers={"Authorization": f"Bearer {TOKEN}"},
            data=data,
            files=files,
            timeout=60,
        )
    resp.raise_for_status()
    return resp.json()["id"]


def record(cur, service_key, filename, media_type, media_id, source_path):
    cur.execute(
        """
        INSERT INTO media_assets
            (service_key, filename, media_type, meta_media_id, uploaded_at, source_path, active)
        VALUES (%s, %s, %s, %s, now(), %s, true)
        ON CONFLICT (service_key, filename) DO UPDATE
        SET meta_media_id = EXCLUDED.meta_media_id,
            media_type    = EXCLUDED.media_type,
            uploaded_at   = now(),
            source_path   = EXCLUDED.source_path,
            active        = true
        """,
        (service_key, filename, media_type, media_id, source_path),
    )


def iter_local_files(media_dir):
    for entry in sorted(pathlib.Path(media_dir).iterdir()):
        if entry.is_file() and entry.name != ".gitkeep":
            yield entry.name, str(entry), None


def iter_drive_files(folder_id, sa_json):
    # Imported lazily so the local path has no Google dependency.
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaIoBaseDownload

    creds = service_account.Credentials.from_service_account_file(
        sa_json, scopes=["https://www.googleapis.com/auth/drive.readonly"]
    )
    service = build("drive", "v3", credentials=creds)
    query = f"'{folder_id}' in parents and trashed = false"
    page_token = None
    while True:
        result = (
            service.files()
            .list(q=query, fields="nextPageToken, files(id, name)", pageToken=page_token)
            .execute()
        )
        for f in result.get("files", []):
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=pathlib.Path(f["name"]).suffix)
            request = service.files().get_media(fileId=f["id"])
            downloader = MediaIoBaseDownload(tmp, request)
            done = False
            while not done:
                _, done = downloader.next_chunk()
            tmp.close()
            yield f["name"], tmp.name, f["id"]
        page_token = result.get("nextPageToken")
        if not page_token:
            break


def source_files():
    source = os.environ.get("MEDIA_SOURCE", "local")
    if source == "drive":
        folder = os.environ.get("GOOGLE_DRIVE_FOLDER_ID", "")
        sa_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
        if not folder or not sa_json:
            sys.exit("MEDIA_SOURCE=drive requires GOOGLE_DRIVE_FOLDER_ID and GOOGLE_SERVICE_ACCOUNT_JSON")
        return iter_drive_files(folder, sa_json)
    media_dir = os.environ.get("MEDIA_DIR", "./media")
    return iter_local_files(media_dir)


def main():
    if not (TOKEN and PHONE_NUMBER_ID and DB_URL):
        sys.exit("WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID and APP_DATABASE_URL must be set")

    conn = psycopg2.connect(DB_URL)
    conn.autocommit = False
    uploaded, skipped = 0, 0
    try:
        with conn.cursor() as cur:
            for filename, path, source_id in source_files():
                ext = pathlib.Path(filename).suffix
                mtype = media_type_for(ext)
                if mtype is None:
                    print(f"skip (unsupported type): {filename}")
                    continue
                service_key = service_key_from_name(filename)
                if already_uploaded(cur, service_key, filename):
                    skipped += 1
                    print(f"skip (already uploaded): {service_key} / {filename}")
                    continue
                mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
                media_id = upload_to_meta(path, mime)
                record(cur, service_key, filename, mtype, media_id, source_id or path)
                uploaded += 1
                print(f"uploaded: {service_key} / {filename} -> {media_id}")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    print(f"done. uploaded={uploaded} skipped={skipped}")


if __name__ == "__main__":
    main()
