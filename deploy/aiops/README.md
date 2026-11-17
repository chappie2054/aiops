# 私有化 Kubernetes 运维工作台

本目录的源码归属和上游合并方式见 [单仓库维护说明](REPOSITORY.md)。当前交付镜像使用官方 Harness 发布包，并未从本 fork 的前端和核心源码构建；因此修改 `apps/web/` 后还需建立源码构建流程，改动才会进入镜像。

此目录是 DeepSeek Harness 的独立交付入口。一个镜像同时运行原版 Harness、固定账号登录网关和通过 stdio 启动的 Kubernetes MCP；`harness.yaml` 包含 Namespace、集群管理员 ServiceAccount、模型与 MCP 配置、Deployment 和 NodePort Service。无需现有 HolmesGPT MCP 服务，也无需 Pod 启动时下载 kubectl 或 MCP 包。

## 构建与安装

```bash
docker build -t aiops/deepseek-harness:custom-v2 deploy/aiops
docker save aiops/deepseek-harness:custom-v2 | gzip > deploy/aiops/deepseek-harness-custom-v2.tar.gz
cd deploy/aiops
AIOPS_NODE_IP='<节点访问地址>' \
AIOPS_MODEL_BASE_URL='<内部模型的 OpenAI 兼容地址>' \
AIOPS_MODEL_ID='<模型标识>' \
AIOPS_DATA_DIR='<宿主机数据目录>' \
AIOPS_USERNAME=aiopsadmin AIOPS_PASSWORD='<由一键安装配置注入的固定密码>' bash install.sh
```

本次已构建的离线包 SHA-256 为 `cc6486a4c6126e7e21bc523793c182fa0be77c96461555cf8252f39791040cf1`；`install.sh` 在加载前会校验。自行重新构建镜像时需同步更新脚本中的校验值。

在已安装旧版基础镜像的测试节点，也可以先把该节点现有的 `kubectl`、`helm` 复制到构建目录，再用 `Dockerfile.cached-base` 构建。此方式避免重新下载 Harness 包；产出的 `custom-v2` 镜像仍是单个完整镜像。

本次已验证的离线镜像采用 `Dockerfile.cached-base` 构建，内含 Harness `0.2.2-rc.1`、测试集群匹配的 kubectl `1.22.17`、Helm `3.3.4` 和 Kubernetes MCP `4.2.1`。本地上游源码当前为 `0.2.2-rc.3`；后续改 Harness 核心时再从源码构建并重新做兼容验证。`Dockerfile` 提供不依赖旧镜像的独立构建方式，本次未跑通它的完整外网依赖下载流程。

Kubernetes MCP 通过镜像中的本地 stdio 进程连接 Harness，公开 `kubectl_get`、`kubectl_logs`、`kubectl_patch`、`kubectl_rollout`、Helm 等工具；它复用 Harness ServiceAccount 的集群管理员权限。旧的 HolmesGPT、Open WebUI 和两套独立 Holmes MCP 已从测试集群下线。`custom-v1` 只有命令行工具，没有集成 Kubernetes MCP；新交付使用 `custom-v2`。

如果不传 `AIOPS_PASSWORD`，首次安装时脚本生成并输出一次随机密码。已有 `deepseek-harness-login` Secret 时默认沿用原账号密码；只有显式设置 `AIOPS_ROTATE_LOGIN=true` 才按传入账号密码轮换，且旧登录态随之失效。账号密码不写入镜像或 YAML，安装脚本用 scrypt 哈希和随机盐创建 Secret。安装脚本可以直接集成到现有一键部署流程。镜像已包含 Harness、Kubernetes MCP、kubectl、Helm、jq、bash、curl、git 和 SSH 客户端。离线安装时把镜像压缩包与 YAML、脚本放在一起；安装节点需有 Docker 与 kubectl，工作负载运行时不需要外网。

入口是 `http://<AIOPS_NODE_IP>:31884/`。中文登录页使用固定账号密码，首次登录显示使用说明，后续也可访问 `/guide`。原版 Harness Web UI 在同一入口。登录网关自动衔接 Harness 重启时生成的新浏览器 token，用户无需获取 token。密码以 scrypt 哈希保存在 Kubernetes Secret；登录态签名密钥也保存在 Secret，Harness 容器不接收登录凭据。当前 HTTP NodePort 仅适用于隔离测试网，正式交付应通过独立 TLS 入口访问。

## 调整交付参数

安装脚本通过 `AIOPS_NODE_IP`、`AIOPS_MODEL_BASE_URL`、`AIOPS_MODEL_ID`、`AIOPS_DATA_DIR` 渲染节点访问地址、模型地址、模型标识及宿主机数据目录。其他集群仍需按交付环境调整镜像名、NodePort 与命名空间。多节点集群须将镜像导入每个可能调度的节点，或推送到私有仓库并调整 `imagePullPolicy`。

此清单明确授予 Harness ServiceAccount `cluster-admin`，并显式启用 ServiceAccount token 自动挂载。安装脚本使用部署机已有的管理员 `kubectl` 上下文创建这些 Kubernetes 资源；Pod 启动后，Kubernetes 自动注入 API Server 地址、CA 证书和 ServiceAccount token。初始化容器生成指向这些自动注入文件的 kubeconfig（`tokenFile` 不复制 token 内容），Harness 与镜像内 Kubernetes MCP 共用它。因此部署完成后使用工作台无需再手工提供 kubeconfig。模型可使用 MCP、`kubectl`、`helm` 等工具；实际变更仍应由操作者在工作台明确指令。

清单把 Harness 的 `HOME` 设为 `/workspace`，Web 的“主目录”选择器因此直接从持久化目录打开。`/workspace` → 宿主机 `<AIOPS_DATA_DIR>/workspace`，`/data/dsh` → 宿主机 `<AIOPS_DATA_DIR>/data`；工作区、会话和设置在 Pod 重建后保留。`/root` 不挂载。登录账号和浏览器签名密钥保存在 Kubernetes Secret；`launch-token` 使用内存临时卷，因为它每次启动都会重新生成。

`hostPath` 是节点本地存储。测试集群只有一个节点；多节点私有化集群应把 Pod 固定在持有数据的节点，或改用现有共享存储/PVC，避免调度到其他节点后看不到原工作区。

## 知识库扩展

后续的应用清单、运维手册和知识库可通过 `cordis.patch.yml` 增加 MCP 客户端条目，或按 Harness 插件机制装入镜像。登录入口、集群权限和使用页不依赖知识库服务，接入时不需改动认证架构。建议为知识库设置明确来源、更新时间和应用范围，让回答能标出手册依据。
