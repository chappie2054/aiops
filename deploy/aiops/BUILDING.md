# AIOps 交付与开发说明

本页保存安装参数、镜像构建和仓库协作细节。产品功能与界面见[项目首页](../../README.md)。

## 一键安装参数

### 并入高级运管平台主安装脚本

将本交付目录完整复制为 shizai-Install-dep/aiops/，与主脚本 main.sh 同属一个工作目录。目录内应包含 install-from-shizai.sh、install.sh、harness.yaml、amd64、arm64 两份镜像归档及各自同名的 .sha256 文件。

主脚本读入 NodeCount 后，增加默认安装的选择项：

```bash
read -r -p '是否安装 AIOps 运维工作台？[Y/n] ' InstallAIOps
case "${InstallAIOps:-Y}" in
  [Yy]|[Yy][Ee][Ss]) InstallAIOps=1 ;;
  [Nn]|[Nn][Oo]) InstallAIOps=0 ;;
  *) echo '请输入 y 或 n' >&2; exit 1 ;;
esac
```

在 main.sh 最后的单机 / 高可用分支结束后追加以下代码。原脚本的无效 NodeCount 分支也应改为 exit 1，避免没有建成集群却继续安装 AIOps：

```bash
if [ "$InstallAIOps" -eq 1 ]; then
  export MasterIP outsideip AppDir
  bash "$WorkDir/aiops/install-from-shizai.sh" || exit 1
fi
```

适配脚本复用主脚本的 outsideip 作为 Web 访问 IP，复用 AppDir 建立 AppDir/aiops 宿主机持久化目录，并按 MasterIP 在集群中找到主节点；单机和高可用模式都把 Pod 与数据固定在该节点，AIOps 安装脚本会在该节点导入镜像。巡检命名空间默认为 privatization。模型接口 URL 和模型 ID 无法从现有 suanfaip 推导，安装 AIOps 时会单独提示；也可在启动 main.sh 前设置 AIOPS_MODEL_BASE_URL、AIOPS_MODEL_ID，实现非交互安装。模型 API Key 可选：免密接口在提示时直接回车；需要鉴权时输入或预设 AIOPS_MODEL_API_KEY。其他 AIOPS_* 参数仍可预先通过环境变量覆盖。首次安装若不指定 AIOPS_PASSWORD，安装脚本会生成并打印密码，请保存安装输出。跳过 AIOps 不会调用交付目录中的任何脚本。

若显式设置 AIOPS_STORAGE_NODE 为其他节点，必须先在该节点导入相同镜像并准备持久化目录。NodePort 31884 需在访问路径上放通，且不得与现有服务冲突。首次集成先在与正式部署相同架构的测试节点验收登录、Pod 就绪、巡检任务和 Pod 重建后的数据保留。

安装机需要 Docker、kubectl、openssl、sha256sum 和可用的集群管理员 kubeconfig。`install.sh`、`harness.yaml`、双架构镜像归档及各自同名 `.sha256` 文件应放在同一目录；运行时按节点架构选择归档。

| 变量 | 要求 | 说明 |
| --- | --- | --- |
| `AIOPS_NODE_IP` | 必填 | 浏览器访问的节点 IP，入口使用 NodePort `31884` |
| `AIOPS_MODEL_BASE_URL` | 必填 | 内部 OpenAI 兼容模型接口基础 URL，通常以 `/v1` 结尾 |
| `AIOPS_MODEL_ID` | 必填 | 模型 ID，应与接口 `/models` 返回值一致 |
| `AIOPS_MODEL_API_KEY` | 可选 | 模型接口密钥；免密接口留空。首次安装写入 Kubernetes Secret，重装时未提供新值则保留原值 |
| `AIOPS_DATA_DIR` | 必填 | 宿主机持久化目录；下设 `data`、`workspace` |
| `AIOPS_RCA_NAMESPACES` | 建议显式指定 | 逗号分隔的巡检命名空间；未传时沿用测试环境默认值 |
| `AIOPS_STORAGE_NODE` | 多节点必填 | 保存 hostPath 的节点名，镜像也须加载在该节点 |
| `AIOPS_USERNAME`、`AIOPS_PASSWORD` | 首次安装可选 | 固定登录账号；不传密码时脚本生成并打印 |
| `AIOPS_ROTATE_LOGIN` | 可选 | 设为 `true` 时更新登录账号与密码 |
| `AIOPS_IMAGE` | 可选 | 覆盖默认镜像标签 `aiops/workbench:v15` |
| `AIOPS_IMAGE_ARCHIVE` | 可选 | 指定镜像归档路径 |
| `AIOPS_PULL` | 可选 | 仅设为 `true` 时允许从镜像仓库拉取 |

交付包内有归档时，脚本先校验并加载归档，即使本机已有同名镜像也会更新；没有归档时才使用本机已有镜像，最后才考虑显式允许的仓库拉取。归档按架构命名 `aiops-workbench-v15-<arch>.tar.gz`，由 `uname -m` 自动选择；加载前校验 `.sha256`。模型密钥保存在 `aiops-model-api-key` Secret 中，Pod 通过环境变量读取；更新密钥后安装脚本会重启工作台。默认清单使用 `imagePullPolicy: Never`，目标节点不需要镜像仓库。卸载脚本保留宿主机持久化目录、命名空间与本地镜像。

## 构建与验收镜像

| 构建入口 | 适用情况 |
| --- | --- |
| `Dockerfile` | 构建机可访问 kubectl 和 Helm 官方下载源 |
| `Dockerfile.arm64` | ARM 构建机已将对应架构的 `kubectl`、`helm` 放入构建上下文 |

构建上下文包含 `Dockerfile*`、`gateway.mjs`、`launcher.mjs`、`hash-password.mjs`、`guide.html`、`login.html`、`brand.*`、`favicon.svg`、`rca/` 和 `seed/`。`Dockerfile.arm64` 还需上述两个 ARM 二进制。`Dockerfile.rca-update` 和 `Dockerfile.cached-base` 是测试环境增量构建入口，不用于完整交付。

```sh
docker build -f Dockerfile -t aiops/workbench:v15 .
docker build -f Dockerfile.arm64 -t aiops/workbench:v15 .  # 仅在 arm64 构建机执行

docker run --rm --entrypoint node aiops/workbench:v15 \
  -e 'console.log(require("/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/koffi").version)'

docker save aiops/workbench:v15 | gzip > aiops-workbench-v15-<arch>.tar.gz
sha256sum aiops-workbench-v15-<arch>.tar.gz > aiops-workbench-v15-<arch>.tar.gz.sha256
```

镜像构建会修正 Alpine musl 环境下 koffi 的二进制加载路径，并在构建时测试 `require('koffi')`。这项检查不能省略：路径错误时工作台可能在创建会话时退出。发布前还应验证 `dsh web` 可监听、能新建会话；部署后检查 Pod `2/2 Running`、登录入口、持久化目录和巡检任务回执。

## 本地开发

源码开发需要 Node.js ≥ 24.9 和 pnpm。`apps/`、`packages/` 保存底层项目源码；交付定制主要位于 `deploy/aiops/`。当前交付镜像使用发布包叠加定制文件，未从本仓库的前端源码编译，因此修改 `apps/`、`packages/` 后必须建立并验证对应的源码构建流程，才能进入交付镜像。

```sh
pnpm install
pnpm run dev:web
pnpm run typecheck
pnpm run test
pnpm run lint
```

`dev:web` 会构建产物再启动本地 Web；默认地址为 `http://127.0.0.1:3080`。私有化模型连接以 Kubernetes 清单为准，凭据、镜像归档、Secret 和会话数据不提交到 Git。

## 分支与远程仓库

`master` 为受保护的交付基线。改动在 `feat/`、`fix/`、`docs/` 等分支上提交，走合并请求；提交信息使用 `<type>(<scope>): <subject>`，正文说明影响与验证。

| 远程名 | 用途 |
| --- | --- |
| `origin` | Codeup 内部仓库，交付来源 |
| `github` | GitHub 同步仓库 |
| `upstream` | 底层项目上游，只用于获取更新 |

```sh
git push origin <branch>
git push github <branch>
```

内部仓库不接受浅克隆更新；若出现 `shallow update not allowed`，先补全仓库历史。合并上游代码时，在独立分支拉取 `upstream` 并验证构建、测试及交付镜像，再提交合并请求。
