#!/bin/bash
# Claude Code status line — a cost & context efficiency dashboard. Example:
#
#   Fable 1M medium 3x | 5h:16% ↺2h | 7d:2% ↺3d | Δ10¢ Σ$14.90 | 169k ❄4m | skymap
#
# Segments, grouped by ` | ` and spaced within a group: model + effort + cost
# multiplier vs Opus-low | rate limits w/ reset | Δ turn cost + Σ session cost |
# context tokens + prompt-cache countdown | cwd. Universal across billing types:
# rate-limit segments render only when
# the account reports them, costs are computed from the session transcript at public
# API prices, and the prompt-cache TTL is detected from actual usage — so seat,
# enterprise, and API-key billing all work unmodified. Requires bash and jq.
input=$(cat)

# Single source of truth for pricing: base input $/MTok per model family, matched as
# a substring of the model id. All other rates are fixed ratios of base input across
# the entire lineup: output 5x, cache read 0.1x, 5m cache write 1.25x, 1h cache
# write 2x. Unknown future models fall back to Opus pricing.
PRICES='{"fable": 10, "opus": 5, "sonnet": 3, "haiku": 1}'

eval "$(echo "$input" | jq -r --argjson P "$PRICES" '
  (.model.id // "") as $id |
  "MODEL=" + (.model.display_name // "?" | @sh),
  "MODEL_ID=" + ($id | @sh),
  "PRICE=" + ([$P | to_entries[] | select(. as $e | $id | test($e.key)) | .value] | first // 5 | tostring),
  "EFFORT=" + (.effort.level // "" | @sh),
  "INP=" + (.context_window.current_usage.input_tokens // 0 | tostring),
  "CC=" + (.context_window.current_usage.cache_creation_input_tokens // 0 | tostring),
  "CR=" + (.context_window.current_usage.cache_read_input_tokens // 0 | tostring),
  "OUT=" + (.context_window.current_usage.output_tokens // 0 | tostring),
  "CTX_SIZE=" + (.context_window.context_window_size // 200000 | tostring),
  "FIVE_H=" + (.rate_limits.five_hour.used_percentage // "" | tostring),
  "FIVE_H_RESET=" + (.rate_limits.five_hour.resets_at // "" | tostring),
  "WEEK=" + (.rate_limits.seven_day.used_percentage // "" | tostring),
  "WEEK_RESET=" + (.rate_limits.seven_day.resets_at // "" | tostring),
  "COST_USD=" + (.cost.total_cost_usd // "" | tostring),
  "TRANSCRIPT=" + (.transcript_path // "" | @sh),
  "CWD=" + (.workspace.current_dir // "" | @sh)
')"

# ANSI colors
GREEN=$'\033[32m'; CYAN=$'\033[36m'; YELLOW=$'\033[33m'
ORANGE=$'\033[38;5;208m'; RED=$'\033[31m'; RESET=$'\033[0m'

# Pick a color by a value's position against 3 (or 4) ascending thresholds.
# tier_color VALUE T1 T2 T3      -> green | cyan | orange | red
# tier_color5 VALUE T1 T2 T3 T4  -> green | cyan | yellow | orange | red
tier_color() {
  if   [ "$1" -lt "$2" ]; then echo "$GREEN"
  elif [ "$1" -lt "$3" ]; then echo "$CYAN"
  elif [ "$1" -lt "$4" ]; then echo "$ORANGE"
  else                         echo "$RED"
  fi
}
tier_color5() {
  if   [ "$1" -lt "$2" ]; then echo "$GREEN"
  elif [ "$1" -lt "$3" ]; then echo "$CYAN"
  elif [ "$1" -lt "$4" ]; then echo "$YELLOW"
  elif [ "$1" -lt "$5" ]; then echo "$ORANGE"
  else                         echo "$RED"
  fi
}

# Cross-platform file mtime (GNU vs BSD stat)
file_mtime() { stat -c %Y "$1" 2>/dev/null || /usr/bin/stat -f %m "$1" 2>/dev/null || echo 0; }

# Format integer milli-dollars (thousandths of $):
#   <10¢ -> one-decimal cents | <$1 -> whole cents | >=$1 -> dollars
fmt_cost() {
  local m=$1
  if   [ "$m" -lt 100 ];  then printf '%d.%d¢' $((m / 10)) $((m % 10))
  elif [ "$m" -lt 1000 ]; then printf '%d¢' $((m / 10))
  else                         printf '$%d.%02d' $((m / 1000)) $(((m / 10) % 100))
  fi
}

# Short "resets in" hint from an epoch-seconds deadline: "3d" / "2h" / "12m", or ""
# if the deadline is unknown or already past.
fmt_reset() {
  [ -z "$1" ] && { echo ""; return; }
  local diff=$(( $1 - $(date +%s) ))
  if   [ "$diff" -le 0 ];     then echo ""
  elif [ "$diff" -ge 86400 ]; then echo "$((diff / 86400))d"
  elif [ "$diff" -ge 3600 ];  then echo "$((diff / 3600))h"
  else                             echo "$((diff / 60))m"
  fi
}

# ---- Context tokens ----
# Context display includes output_tokens (the last response occupies the window on
# the next request).
TOTAL=$((INP + CC + CR + OUT))
TOKENS=$([ "$TOTAL" -ge 1000 ] && echo "$((TOTAL / 1000))k" || echo "$TOTAL")

# Context tiers measure what context size does to quality and per-turn cost, and
# neither depends on the window — quality noticeably degrades past ~100-200k on
# every model, and each request re-reads the whole window (at 160k that's real
# money per tool call even at the 0.1x cache-read rate). So the health bands are
# identical everywhere: green <60k = fresh (baseline prompt + early work, don't
# think about context), cyan <100k = normal working range, yellow <130k = drifting
# (start watching for a natural breakpoint), orange = compact at the next clean
# stopping point. Only red is window-dependent, because only the wall differs:
# 160k on a 200k window (auto-compact imminent — external constraint), 200k on a
# 1M window (past the point every model handles well; the bigger window buys
# headroom for the occasional overshoot, not a license to live there). The cost
# half of this is also visible in the Δ segment.
CTX_RED=$([ "$CTX_SIZE" -ge 1000000 ] && echo 200000 || echo 160000)
TCOLOR_CTX=$(tier_color5 "$TOTAL" 60000 100000 130000 "$CTX_RED")

# ---- Cost burn (Σ session, Δ current turn) ----
# Hybrid sourcing. Σ prefers cost.total_cost_usd when present (API/enterprise
# billing): Claude Code prices each request from exact per-model tables, including
# the 2x 1h cache-write rate and background utility requests (titling, command
# summarization) that never appear in the transcript — it is authoritative there.
# On subscription seats the field is absent, so Σ falls back to a transcript
# rescan at public list prices. Δ (per-turn) always comes from the rescan: the
# cost field has no per-turn granularity, and the rescan also attributes
# mixed-model turns and subagent fan-outs correctly. On flat-rate seats the
# dollars are notional ("what this would cost on the API"), but the relative
# signal is exact. Σ = whole session; Δ = since the last real user prompt.
# Subagent transcripts (<transcript>/subagents/*.jsonl) are folded in: all of
# them count toward Σ; those timestamped after the last user prompt count toward
# Δ (they ran during the current turn).
JQ_BURN='
  def cw(u): if u.cache_creation
    then ((u.cache_creation.ephemeral_5m_input_tokens // 0) * 1.25)
       + ((u.cache_creation.ephemeral_1h_input_tokens // 0) * 2)
    else ((u.cache_creation_input_tokens // 0) * 1.25) end;
  def w(u): (u.input_tokens // 0) + cw(u)
    + ((u.cache_read_input_tokens // 0) * 0.1)
    + ((u.output_tokens // 0) * 5);
  def price(m): ([$P | to_entries[] | select(. as $e | (m // "") | test($e.key)) | .value]
    | first // 5) / 1000000;
  def cost(m): (w(m.message.usage) * price(m.message.model));
'
BURN_SESS_M=0; BURN_TURN_M=0; CACHE_TTL=0
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  # Main thread: session $, turn $, prompt-cache TTL, timestamp of the last real
  # user prompt. jq -n + `reduce inputs` streams line-by-line (constant memory)
  # instead of slurping the file, which can be huge on long 1M-context sessions.
  # A "real" user prompt is string content that isn't a harness wrapper
  # (<command-*>, <local-command-*>, <system-reminder>), or array content with no
  # tool_result — bare startswith("<") would misclassify pasted XML/HTML.
  # The cache TTL comes from which tier the main thread actually writes to
  # (usage.cache_creation breakdown), so no billing-type assumptions are needed.
  # A single request can write breakpoints to both tiers at once (the API allows it),
  # so when both appear the shortest live TTL wins: the 5m blocks expire first, and
  # that earlier deadline is when the next turn starts paying to rebuild. Claude Code
  # doesn't mix tiers today, so this is defensive — but a too-long countdown would be
  # the dangerous failure, hiding churn that's already happening.
  # Dedup by message.id: Claude Code logs a multi-content-block assistant response
  # across several transcript lines, each repeating the *same* usage object, so a
  # naive per-line sum double-counts (~2x on tool-using turns). `seen` keeps the
  # first occurrence of each id and skips the rest; rows without an id are counted
  # unconditionally (can't dedup, and the miss is rarer than collapsing them all).
  read -r T_MAIN D_MAIN CACHE_TTL LAST_TS < <(jq -rn --argjson P "$PRICES" "$JQ_BURN"'
    def isUser: .type == "user" and (.message.content as $c |
      if ($c | type) == "string"
      then ($c | test("^<(command-|local-command-|system-reminder)") | not)
      else ([$c[]?.type] | index("tool_result") | not) end);
    reduce inputs as $m ({t: 0, d: 0, ttl: 0, ts: "", seen: {}};
      if   ($m | isUser)      then .d = 0 | .ts = ($m.timestamp // .ts)
      elif ($m.message.usage) then
        (($m.message.id) // "") as $id
        | if ($id != "" and (.seen[$id] // false)) then .
          else .t += cost($m) | .d += cost($m)
            | (if $id != "" then .seen[$id] = true else . end)
            | ($m.message.usage.cache_creation // {}) as $cc
            | if   ($cc.ephemeral_5m_input_tokens // 0) > 0 then .ttl = 300
              elif ($cc.ephemeral_1h_input_tokens // 0) > 0 then .ttl = 3600
              else . end
          end
      else . end)
    | "\(.t) \(.d) \(.ttl) \(.ts)"
  ' "$TRANSCRIPT" 2>/dev/null)
  : "${T_MAIN:=0}"; : "${D_MAIN:=0}"; : "${CACHE_TTL:=0}"; : "${LAST_TS:=}"

  # Subagents: all -> session; only those after LAST_TS -> current turn. If no user
  # prompt was found ($ts == ""), attribute nothing to the turn — an empty ts would
  # otherwise compare lower than every timestamp and dump the session's entire
  # subagent history into Δ.
  S_TOT=0; S_TURN=0
  SUB_DIR="${TRANSCRIPT%.jsonl}/subagents"
  if [ -d "$SUB_DIR" ]; then
    read -r S_TOT S_TURN < <(jq -rn --argjson P "$PRICES" "$JQ_BURN"'
      reduce (inputs | select(.message.usage)) as $m ({tot: 0, turn: 0, seen: {}};
        (($m.message.id) // "") as $id
        | if ($id != "" and (.seen[$id] // false)) then .
          else .tot += cost($m)
            | (if $ts != "" and (($m.timestamp // "") > $ts) then .turn += cost($m) else . end)
            | (if $id != "" then .seen[$id] = true else . end)
          end)
      | "\(.tot) \(.turn)"
    ' --arg ts "$LAST_TS" "$SUB_DIR"/*.jsonl 2>/dev/null)
    : "${S_TOT:=0}"; : "${S_TURN:=0}"
  fi

  # Combine and convert dollars -> integer milli-dollars (rounded).
  read -r BURN_SESS_M BURN_TURN_M < <(awk -v t="$T_MAIN" -v d="$D_MAIN" \
    -v st="$S_TOT" -v sd="$S_TURN" 'BEGIN{
      printf "%d %d", (t + st) * 1000 + 0.5, (d + sd) * 1000 + 0.5 }')
  : "${BURN_SESS_M:=0}"; : "${BURN_TURN_M:=0}"
fi
# Authoritative Σ override: total_cost_usd resets on each fresh `claude` launch
# while the transcript persists across resumes, so the two can legitimately
# diverge — when the field exists, it wins.
if [ -n "$COST_USD" ]; then
  BURN_SESS_M=$(awk -v c="$COST_USD" 'BEGIN{ printf "%d", c * 1000 + 0.5 }')
fi
# Σ session tiers (milli-$): green <$2, cyan <$8, orange <$20, red >=$20.
SCOLOR=$(tier_color "$BURN_SESS_M" 2000 8000 20000)
# Δ turn tiers (milli-$): green <10¢, cyan <50¢, yellow <$1.50, orange <$4, red >=$4.
DCOLOR=$(tier_color5 "$BURN_TURN_M" 100 500 1500 4000)
BURN_SESS_FMT=$(fmt_cost "$BURN_SESS_M")
BURN_TURN_FMT=$(fmt_cost "$BURN_TURN_M")

# ---- Cache expiry countdown from last transcript activity ----
# Reply within ❄<countdown> and the context re-reads from cache at 0.1x; once it
# lapses the whole prompt is re-written at full 1.25x. A countdown ("4m") answers
# "should I hurry?" directly, where a wall-clock would force mental subtraction; the
# 5s status-line refresh keeps it live. TTL was detected above from the actual
# cache-write tier (1h on subscription main threads, 5m on API billing); until the
# first response reveals it, assume the conservative 5m. The countdown is rendered
# NEUTRAL (terminal default) while there's plenty of time — color only appears once
# it matters, so it doesn't visually conflate with the green-ish token count beside
# it. Warning thresholds scale with the TTL (orange < TTL/5, red < TTL/10) so they
# fire proportionally on both tiers: orange 12m / red 6m on 1h, orange 60s / red 30s
# on 5m. (A fixed 1-2min cutoff would leave a 1h cache silent until its last minute.)
[ "$CACHE_TTL" -gt 0 ] || CACHE_TTL=300
ORANGE_AT=$((CACHE_TTL / 5)); RED_AT=$((CACHE_TTL / 10))
EXPIRY_COLOR=""
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  LEFT=$(( $(file_mtime "$TRANSCRIPT") + CACHE_TTL - $(date +%s) ))
  if   [ "$LEFT" -le 0 ];    then EXPIRY_FMT="now"
  elif [ "$LEFT" -lt 60 ];   then EXPIRY_FMT="${LEFT}s"
  elif [ "$LEFT" -lt 3600 ]; then EXPIRY_FMT="$((LEFT / 60))m"
  else                            EXPIRY_FMT="$((LEFT / 3600))h"
  fi
  if   [ "$LEFT" -le "$RED_AT" ];    then EXPIRY_COLOR="$RED"
  elif [ "$LEFT" -le "$ORANGE_AT" ]; then EXPIRY_COLOR="$ORANGE"
  fi
else
  EXPIRY_FMT="?"
fi

# ---- Rate-limit usage (rendered only when the account reports limits) ----
# .rate_limits.five_hour = rolling session window; .seven_day = weekly window.
# Populated after the first model response on subscription seats; absent on API
# billing, so these segments disappear there. used_percentage is quantized to whole
# percent server-side — show ints. Tiers: green <50, cyan <75, orange <90, red >=90.
# Label and value are colon-bound ("5h:5%") so each reads as one token; the ↺reset
# hint follows after a space, and the two limits are joined by ` | ` (same separator
# as between groups) so the hierarchy is unambiguous: pipe between limits, space
# within a limit.
LIMIT_SEG=""
if [ -n "$FIVE_H" ]; then
  FH_INT=$(printf '%.0f' "$FIVE_H")
  FH_COLOR=$(tier_color "$FH_INT" 50 75 90)
  FH_R=$(fmt_reset "$FIVE_H_RESET")
  LIMIT_SEG="5h:${FH_COLOR}${FH_INT}%${RESET}${FH_R:+ ↺$FH_R}"
fi
if [ -n "$WEEK" ]; then
  WK_INT=$(printf '%.0f' "$WEEK")
  WK_COLOR=$(tier_color "$WK_INT" 50 75 90)
  WK_R=$(fmt_reset "$WEEK_RESET")
  WK_SEG="7d:${WK_COLOR}${WK_INT}%${RESET}${WK_R:+ ↺$WK_R}"
  LIMIT_SEG="${LIMIT_SEG:+$LIMIT_SEG | }$WK_SEG"
fi

# ---- Per-prompt cost multiplier (Opus low = 1x baseline) ----
# Anchored to Opus low — the usual default driver — so 1x reads as "my normal" and
# the number becomes a deviation signal: >1 means I'm spending more than usual this
# turn, <1 means I'm economizing. (If your default isn't Opus low, change the 50
# divisor below = baseline_model_price x baseline_effort_weight.) Derived from the
# price table x an effort weight, so it tracks PRICES automatically: each effort
# level costs roughly low 1x | medium 1.5x | high 2.5x | xhigh 3.5x | max 4x of the
# same model's low. MULT is kept in tenths (x10) for one-decimal formatting without
# floats; /50 (Opus price 5 x low weight 10) normalizes Opus low to 1.0x.
case "$EFFORT" in
  low) W=10 ;; medium) W=15 ;; high) W=25 ;; xhigh) W=35 ;; max) W=40 ;; *) W=15 ;;
esac
MULT=$(( (PRICE * W * 10 + 25) / 50 ))
MCOLOR=$(tier_color5 "$MULT" 13 26 41 61)
if [ $((MULT % 10)) -eq 0 ]; then
  MULT_FMT="$((MULT / 10))x"
else
  MULT_FMT=$(printf '%d.%dx' $((MULT / 10)) $((MULT % 10)))
fi

# ---- Short model label ("1M" from the actual context window size) ----
case "$MODEL_ID" in
  *opus*)   SHORT="Opus" ;;
  *sonnet*) SHORT="Sonnet" ;;
  *fable*)  SHORT="Fable" ;;
  *haiku*)  SHORT="Haiku" ;;
  *)        SHORT="$MODEL" ;;
esac
[ "$CTX_SIZE" -ge 1000000 ] && SHORT="$SHORT 1M"

FOLDER=$(basename "${CWD:-$PWD}")

# ---- Compose output ----
# Pipes separate groups; spaces separate segments within a group. Related signals
# (model/effort/mult, the two rate limits, Δ/Σ cost, tokens/cache) sit together so
# the eye parses four chunks, not eleven. Empty segments collapse; a group that
# ends up empty leaves no stray pipe (groups are joined only when non-empty).

# Model group: label, effort, cost multiplier.
MODEL_GRP="$SHORT"
[ -n "$EFFORT" ] && MODEL_GRP="$MODEL_GRP $EFFORT"
MODEL_GRP="$MODEL_GRP ${MCOLOR}${MULT_FMT}${RESET}"

# Cost group: Δ turn, Σ session. Shown as a stable pair once the session has any
# cost, rather than dropping Δ when it's momentarily zero. Δ resets to 0 at each new
# user prompt and then grows in place as the status line re-runs (every ~5s) and the
# transcript gains a usage row per tool round — so the turn cost ticks up live and
# the layout never shifts. Below it would only flicker in/out between turns.
COST_GRP=""
[ "$BURN_SESS_M" -gt 0 ] && COST_GRP="Δ${DCOLOR}${BURN_TURN_FMT}${RESET} Σ${SCOLOR}${BURN_SESS_FMT}${RESET}"

# Context group: tokens, cache countdown.
CTX_GRP="${TCOLOR_CTX}${TOKENS}${RESET} ❄${EXPIRY_COLOR}${EXPIRY_FMT}${RESET}"

# Join non-empty groups with ` | `.
LINE="$MODEL_GRP"
for g in "$LIMIT_SEG" "$COST_GRP" "$CTX_GRP" "$FOLDER"; do
  [ -n "$g" ] && LINE="$LINE | $g"
done
echo "$LINE"
