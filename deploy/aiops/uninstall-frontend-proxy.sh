#!/usr/bin/env bash
set -euo pipefail

namespace=privatization
deployment=dep-court-fe
if ! kubectl get deployment "${deployment}" -n "${namespace}" >/dev/null 2>&1; then
  exit 0
fi
if ! kubectl get deployment "${deployment}" -n "${namespace}" -o jsonpath='{.spec.template.spec.volumes[*].name}' | grep -qw aiops-nginx; then
  kubectl delete configmap aiops-court-nginx -n "${namespace}" --ignore-not-found
  exit 0
fi

patch="$(mktemp)"
trap 'rm -f "${patch}"' EXIT
cat > "${patch}" <<'EOF'
spec:
  template:
    spec:
      containers:
        - name: dep-court-fe
          volumeMounts:
            - mountPath: /etc/nginx/nginx.conf
              $patch: delete
      volumes:
        - name: aiops-nginx
          $patch: delete
EOF
kubectl patch deployment "${deployment}" -n "${namespace}" --type=strategic --patch-file="${patch}"
kubectl rollout status deployment/"${deployment}" -n "${namespace}" --timeout=300s
kubectl delete configmap aiops-court-nginx -n "${namespace}" --ignore-not-found
echo 'AIOps 前端代理已移除，dep-court-fe 恢复镜像内原始 Nginx 配置。'
