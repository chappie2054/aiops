# 镜像拉取失败案例

这是模拟案例，不代表当前集群状态。

**现象：** Deployment 期望 2 个副本，但 Pod 长时间处于 `ImagePullBackOff`，可用副本为 0。

**已确认事实：** Pod 的容器状态显示等待镜像；事件中出现 `Failed to pull image`；业务容器尚未启动，因此没有业务日志。

**疑似根因：** 镜像地址错误、仓库不可达，或节点缺少仓库凭证。仅凭 `ImagePullBackOff` 无法区分三者。

**下一步：** 查看完整事件消息、Deployment 镜像字段、节点到仓库的网络连通性和 `imagePullSecrets`。确认根因后，再由操作人员决定是否更新镜像或仓库配置。
