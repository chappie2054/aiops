FROM docker.m.daocloud.io/library/node:24-alpine

ARG DSH_VERSION=0.2.2-rc.1
ARG KUBECTL_VERSION=v1.22.17
ARG HELM_VERSION=v3.3.4
ARG TARGETARCH=amd64

RUN sed -i 's#https://dl-cdn.alpinelinux.org/alpine#https://mirrors.aliyun.com/alpine#g' /etc/apk/repositories \
    && apk add --no-cache bash curl git jq openssh-client ca-certificates libstdc++ \
    && apk add --no-cache --virtual .arm-build-deps cmake make g++ python3 \
    && npm install --global --omit=dev --no-audit --no-fund "@deepseek-ai/dsh@${DSH_VERSION}" mcp-server-kubernetes@4.2.1 \
    && apk del .arm-build-deps \
    && npm cache clean --force \
    && curl -fsSL --retry 3 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" -o /usr/local/bin/kubectl \
    && chmod 755 /usr/local/bin/kubectl \
    && curl -fsSL --retry 3 "https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" -o /tmp/helm.tar.gz \
    && tar -xzf /tmp/helm.tar.gz -C /tmp "linux-${TARGETARCH}/helm" \
    && install -m 755 "/tmp/linux-${TARGETARCH}/helm" /usr/local/bin/helm \
    && rm -rf /tmp/helm.tar.gz "/tmp/linux-${TARGETARCH}" \
    && kubectl version --client && helm version --short

# koffi 3.1.1 tries @koromix/koffi-<platform> before the musl triplet, and that package
# resolves to its glibc build; loading the glibc build on musl throws std::system_error and
# aborts the process. Every path resolves to the musl build, and the load below fails the
# build instead of shipping an image that cannot create a Session.
RUN set -eu; \
    root=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@koromix; \
    for pkg in "${root}"/koffi-*; do \
      for musl in "${pkg}"/musl_*; do \
        [ -d "${musl}" ] || continue; \
        abi="${musl##*/musl_}"; \
        cp "${musl}/koffi.node" "${pkg}/linux_${abi}/koffi.node"; \
      done; \
    done; \
    node -e 'console.log("koffi", require("/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/koffi").version)'

COPY gateway.mjs launcher.mjs hash-password.mjs guide.html login.html brand.css brand.js favicon.svg /opt/aiops/
COPY rca/scan.mjs rca/SKILL.md /opt/aiops/rca/
COPY seed/bootstrap.mjs /opt/aiops/seed/bootstrap.mjs
COPY seed/cases/ /opt/aiops/seed/cases/
ENV DSH_HOME=/data/dsh
WORKDIR /workspace
EXPOSE 3080 8080
CMD ["node", "/opt/aiops/launcher.mjs"]
