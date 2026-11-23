"""Small, deterministic archived artifacts built in a temporary directory.

The geometry matches the import contract. No model, service, registry or personal data is used.
"""

from contextlib import contextmanager, closing
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch
from zipfile import ZipFile, ZIP_DEFLATED

import numpy as np
from PIL import Image

from app.hit import catalog, research, storage


EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)
JOB = "scan-a"
CASE = "case-01"
AUTHOR = "作者甲"
PEER = "复核乙"
FILES = {
    "deep_projection": "projections/OCTA_OPL_BM.png",
    "shallow_projection": "projections/OCTA_ILM_OPL.png",
    "full_projection": "projections/OCTA_FULL.png",
    "model_input": "projections/input.png",
    "surfaces": "projections/surfaces.npz",
    "boundary_qc": "projections/oct_boundaries_qc.png",
    "mask": "result/mask.png",
    "probability": "result/probability.npy",
    "overlay": "result/overlay.png",
}
FILTERS = {"case": "", "job": "", "author": ""}


def moment(seconds):
    return (EPOCH + timedelta(seconds=seconds)).isoformat(timespec="microseconds")


def png(array):
    out = BytesIO()
    Image.fromarray(array).save(out, format="PNG")
    return out.getvalue()


def json_file(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def standard_mask():
    out = np.zeros((448, 448), np.uint8)
    out[11:22, 17:43] = 255
    out[200:205, :] = 255
    return out


def changed_mask():
    data = standard_mask()
    data[14:20, 20:26] = 0
    data[0:3, 442:448] = 255
    return data


def make_run(data_dir, job=JOB, case=CASE):
    folder = data_dir / "hit" / job
    (folder / "projections").mkdir(parents=True)
    (folder / "result").mkdir()
    y, x = np.indices((448, 448))
    planes = {
        "full_projection": (x % 256).astype(np.uint8),
        "shallow_projection": (y % 256).astype(np.uint8),
        "deep_projection": ((x + y) % 256).astype(np.uint8),
    }
    image = np.stack(
        [planes[key] for key in ("deep_projection", "shallow_projection", "full_projection")],
        axis=2,
    )
    mask = standard_mask()
    yellow = np.zeros_like(image)
    yellow[:, :, :2] = mask[:, :, None]
    overlay = ((image.astype(np.uint16) + yellow) // 2).astype(np.uint8)
    images = {
        **planes,
        "model_input": image,
        "mask": mask,
        "overlay": overlay,
        "boundary_qc": np.zeros((1024, 2240, 3), np.uint8),
    }
    for key, array in images.items():
        (folder / FILES[key]).write_bytes(png(array))
    base = (200 + y // 16).astype(np.int16)
    np.savez_compressed(folder / FILES["surfaces"], ilm=base, opl=base + 30, bm=base + 65)
    np.save(folder / FILES["probability"], np.where(mask, 0.95, 0.1).astype(np.float16))
    record = {
        "case_id": case,
        "job_id": job,
        "completed_at": moment(0),
        "model": {"vessel_weight": "fixture.pth", "layer_model": "fixture"},
        "parameters": {
            "threshold": 0.8,
            "tile_size_px": 224,
            "tile_overlap": 0.25,
            "tile_fov_mm": [6, 6],
        },
        "outputs": FILES.copy(),
        "sha256": {
            key: sha256((folder / relative).read_bytes()).hexdigest()
            for key, relative in FILES.items()
        },
    }
    write_json(folder / "record.json", record)
    return folder


class DataVolume(TestCase):
    def setUp(self):
        directory = TemporaryDirectory(prefix="hit-fixture-")
        self.addCleanup(directory.cleanup)
        self.data = Path(directory.name)
        for name, folder in (("PRIVATE", "private"), ("RUNS", "hit"), ("LEGACY", "hit-revisions")):
            replacement = patch.object(catalog, name, self.data / folder)
            replacement.start()
            self.addCleanup(replacement.stop)
        self.run_dir = make_run(self.data)
        self.dbfile = self.data / "private" / "hit.sqlite3"
        self.private = self.dbfile.parent
        self.private.mkdir(parents=True)
        self.sequence = 0
        with self.connection() as db:
            db.executescript(storage.SCHEMA)
            db.execute("INSERT INTO imported(job) VALUES (?)", (JOB,))

    @contextmanager
    def connection(self):
        with closing(sqlite3.connect(self.dbfile)) as db:
            db.row_factory = sqlite3.Row
            with db:
                yield db

    def identity(self):
        self.sequence += 1
        return f"{self.sequence:032x}"

    def revision(
        self, *, author=AUTHOR, job=JOB, parent=None, source=None, threshold=None, pixels=None
    ):
        key = self.identity()
        raw = png(changed_mask() if pixels is None else pixels)
        with self.connection() as db:
            db.execute("INSERT OR IGNORE INTO imported VALUES (?)", (job,))
            db.execute(
                "INSERT INTO versions VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    key,
                    job,
                    author,
                    moment(self.sequence),
                    parent,
                    threshold,
                    source or ("revision" if parent else "original"),
                    raw,
                    sha256(raw).hexdigest(),
                ),
            )
            db.execute("INSERT OR REPLACE INTO heads VALUES (?,?,?)", (job, author, key))
        return key

    def review(self, version, state="approved", previous=None, reason="", reviewer=PEER):
        key = self.identity()
        created = moment(self.sequence)
        self.sequence += 1
        decided = moment(self.sequence)
        with self.connection() as db:
            db.execute(
                "INSERT INTO rounds VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    key,
                    version,
                    previous,
                    reason,
                    created,
                    state,
                    None if state == "pending" else reviewer,
                    None if state == "pending" else decided,
                    None if state == "pending" else "fixture decision",
                ),
            )
        return key

    def note(self, round_id, body="fixture note", x=0, y=447):
        key = self.identity()
        with self.connection() as db:
            submitted = db.execute(
                "SELECT submitted FROM rounds WHERE id=?", (round_id,)
            ).fetchone()[0]
            db.execute(
                "INSERT INTO comments VALUES (?,?,?,?,?,?,?)",
                (key, round_id, PEER, submitted, body, x, y),
            )
        return key

    def export(self, versions, seed="fixture", filters=None):
        archive = self.data / "research.zip"
        with self.connection() as db:
            with research.build_archive(db, versions, seed, filters or FILTERS) as package:
                archive.write_bytes(package.read())
        return archive

    def package(self):
        version = self.revision()
        self.review(version)
        return self.export([version])

    def replace_asset(self, name, raw, rehash=True):
        record_path = self.run_dir / "record.json"
        record = json_file(record_path)
        (self.run_dir / record["outputs"][name]).write_bytes(raw)
        if rehash:
            record["sha256"][name] = sha256(raw).hexdigest()
            write_json(record_path, record)

    def change_record(self, edit):
        path = self.run_dir / "record.json"
        record = json_file(path)
        edit(record)
        write_json(path, record)

    def modify_zip(self, path, callback):
        with ZipFile(path) as source:
            members = {key: source.read(key) for key in source.namelist()}
        manifest = json.loads(members["manifest.json"])
        callback(manifest, members)
        members["manifest.json"] = json.dumps(manifest, ensure_ascii=False).encode()
        with ZipFile(path, "w", compression=ZIP_DEFLATED) as archive:
            for key, data in members.items():
                archive.writestr(key, data)

    def assertClean(self, report):
        self.assertTrue(report.output()["ok"], report.render())

    def assertFinding(self, report, phrase):
        self.assertFalse(report.output()["ok"])
        self.assertIn(phrase, report.render())
