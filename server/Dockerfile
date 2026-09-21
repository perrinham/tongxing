# 同行后端镜像 —— 零 npm 依赖（node:http + Node 22 内置 node:sqlite），无需 npm install。
#
# 构建上下文就是 server 目录本身：
#   cd server && docker build -t tongxing-server .
#   docker run -p 8787:7860 -v tongxing-data:/app/data tongxing-server
#
# Hugging Face Spaces（Docker 模板，免费）也用这份：把 server 目录内容作为
# Space 仓库根上传即可；HF 固定要求监听 7860，本地跑想用 8787 就 -e PORT=8787。
#
# ⚠️ 免费容器（HF 空闲休眠 / 重建容器）的磁盘是临时的：/app/data 在重建后会清空，
#    重要数据要定期备份（docker cp 容器:/app/data/travel.sqlite3 .）。
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=7860 \
    DATA_DIR=/app/data

COPY . .

RUN mkdir -p /app/data

EXPOSE 7860

CMD ["node", "index.mjs"]
