"""One transaction per HIT operation, including legacy snapshot import."""

from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
import sqlite3
from uuid import uuid4

from fastapi import HTTPException

from . import catalog

SCHEMA = """
CREATE TABLE IF NOT EXISTS versions (
    id TEXT PRIMARY KEY,
    job TEXT NOT NULL,
    username TEXT NOT NULL,
    created TEXT NOT NULL,
    parent TEXT REFERENCES versions(id),
    threshold REAL,
    source TEXT NOT NULL,
    png BLOB NOT NULL,
    digest TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS versions_job ON versions(job, created);
CREATE TABLE IF NOT EXISTS heads (
    job TEXT NOT NULL,
    username TEXT NOT NULL,
    version TEXT NOT NULL REFERENCES versions(id),
    PRIMARY KEY(job, username)
);
CREATE TABLE IF NOT EXISTS saves (
    job TEXT NOT NULL,
    username TEXT NOT NULL,
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    version TEXT NOT NULL REFERENCES versions(id),
    PRIMARY KEY(job,username,request_id)
);
CREATE TABLE IF NOT EXISTS imported (
    job TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL REFERENCES versions(id),
    previous TEXT REFERENCES rounds(id),
    reason TEXT NOT NULL,
    submitted TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending', 'approved', 'returned')),
    reviewer TEXT,
    decided TEXT,
    conclusion TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS pending_version ON rounds(version) WHERE state='pending';
CREATE UNIQUE INDEX IF NOT EXISTS next_round ON rounds(previous) WHERE previous IS NOT NULL;
CREATE INDEX IF NOT EXISTS round_version ON rounds(version, submitted);
CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    round_id TEXT NOT NULL REFERENCES rounds(id),
    author TEXT NOT NULL,
    created TEXT NOT NULL,
    body TEXT NOT NULL,
    x INTEGER,
    y INTEGER
);
CREATE INDEX IF NOT EXISTS comment_round ON comments(round_id, created);
"""


def now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


@contextmanager
def transaction(write=False):
    catalog.PRIVATE.mkdir(exist_ok=True, parents=True)
    db = sqlite3.connect(catalog.PRIVATE / "hit.sqlite3", isolation_level=None, timeout=15)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA foreign_keys=ON")
        schema_version = db.execute("PRAGMA user_version").fetchone()[0]
        if schema_version == 0:
            db.executescript("BEGIN IMMEDIATE;\n" + SCHEMA + "\nPRAGMA user_version=1; COMMIT;")
        elif schema_version != 1:
            raise RuntimeError("此版本无法读取该复核数据库格式")
        db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
        yield db
        db.commit()
    finally:
        db.close()


def import_legacy(db, job):
    if db.execute("SELECT 1 FROM imported WHERE job=?", (job,)).fetchone():
        return
    for path in sorted((catalog.LEGACY / job).glob("*.png")):
        created = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(
            timespec="microseconds"
        )
        insert_version(db, job, path.stem, path.read_bytes(), "legacy", created=created)
    db.execute("INSERT INTO imported VALUES (?)", (job,))


def prepare(job):
    with transaction() as db:
        if db.execute("SELECT 1 FROM imported WHERE job=?", (job,)).fetchone():
            return
    with transaction(write=True) as db:
        import_legacy(db, job)


def insert_version(db, job, username, png, source, parent=None, threshold=None, created=None):
    identity = uuid4().hex
    db.execute(
        """INSERT INTO versions(id, job, username, created, parent, threshold, source, png, digest)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            identity,
            job,
            username,
            created or now(),
            parent,
            threshold,
            source,
            png,
            sha256(png).hexdigest(),
        ),
    )
    db.execute(
        """INSERT INTO heads(job, username, version) VALUES (?, ?, ?)
           ON CONFLICT(job,username) DO UPDATE SET version=excluded.version""",
        (job, username, identity),
    )
    return identity


PUBLIC_FIELDS = (
    "v.id, v.job, v.username, v.created AS updated_at, v.parent, v.threshold, v.source, v.digest"
)


def history(db, job):
    rows = db.execute(
        f"""SELECT {PUBLIC_FIELDS}, h.version IS NOT NULL AS current
            FROM versions v LEFT JOIN heads h ON h.version=v.id
            WHERE v.job=? ORDER BY v.created DESC, v.rowid DESC""",
        (job,),
    )
    return [
        {**dict(row), "current": bool(row["current"]), "mask_url": mask_url(job, row["id"])}
        for row in rows
    ]


def mask_url(job, identity):
    return f"/api/hit/runs/{job}/versions/{identity}/mask"


def version(db, job, identity):
    row = db.execute(
        f"SELECT {PUBLIC_FIELDS} FROM versions v WHERE job=? AND id=?", (job, identity)
    ).fetchone()
    if row is None:
        raise HTTPException(404, "本批次没有这个修订版本")
    return dict(row)


def head(db, job, username):
    row = db.execute(
        "SELECT version FROM heads WHERE job=? AND username=?", (job, username)
    ).fetchone()
    return row["version"] if row else None


def mask_bytes(db, item, identity):
    if identity == catalog.ORIGINAL:
        return catalog.artifact(item, "mask").read_bytes()
    row = db.execute(
        "SELECT png FROM versions WHERE job=? AND id=?", (item["job_id"], identity)
    ).fetchone()
    if row is None:
        raise HTTPException(404, "本批次没有这个修订版本")
    return row["png"]
