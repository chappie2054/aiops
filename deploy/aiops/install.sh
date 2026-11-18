#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
image="aiops/deepseek-harness:custom-v8"
namespace="aiops-test"
archive="${script_dir}/deepseek-harness-custom-v8.tar.gz"

: "${AIOPS_NODE_IP:?请提供 AIOPS_NODE_IP（供浏览器访问的节点 IP）}"
: "${AIOPS_MODEL_BASE_URL:?请提供 AIOPS_MODEL_BASE_URL（OpenAI 兼容模型地址）}"
: "${AIOPS_MODEL_ID:?请提供 AIOPS_MODEL_ID（模型标识）}"
: "${AIOPS_DATA_DIR:?请提供 AIOPS_DATA_DIR（宿主机持久化目录）}"
AIOPS_RCA_NAMESPACES="${AIOPS_RCA_NAMESPACES:-privatization}"
[[ "${AIOPS_NODE_IP}" =~ ^[0-9.]+$ ]] || { echo 'AIOPS_NODE_IP 格式不正确' >&2; exit 1; }
[[ "${AIOPS_MODEL_BASE_URL}" =~ ^https?://[A-Za-z0-9._:/-]+$ ]] || { echo 'AIOPS_MODEL_BASE_URL 格式不正确' >&2; exit 1; }
[[ "${AIOPS_MODEL_ID}" =~ ^[A-Za-z0-9._-]+$ ]] || { echo 'AIOPS_MODEL_ID 格式不正确' >&2; exit 1; }
[[ "${AIOPS_DATA_DIR}" =~ ^/[A-Za-z0-9_./-]+$ ]] || { echo 'AIOPS_DATA_DIR 格式不正确' >&2; exit 1; }
[[ "${AIOPS_RCA_NAMESPACES}" =~ ^[a-z0-9-]+(,[a-z0-9-]+)*$ ]] || { echo 'AIOPS_RCA_NAMESPACES 格式不正确' >&2; exit 1; }
for tool in docker kubectl openssl; do command -v "${tool}" >/dev/null || { echo "缺少 ${tool}" >&2; exit 1; }; done
if [[ -z "${AIOPS_STORAGE_NODE:-}" ]]; then
  read -r -a nodes <<< "$(kubectl get nodes -o jsonpath='{.items[*].metadata.name}')"
  [[ "${#nodes[@]}" -eq 1 ]] || { echo '多节点集群请指定保存 hostPath 数据的 AIOPS_STORAGE_NODE' >&2; exit 1; }
  AIOPS_STORAGE_NODE="${nodes[0]}"
fi
[[ "${AIOPS_STORAGE_NODE}" =~ ^[a-zA-Z0-9.-]+$ ]] || { echo 'AIOPS_STORAGE_NODE 格式不正确' >&2; exit 1; }
manifest="$(mktemp)"
trap 'rm -f "${manifest}"' EXIT
sed -e "s|__AIOPS_NODE_IP__|${AIOPS_NODE_IP}|g" \
    -e "s|__AIOPS_MODEL_BASE_URL__|${AIOPS_MODEL_BASE_URL}|g" \
    -e "s|__AIOPS_MODEL_ID__|${AIOPS_MODEL_ID}|g" \
    -e "s|__AIOPS_DATA_DIR__|${AIOPS_DATA_DIR}|g" \
    -e "s|__AIOPS_RCA_NAMESPACES__|${AIOPS_RCA_NAMESPACES}|g" \
    -e "s|__AIOPS_STORAGE_NODE__|${AIOPS_STORAGE_NODE}|g" \
    "${script_dir}/harness.yaml" > "${manifest}"

if [[ -f "${archive}" ]]; then
  for tool in gzip sha256sum; do command -v "${tool}" >/dev/null || { echo "缺少 ${tool}" >&2; exit 1; }; done
  echo "320e3749b57d491ddfa01529e850cfbb92723591551ac4edd71277f6b081c814  ${archive}" | sha256sum -c -
  gzip -dc "${archive}" | docker load
fi
docker image inspect "${image}" >/dev/null
kubectl apply -f "${manifest}" --dry-run=client >/dev/null
kubectl get namespace "${namespace}" >/dev/null 2>&1 || kubectl create namespace "${namespace}"

if ! kubectl get secret deepseek-harness-login -n "${namespace}" >/dev/null 2>&1 || [[ "${AIOPS_ROTATE_LOGIN:-false}" == true ]]; then
  username="${AIOPS_USERNAME:-aiopsadmin}"
  password="${AIOPS_PASSWORD:-$(openssl rand -base64 24)}"
  [[ "${username}" =~ ^[A-Za-z0-9._-]+$ ]] || { echo '账号只能包含字母、数字、点、下划线和短横线' >&2; exit 1; }
  hash_output="$(printf '%s' "${password}" | docker run --rm -i "${image}" node -e 'const{randomBytes,scryptSync}=require("node:crypto");let p="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>p+=c);process.stdin.on("end",()=>{if(!p)process.exit(1);const s=randomBytes(24).toString("hex");console.log(s);console.log(scryptSync(p,s,64).toString("hex"))})')"
  salt="$(printf '%s\n' "${hash_output}" | sed -n '1p')"
  hash="$(printf '%s\n' "${hash_output}" | sed -n '2p')"
  session_key="$(openssl rand -hex 32)"
  kubectl create secret generic deepseek-harness-login -n "${namespace}" \
    --from-literal="username=${username}" --from-literal="salt=${salt}" --from-literal="hash=${hash}" --from-literal="sessionKey=${session_key}" \
    --dry-run=client -o yaml | kubectl apply -f -
  if [[ -z "${AIOPS_PASSWORD:-}" ]]; then
    printf '固定登录账号: %s\n生成的登录密码: %s\n请保存密码。\n' "${username}" "${password}"
  else
    printf '固定登录账号已设置: %s\n' "${username}"
  fi
  kubectl rollout restart deployment/deepseek-harness -n "${namespace}" >/dev/null 2>&1 || true
else
  echo '沿用现有固定登录账号和密码。'
  if [[ -z "$(kubectl get secret deepseek-harness-login -n "${namespace}" -o jsonpath='{.data.sessionKey}')" ]]; then
    session_key="$(openssl rand -hex 32)"
    kubectl patch secret deepseek-harness-login -n "${namespace}" --type merge -p "{\"stringData\":{\"sessionKey\":\"${session_key}\"}}" >/dev/null
  fi
fi

kubectl apply -f "${manifest}"
kubectl rollout status deployment/deepseek-harness -n "${namespace}" --timeout=240s

if ! kubectl get secret deepseek-harness-browser-session -n "${namespace}" >/dev/null 2>&1; then
  pod="$(kubectl get pod -n "${namespace}" -l app=deepseek-harness -o jsonpath='{.items[0].metadata.name}')"
  credentials="$(mktemp)"
  trap 'rm -f "${credentials}" "${manifest}"' EXIT
  kubectl cp "${namespace}/${pod}:/data/dsh/.credentials.yaml" "${credentials}" -c harness
  kubectl create secret generic deepseek-harness-browser-session -n "${namespace}" --from-file=".credentials.yaml=${credentials}"
fi
echo "入口: http://${AIOPS_NODE_IP}:31884/"
echo "使用说明: http://${AIOPS_NODE_IP}:31884/guide"
