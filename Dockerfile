FROM python:3.11-slim

WORKDIR /app

# 先安装依赖（利用 Docker 层缓存，代码改动不用重新装包）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

# 复制项目代码（.env 已被 .dockerignore 排除，密钥通过环境变量注入）
COPY . .

ENV PYTHONUNBUFFERED=1

EXPOSE 8000

# 用生产级 WSGI 服务器 gunicorn，替代 Flask 自带开发服务器
# ${PORT:-8000}：优先使用平台注入的 PORT 环境变量，否则 8000
CMD ["sh", "-c", "gunicorn -w 2 -b 0.0.0.0:${PORT:-8000} --timeout 120 --access-logfile - app:app"]
