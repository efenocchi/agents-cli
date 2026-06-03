#!/bin/bash
# End-to-end smoke for the artist skill: generates a fresh OG home cover
# (homepage variant) and writes it to ./out/og-home.png.
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. Find the live Higgsfield tab in the Rush app browser.
TAB=$(curl -s http://localhost:9222/json/list \
  | python3 -c "import json,sys; t=[x for x in json.load(sys.stdin) if 'higgsfield' in (x.get('url') or '')]; print(t[0]['id'] if t else '')")

if [ -z "$TAB" ]; then
  echo "error: no Higgsfield tab found on localhost:9222."
  echo "       open the Rush app and navigate it to https://higgsfield.ai/ai/image?model=nano-banana-2"
  exit 1
fi

# 2. Make sure /tmp runner scripts exist (copy from this skill if not).
[ -f /tmp/cdp-eval.js ] || cp runner/cdp-eval.js /tmp/cdp-eval.js
[ -f /tmp/higgs-batch.js ] || cp runner/higgs-batch.js /tmp/higgs-batch.js

# 3. Switch aspect to 16:9 (OG covers).
node /tmp/cdp-eval.js "$TAB" "
  (function(){
    const tb = document.querySelector('[contenteditable=true]');
    let c = tb; for (let i=0; i<4; i++) c = c.parentElement;
    const cur = Array.from(c.querySelectorAll('button')).find(b => /^(1:1|3:4|4:3|16:9|9:16|2:3|3:2)\$/.test((b.textContent||'').trim()));
    if (cur && cur.textContent.trim() !== '16:9') cur.click();
    return true;
  })()
" >/dev/null
sleep 1
node /tmp/cdp-eval.js "$TAB" "
  (function(){
    const opts = Array.from(document.querySelectorAll('button, [role=option], [role=menuitem]')).filter(el => (el.textContent||'').trim() === '16:9');
    if (opts.length) opts[opts.length - 1].click();
    return true;
  })()
" >/dev/null
sleep 1

# 4. Generate the OG home cover.
PROMPT=$(python3 -c "import json; print(json.load(open('prompts/og-prompts.example.json'))[0]['prompt'])")
OUT=$(node /tmp/higgs-batch.js "$TAB" "og-home" "$PROMPT")
echo "$OUT"

# 5. Download the four candidates.
mkdir -p out
USER="user_32IZxcf50OUWPPQMLGusPynU3CF"
BASE="https://d8j0ntlcm91z4.cloudfront.net/$USER"
echo "$OUT" | python3 -c "
import json, sys, subprocess
d = json.load(sys.stdin)
for i, hid in enumerate(d['ids'], 1):
    target = f'out/og-home-{i}.png'
    subprocess.run(['curl','-sSL',f'{\"$BASE\"}/{hid}.png','-o',target], check=False)
    import os
    if os.path.getsize(target) < 1000:
        subprocess.run(['curl','-sSL',f'{\"$BASE\"}/{hid}_min.webp','-o',f'{target}.webp'], check=False)
        subprocess.run(['sips','-s','format','png',f'{target}.webp','--out',target], check=False, capture_output=True)
        os.remove(f'{target}.webp')
    print(f'  ✓ {target}')
"

echo "done. inspect out/og-home-*.png, pick the best, crop to 1200x630 with:"
echo "  magick out/og-home-1.png -resize 1200x675 -gravity center -crop 1200x630+0+0 +repage out/og-home.png"
