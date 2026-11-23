"""Public viewer files sharing a volume with private credentials and review metadata."""

from pathlib import Path

from fastapi.staticfiles import StaticFiles


class PublicData(StaticFiles):
    folders = frozenset({"samples", "annotations", "hit", "hit-revisions", "cache"})
    files = frozenset(
        {"index.json", "thumb_vessel.png", "thumb_faz.png", "thumb_layers.png", "thumb_faz3d.png"}
    )

    def lookup_path(self, path):
        root = Path(self.directory).resolve()
        relative = Path(path)
        if relative.is_absolute() or ".." in relative.parts:
            return "", None
        candidate = (root / relative).resolve()
        if not candidate.is_relative_to(root):
            return "", None
        for name in (relative, candidate.relative_to(root)):
            if not name.parts:
                return "", None
            if name.parts[0] not in self.folders and name.as_posix() not in self.files:
                return "", None
        return super().lookup_path(path)
