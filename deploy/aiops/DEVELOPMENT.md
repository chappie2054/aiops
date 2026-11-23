# AIOps 开发指南

本 fork 交付 AIOps Kubernetes 运维工作台。交付件在 `deploy/aiops/`，运行形态是「镜像 + 清单 + 一键安装脚本」，镜像基于官方 `@deepseek-ai/dsh` 发布包叠加登录网关、Kubernetes MCP、kubectl/Helm、定时根因巡检和演示数据。

## 分支与提交

`master` 是交付基线，**受保护、不直接推送**。改动一律走分支和合并请求。

| 规则 | 内容 |
| --- | --- |
| 分支命名 | `feat/<scope>-<简述>`、`fix/<scope>-<简述>`、`chore/…`、`docs/…`，scope 用 `aiops` 或子系统名 |
| 合并方式 | codeup 上对 `master` 开启保护：禁止直接推送、要求合并请求、至少一人审核、流水线通过才可合并 |
| 提交信息 | `<type>(<scope>): <subject>`，正文写清根因、影响面、验证方式；`type` 取 feat/fix/chore/docs/refactor/test |
| 镜像标签 | 必须带提交短 SHA，例如 `v15-02d77164`；交付版本号单独打 `v15` |
| 合并上游 | 先看官方升级说明，再 `git fetch upstream && git switch master && git merge upstream/master`；解决冲突后跑构建与本地启动验证才推送 |

两个远端：

```sh
git push origin <branch>   # origin = codeup 内部仓库，交付来源
git push github <branch>   # github = chappie2054/aiops 镜像
```

内部仓库不接受浅克隆推送（`shallow update not allowed`）。新机器首次同步先 `git fetch --unshallow github`，再推送。

## 构建镜像

两个入口，区别只在 kubectl/helm 从哪来：

| 入口 | 用途 | 依赖 |
| --- | --- | --- |
| `Dockerfile` | 能访问 `dl.k8s.io`、`get.helm.sh` 的机器 | 在线下载 kubectl/helm |
| `Dockerfile.arm64` | 离线或受限网络，在 arm64 节点原生构建 | 构建上下文里带 `kubectl`、`helm` |

另有 `Dockerfile.rca-update`（在已发布镜像上做增量更新）和 `Dockerfile.cached-base`（依赖本地缓存的基础镜像），只用于测试环境快速迭代，不适合作为交付构建入口。

两个入口都会在镜像里把 koffi 的 musl 产物覆盖到 glibc 路径，并以 `require('koffi')` 作为构建门禁。**这条不能删**：Alpine 上 koffi 会优先加载 `@koromix/koffi-<platform>` 的 glibc 产物，在 musl 下抛 `std::system_error` 直接中止进程，表现为 harness 容器每次创建会话就退出。门禁让这种镜像构建失败，而不是发出去。

构建上下文需要：`Dockerfile*`、`gateway.mjs`、`launcher.mjs`、`hash-password.mjs`、`guide.html`、`login.html`、`brand.css`、`brand.js`、`favicon.svg`、`rca/`、`seed/`，以及 `Dockerfile.arm64` 用的 `kubectl`、`helm` 二进制。

```sh
# x86 构建机
docker build -f Dockerfile -t aiops/workbench:v15 .

# arm64 节点（kubectl/helm 取自已部署镜像，节点访问不了 dl.k8s.io）
docker build -f Dockerfile.arm64 -t aiops/workbench:v15 .
```

构建后先自检，再谈发布：

```sh
docker run --rm --entrypoint node aiops/workbench:v15 \
  -e 'console.log(require("/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/koffi").version)'
docker run --rm --entrypoint sh aiops/workbench:v15 -c 'kubectl version --client | head -1; helm version --short'
```

发布用的归档按架构命名，并由安装脚本按 `uname -m` 选择：

```sh
docker save <image> | gzip > aiops-workbench-v15-<arch>.tar.gz
sha256sum aiops-workbench-v15-<arch>.tar.gz > aiops-workbench-v15-<arch>.tar.gz.sha256
```

需要多发一个架构版本时，用多架构清单让同一个标签适配两种节点：

```sh
docker manifest create <repo>/aiops-workbench:v15 \
  --amend <repo>/aiops-workbench:v15-arm64 --amend <repo>/aiops-workbench:v15-amd64
docker manifest push --purge <repo>/aiops-workbench:v15
```

## 本地启动开发

### 跑 dsh 源码（改前端、插件、网关逻辑时）

需要 Node.js ≥ 24.9 和 pnpm。

```sh
pnpm install
pnpm run dev:web        # 构建并启动 Web，改 client 插件时热更新
pnpm dsh --profile headless "看看 privatization 下有没有异常 Pod"   # 单次任务
```

`dev:web` 会先 `build:artifacts` 再启动；`start:web` 跳过构建。默认地址 `http://127.0.0.1:3080`，加 `--no-open` 不打开浏览器。模型走 `DEEPSEEK_API_KEY`，或按本交付的 `cordis.patch.yml` 指向内部 OpenAI 兼容端点。

提交前跑与改动面匹配的检查：

```sh
pnpm run typecheck
pnpm run test
pnpm run lint
```

### 跑交付镜像（验证真实部署形态）

```sh
mkdir -p /tmp/dsh-home /tmp/dsh-ws
docker run --rm -it -p 3080:3080 \
  -e DSH_HOME=/data/dsh -e HOME=/workspace \
  -v /tmp/dsh-home:/data/dsh -v /tmp/dsh-ws:/workspace \
  aiops/workbench:v15 dsh web --no-open --host 0.0.0.0
```

登录网关单独起时，需要 `LOGIN_USERNAME`、`LOGIN_SALT`、`LOGIN_HASH`、`LOGIN_SESSION_KEY` 四个环境变量，端口 8080，由 `node /opt/aiops/gateway.mjs` 提供。`launcher.mjs` 负责生成启动令牌并转交 `dsh web`，K8s 里由它做容器入口。

想复现集群里的首装效果（演示会话 + 15 分钟巡检任务），先跑一次 seed：

```sh
docker run --rm -v /tmp/dsh-home:/data/dsh -v /tmp/dsh-ws:/workspace \
  -e DSH_HOME=/data/dsh aiops/workbench:v15 node /opt/aiops/seed/bootstrap.mjs
```

### 本地装到 Kubernetes

`install.sh` 默认从同目录归档 `docker load -i`，四个必填变量见 [README.md](README.md)；用 `AIOPS_IMAGE_ARCHIVE` 可指向别处的归档，`AIOPS_PULL=true` 才从仓库拉取。

## 验证清单

改交付件后至少确认：

1. 镜像：koffi 能 `require`、`dsh web` 正常监听、新建会话不崩。
2. 部署：Pod `2/2 Running`、`/` 与 `/login` 返回 200。
3. 定时任务：启动后 `storages/schedule.json` 的 `scheduledAt` 推进、`deliveryHistory` 有回执、目标会话目录里出现 `session.v4.jsonl.zstd`。
4. 脚本：`bash -n install.sh uninstall.sh`。

## 目录约定

| 位置 | 内容 |
| --- | --- |
| `deploy/aiops/` | 源码：脚本、Dockerfile、清单模板、种子数据、巡检技能、文档 |
| `<workspace>/delivery/aiops-v15/` | 交付包：两架构归档与 `.sha256`、清单、安装/卸载脚本、说明（在仓库之外） |
| `<workspace>/archive/superseded-*` | 被取代的历史产物，可直接删 |

镜像归档、密码、Kubernetes Secret、会话数据不进 Git。
