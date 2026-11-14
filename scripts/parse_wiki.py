"""Parse saved Wikipedia 'Billboard Year-End Hot 100 singles of YYYY' API responses
into a JSON list of the top 10 songs per year.

Usage: python3 -I scripts/parse_wiki.py <dir-with-YYYY.html> <out.json>
"""
import json, re, sys, os
import bs4

src, out = sys.argv[1], sys.argv[2]

def clean(txt):
    txt = re.sub(r'\[[^\]]*\]', '', txt)          # footnote markers
    txt = txt.replace('“', '"').replace('”', '"')
    txt = re.sub(r'\s+', ' ', txt).strip()
    txt = re.sub(r'\s*"\s*/\s*"\s*', ' / ', txt)  # double A-sides: 'A " / " B' -> 'A / B'
    txt = txt.strip('"').strip()
    return txt

def table_rows(table):
    """Expand rowspans so every row has the full set of cells."""
    grid, pending = [], {}
    for tr in table.find_all('tr'):
        cells = tr.find_all(['td', 'th'])
        row, col, it = [], 0, iter(cells)
        while True:
            if col in pending:
                text, left = pending[col]
                row.append(text)
                if left <= 1: del pending[col]
                else: pending[col] = (text, left - 1)
                col += 1
                continue
            c = next(it, None)
            if c is None: break
            text = clean(c.get_text(' ', strip=True))
            span = int(c.get('rowspan', 1) or 1)
            if span > 1: pending[col] = (text, span - 1)
            row.append(text); col += 1
        while col in pending:
            text, left = pending[col]; row.append(text)
            if left <= 1: del pending[col]
            else: pending[col] = (text, left - 1)
            col += 1
        grid.append(row)
    return grid

result = {}
for f in sorted(os.listdir(src)):
    year = f.split('.')[0]
    try:
        html = json.load(open(os.path.join(src, f)))['parse']['text']
    except Exception:
        print('skip', f); continue
    soup = bs4.BeautifulSoup(html, 'html.parser')
    songs = None
    for table in soup.find_all('table', class_='wikitable'):
        grid = table_rows(table)
        header = [h.lower() for h in grid[0]]
        if not any('title' in h for h in header): continue
        ti = next(i for i, h in enumerate(header) if 'title' in h)
        ai = next(i for i, h in enumerate(header) if 'artist' in h)
        ri = 0
        songs = []
        for r in grid[1:]:
            if len(r) <= max(ti, ai): continue
            m = re.match(r'\d+', r[ri])
            if not m: continue
            rank = int(m.group())
            if rank > 10: break
            songs.append({'rank': rank, 'title': r[ti], 'artist': r[ai]})
        break
    if not songs or len(songs) < 10:
        print('PROBLEM', year, songs); continue
    result[year] = songs[:10]

json.dump(result, open(out, 'w'), indent=1, ensure_ascii=False)
print('years parsed:', len(result))
