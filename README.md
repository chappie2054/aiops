# AIOps 运维工作台

基于 [DeepSeek Harness](README.upstream.md) 的 Kubernetes 运维工作台。交付形态是「一个镜像 + 一份清单 + 一键安装脚本」，私有化部署不依赖镜像仓库。

浏览器入口 `http://<节点 IP>:31884/`，固定账号登录，模型接内部 OpenAI 兼容端点。镜像内置 Web 工作台、登录网关、Kubernetes MCP、kubectl、Helm、定时根因巡检和两个入门案例。

## 仓库结构

| 位置 | 内容 | 状态 |
| --- | --- | --- |
| `deploy/aiops/` | 登录网关、使用页、Kubernetes 清单、镜像构建入口、安装与卸载脚本、种子数据、巡检技能 | 本项目的定制源码 |
| `apps/`、`packages/` | Harness 原版前端与插件 | 未修改 |
| `delivery/aiops-v15/`（仓库之外） | 交付包：两种架构的镜像归档与 `.sha256`、清单、脚本、说明 | 构建产物 |

镜像基于官方 `@deepseek-ai/dsh@0.2.2-rc.1` 发布包叠加上述定制，**不是**从 `apps/`、`packages/` 编译出来的。要改上游前端或核心，需要另建并验证源码构建流程。

## 安装到集群

安装机需要 Docker、kubectl、openssl。`install.sh`、`harness.yaml` 与镜像归档放在同一目录：

```bash
cd delivery/aiops-v15
AIOPS_NODE_IP='<浏览器访问的节点 IP>' \
AIOPS_MODEL_BASE_URL='<OpenAI 兼容接口基础 URL，通常以 /v1 结尾>' \
AIOPS_MODEL_ID='<模型 ID>' \
AIOPS_DATA_DIR='<宿主机持久化绝对路径>' \
bash install.sh
```

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AIOPS_NODE_IP` | 是 | 浏览器访问的节点 IP，用于渲染入口地址 |
| `AIOPS_MODEL_BASE_URL` | 是 | OpenAI 兼容接口的基础地址 |
| `AIOPS_MODEL_ID` | 是 | 模型 ID，对应接口 `/models` 的返回值 |
| `AIOPS_DATA_DIR` | 是 | 宿主机持久化目录，`data` 与 `workspace` 建在它下面 |
| `AIOPS_RCA_NAMESPACES` | 否 | 巡检的命名空间，逗号分隔，默认 `privatization` |
| `AIOPS_STORAGE_NODE` | 否 | 多节点集群保存 hostPath 的数据节点；单节点自动取 |
| `AIOPS_USERNAME`、`AIOPS_PASSWORD` | 否 | 首次安装写入登录 Secret；不传则生成随机密码并打印 |
| `AIOPS_ROTATE_LOGIN` | 否 | `true` 时重置登录账号与密码 |
| `AIOPS_IMAGE`、`AIOPS_IMAGE_ARCHIVE`、`AIOPS_PULL` | 否 | 改镜像名、指定归档路径、允许从镜像仓库拉取 |

镜像来源依次是本机已有镜像、同目录归档、镜像仓库。归档用 `docker load -i` 导入并校验同名 `.sha256`；清单渲染后是 `imagePullPolicy: Never`，节点不需要访问仓库。归档按架构命名 `aiops-workbench-v15-<arch>.tar.gz`，脚本按 `uname -m` 自动选择。只有显式设置 `AIOPS_PULL=true` 才从仓库拉取，这时才改用 `IfNotPresent`。

安装完成后访问 `http://<节点 IP>:31884/` 登录，`/guide` 是使用说明。执行 `bash uninstall.sh` 删除工作负载、入口、配置和登录 Secret，宿主机数据、命名空间与本地镜像保留。

数据布局：`<AIOPS_DATA_DIR>/data` 存会话、定时任务和设置，`<AIOPS_DATA_DIR>/workspace` 存工作区文件；两者都是 hostPath，Pod 固定在同一节点。

## 构建镜像

| 入口 | 用于 | 依赖 |
| --- | --- | --- |
| `Dockerfile` | 能访问 `dl.k8s.io`、`get.helm.sh` 的机器 | 在线下载 kubectl 与 helm |
| `Dockerfile.arm64` | 离线或受限网络，在 arm64 节点原生构建 | 构建上下文里带 `kubectl`、`helm` 二进制 |

`Dockerfile.rca-update`（在已发布镜像上增量更新）和 `Dockerfile.cached-base`（依赖本地缓存的基础镜像）只用于测试环境快速迭代。

两个交付入口都会把 koffi 的 musl 产物覆盖到 glibc 路径，并以能否 `require('koffi')` 作为构建门禁。**这一步不能删**：Alpine 上 koffi 会优先加载 `@koromix/koffi-<platform>` 的 glibc 产物，在 musl 下抛 `std::system_error` 直接中止进程，表现为 harness 容器每次创建会话就退出。

构建上下文需要 `Dockerfile*`、`gateway.mjs`、`launcher.mjs`、`hash-password.mjs`、`guide.html`、`login.html`、`brand.*`、`favicon.svg`、`rca/`、`seed/`，以及 `Dockerfile.arm64` 用的 `kubectl`、`helm`。

```sh
docker build -f Dockerfile -t aiops/workbench:v15 .        # amd64
docker build -f Dockerfile.arm64 -t aiops/workbench:v15 .  # arm64，需先放入二进制

docker run --rm --entrypoint node aiops/workbench:v15 \
  -e 'console.log(require("/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/koffi").version)'
```

发布用归档按架构生成，并带校验文件：

```sh
docker save <image> | gzip > aiops-workbench-v15-<arch>.tar.gz
sha256sum aiops-workbench-v15-<arch>.tar.gz > aiops-workbench-v15-<arch>.tar.gz.sha256
```

需要同一个标签适配两种节点时用多架构清单：

```sh
docker manifest create <repo>:v15 --amend <repo>:v15-arm64 --amend <repo>:v15-amd64
docker manifest push --purge <repo>:v15
```

## 本地开发

需要 Node.js ≥ 24.9 和 pnpm。

```sh
pnpm install
pnpm run dev:web                                            # 构建并启动 Web，改 client 插件热更新
pnpm dsh --profile headless "看看 privatization 有没有异常 Pod"  # 单次任务
```

`dev:web` 会先 `build:artifacts` 再启动，`start:web` 跳过构建；默认地址 `http://127.0.0.1:3080`，`--no-open` 不打开浏览器。模型用 `DEEPSEEK_API_KEY`，或按 `deploy/aiops/` 的清单把 provider 指向内部端点。提交前跑 `pnpm run typecheck`、`pnpm run test`、`pnpm run lint`。

直接跑交付镜像，验证真实形态：

```sh
mkdir -p /tmp/dsh-home /tmp/dsh-ws
docker run --rm -it -p 3080:3080 \
  -e DSH_HOME=/data/dsh -e HOME=/workspace \
  -v /tmp/dsh-home:/data/dsh -v /tmp/dsh-ws:/workspace \
  aiops/workbench:v15 dsh web --no-open --host 0.0.0.0
```

想复现首次安装的效果（演示会话 + 15 分钟巡检任务），先跑一次种子脚本：

```sh
docker run --rm -v /tmp/dsh-home:/data/dsh -v /tmp/dsh-ws:/workspace \
  -e DSH_HOME=/data/dsh aiops/workbench:v15 node /opt/aiops/seed/bootstrap.mjs
```

登录网关单独起时需要 `LOGIN_USERNAME`、`LOGIN_SALT`、`LOGIN_HASH`、`LOGIN_SESSION_KEY` 四个环境变量，端口 8080；`launcher.mjs` 负责生成启动令牌并转交 `dsh web`。

改完交付件至少确认：koffi 能加载、`dsh web` 能监听、新建会话不崩；部署后 Pod `2/2 Running`、`/` 与 `/login` 返回 200；定时任务启动后 `storages/schedule.json` 的 `scheduledAt` 推进且有回执。

## 分支与提交

`master` 是交付基线，**受保护、不直接推送**。改动走分支和合并请求。

| 规则 | 内容 |
| --- | --- |
| 分支命名 | `feat/<scope>-<简述>`、`fix/<scope>-<简述>`、`chore/…`、`docs/…` |
| 提交信息 | `<type>(<scope>): <subject>`，正文写根因、影响面和验证方式 |
| 镜像标签 | 带提交短 SHA，例如 `v15-02d77164`；交付版本号单独打 `v15` |
| 远端 | `origin` = codeup 内部仓库（交付来源），`github` = 镜像，`upstream` = 官方 dsh |

```sh
git push origin <branch>   # 内部仓库
git push github <branch>   # GitHub 镜像
```

内部仓库不接受浅克隆推送（`shallow update not allowed`），新机器先 `git fetch --unshallow github`。

合并官方更新：`git fetch upstream && git switch master && git merge upstream/master`，解决冲突后跑构建和本地验证再推送。自有功能尽量留在 `deploy/aiops/`，必须改 `apps/`、`packages/` 时同步验证上游合并。

镜像归档、密码、Kubernetes Secret、会话数据都不进 Git。

## 上游文档

`README.upstream.md`、`README.upstream.zh.md` 是官方 DeepSeek Harness 的原始说明，合并上游时以对方版本覆盖这两个文件。
