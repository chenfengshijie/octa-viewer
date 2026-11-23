"""Authenticated HIT review queue, spatial notes and decisions."""

from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.auth import require_user
from app.hit import catalog, reviews, storage

router = APIRouter(prefix="/api/hit", tags=["hit-review"], dependencies=[Depends(require_user)])


class Submission(BaseModel):
    version: str
    previous: str | None = None
    reason: str = Field(default="", max_length=4000)


class Decision(BaseModel):
    outcome: Literal["approved", "returned"]
    note: str = Field(default="", max_length=4000)


class Comment(BaseModel):
    body: str = Field(min_length=1, max_length=4000)
    x: int | None = Field(default=None, ge=0, lt=catalog.SIZE)
    y: int | None = Field(default=None, ge=0, lt=catalog.SIZE)


@router.get("/reviews")
def list_rounds(job: str | None = None):
    cases = {item["job_id"]: item["case_id"] for item in catalog.records()}
    with storage.transaction() as db:
        rows = reviews.queue(db, job)
    return {
        "rounds": [{**row, "case_id": cases[row["job"]]} for row in rows if row["job"] in cases]
    }


@router.post("/runs/{job}/reviews")
def submit(job: str, payload: Submission, user: dict = Depends(require_user)):
    catalog.record(job)
    with storage.transaction(write=True) as db:
        storage.import_legacy(db, job)
        return reviews.submitted(
            db, job, payload.version, user["username"], payload.previous, payload.reason
        )


@router.get("/reviews/{identity}")
def read_round(identity: str):
    with storage.transaction() as db:
        return reviews.thread(db, identity)


@router.post("/reviews/{identity}/comments")
def comment(identity: str, payload: Comment, user: dict = Depends(require_user)):
    with storage.transaction(write=True) as db:
        comment_id = reviews.add_comment(
            db, identity, user["username"], payload.body, payload.x, payload.y
        )
    return {"id": comment_id}


@router.post("/reviews/{identity}/decision")
def decide(identity: str, payload: Decision, user: dict = Depends(require_user)):
    with storage.transaction(write=True) as db:
        return reviews.conclude(db, identity, user["username"], payload.outcome, payload.note)
