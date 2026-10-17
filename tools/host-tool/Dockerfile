# SPDX-License-Identifier: MPL-2.0
# The host tool as a container image (S2.02). Built from the folder `pack.ts --no-node` makes:
#
#   node tools/host-tool/scripts/pack.ts --no-node
#   docker build -t flatchat-host -f tools/host-tool/Dockerfile release/host/flatchat-host-0.0.0-linux-x64
#   docker run --rm -v "$PWD/my-world:/world" flatchat-host check /world
#
# A world needs its UDP port (7778 by default) reachable, and its key from `host key` in the
# environment of `host run` (mount ~/.config/flatchat at /root/.config/flatchat).
FROM node:24.22.0-bookworm-slim
WORKDIR /flatchat
COPY app/ ./
COPY bin/ ./bin/
ENV NODE_ENV=production
EXPOSE 7778/udp
ENTRYPOINT ["node", "/flatchat/tools/host-tool/src/cli.ts"]
