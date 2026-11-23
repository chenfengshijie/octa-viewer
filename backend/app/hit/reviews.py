"""Transitions for one submission of one immutable mask."""

from uuid import uuid4

from fastapi import HTTPException

from . import storage


def round_detail(db, identity):
    row = db.execute(
        """SELECT r.*, v.job, v.username AS author
           FROM rounds r JOIN versions v ON v.id=r.version WHERE r.id=?""",
        (identity,),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "复核轮次不存在")
    return dict(row)


def submitted(db, job, version, author, previous, reason):
    target = storage.version(db, job, version)
    if target["username"] != author:
        raise HTTPException(403, "只能提交自己保存的版本")
    latest = db.execute(
        "SELECT id, state FROM rounds WHERE version=? ORDER BY rowid DESC LIMIT 1", (version,)
    ).fetchone()
    if latest:
        if latest["state"] != "returned":
            raise HTTPException(409, "此版本已提交或已经通过")
        if previous and latest["id"] != previous:
            raise HTTPException(409, "请从最近一次退回的轮次重提")
        previous = latest["id"]

    reason = reason.strip()
    if previous:
        earlier = round_detail(db, previous)
        if earlier["job"] != job or earlier["author"] != author or earlier["state"] != "returned":
            raise HTTPException(409, "上轮须为同一批次中本人已退回的版本")
        if earlier["version"] == version and not reason:
            raise HTTPException(422, "以原版重提时请填写理由")
        if db.execute("SELECT 1 FROM rounds WHERE previous=?", (previous,)).fetchone():
            raise HTTPException(409, "这次退回已有后续轮次")
    identity = uuid4().hex
    db.execute(
        """INSERT INTO rounds(id,version,previous,reason,submitted,state)
           VALUES (?,?,?,?,?,'pending')""",
        (identity, version, previous, reason, storage.now()),
    )
    return round_detail(db, identity)


def conclude(db, identity, username, outcome, note):
    current = round_detail(db, identity)
    if current["author"] == username:
        raise HTTPException(403, "作者不能复核自己的版本")
    updated = db.execute(
        """UPDATE rounds SET state=?, reviewer=?, decided=?, conclusion=?
           WHERE id=? AND state='pending'""",
        (outcome, username, storage.now(), note.strip(), identity),
    )
    if updated.rowcount != 1:
        raise HTTPException(409, "本轮已结束，请查看已采纳的结论")
    return round_detail(db, identity)


def add_comment(db, identity, username, body, x, y):
    current = round_detail(db, identity)
    if current["state"] != "pending":
        raise HTTPException(409, "本轮已结束，意见已归档")
    if not body.strip():
        raise HTTPException(422, "请填写意见内容")
    if (x is None) != (y is None):
        raise HTTPException(422, "请同时指定横纵坐标")
    comment_id = uuid4().hex
    db.execute(
        "INSERT INTO comments(id,round_id,author,created,body,x,y) VALUES (?,?,?,?,?,?,?)",
        (comment_id, identity, username, storage.now(), body.strip(), x, y),
    )
    return comment_id


def queue(db, job=None):
    query = """SELECT r.*, v.job, v.username AS author,
                      (SELECT COUNT(*) FROM comments c WHERE c.round_id=r.id) AS comment_count,
                      (SELECT id FROM rounds next WHERE next.previous=r.id) AS successor
               FROM rounds r JOIN versions v ON v.id=r.version"""
    args = ()
    if job:
        query += " WHERE v.job=?"
        args = (job,)
    query += " ORDER BY r.submitted DESC,r.rowid DESC"
    return [dict(row) for row in db.execute(query, args)]


def thread(db, identity):
    item = round_detail(db, identity)
    comments = db.execute(
        "SELECT * FROM comments WHERE round_id=? ORDER BY created,rowid", (identity,)
    )
    return {**item, "comments": [dict(row) for row in comments]}
