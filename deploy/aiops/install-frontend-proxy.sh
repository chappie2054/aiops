#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
namespace=privatization
deployment=dep-court-fe
snippet="${script_dir}/frontend-location.conf"
[[ -s "${snippet}" ]] || { echo "缺少 AIOps 前端代理规则: ${snippet}" >&2; exit 1; }
kubectl rollout status deployment/"${deployment}" -n "${namespace}" --timeout=300s
if kubectl get deployment "${deployment}" -n "${namespace}" -o jsonpath='{.spec.template.spec.volumes[*].name}' | grep -qw aiops-nginx; then
  # Remove the old mount first so a repeat install reads nginx.conf from the
  # currently deployed frontend image, including any frontend image upgrade.
  bash "${script_dir}/uninstall-frontend-proxy.sh"
fi
pod="$(kubectl get pod -n "${namespace}" -l app="${deployment}" -o jsonpath='{.items[0].metadata.name}')"
[[ -n "${pod}" ]] || { echo '找不到 dep-court-fe Pod' >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
kubectl exec -n "${namespace}" "${pod}" -- cat /etc/nginx/nginx.conf > "${work}/original.conf"
if grep -Fq 'location ^~ /K7vQ2mT9xR4pL8nC5sH3yW6d/' "${work}/original.conf"; then
  cp "${work}/original.conf" "${work}/nginx.conf"
else
  awk -v snippet="${snippet}" '
    /server_name[[:space:]]+_;[[:space:]]*$/ && !inserted {
      print
      while ((getline line < snippet) > 0) { print line; lines++ }
      close(snippet)
      inserted = 1
      next
    }
    { print }
    END { if (!inserted || !lines) exit 2 }
  ' "${work}/original.conf" > "${work}/nginx.conf" || { echo '前端 Nginx 配置中找不到 server_name _;，未修改 Deployment' >&2; exit 1; }
fi

kubectl exec -i -n "${namespace}" "${pod}" -- sh -c 'cat > /tmp/aiops-nginx-check.conf' < "${work}/nginx.conf"
kubectl exec -n "${namespace}" "${pod}" -- nginx -t -c /tmp/aiops-nginx-check.conf
kubectl create configmap aiops-court-nginx -n "${namespace}" --from-file="${work}/nginx.conf" --dry-run=client -o yaml | kubectl apply -f -

cat > "${work}/patch.yaml" <<'EOF'
spec:
  template:
    spec:
      containers:
        - name: dep-court-fe
          volumeMounts:
            - name: aiops-nginx
              mountPath: /etc/nginx/nginx.conf
              subPath: nginx.conf
              readOnly: true
      volumes:
        - name: aiops-nginx
          configMap:
            name: aiops-court-nginx
EOF
kubectl patch deployment "${deployment}" -n "${namespace}" --type=strategic --patch-file="${work}/patch.yaml"
kubectl rollout restart deployment/"${deployment}" -n "${namespace}" >/dev/null
kubectl rollout status deployment/"${deployment}" -n "${namespace}" --timeout=300s
echo "AIOps 前端入口已启用: /K7vQ2mT9xR4pL8nC5sH3yW6d/"
