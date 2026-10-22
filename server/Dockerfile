# 同行后端镜像 —— 零 npm 依赖（node:http + Node 22 内置 node:sqlite），无需 npm install。
#
# 构建上下文就是 server 目录本身：
#   cd server && docker build -t tongxing-server .
#   docker run -p 8787:7860 -v tongxing-data:/app/data tongxing-server
#
# Hugging Face Spaces（Docker 模板，免费）也用这份：把 server 目录内容作为
# Space 仓库根上传即可；HF 固定要求监听 7860，本地跑想用 8787 就 -e PORT=8787。
#
# ⚠️ 免费容器（HF 空闲休眠 / 重建容器）的磁盘是临时的：/app/data 在重建后会清空。
#    配套方案：Space 设置里加 Variable BACKUP_ENABLED=1 + Secret HF_TOKEN（write 权限），
#    服务每小时把数据库 commit/push 回 Space 仓库（/app/_backup），重建时随代码检出自动恢复（backup.mjs）。
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=7860 \
    DATA_DIR=/app/data

COPY . .

RUN mkdir -p /app/data

EXPOSE 7860

CMD ["node", "index.mjs"]
