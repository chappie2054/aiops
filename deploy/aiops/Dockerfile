FROM docker.m.daocloud.io/library/node:24-alpine

ARG DSH_VERSION=0.2.2-rc.1
ARG KUBECTL_VERSION=v1.22.17
ARG HELM_VERSION=v3.3.4
ARG TARGETARCH=amd64

RUN sed -i 's#https://dl-cdn.alpinelinux.org/alpine#https://mirrors.aliyun.com/alpine#g' /etc/apk/repositories \
    && apk add --no-cache bash curl git jq openssh-client ca-certificates \
    && npm install --global --omit=dev --no-audit --no-fund "@deepseek-ai/dsh@${DSH_VERSION}" mcp-server-kubernetes@4.2.1 \
    && npm cache clean --force \
    && curl -fsSL --retry 3 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" -o /usr/local/bin/kubectl \
    && chmod 755 /usr/local/bin/kubectl \
    && curl -fsSL --retry 3 "https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" -o /tmp/helm.tar.gz \
    && tar -xzf /tmp/helm.tar.gz -C /tmp "linux-${TARGETARCH}/helm" \
    && install -m 755 "/tmp/linux-${TARGETARCH}/helm" /usr/local/bin/helm \
    && rm -rf /tmp/helm.tar.gz "/tmp/linux-${TARGETARCH}" \
    && kubectl version --client && helm version --short

COPY gateway.mjs launcher.mjs hash-password.mjs guide.html login.html brand.css brand.js favicon.svg /opt/aiops/
COPY rca/scan.mjs rca/SKILL.md /opt/aiops/rca/
COPY seed/bootstrap.mjs /opt/aiops/seed/bootstrap.mjs
COPY seed/cases/ /opt/aiops/seed/cases/
ENV DSH_HOME=/data/dsh
WORKDIR /workspace
EXPOSE 3080 8080
CMD ["node", "/opt/aiops/launcher.mjs"]
