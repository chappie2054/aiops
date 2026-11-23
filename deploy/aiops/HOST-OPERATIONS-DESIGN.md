# 宿主机管理与离线镜像发布设计（优先复用现成组件）

> **选型结论（2026-11-17）：本文件中的“高权限工具 Pod + 宿主机根目录挂载 + `kubectl exec`”仅是可行的测试实现，不应称为 Kubernetes 官方推荐的常态宿主机管理方案，也尚未获得交付选型确认。Kubernetes 官方 Pod Security Standards 的 Baseline/Restricted 均不允许 privileged/hostPath。正式方案建议改为私有镜像仓库（如 Harbor）分发业务镜像，由 Kubernetes 正常拉取和滚动发布；宿主机文件/命令需求单独采用 Ansible 通过 SSH 管理。**现有 Harness 与这些系统的前端集成仍需验证，不应宣称开箱即用。

> 2026-11-17 修订：第一版不开发 Node Agent，也不开发新的宿主机 MCP。以下“现成组件优先方案”替代本文后半部分原先的自研方案；原方案仅供以后需要专门产品化接口时参考。

## 现成组件优先方案

当前已集成的 [mcp-server-kubernetes](https://github.com/Flux159/mcp-server-kubernetes) 提供 `exec_in_pod`、`kubectl_generic`、`kubectl_apply`、`kubectl_patch` 和 `kubectl_rollout` 等能力。第一版直接复用它，经 Kubernetes API 操作节点上的工具 Pod；不再另写 MCP。工具 Pod 用 Kubernetes 官方 [DaemonSet](https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/) 在每个节点运行，使用现成基础镜像、挂载宿主机根目录到 `/host`，在需要时通过 `chroot /host` 调用该节点的 shell 和 Docker CLI。宿主机权限只给工具 Pod，不给 Harness Pod。

```text
Harness Web UI → 已有 Kubernetes MCP → Kubernetes API
                                  ├─ exec 到目标节点的工具 Pod → 浏览 /host、执行宿主机命令
                                  ├─ 在目标节点运行导入 Job → docker load、校验镜像
                                  └─ 更新 Deployment → 跟踪 rollout / 回滚
```

可直接做到的事：列节点、按 `spec.nodeName` 找工具 Pod、`ls/stat/find /host/...`、通过 `chroot /host /bin/sh -c ...` 执行宿主机命令，以及现有 MCP 的资源更新。导入较大镜像包用按节点指定的 Kubernetes Job，避免长时间的 `exec` 会话超时；Job 的状态和日志由现有 MCP 读取。镜像包须在目标节点可见；多节点可使用共享存储、私有镜像仓库，或在一键安装包中按节点分发。测试节点是单节点 Docker 20.10.5，可先验证 `docker load`。若以后客户节点用 containerd，导入命令及镜像命名空间需针对该运行时调整。

现成方案仍需编写和维护 **YAML、少量安装脚本、Harness 使用说明及验收测试**，但无需开发常驻 Agent 程序或新的 MCP 服务。第一版的节点文件浏览通过聊天工具调用呈现；如果要文件管理器式的图形界面、任务进度面板或强制的跨步骤发布事务，才需要追加前端或控制器开发。宿主机工具 Pod 具有管理员级能力，应只在明确授权的内部集群部署，且不开放公网端口。

**验收顺序：**先用单节点工具 Pod 验证看到的是 `10.100.90.199` 的宿主机文件和进程；再用测试镜像归档执行 Job 导入并检查 Docker 镜像；最后更新独立测试 Deployment 并核对新 Pod 镜像与回滚。通过这些实测后，才能把“满足需求”标为已交付。当前仅完成方案核对，尚未部署工具 Pod 和导入 Job。

---

## 后续可选的专用 Agent 方案

## 目标与现状

用户从 DeepSeek Harness Web UI 选择节点和宿主机镜像包，完成镜像导入、Deployment 更新、发布检查与必要的回滚；也能查看节点文件和执行明确指定的宿主机命令。交付物随现有一键安装包部署，不要求使用者再手动安装 kubectl、配置 kubeconfig 或登录每台节点。

**现状（2026-11-17）：**测试集群只有 `10.100.90.199` 一个节点，Kubernetes v1.22.17，容器运行时为 `docker://20.10.5`。现有 Harness 镜像已包含 Kubernetes MCP、kubectl、Helm；其 ServiceAccount 有集群管理员权限。Harness 可查询与修改 Deployment，但只能访问映射到 `/workspace`、`/data/dsh` 的宿主机目录；没有宿主机文件浏览、命令执行、`docker load` 工具。本文是下一版实现方案，**尚未部署 Node Agent**。

## 组件与职责

| 组件 | 来源 | 职责 |
| --- | --- | --- |
| DeepSeek Harness Web UI、固定账号网关 | 已有交付 | 会话入口、登录、展示工具调用和结果 |
| Kubernetes MCP | 已有交付 | 查询工作负载、更新 Deployment、检查 rollout 与回滚 |
| 宿主机 MCP 适配器 | 需开发并打入 Harness 镜像 | 将结构化工具调用转成节点操作；关联会话与任务 ID |
| Node Agent | 需开发为独立镜像 | 每个节点执行文件、命令、镜像操作，返回结构化结果 |
| DaemonSet | Kubernetes 官方资源 | 使目标节点各运行一个 Node Agent，节点增减时自动调整 |
| Job/任务记录 | Kubernetes 官方资源及自定义实现 | 长时间导入的进度、结果、重试和审计；避免聊天请求超时 |

Node Agent 不是 Kubernetes 官方组件。DaemonSet 是其部署方式。节点诊断可用官方 `kubectl debug node`，但它是临时调试入口，不提供产品所需的发布工作流。[DaemonSet 文档](https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/) · [节点调试文档](https://kubernetes.io/docs/tasks/debug/debug-cluster/kubectl-node-debug/)

```text
浏览器 → 登录网关 → Harness
                      ├─ Kubernetes MCP → Kubernetes API
                      └─ 宿主机 MCP → 节点任务控制器 → Node Agent DaemonSet
                                                   ├─ 节点文件系统
                                                   └─ Docker / containerd
```

不要把宿主机 `/` 或 Docker socket 直接挂到 Harness Pod。需要宿主机权限的容器只有 Node Agent；Harness 通过有身份校验的内部接口或 Kubernetes API 中的任务对象调用它。Node Agent 的访问范围和权限在 YAML 中定义，前端不直接连接节点端口。

## 工具接口

| 工具 | 输入 | 输出及限制 |
| --- | --- | --- |
| `host_list_nodes` | 无 | 节点名、运行时、Agent 就绪状态、磁盘余量 |
| `host_list_files` | 节点、绝对路径 | 文件名、类型、大小、修改时间；分页；路径解析后限制在授权目录 |
| `host_read_file` | 节点、路径、范围 | 文本预览或文件元信息；限制大小，二进制文件不直接塞进模型上下文 |
| `host_run_command` | 节点、命令/参数、超时 | 退出码、标准输出/错误、任务 ID；限制并发、执行时长和输出量，保留审计 |
| `host_import_image` | 节点集合、镜像包路径、预期摘要 | 每节点导入进度、导入后的镜像名与 digest；支持 Docker 和 containerd 后端 |
| `host_image_status` | 节点集合、镜像引用 | 各节点是否已有目标镜像及实际 digest |
| `release_deployment` | 命名空间、Deployment、容器、镜像、节点策略 | 先调用镜像校验，再经 Kubernetes API 更新、跟踪状态，记录旧镜像与回滚命令 |

命令执行应支持真正的宿主机 shell 环境，而非在 Harness 容器或业务 Pod 中执行。文件浏览与命令执行显示节点名，避免把容器路径误认为宿主机路径。默认授权目录可配置；管理员如需浏览完整宿主机文件系统，可在交付参数中开启。宿主机命令结果通过 Agent 返回，不要求预置 SSH 密钥。

## 离线镜像发布流程

1. 用户在 Web UI 指定命名空间、Deployment、容器、镜像包路径和目标镜像引用。系统读取 Deployment 当前镜像、调度约束及目标节点，展示变更计划。
2. Node Agent 对镜像包做存在性、大小、格式及 SHA-256 校验。测试单节点可直接选择 `/data/aiops-test/deepseek-harness/workspace` 中的文件；其它宿主机目录按 Agent 的授权路径浏览。
3. 在**所有可能运行该工作负载的节点**导入镜像。Docker 节点执行等价于 `docker load -i`；containerd 节点采用其 Kubernetes 使用的命名空间导入。每节点完成后检查镜像引用与 digest。若通过私有仓库分发，则改为推送/拉取流程。
4. 全部节点准备成功后，才更新 Deployment Pod 模板中的容器镜像，并跟踪 rollout。失败时保留旧镜像信息，提供 `rollout undo` 和逐节点结果；不能把“API 更新成功”报告为“发布成功”。
5. 对未推送私有仓库的本地镜像设置匹配的 `imagePullPolicy`，并约束新 Pod 只调度到已导入该镜像的节点；多节点默认优先全节点导入，避免漂移后出现 `ImagePullBackOff`。

Kubernetes 官方通过更新 Pod 模板镜像触发 Deployment 滚动发布；发布过程需另行检查结果。[Deployment 更新文档](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#updating-a-deployment)

## 交付与权限

- 一键包包含 Harness 镜像、Node Agent 镜像、各自的离线归档、YAML、配置模板和安装脚本。安装脚本校验归档摘要，导入到全部需要运行它们的节点，再应用资源并等待 Agent 和 Web UI 就绪。
- Node Agent 使用独立 ServiceAccount、DaemonSet、仅内部可达的通信入口；不对外开 NodePort。宿主机文件系统与运行时 socket 只挂入 Agent Pod。需要执行宿主机命令的 Agent 在该节点具有等效宿主机管理员能力，应与普通会话容器隔离。
- 固定登录账号继续沿用现有 Secret。对宿主机操作再记录操作者、会话、节点、参数、起止时间、退出码及变更前后状态。聊天模型提出的操作先展示目标与影响，用户明确下达执行指令后再运行。
- 运行时适配器先实现并实测本集群 Docker 20.10.5；再补 containerd。不可把 `docker load` 当作所有客户集群通用命令。
- 现有工作区 `hostPath` 在单节点可用；多节点的镜像包应通过节点 Agent 分发、共享存储或私有镜像仓库提供。会话数据仍需单独处理多节点持久化。

## 需求覆盖和验收

| 用户需求 | 方案 | 验收标准 |
| --- | --- | --- |
| 前端看宿主机文件 | `host_list_files` / `host_read_file` | 指定节点能看到宿主机授权目录，路径与节点名明确 |
| 前端运行宿主机命令 | `host_run_command` | 返回该节点真实主机名、退出码、输出和审计记录 |
| 导入本地镜像包 | `host_import_image` | 导入前后 digest 可核对，失败节点和原因可见 |
| 更新业务 Deployment | `release_deployment` + Kubernetes MCP | 目标 Pod 使用新镜像且 rollout 成功；失败可回滚 |
| 多节点发布 | Agent DaemonSet + 节点集合校验 | 所有可调度节点均有目标镜像，或工作负载被限制在已导入节点 |
| 一键私有化交付 | 离线双镜像 + YAML + 安装脚本 | 新环境只执行安装入口即可登录、查节点、完成一次测试发布 |
| 后续知识库接入 | 独立 MCP 扩展 | 不改变节点代理和发布链路 |

**实施顺序：**先完成单节点 Agent、宿主机浏览/命令、Docker 导入和测试 Deployment 发布闭环；再加多节点分发、containerd 适配及离线安装验收。测试用独立 Deployment 验证，不拿业务服务作为首次发布对象。
