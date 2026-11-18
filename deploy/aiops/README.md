# 私有化 Kubernetes 运维工作台

本目录的源码归属和上游合并方式见 [单仓库维护说明](REPOSITORY.md)。当前交付镜像使用官方 Harness 发布包，并未从本 fork 的前端和核心源码构建；因此修改 `apps/web/` 后还需建立源码构建流程，改动才会进入镜像。

此目录是 DeepSeek Harness 的独立交付入口。一个镜像同时运行原版 Harness、固定账号登录网关和通过 stdio 启动的 Kubernetes MCP；`harness.yaml` 包含 Namespace、集群管理员 ServiceAccount、模型与 MCP 配置、Deployment 和 NodePort Service。无需现有 HolmesGPT MCP 服务，也无需 Pod 启动时下载 kubectl 或 MCP 包。

## 构建与安装

```bash
docker build -t aiops/deepseek-harness:custom-v8 deploy/aiops
docker save aiops/deepseek-harness:custom-v8 | gzip > deploy/aiops/deepseek-harness-custom-v8.tar.gz
cd deploy/aiops
AIOPS_NODE_IP='<节点访问地址>' \
AIOPS_MODEL_BASE_URL='<内部模型的 OpenAI 兼容地址>' \
AIOPS_MODEL_ID='<模型标识>' \
AIOPS_DATA_DIR='<宿主机数据目录>' \
AIOPS_USERNAME=aiopsadmin AIOPS_PASSWORD='<由一键安装配置注入的固定密码>' bash install.sh
```

最终离线包的 SHA-256 为 `320e3749b57d491ddfa01529e850cfbb92723591551ac4edd71277f6b081c814`，`install.sh` 在加载前校验。自行重新构建镜像时需同步更新脚本中的校验值。

在已安装旧版基础镜像的测试节点，也可以先把该节点现有的 `kubectl`、`helm` 复制到构建目录，再用 `Dockerfile.cached-base` 构建。`Dockerfile.rca-update` 可以基于已有 `custom-v2` 构建，适合离线升级；产出的 `custom-v8` 镜像仍是单个完整镜像。

本次已验证的离线镜像基于现有 `custom-v2` 增加巡检与初始化内容，内含 Harness `0.2.2-rc.1`、kubectl `1.22.17`、Helm `3.3.4` 和 Kubernetes MCP `4.2.1`。本地上游源码当前为 `0.2.2-rc.3`；后续改 Harness 核心时再从源码构建并重新做兼容验证。`Dockerfile` 提供不依赖旧镜像的独立构建方式，本次未跑通它的完整外网依赖下载流程。

Kubernetes MCP 通过镜像中的本地 stdio 进程连接 Harness，公开 `kubectl_get`、`kubectl_logs`、`kubectl_patch`、`kubectl_rollout`、Helm 等工具；它复用 Harness ServiceAccount 的集群管理员权限。旧的 HolmesGPT、Open WebUI 和两套独立 Holmes MCP 已从测试集群下线。新交付使用 `custom-v8`。

如果不传 `AIOPS_PASSWORD`，首次安装时脚本生成并输出一次随机密码。已有 `deepseek-harness-login` Secret 时默认沿用原账号密码；只有显式设置 `AIOPS_ROTATE_LOGIN=true` 才按传入账号密码轮换，且旧登录态随之失效。账号密码不写入镜像或 YAML，安装脚本用 scrypt 哈希和随机盐创建 Secret。安装脚本可以直接集成到现有一键部署流程。镜像已包含 Harness、Kubernetes MCP、kubectl、Helm、jq、bash、curl、git 和 SSH 客户端。离线安装时把镜像压缩包与 YAML、脚本放在一起；安装节点需有 Docker 与 kubectl，工作负载运行时不需要外网。

入口是 `http://<AIOPS_NODE_IP>:31884/`。中文登录页使用固定账号密码，首次登录显示使用说明，后续也可访问 `/guide`。原版 Harness Web UI 在同一入口。登录网关自动衔接 Harness 重启时生成的新浏览器 token，用户无需获取 token。密码以 scrypt 哈希保存在 Kubernetes Secret；登录态签名密钥也保存在 Secret，Harness 容器不接收登录凭据。当前 HTTP NodePort 仅适用于隔离测试网，正式交付应通过独立 TLS 入口访问。

## 调整交付参数

安装脚本通过 `AIOPS_NODE_IP`、`AIOPS_MODEL_BASE_URL`、`AIOPS_MODEL_ID`、`AIOPS_DATA_DIR` 和可选的 `AIOPS_RCA_NAMESPACES`（默认 `privatization`）渲染节点访问地址、模型地址、模型标识、宿主机数据目录及巡检范围。单节点集群自动固定到该节点；多节点集群须指定保存数据的 `AIOPS_STORAGE_NODE`，并将镜像加载到该节点或推送到私有仓库后调整 `imagePullPolicy`。其他集群仍需按交付环境调整镜像名、NodePort 与命名空间。

此清单明确授予 Harness ServiceAccount `cluster-admin`，并显式启用 ServiceAccount token 自动挂载。安装脚本使用部署机已有的管理员 `kubectl` 上下文创建这些 Kubernetes 资源；Pod 启动后，Kubernetes 自动注入 API Server 地址、CA 证书和 ServiceAccount token。初始化容器生成指向这些自动注入文件的 kubeconfig（`tokenFile` 不复制 token 内容），Harness 与镜像内 Kubernetes MCP 共用它。因此部署完成后使用工作台无需再手工提供 kubeconfig。模型可使用 MCP、`kubectl`、`helm` 等工具；实际变更仍应由操作者在工作台明确指令。

清单把 Harness 的 `HOME` 设为 `/workspace`，Web 的“主目录”选择器因此直接从持久化目录打开。`/workspace` → 宿主机 `<AIOPS_DATA_DIR>/workspace`，`/data/dsh` → 宿主机 `<AIOPS_DATA_DIR>/data`；工作区、会话和设置在 Pod 重建后保留。`/root` 不挂载。登录账号和浏览器签名密钥保存在 Kubernetes Secret；`launch-token` 使用内存临时卷，因为它每次启动都会重新生成。

`hostPath` 是节点本地存储，清单通过 `nodeName` 固定到数据节点。Pod 重启与同节点重建会读取原数据；若数据节点故障，需恢复该节点的持久化目录后再启动，或改用现有共享存储/PVC。

## 自动根因巡检（MVP）

镜像内置 `rca/scan.mjs` 与 Harness Skill。部署初始化时复制到持久化的 `/workspace/aiops-rca/scan.mjs` 和 `/data/dsh/skills/aiops-root-cause-analysis/SKILL.md`。扫描使用 Pod 自带的 Kubernetes 身份，只读取指定命名空间的 Pod、Deployment、Event 和 Pod 日志；默认扫描 `privatization`，可通过 `AIOPS_RCA_NAMESPACES` 指定逗号分隔的命名空间。检查镜像拉取、启动循环、OOM、超过两分钟的 Pending 和 Deployment 副本不可用，并在标准输出给出结构化证据。正常扫描不写工作区，也不要求会话授权。

初始化容器运行 `seed/bootstrap.mjs`，在宿主机挂载的 `/data/dsh` 中只创建缺少的示例会话、工作区索引和每 15 分钟一次的“业务服务自动根因巡检”任务。前端会显示“运维案例”工作区，包含入门与镜像拉取失败两条演示会话；首次定时运行会在“巡检记录”工作区建立一条会话，后续结果持续追加。已有任务和用户会话不覆盖，重复安装不重复创建任务。任务提示词只读：`运行 node /workspace/aiops-rca/scan.mjs；若 healthy 简报；若 anomalies_found 根据事件和日志输出中文根因、置信度与缺失证据；不修复资源`。人工输入“检查故障”也可由同一 Skill 使用扫描脚本。

故障演练清单在 `rca/privatization-test.yaml`，仅供测试；会创建镜像拉取失败、容器启动退出、节点条件不匹配三个样例。不要把该清单加入生产安装流程。测试完成后可按清单删除样例资源。

## 知识库扩展

后续的应用清单、运维手册和知识库可通过 `cordis.patch.yml` 增加 MCP 客户端条目，或按 Harness 插件机制装入镜像。登录入口、集群权限和使用页不依赖知识库服务，接入时不需改动认证架构。建议为知识库设置明确来源、更新时间和应用范围，让回答能标出手册依据。
