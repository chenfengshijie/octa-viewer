# ---------- stage 1: frontend build ----------
FROM node:20-alpine AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- stage 2: backend + static frontend ----------
FROM python:3.11-slim
WORKDIR /app/backend

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .
# 前端产物放到 /app/frontend/dist，与本地生产模式的相对路径一致，
# FastAPI 以 ../frontend/dist 挂载静态站点（容器内 /app 与仓库布局同构）
COPY --from=frontend-build /build/dist /app/frontend/dist

# 数据集不进镜像：backend/data 由宿主机 prep_data.py 生成后，
# 运行时用 -v 挂载到该路径，或 docker cp 拷入（见 README「Docker」一节）
VOLUME /app/backend/data

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
