"""The mounted data volume publishes images while review notes remain authenticated."""

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from app.public_data import PublicData


class PublicMount(TestCase):
    def setUp(self):
        temp = TemporaryDirectory(prefix="public-data-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.mount = PublicData(directory=self.root)
        for name in (
            "index.json",
            "thumb_faz.png",
            "thumb_faz3d.png",
            "thumb_layers.png",
            "thumb_vessel.png",
            "hit/first/result/mask.png",
            "annotations/a/sample/meta.json",
            "samples/12/proj_octa.png",
            "hit-revisions/first/user.png",
            "cache/entry.png",
            "private/hit.sqlite3",
            "private/hit.sqlite3-wal",
            "private/oct/first/oct.npy",
            "secret.key",
            "users.json",
        ):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture")

    def assertVisible(self, name):
        found, stat = self.mount.lookup_path(name)
        self.assertEqual(Path(found).resolve(), (self.root / name).resolve())
        self.assertIsNotNone(stat)

    def assertPrivate(self, name):
        path, stat = self.mount.lookup_path(name)
        self.assertFalse(path)
        self.assertIsNone(stat)

    def test_original_sample_and_user_mask_links_still_resolve(self):
        for relative in (
            "hit/first/result/mask.png",
            "samples/12/proj_octa.png",
            "hit-revisions/first/user.png",
        ):
            with self.subTest(relative=relative):
                self.assertVisible(relative)

    def test_shared_existing_annotation_and_cache_routes_still_resolve(self):
        self.assertVisible("annotations/a/sample/meta.json")
        self.assertVisible("cache/entry.png")

    def test_viewer_metadata_and_existing_thumbnails_are_public(self):
        for relative in (
            "index.json",
            "thumb_faz.png",
            "thumb_faz3d.png",
            "thumb_layers.png",
            "thumb_vessel.png",
        ):
            with self.subTest(relative=relative):
                self.assertVisible(relative)

    def test_credentials_and_review_store_never_have_static_urls(self):
        for relative in (
            "private/hit.sqlite3",
            "private/hit.sqlite3-wal",
            "private/oct/first/oct.npy",
            "secret.key",
            "users.json",
        ):
            with self.subTest(relative=relative):
                self.assertPrivate(relative)

    def test_public_tree_alias_cannot_publish_private_file(self):
        alias = self.root / "samples" / "alias"
        alias.symlink_to(self.root / "private", target_is_directory=True)
        self.assertPrivate("samples/alias/hit.sqlite3")

    def test_symlink_to_another_public_image_can_be_served(self):
        alias = self.root / "cache" / "alias.png"
        alias.symlink_to(self.root / "samples" / "12" / "proj_octa.png")
        self.assertVisible("cache/alias.png")

    def test_unrecognized_top_level_files_do_not_become_public_by_extension(self):
        (self.root / "private-copy.png").write_text("fixture")
        self.assertPrivate("private-copy.png")
