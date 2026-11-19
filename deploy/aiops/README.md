# AIOps Kubernetes 运维工作台交付

交付目录包含一个完整镜像归档、`harness.yaml`、`install.sh` 和 `uninstall.sh`。镜像内置 Web 工作台、登录网关、Kubernetes MCP、kubectl、Helm、定时根因巡检及两个入门案例。浏览器入口为 `http://<节点 IP>:31884/`。

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

镜像归档 `deepseek-harness-custom-v12.tar.gz` 的 SHA-256 为 `2eed7d8f601e186a72480ea0b8df0b1a77dcc042ff90445aa9720523dbe75432`，安装脚本会在加载前校验。将归档、YAML 与脚本放在同一目录即可集成到现有安装包。安装机需要 Docker、kubectl、openssl；运行中的工作台不需要临时下载工具。

## 数据与卸载

`<AIOPS_DATA_DIR>/data` 保存会话、任务和设置；`<AIOPS_DATA_DIR>/workspace` 保存工作区文件。清单通过 `hostPath` 挂载，并将 Pod 固定到数据节点。Pod 在同一节点重建后继续使用原目录；跨节点迁移前需要转移数据或使用共享存储。

执行 `bash uninstall.sh` 会删除本产品的 Kubernetes 工作负载、入口、配置和登录 Secret。宿主机数据、命名空间与本地镜像默认保留，便于备份或再次安装。数据清理由负责该节点的运维人员单独确认。

## 构建

已验证的升级构建使用 `Dockerfile.rca-update` 和本地已加载的基础镜像 `aiops/deepseek-harness:custom-v2`。交付的完整镜像归档可直接安装，不要求目标环境具备基础镜像。`Dockerfile` 是独立构建入口；修改上游前端源码后，需要建立对应源码构建流程并做兼容验证。
