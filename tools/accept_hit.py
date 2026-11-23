"""Reproduce HIT static acceptance on a local checkout, with optional published artifacts."""

import argparse
import ast
from collections import Counter
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
SUFFIXES = {".py", ".js", ".jsx", ".html", ".css"}


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def tree_files(revision=None):
    if revision:
        listing = git("ls-tree", "--name-only", "-r", "-z", revision)
    else:
        listing = git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
    for raw in listing.split(b"\0"):
        if not raw:
            continue
        name = raw.decode("utf-8")
        path = ROOT / name
        if path.suffix not in SUFFIXES:
            continue
        if revision:
            yield name, git("show", f"{revision}:{name}")
        elif path.is_file():
            yield name, path.read_bytes()


def scale(files):
    counts = Counter()
    sizes = Counter()
    for name, raw in files:
        category = name.split("/", 1)[0]
        counts[category] += 1
        sizes[category] += len(raw.splitlines())
    return {
        "files": sum(counts.values()),
        "lines": sum(sizes.values()),
        "groups": {key: {"files": counts[key], "lines": sizes[key]} for key in sorted(counts)},
    }


def python_syntax(files):
    count = 0
    problems = []
    for name, raw in files:
        if not name.endswith(".py"):
            continue
        try:
            ast.parse(raw, filename=name, feature_version=(3, 10))
            compile(raw, name, "exec")
        except SyntaxError as exc:
            problems.append(f"{name}:{exc.lineno} {exc.msg}")
        count += 1
    if problems:
        raise ValueError("\n".join(problems))
    return count


def contracts():
    # app.auth creates a local key when imported. Generate OpenAPI against an isolated
    # volume so acceptance does not initialize any accounts, data or credentials in the checkout.
    sys.path.insert(0, str(ROOT / "backend"))
    from app import config

    with TemporaryDirectory(prefix="hit-openapi-") as directory:
        config.DATA_DIR = Path(directory)
        from app.auth import require_user
        from app.main import app
        from app.routers import (
            hit,
            hit_qc,
            hit_measurements,
            hit_spatial,
            hit_research,
            hit_reviews,
        )

        from hit_api_contract import validate

        document = app.openapi()
        paths = document["paths"]
        result = []
        for module in (hit, hit_qc, hit_measurements, hit_spatial, hit_research, hit_reviews):
            for route in module.router.routes:
                for method in sorted(route.methods):
                    contract = paths.get(route.path, {}).get(method.lower())
                    if not contract:
                        raise ValueError(f"{method} {route.path} 缺少已挂载的接口定义")
                    guard = any(dep.call is require_user for dep in route.dependant.dependencies)
                    private = (
                        method != "GET"
                        or module is hit_reviews
                        or route.path.endswith("/candidates")
                    )
                    if guard != private:
                        raise ValueError(f"{method} {route.path} 身份校验不符合工作流约定")
                    result.append(
                        {
                            "method": method,
                            "path": route.path,
                            "login": guard,
                            "media_types": list(contract["responses"]["200"].get("content", {})),
                        }
                    )
        validate(document, result)
        return result


def frontend_build():
    with TemporaryDirectory(prefix="hit-frontend-") as temp:
        subprocess.run(
            ["npm", "run", "build", "--", "--outDir", temp],
            cwd=ROOT / "frontend",
            check=True,
            stdout=sys.stderr,
        )
        path = Path(temp)
        if not (path / "index.html").is_file() or not list((path / "assets").glob("*.js")):
            raise ValueError("生产构建缺少网页或 JavaScript 资源")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", default="2761fa7", help="规模基线提交")
    parser.add_argument("--run", type=Path, help="已导入批次目录")
    parser.add_argument("--handoff", type=Path, help="与 --run 配套的交接结果目录")
    parser.add_argument("--build", action="store_true", help="构建临时 Vite 生产资源")
    args = parser.parse_args()
    if args.handoff and not args.run:
        parser.error("--handoff 需要 --run")
    files = list(tree_files())
    totals = scale(files)
    baseline = scale(tree_files(args.baseline))
    summary = {
        "head": git("rev-parse", "--short", "HEAD").decode().strip(),
        "scale": totals,
        "baseline": baseline,
        "net_lines": totals["lines"] - baseline["lines"],
        "python_compiled": python_syntax(files),
        "routes": contracts(),
    }
    if args.run:
        from app.hit.audit.run import inspect_run
        from app.hit.audit.handoff import inspect_handoff

        report = inspect_handoff(args.run, args.handoff) if args.handoff else inspect_run(args.run)
        summary["artifacts"] = report.output()
        if report.findings:
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            return 1
    git("diff", "--check")
    git("diff", "--cached", "--check")
    if args.build:
        frontend_build()
        summary["production_build"] = True
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
