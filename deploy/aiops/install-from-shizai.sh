#!/usr/bin/env bash
# Called by shizai-Install-dep/main.sh after the Kubernetes and business workloads are installed.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${MasterIP:?主安装脚本需要传入 MasterIP}"
: "${AppDir:?主安装脚本需要传入 AppDir}"
[[ -f "${script_dir}/install.sh" && -f "${script_dir}/harness.yaml" ]] || {
  echo "AIOps 交付目录缺少 install.sh 或 harness.yaml: ${script_dir}" >&2
  exit 1
}

export AIOPS_NODE_IP="${AIOPS_NODE_IP:-${outsideip:-${MasterIP}}}"
export AIOPS_DATA_DIR="${AIOPS_DATA_DIR:-${AppDir%/}/aiops}"
export AIOPS_RCA_NAMESPACES="${AIOPS_RCA_NAMESPACES:-privatization}"

if [[ -z "${AIOPS_MODEL_BASE_URL:-}" ]]; then
  [[ -t 0 ]] || { echo '请通过 AIOPS_MODEL_BASE_URL 提供模型接口地址' >&2; exit 1; }
  read -r -p 'AIOps 模型接口基础 URL（通常以 /v1 结尾）: ' AIOPS_MODEL_BASE_URL
  export AIOPS_MODEL_BASE_URL
fi
if [[ -z "${AIOPS_MODEL_ID:-}" ]]; then
  [[ -t 0 ]] || { echo '请通过 AIOPS_MODEL_ID 提供模型 ID' >&2; exit 1; }
  read -r -p 'AIOps 模型 ID: ' AIOPS_MODEL_ID
  export AIOPS_MODEL_ID
fi
: "${AIOPS_MODEL_BASE_URL:?模型接口地址不能为空}"
: "${AIOPS_MODEL_ID:?模型 ID 不能为空}"

# The main installer loads images on its first master. Pin hostPath and the AIOps Pod
# to that node, including in the three-master deployment mode.
if [[ -z "${AIOPS_STORAGE_NODE:-}" ]]; then
  AIOPS_STORAGE_NODE="$(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.addresses[?(@.type=="InternalIP")].address}{"\n"}{end}' | awk -v ip="${MasterIP}" '$2 == ip { print $1 }')"
  [[ -n "${AIOPS_STORAGE_NODE}" && "${AIOPS_STORAGE_NODE}" != *$'\n'* ]] || {
    echo "无法从集群节点 InternalIP 唯一匹配主节点 ${MasterIP}；请设置 AIOPS_STORAGE_NODE" >&2
    exit 1
  }
  export AIOPS_STORAGE_NODE
fi

echo "安装 AIOps：访问地址 ${AIOPS_NODE_IP}:31884，数据目录 ${AIOPS_DATA_DIR}，节点 ${AIOPS_STORAGE_NODE}"
bash "${script_dir}/install.sh"
