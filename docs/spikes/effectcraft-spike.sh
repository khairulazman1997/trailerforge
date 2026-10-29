#!/usr/bin/env bash
# EffectCraft spike for TrailerForge M8 task 8.1. Prints facts; decides nothing.
set -u
CLI=${CLI:-/tmp/claude-0/ec-src/target/release/effectcraft-cli}
W=${W:-/tmp/claude-0/ec-spike/work}
rm -rf "$W"; mkdir -p "$W"; cd "$W"
t() { local s=$(date +%s.%N); "$@"; local rc=$?; echo "  [$(echo "$(date +%s.%N) - $s" | bc) s, rc=$rc]"; return $rc; }

echo "== version"; "$CLI" info --empty --json 2>&1 | head -c 600; echo

echo "== 1. build a title comp by commands (the way an LLM would), save .ecproj"
t "$CLI" --empty run \
  comp.new '{"name":"Title","width":1920,"height":1080,"frameRate":30,"duration":3}' \
  layer.newText '{"text":"NIGHTFALL","size":180,"fill":"#ffffff"}' \
  --save-as title.ecproj --json > run.json 2>&1
head -c 800 run.json; echo
ls -la title.ecproj && head -c 400 title.ecproj; echo
python3 -c "import json;d=json.load(open('title.ecproj'));print('keys',list(d)[:12],'schema',d.get('schema'),'savedBy',d.get('savedBy'))"

echo "== 2. animate: keyframes + an effect"
t "$CLI" title.ecproj --save run \
  prop.addKey '{"layer":"#1","path":"transform/scale","time":0,"value":[60,60]}' \
  prop.addKey '{"layer":"#1","path":"transform/scale","time":0.6,"value":[100,100]}' \
  prop.addKey '{"layer":"#1","path":"transform/opacity","time":0,"value":0}' \
  prop.addKey '{"layer":"#1","path":"transform/opacity","time":0.4,"value":100}' \
  --json > anim.json 2>&1; head -c 600 anim.json; echo
t "$CLI" title.ecproj --save exec effect.apply --params '{"layer":"#1","effect":"Glow"}' --json 2>&1 | head -c 300; echo

echo "== 3. ProRes 4444 with alpha, twice (determinism), and timing"
for i in 1 2; do t "$CLI" render title.ecproj --comp Title --out "a$i.mov" --format prores --prores 4444 --channels rgba --audio off --json 2>&1 | tail -c 300; echo; done
sha256sum a1.mov a2.mov
ffprobe -v error -show_entries stream=codec_name,profile,pix_fmt,width,height,r_frame_rate,nb_frames -of compact a1.mov

echo "== 4. thread count independence (RAYON_NUM_THREADS=1 vs 4)"
RAYON_NUM_THREADS=1 t "$CLI" render title.ecproj --comp Title --out t1.mov --format prores --prores 4444 --channels rgba --audio off >/dev/null 2>&1
RAYON_NUM_THREADS=4 t "$CLI" render title.ecproj --comp Title --out t4.mov --format prores --prores 4444 --channels rgba --audio off >/dev/null 2>&1
sha256sum t1.mov t4.mov
echo "decoded-frame hashes (container-independent):"
for f in a1.mov t1.mov t4.mov; do ffmpeg -v error -i "$f" -f framemd5 -pix_fmt rgba64le - | grep -v '^#' | md5sum | sed "s|-|$f|"; done

echo "== 5. alpha is real: first frame (opacity 0) and a middle frame"
ffmpeg -v error -i a1.mov -vf "select=eq(n\,0)+eq(n\,45),alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YAVG" -f null - 2>&1 | grep YAVG

echo "== 6. PNG frame (transparent) and PNG sequence"
t "$CLI" render-frame title.ecproj --comp Title --time 1.5 --transparent --out f.png >/dev/null 2>&1; ffprobe -v error -show_entries stream=pix_fmt -of csv=p=0 f.png
t "$CLI" render title.ecproj --comp Title --out 'seq_[#####].png' --format png --channels rgba --audio off >/dev/null 2>&1; ls seq_*.png | wc -l

echo "== 7. hand-edit the JSON (what an LLM authoring the file directly does): change the text"
python3 - <<'EOF'
import json,re
s=open('title.ecproj').read()
n=s.count('NIGHTFALL'); s=s.replace('NIGHTFALL','DAYBREAK'); open('edited.ecproj','w').write(s); print('replaced',n)
EOF
t "$CLI" render-frame edited.ecproj --comp Title --time 1.5 --out e.png >/dev/null 2>&1 && cmp -s e.png f.png && echo "SAME (edit ignored?)" || echo "differs (edit used)"
echo "broken file:"; echo '{"schema":2,"bogus":1}' > broken.ecproj; "$CLI" info broken.ecproj --json 2>&1 | head -c 300; echo

echo "== 8. Essential Graphics template + values (TrailerForge templates)"
t "$CLI" title.ecproj --save run \
  essential.addProperty '{"comp":"Title","layer":"#1","path":"text/sourceText","name":"Title"}' --json 2>&1 | head -c 400; echo
t "$CLI" title.ecproj exec essential.exportTemplate --params '{"comp":"Title","path":"'"$W"'/title.ectemplate"}' --json 2>&1 | head -c 400; echo
echo '{"Title":"SEASON ONE"}' > values.json
t "$CLI" render-frame --template title.ectemplate --values values.json --time 1.5 --out tpl.png 2>&1 | tail -c 300; echo
ls -la tpl.png 2>/dev/null

echo "== 9. 1080p 10 s speed check"
"$CLI" title.ecproj --save exec comp.settings --params '{"comp":"Title","duration":10}' >/dev/null 2>&1
t "$CLI" render title.ecproj --comp Title --out long.mov --format prores --prores 4444 --channels rgba --audio off >/dev/null 2>&1
ffprobe -v error -show_entries stream=nb_frames -of csv=p=0 long.mov

echo "== 10. network: strace connect() during a render"
command -v strace >/dev/null && strace -f -e trace=connect -o net.txt "$CLI" render title.ecproj --comp Title --out n.mov --format prores --prores 4444 --channels rgba --audio off >/dev/null 2>&1; grep -c "connect(" net.txt 2>/dev/null; grep -v "AF_UNIX" net.txt 2>/dev/null | grep connect | head -3
echo done
