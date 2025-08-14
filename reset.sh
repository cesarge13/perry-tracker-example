#!/bin/bash

# ./reset.sh --dry-run - Muestra qué se borraría sin borrar nada
# ./reset.sh - Limpia cachés y archivos temporales sin borrar tu código


# ./reset.sh --deep npm install - Limpia profundomente (incluye dependencias, node_modules y lock files)

echo "🧹 Limpiando artefactos temporales..."

# Listas de archivos/carpeta
BASIC_CLEAN=(
  ".vscode"
  ".idea"
  "db.sqlite"
  ".DS_Store"
  "npm-debug.log*"
  "yarn-debug.log*"
  "pnpm-debug.log*"
)

DEEP_CLEAN=(
  "node_modules"
  "package-lock.json"
  "pnpm-lock.yaml"
  "yarn.lock"
)

# Función para mostrar qué se borraría
dry_run() {
  echo "🔍 Archivos/carpetas que se eliminarían:"
  for item in "${BASIC_CLEAN[@]}"; do
    echo " - $item"
  done
  if [ "$1" == "--deep" ]; then
    for item in "${DEEP_CLEAN[@]}"; do
      echo " - $item"
    done
  fi
}

# Función para limpiar
clean_now() {
  echo "🧹 Limpiando artefactos temporales..."
  for item in "${BASIC_CLEAN[@]}"; do
    rm -rf $item
  done
  if [ "$1" == "--deep" ]; then
    echo "🧹 Limpieza profunda activada (--deep)"
    for item in "${DEEP_CLEAN[@]}"; do
      rm -rf $item
    done
  fi
  echo "✅ Limpieza completada."
}

# Modo DRY RUN
if [ "$1" == "--dry-run" ]; then
  dry_run $2
  exit 0
fi

# Ejecución normal
clean_now $1