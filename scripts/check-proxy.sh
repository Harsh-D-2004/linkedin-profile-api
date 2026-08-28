#!/usr/bin/env bash
# Validate a proxy before trusting it with a session cookie.
#
#   ./scripts/check-proxy.sh http://user:pass@host:port
#
# Checks three things, none of which involve your LinkedIn cookie:
#   1. who owns the exit IP  — cloud ASNs are blocked by LinkedIn outright
#   2. anonymity level       — anything leaking X-Forwarded-For/Via is useless
#   3. does LinkedIn answer  — 200 means the IP passes; 999 means blocked
set -u

PROXY="${1:-}"
[ -z "$PROXY" ] && { echo "usage: $0 <proxy-url>"; exit 1; }

UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
curl_p() { curl -s --max-time 20 -x "$PROXY" -A "$UA" "$@"; }

echo "== 1. exit IP =="
curl_p https://ipinfo.io/json | python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception: print('  no response — proxy dead or unreachable'); sys.exit(1)
org=d.get('org') or '?'
cloud=any(k in org.lower() for k in ['amazon','aws','google','microsoft','azure','oracle','digitalocean','hetzner','ovh','linode','vultr','e2e'])
print(f\"  {d.get('ip')}  {org}  {d.get('city','')} {d.get('country','')}\")
print('  VERDICT: CLOUD ASN — LinkedIn blocks this, do not use' if cloud else '  VERDICT: not an obvious cloud ASN')
" || exit 1

echo "== 2. anonymity =="
curl_p https://httpbin.org/headers | python3 -c "
import sys,json
h=json.load(sys.stdin)['headers']
leaks=[k for k in ('X-Forwarded-For','Via','X-Real-Ip','Forwarded','Proxy-Connection') if k in h]
print('  LEAKS:', ', '.join(leaks), '— not elite, do not use') if leaks else print('  clean — no proxy headers forwarded (elite)')
"

echo "== 3. linkedin.com =="
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 25 -x "$PROXY" -A "$UA" https://www.linkedin.com/)
case "$code" in
  200) echo "  200 — not blocked. This proxy is usable." ;;
  999) echo "  999 — LinkedIn blocks this IP. Unusable." ;;
  000) echo "  no response — proxy dead." ;;
  *)   echo "  $code" ;;
esac
