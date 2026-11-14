"""Look up each song on the iTunes Search API and attach a 30s preview URL + artwork.

Usage: python3 -I scripts/resolve_previews.py <top10.json> <out songs.json> [--redo]

--redo re-checks songs that are missing a preview or matched an alternate version
(remix, live, extended mix...), using the current scoring rules and OVERRIDES.

Results are cached in <out>.cache.json so the script can be stopped and resumed.
iTunes allows roughly 20 requests/minute, so a full run takes a while.
"""
import json, re, sys, time, os, unicodedata, urllib.parse, urllib.request

src, out = sys.argv[1], sys.argv[2]
REDO = '--redo' in sys.argv

# Hand-tuned searches for songs whose chart title differs from the iTunes listing.
OVERRIDES = {
    '1980|2': {'term': 'Another Brick in the Wall Pt. 2 Pink Floyd', 'title': 'Another Brick in the Wall, Pt. 2', 'artist': 'Pink Floyd'},
    '1989|9': {'term': 'Baby I Love Your Way Freebird Will to Power', 'title': 'Baby I Love Your Way', 'artist': 'Will to Power'},
    '2001|10': {'term': "Independent Women Pt. 1 Destiny's Child", 'title': 'Independent Women, Pt. 1', 'artist': "Destiny's Child"},
    '2005|7': {'term': 'Boulevard of Broken Dreams Green Day', 'title': 'Boulevard of Broken Dreams', 'artist': 'Green Day'},
    '2011|7': {'term': 'Forget You CeeLo Green', 'title': 'Forget You', 'artist': 'CeeLo Green'},
    '2013|7': {'term': 'Just Give Me a Reason P!nk Nate Ruess', 'title': 'Just Give Me a Reason', 'artist': 'P!nk'},
    '2022|10': {'term': 'Cold Heart PNAU Remix Elton John Dua Lipa', 'title': 'Cold Heart (PNAU Remix)', 'artist': 'Elton John'},
    '2008|5': {'term': 'Apologize Timbaland OneRepublic', 'title': 'Apologize', 'artist': 'Timbaland'},
    '2009|2': {'term': 'Poker Face Lady Gaga The Fame', 'title': 'Poker Face', 'artist': 'Lady Gaga'},
    '1993|2': {'term': 'Whoomp There It Is Tag Team', 'title': 'Whoomp! There It Is', 'artist': 'Tag Team'},
    '2020|3': {'term': 'The Box Roddy Ricch', 'title': 'The Box', 'artist': 'Roddy Ricch'},
}
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

BAD = re.compile(r'karaoke|tribute|cover|instrumental|re-?record|made famous|in the style|lullaby|8-bit|piano version|cast recording|broadway|kidz bop', re.I)

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

# Parenthetical tags that mean "not the hit version" (unless the chart title says so too).
ALT = re.compile(r'live|remix|\bmix\b|extended|long version|club|a ?capp?ella|acoustic|instrumental|demo|'
                 r'vacation|sped up|slowed|special edition|from spotify|session|unplugged|rerecorded', re.I)
OK_MIX = re.compile(r'single mix|radio mix|radio edit|single version|original|stereo|mono|remaster|45 version|album version', re.I)

def alt_penalty(cand_title, chart_title):
    if ALT.search(chart_title):
        return 0
    for tag in re.findall(r'[\(\[](.*?)[\)\]]', cand_title):
        tag = tag.strip()
        if OK_MIX.fullmatch(tag) or re.fullmatch(r'(original |single |radio |main |album )*(version|edit|mix)', tag, re.I):
            continue
        if ALT.search(tag):
            return 35
    return 0

_catalogs = {}
def artist_catalog(name):
    """All songs by an artist (search results can bury originals under covers)."""
    if name in _catalogs: return _catalogs[name]
    songs = []
    url = 'https://itunes.apple.com/search?' + urllib.parse.urlencode({'term': name, 'entity': 'musicArtist', 'limit': 1, 'country': 'US'})
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            hits = json.load(r).get('results', [])
        time.sleep(3.2)
        if hits:
            url = f"https://itunes.apple.com/lookup?id={hits[0]['artistId']}&entity=song&limit=200&country=US"
            with urllib.request.urlopen(url, timeout=30) as r:
                songs = [x for x in json.load(r).get('results', []) if x.get('wrapperType') == 'track']
            time.sleep(3.2)
    except Exception as e:
        print('  catalog lookup failed', name, e)
    _catalogs[name] = songs
    return songs

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
    s -= alt_penalty(c.get('trackName', ''), title)
    full = lambda x: re.sub(r'[^a-z0-9]', '', x.lower())
    if '(' in title and full(c.get('trackName', '')) == full(title): s += 5  # exact version, e.g. "(PNAU Remix)"
    if not re.search(r'[\(\[]', c.get('trackName', '')): s += 3  # prefer the plain listing over tagged versions
    if not c.get('previewUrl'): s -= 100
    return s

for year, songs in data.items():
    for song in songs:
        key = f"{year}|{song['rank']}|{song['title']}|{song['artist']}"
        ov = OVERRIDES.get(f"{year}|{song['rank']}")
        hit = cache.get(key)
        needs_redo = REDO and (not hit or ov or hit['score'] < 80 or alt_penalty(hit['matched'].split(' — ')[0], song['title']))
        if key in cache and not needs_redo: continue
        title_q = ov['title'] if ov else re.sub(r'\s*/\s*.*$', '', song['title'])  # double A-sides: search the first title
        artist_q = ov['artist'] if ov else song['artist']
        terms = [ov['term']] if ov else [f"{title_q} {main_artist(song['artist'])}", title_q]
        best, best_s = None, -1
        for term in terms:
            results = search(term)
            time.sleep(3.2)
            for c in results:
                s = score(c, title_q, artist_q)
                if s > best_s: best, best_s = c, s
            if best_s >= 60: break
        if best_s < 93:  # no clean exact match: also check the artist's own catalog
            for c in artist_catalog(main_artist(artist_q)):
                sc = score(c, title_q, artist_q)
                if sc > best_s: best, best_s = c, sc
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
