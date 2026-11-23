# AIOps Kubernetes 运维工作台交付

交付目录包含按架构划分的完整镜像归档、`harness.yaml`、`install.sh` 和 `uninstall.sh`。镜像内置 Web 工作台、登录网关、Kubernetes MCP、kubectl、Helm、定时根因巡检及两个入门案例。浏览器入口为 `http://<节点 IP>:31884/`。

## 安装与模型配置

安装脚本通过环境变量接收参数，不会交互提问。调用示例：

```bash
cd deploy/aiops
AIOPS_NODE_IP='<浏览器访问的节点 IP>' \
AIOPS_MODEL_BASE_URL='<OpenAI 兼容接口的基础 URL>' \
AIOPS_MODEL_ID='<模型列表返回的 ID>' \
AIOPS_DATA_DIR='<宿主机持久化绝对路径>' \
bash install.sh
```

上面四项必填。模型 URL 应指向兼容接口的基础路径，通常以 `/v1` 结尾；模型 ID 对应其 `/models` 返回值。当前交付配置适用于无需 API Key 的兼容接口。可选参数有 `AIOPS_RCA_NAMESPACES`（逗号分隔的巡检命名空间）、`AIOPS_STORAGE_NODE`（多节点集群的数据节点）、`AIOPS_USERNAME` 和 `AIOPS_PASSWORD`（安装时配置登录账号）。安装脚本复用已有登录配置；需要主动更新时指定 `AIOPS_ROTATE_LOGIN=true`。调整模型地址或 ID 后重新运行安装脚本即可更新集群 ConfigMap。

私有化交付不依赖镜像仓库：`install.sh` 默认用 `docker load -i` 导入交付包里的归档，按架构选择 `aiops-workbench-v15-<arch>.tar.gz`（`arch` 取 `amd64` 或 `arm64`），归档必须带同名 `.sha256`，缺失或校验失败会直接退出。导入后的镜像标签是 `aiops/workbench:v15`，清单使用 `imagePullPolicy: Never`，节点既不访问也不需要镜像仓库。用 `AIOPS_IMAGE` 可以改镜像标签，用 `AIOPS_IMAGE_ARCHIVE` 可以指定归档路径。只有显式设置 `AIOPS_PULL=true` 时才从 `AIOPS_IMAGE` 指向的仓库拉取，这时清单改用 `IfNotPresent`。多节点集群要把归档导入 Pod 实际所在的节点。安装机需要 Docker、kubectl、openssl；运行中的工作台不需要临时下载工具。

## 数据与卸载

`<AIOPS_DATA_DIR>/data` 保存会话、任务和设置；`<AIOPS_DATA_DIR>/workspace` 保存工作区文件。清单通过 `hostPath` 挂载，并将 Pod 固定到数据节点。Pod 在同一节点重建后继续使用原目录；跨节点迁移前需要转移数据或使用共享存储。

执行 `bash uninstall.sh` 会删除本产品的 Kubernetes 工作负载、入口、配置和登录 Secret。宿主机数据、命名空间与本地镜像默认保留，便于备份或再次安装。数据清理由负责该节点的运维人员单独确认。

## 构建

交付的完整镜像归档可直接安装，不要求目标环境具备构建基础镜像。`Dockerfile.rca-update` 是当前的增量构建入口，依赖构建环境已有的基础镜像；`Dockerfile` 是独立构建入口。修改上游前端源码后，需要建立对应源码构建流程并做兼容验证。

ARM64 交付镜像用 `Dockerfile.arm64` 在 arm64 节点上原生构建：`docker build -f Dockerfile.arm64 -t aiops/workbench:v15 .`。构建上下文需要带 `kubectl` 和 `helm`（本环境的节点访问不了 `dl.k8s.io`，直接从已部署镜像里取这两个二进制）。ARM64 与 amd64 两个架构分别构建后用多架构清单发布到同一个 `v15` 标签。

Alpine 上的 koffi 3.1.1 会优先解析 `@koromix/koffi-<platform>` 包，而该包的入口是 glibc 产物；在 musl 下加载它会抛 `std::system_error` 并中止进程，表现为 harness 容器每次创建会话时 `terminate called after throwing an instance of 'std::system_error'`。`Dockerfile` 和 `Dockerfile.arm64` 因此把 musl 产物覆盖到 glibc 路径，并以能否 `require` koffi 作为构建门禁；缺这一步的镜像会在第一次创建会话时退出，而不是启动时报错。

## 相关文档

- [DEVELOPMENT.md](DEVELOPMENT.md)：分支与提交规范、两种架构的构建流程、本地启动开发与验证清单。
- [REPOSITORY.md](REPOSITORY.md)：仓库职责、上游合并方式与发布边界。
