"""Keep a user's current pointer independent from immutable ancestry and save retries."""

from hashlib import sha256
import json

from fastapi import HTTPException

from . import storage


def signature(png, parent, threshold, expected, guarded):
    descriptor = {
        "digest": sha256(png).hexdigest(),
        "parent": parent,
        "threshold": threshold,
        "expected_head": expected,
        "guarded": guarded,
    }
    return sha256(
        json.dumps(descriptor, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def prior_save(db, job, author, request_id, fingerprint):
    receipt = db.execute(
        """SELECT fingerprint,version FROM saves
           WHERE job=? AND username=? AND request_id=?""",
        (job, author, request_id),
    ).fetchone()
    if receipt is None:
        return None
    if receipt["fingerprint"] != fingerprint:
        raise HTTPException(409, "保存请求已用于不同的修订内容")
    return receipt["version"]


def check_head(db, job, author, expected):
    if storage.head(db, job, author) != expected:
        raise HTTPException(409, "其他窗口已更新你的当前版本")


def save(
    job, author, png, *, parent=None, threshold=None, expected=None, guarded=False, request_id=None
):
    with storage.transaction(write=True) as db:
        storage.import_legacy(db, job)
        if request_id:
            fingerprint = signature(png, parent, threshold, expected, guarded)
            previous = prior_save(db, job, author, request_id, fingerprint)
            if previous:
                return previous
        if guarded:
            check_head(db, job, author, expected)
        source = "original"
        if parent is not None:
            base = storage.version(db, job, parent)
            if base["username"] != author:
                raise HTTPException(403, "请选择自己保存的来源版本")
            if threshold is not None:
                raise HTTPException(422, "修订只能有一个编辑起点")
            source = "revision"
        elif threshold is not None:
            source = "threshold"
        identity = storage.insert_version(
            db, job, author, png, source, parent=parent, threshold=threshold
        )
        if request_id:
            db.execute(
                """INSERT INTO saves(job,username,request_id,fingerprint,version)
                   VALUES (?,?,?,?,?)""",
                (job, author, request_id, fingerprint, identity),
            )
        return identity


def reset(job, author, expected=None):
    with storage.transaction(write=True) as db:
        storage.import_legacy(db, job)
        if expected is not None:
            check_head(db, job, author, expected)
        db.execute("DELETE FROM heads WHERE job=? AND username=?", (job, author))
