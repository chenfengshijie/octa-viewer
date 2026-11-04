"""用户认证：文件式用户存储 + PBKDF2 密码哈希 + HMAC 无状态 token。

全部基于标准库，不引入新依赖。用户存 data/users.json（threading.Lock 保护读改写），
token 为 base64url(payload).base64url(hmac) 两段式，30 天有效，密钥存 data/secret.key
（首次调用时自动生成；data/ 已在 .gitignore 中，不会入库）。
"""
import base64
import hashlib
import hmac
import json
import re
import secrets
import threading
import time
from pathlib import Path

from fastapi import Depends, HTTPException, Request

from app.config import DATA_DIR

USERS_FILE = DATA_DIR / "users.json"
SECRET_FILE = DATA_DIR / "secret.key"

TOKEN_TTL_SECONDS = 30 * 24 * 3600  # 30 天
PBKDF2_ITERATIONS = 100_000
USERNAME_MIN, USERNAME_MAX = 2, 32
PASSWORD_MIN = 6

_lock = threading.Lock()  # users.json 的读改写保护（同步端点在线程池中并发执行）
_users_cache: list[dict] | None = None

# 用户名允许：字母/数字/下划线/中文（同时保证作为目录名安全：无路径分隔符、无点）
_USERNAME_RE = re.compile(r"^[A-Za-z0-9_\u4e00-\u9fa5]{%d,%d}$" % (USERNAME_MIN, USERNAME_MAX))


class UserError(ValueError):
    """用户名/密码不合法或用户已存在等业务错误。"""


def load_secret() -> bytes:
    """读取（或首次生成）token 签名密钥。"""
    try:
        key = bytes.fromhex(SECRET_FILE.read_text(encoding="ascii").strip())
        if len(key) >= 32:
            return key
    except (OSError, ValueError):
        pass
    key = secrets.token_bytes(32)
    SECRET_FILE.parent.mkdir(parents=True, exist_ok=True)
    SECRET_FILE.write_text(key.hex(), encoding="ascii")
    return key


_SECRET = load_secret()


# ---------------------------------------------------------------- 校验
def validate_username(username: str) -> str:
    if not isinstance(username, str):
        raise UserError("用户名不合法")
    name = username.strip()
    if _USERNAME_RE.fullmatch(name):
        return name
    raise UserError(
        f"用户名需为 {USERNAME_MIN}-{USERNAME_MAX} 位中文、字母、数字或下划线"
    )


def validate_password(password: str) -> str:
    if not isinstance(password, str) or len(password) < PASSWORD_MIN:
        raise UserError(f"密码至少 {PASSWORD_MIN} 位")
    return password


# ---------------------------------------------------------------- 密码哈希
def hash_password(password: str, salt: bytes) -> str:
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return digest.hex()


def verify_password(password: str, salt_hex: str, pw_hash_hex: str) -> bool:
    try:
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(pw_hash_hex)
    except ValueError:
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return hmac.compare_digest(actual, expected)


# ---------------------------------------------------------------- 用户存储
def _load_users() -> list[dict]:
    global _users_cache
    if _users_cache is None:
        try:
            _users_cache = json.loads(USERS_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            _users_cache = []
        if not isinstance(_users_cache, list):
            _users_cache = []
    return _users_cache


def _save_users(users: list[dict]) -> None:
    USERS_FILE.parent.mkdir(parents=True, exist_ok=True)
    USERS_FILE.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8")


def public_view(user: dict) -> dict:
    return {"id": user["id"], "username": user["username"], "created_at": user["created_at"]}


def create_user(username: str, password: str) -> dict:
    name = validate_username(username)
    validate_password(password)
    with _lock:
        users = _load_users()
        if any(u["username"] == name for u in users):
            raise UserError(f"用户名 “{name}” 已被注册")
        user = {
            "id": f"u_{secrets.token_hex(8)}",
            "username": name,
            "salt": secrets.token_hex(16),
            "pw_hash": "",
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        user["pw_hash"] = hash_password(password, bytes.fromhex(user["salt"]))
        users.append(user)
        _save_users(users)
    return public_view(user)


def find_user(username: str) -> dict | None:
    """按用户名查找（内部含 pw_hash 等私有字段，不直接外发）。"""
    with _lock:
        users = _load_users()
        for u in users:
            if u["username"] == username:
                return dict(u)
    return None


def find_user_by_id(uid: str) -> dict | None:
    with _lock:
        users = _load_users()
        for u in users:
            if u["id"] == uid:
                return dict(u)
    return None


# ---------------------------------------------------------------- Token
def _b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def issue_token(uid: str) -> str:
    payload = {"uid": uid, "exp": int(time.time()) + TOKEN_TTL_SECONDS}
    body = _b64e(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = hmac.new(_SECRET, body.encode("ascii"), hashlib.sha256).digest()
    return f"{body}.{_b64e(sig)}"


def verify_token(token: str) -> str | None:
    """校验 token，返回 uid；无效/过期返回 None。"""
    try:
        body, sig_text = token.split(".", 1)
        expected = hmac.new(_SECRET, body.encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64d(sig_text)):
            return None
        payload = json.loads(_b64d(body))
        if not isinstance(payload, dict) or int(payload.get("exp", 0)) < time.time():
            return None
        return str(payload["uid"])
    except (ValueError, KeyError, TypeError):
        return None


# ---------------------------------------------------------------- FastAPI 依赖
def _bearer_token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        token = header[7:].strip()
        return token or None
    return None


def optional_user(request: Request) -> dict | None:
    """解析请求中的 token，有效则返回用户公开信息，否则 None（匿名放行）。"""
    token = _bearer_token(request)
    if token is None:
        return None
    uid = verify_token(token)
    if uid is None:
        return None
    user = find_user_by_id(uid)
    return None if user is None else public_view(user)


def require_user(user: dict | None = Depends(optional_user)) -> dict:
    """需要登录的端点使用；未登录抛 401。"""
    if user is None:
        raise HTTPException(status_code=401, detail="请先登录")
    return user
