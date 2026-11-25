#!/usr/bin/env bash
set -euo pipefail

namespace="${AIOPS_NAMESPACE:-aiops-test}"
[[ "${namespace}" =~ ^[a-z0-9-]+$ ]] || { echo 'AIOPS_NAMESPACE 格式不正确' >&2; exit 1; }
command -v kubectl >/dev/null || { echo '缺少 kubectl' >&2; exit 1; }
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "${script_dir}/uninstall-frontend-proxy.sh" ]]; then
  bash "${script_dir}/uninstall-frontend-proxy.sh"
fi

kubectl -n "${namespace}" delete deployment/deepseek-harness --ignore-not-found --wait=true
kubectl -n "${namespace}" delete service/deepseek-harness configmap/deepseek-harness-config configmap/aiops-gateway-overrides serviceaccount/deepseek-harness \
  secret/deepseek-harness-login secret/deepseek-harness-browser-session secret/aiops-model-api-key --ignore-not-found
kubectl delete clusterrolebinding/deepseek-harness-cluster-admin --ignore-not-found

echo 'AIOps 工作负载、入口、配置与登录 Secret 已卸载。'
echo '宿主机持久化数据目录、命名空间和本地镜像保留，便于重新安装或备份。'
if [[ -n "${AIOPS_DATA_DIR:-}" ]]; then printf '保留的数据目录: %s\n' "${AIOPS_DATA_DIR}"; fi
