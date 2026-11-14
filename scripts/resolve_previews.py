"""Look up each song on the iTunes Search API and attach a 30s preview URL + artwork.

Usage: python3 -I scripts/resolve_previews.py <top10.json> <out songs.json>

Results are cached in <out>.cache.json so the script can be stopped and resumed.
iTunes allows roughly 20 requests/minute, so a full run takes a while.
"""
import json, re, sys, time, os, unicodedata, urllib.parse, urllib.request

src, out = sys.argv[1], sys.argv[2]
cache_path = out + '.cache.json'
cache = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
data = json.load(open(src))

def norm(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
    s = s.replace('&', ' and ')
    s = re.sub(r'\(.*?\)|\[.*?\]', ' ', s)
    s = re.sub(r'[^a-z0-9 ]', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()

def main_artist(a):
    return re.split(r'\s+(?:featuring|feat\.?|ft\.?|with|and|&|x|,|duet with)\s+', a, flags=re.I)[0]

BAD = re.compile(r'karaoke|tribute|cover|instrumental|re-?record|made famous|in the style|lullaby|8-bit|piano version', re.I)

def search(term):
    url = 'https://itunes.apple.com/search?' + urllib.parse.urlencode(
        {'term': term, 'media': 'music', 'entity': 'song', 'limit': 25, 'country': 'US'})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'song-chooser/1.0'}), timeout=30) as r:
                return json.load(r).get('results', [])
        except Exception as e:
            print('  retry', attempt, e); time.sleep(20 * (attempt + 1))
    return []

def score(c, title, artist):
    ct, ca = norm(c.get('trackName', '')), norm(c.get('artistName', ''))
    t, a, ma = norm(title), norm(artist), norm(main_artist(artist))
    s = 0
    if ct == t: s += 50
    elif ct.startswith(t) or t.startswith(ct): s += 30
    elif t in ct: s += 15
    else: return -999
    if ca == a: s += 40
    elif ma and (ma in ca or ca in a): s += 30
    else: s -= 40
    blob = ' '.join([c.get('trackName', ''), c.get('collectionName', ''), c.get('artistName', '')])
    if BAD.search(blob): s -= 60
    if re.search(r'\blive\b|remix|remaster(ed)? 20|acoustic|edit\)', c.get('trackName', ''), re.I): s -= 10
    if not c.get('previewUrl'): s -= 100
    return s

for year, songs in data.items():
    for song in songs:
        key = f"{year}|{song['rank']}|{song['title']}|{song['artist']}"
        if key in cache: continue
        title_q = re.sub(r'\s*/\s*.*$', '', song['title'])  # double A-sides: search the first title
        best, best_s = None, -1
        for term in [f"{title_q} {main_artist(song['artist'])}", title_q]:
            results = search(term)
            time.sleep(3.2)
            for c in results:
                s = score(c, title_q, song['artist'])
                if s > best_s: best, best_s = c, s
            if best_s >= 60: break
        if best and best_s >= 20:
            cache[key] = {
                'preview': best.get('previewUrl'),
                'art': (best.get('artworkUrl100') or '').replace('100x100bb', '400x400bb'),
                'link': best.get('trackViewUrl'),
                'matched': f"{best.get('trackName')} — {best.get('artistName')}",
                'score': best_s,
            }
        else:
            cache[key] = None
        print(year, song['rank'], song['title'], '->', cache[key] and cache[key]['matched'], best_s, flush=True)
        json.dump(cache, open(cache_path, 'w'))

final = {}
for year, songs in data.items():
    final[year] = []
    for song in songs:
        hit = cache.get(f"{year}|{song['rank']}|{song['title']}|{song['artist']}") or {}
        final[year].append({**song, 'preview': hit.get('preview'), 'art': hit.get('art'), 'link': hit.get('link')})
json.dump(final, open(out, 'w'), indent=1, ensure_ascii=False)
missing = sum(1 for y in final.values() for s in y if not s['preview'])
print('done; songs without preview:', missing)
