# Bash 5.3 syntax specimen. This file is data and must never be executed.
plain='single quoted text'
quoted="double: ${plain} and \"escaped\""
ansi=$'tab:\t snowman:\u2603'
integer=0x2A
numbers=(1 2 3 4)
total=$((integer + numbers[0]))
(( total += 2 ))
paths=(src/{main,test}/*.sh)
output=/dev/null
printf '%s\n' "$total" > "$output"
declare -A labels=([ready]=yes [waiting]=no)

summarize() {
  local value=${1:-unknown}
  local rest=${value#*-}
  printf '%s:%q\n' "$value" "$rest"
}

case "$plain" in
  ready|done) status=known ;;
  *) status=other ;;
esac

if [[ $status =~ ^[a-z]+$ && ${#numbers[@]} -gt 1 ]]; then
  for item in "${numbers[@]}"; do
    printf '%s\n' "$item"
  done | while IFS= read -r item; do printf '[%s]\n' "$item"; done
fi

value=$(printf '%s' "${labels[ready]}")
read -r parsed <<< "$value"
mapfile -t collected < <(printf '%s\n' "${numbers[@]}")

cat <<'FIXTURE_TEXT'
This body is literal: $(not executed), quotes " stay visible.
FIXTURE_TEXT

cat <<-FIXTURE_INDENTED
	Indented here-document text.
FIXTURE_INDENTED
