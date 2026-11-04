"""注册 / 登录 / 当前用户端点：POST /api/auth/register、/login、GET /api/auth/me。"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import auth

router = APIRouter(prefix="/api/auth", tags=["auth"])


class Credentials(BaseModel):
    username: str
    password: str


def _auth_payload(user: dict) -> dict:
    """登录/注册成功后的统一返回：token + 用户信息。"""
    return {"token": auth.issue_token(user["id"]), "user": user}


@router.post("/register")
def register(creds: Credentials) -> dict:
    try:
        user = auth.create_user(creds.username, creds.password)
    except auth.UserError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _auth_payload(user)


@router.post("/login")
def login(creds: Credentials) -> dict:
    user = auth.find_user(creds.username or "")
    if user is None or not auth.verify_password(creds.password or "", user["salt"], user["pw_hash"]):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    return _auth_payload(auth.public_view(user))


@router.get("/me")
def me(user: dict = Depends(auth.require_user)) -> dict:
    return {"user": user}
