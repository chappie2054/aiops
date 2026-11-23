# AIOps 单仓库维护说明

本 fork 是 AIOps 的唯一源码仓库。`origin` 指向内部仓库 `codeup.aliyun.com/62cf7f0b487c500c27f70f94/aiops`，`github` 指向 `chappie2054/aiops`（镜像），`upstream` 指向 `deepseek-ai/deepseek-harness`。仓库保存程序、部署清单、安装脚本、测试和运维手册；镜像归档、密码、Kubernetes Secret、会话数据、模型文件与宿主机日志不提交到 Git。

内部仓库不接受浅克隆推送（`shallow update not allowed`）。在这台机器上首次同步前先补全历史：`git fetch --unshallow github`，然后用 `git push origin master` 推送到内部仓库；GitHub 镜像用 `git push github master`。

## 当前代码与部署的关系

| 位置 | 责任 | 当前状态 |
| --- | --- | --- |
| `apps/web/` | Harness 原版 Web 前端；深度定制时在此开发 | 当前 AIOps 未修改 |
| `deploy/aiops/` | 固定账号网关、中文使用页、Kubernetes 配置、镜像与一键安装入口 | AIOps 当前定制源码 |
| `packages/` | Harness 原有插件与 MCP 客户端 | 当前 AIOps 未修改 |
| `deploy/aiops/runbooks/`（规划） | 应用管理与运维手册 | 后续按业务版本增加 |

当前测试镜像 `aiops/deepseek-harness:custom-v2` 使用官方发布的 Harness `0.2.2-rc.1` 包，并加入本目录的网关、MCP、kubectl 和 Helm。它**不是**从本 fork 的 `apps/`、`packages/` 源码编译的。`Dockerfile.cached-base` 还依赖测试环境已有的基础镜像及本地提供的二进制文件；仅克隆仓库不能重复构建这条路径。`Dockerfile` 可独立下载官方发布包，但其完整构建尚未在当前环境验证。修改 Harness 前端或核心后，需要另建并验证源码构建流程，才能让改动进入交付镜像。

后续自有 MCP 实现优先放在 `deploy/aiops/mcp/` 等独立目录，按 Harness MCP 客户端配置接入。若必须调用 Harness 内部 API，再按其插件规范添加 workspace package。应用运维手册可放在 `deploy/aiops/runbooks/`，与版本一同维护；运行时知识检索、索引和数据更新机制需要单独实现与验收。现有 Kubernetes MCP 可管理集群资源；宿主机 `docker load` 的完整发布流程仍需单独完成测试。

## 合并官方更新

在干净工作树上运行：

```bash
git fetch upstream
git switch master
git merge upstream/master
```

解决冲突后运行受影响部分的测试和构建，再构建 AIOps 镜像、验证登录与 Kubernetes 工具，最后推送 `origin/master`。每次合并前先看官方升级说明；Harness 目前属于开发预览，接口可能发生不兼容变更。优先把自有功能留在 `deploy/aiops/`，确实需要修改原版 Web 或插件时再改 `apps/`、`packages/`，并验证上游合并冲突。

## 发布边界

ARM64 交付镜像在目标节点上原生构建后发布到 `registry-szzn-registry.cn-hangzhou.cr.aliyuncs.com/tools/aiops-workbench`，标签同时包含交付版本号和提交短 SHA。Git 提交标识源码版本；镜像标签应包含该提交的短 SHA。CI 或打包机从该提交构建镜像，把镜像归档与 `harness.yaml`、`install.sh`、校验文件组成离线安装包。安装时由外部注入登录密码，不把密码写入 Git、镜像或 YAML。当前 `custom-v2` 是已验证的测试版本；源码构建与自动发布流程尚未接入，因此不能把它称作从本 fork 可复现的一键构建。
