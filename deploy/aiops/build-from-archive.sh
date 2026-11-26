#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
archive="${1:?用法: build-from-archive.sh <v15 镜像归档> <amd64|arm64> <输出目录>}"
arch="${2:?请提供目标架构}"
output_dir="${3:?请提供输出目录}"
[[ "${arch}" == amd64 || "${arch}" == arm64 ]] || { echo '架构必须为 amd64 或 arm64' >&2; exit 1; }
[[ -f "${archive}" && -f "${archive}.sha256" ]] || { echo '缺少旧镜像归档或校验文件' >&2; exit 1; }
mkdir -p "${output_dir}"
(cd "$(dirname "${archive}")" && sha256sum -c "$(basename "${archive}").sha256")
loaded="$(docker load -i "${archive}" | sed -n 's/^Loaded image: //p' | tail -1)"
[[ -n "${loaded}" ]] || { echo '旧镜像归档没有可用标签' >&2; exit 1; }
docker tag "${loaded}" aiops/workbench:v15
docker build --pull=false -f "${script_dir}/Dockerfile.overlay" -t aiops/workbench:v16 "${script_dir}"
actual_arch="$(docker image inspect aiops/workbench:v16 --format '{{.Architecture}}')"
[[ "${actual_arch}" == "${arch}" ]] || { echo "构建架构不匹配: ${actual_arch}" >&2; exit 1; }

output="${output_dir}/aiops-workbench-v16-${arch}.tar.gz"
temporary="${output}.tmp"
trap 'rm -f "${temporary}"' EXIT
docker save aiops/workbench:v16 | gzip -1 > "${temporary}"
mv "${temporary}" "${output}"
(cd "${output_dir}" && sha256sum "$(basename "${output}")" > "$(basename "${output}").sha256")
echo "已构建 ${output}"
