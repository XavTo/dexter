#!/usr/bin/env bash
set -euo pipefail

: "${DEXTER_QUERY:?DEXTER_QUERY doit être défini}"

# Tente d'envoyer la requête à l'entrée interactive.
# Si Dexter redemande des infos, ce mode peut nécessiter une adaptation du code.
printf "%s\n" "$DEXTER_QUERY" | bun start
