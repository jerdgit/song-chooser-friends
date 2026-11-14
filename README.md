# Song Chooser (friends edition)

A private game for you and your friends. Each year from **1960 to 2025** has the 10 biggest songs from the
Billboard Year-End Hot 100. You hear a 30-second preview of each song, one at a time, then pick your
top 3:

| Pick | Points |
|------|--------|
| 🥇 1st | 5 |
| 🥈 2nd | 3 |
| 🥉 3rd | 1 |

Everyone's points are added up per year, and the results page shows the group's ranking for each year
next to the real Billboard ranking.

## How a game works

1. **Create a game.** Name it and choose the years (all of them, one decade, or any range).
2. **Share the link or the 5-letter code.** Friends open it and type their name. That's it, no accounts.
3. **Play each year.** The 10 songs come in a shuffled order, so the chart position isn't given away. Each preview
   plays automatically. Tap ♥ to shortlist a song, then rank your top 3. Afterwards you see where your picks
   landed on Billboard's chart and what the group has voted so far.
4. **Check the results** at any time (they update live):
   - **Years:** the group's #1 for every year, and whether it matched Billboard's #1. Tap a year to see all
     10 songs with points, who voted for what, and the Billboard rank (sortable either way).
   - **Friends:** each person's chart-match count, how often they agreed with the group, how mainstream their
     #1 picks are (average Billboard rank), and their "taste twin" in the group.
   - **Hall of Fame:** the group's most-loved songs across all years, underdog wins (group #1s that Billboard
     ranked 6th or lower), and snubbed #1s that got zero points.

Nobody has to finish every year. Results count whatever each person has voted on. You can go back and change
a vote. On a new device, enter the same name to pick up where you left off. Whoever created the game can
remove players from the lobby.

## Run it

You need Node.js 18 or newer. There are no dependencies to install.

```bash
npm start            # http://localhost:3000
npm test             # scoring + API tests
```

Environment variables (both optional):

- `PORT`: the port to listen on (default `3000`)
- `DATA_DIR`: the folder for `db.json`, which holds all games and votes (default `./data`)

### Hosting it from your own computer (free)

Votes are saved in `data/db.json` on your computer, so they survive restarts.

1. In one terminal: `npm start`
2. In a second terminal: `npx cloudflared tunnel --url http://localhost:3000`
   (or install it with `brew install cloudflared` / `winget install Cloudflare.cloudflared` and run
   `cloudflared tunnel --url http://localhost:3000`). It prints a public link like
   `https://some-random-words.trycloudflare.com`.
3. Open **that** link (not `localhost`) to create the game. The invite link in the lobby is built from the address
   you're using, so a game opened on `localhost` would hand out a link that only works on your computer.
4. Send friends the link. Keep both terminals open and stop your computer from sleeping while people play.

The `trycloudflare.com` address changes every time you restart the tunnel. Games and votes are kept. Send
friends the new link, or the new address plus the 5-letter game code. To back up the votes, copy `data/db.json`.

### Hosting it on a server

Any host that runs Node works with start command `npm start`. Votes live in one JSON file, so the host needs a
**persistent disk** mounted at a folder you point `DATA_DIR` to. Free tiers with no persistent disk (such as
Render's free web service) wipe the file whenever they restart, so all the votes disappear with it.

## Where the data comes from

- **Songs:** the top 10 of each [Billboard Year-End Hot 100](https://en.wikipedia.org/wiki/Billboard_Year-End_Hot_100)
  (1960–2025), parsed from Wikipedia. This is the "real world" ranking the group is compared against.
- **Previews and album art:** the iTunes Search API. Matches were found ahead of time and saved in
  `public/songs.json`. If a preview link ever stops working, the server looks up a fresh one from iTunes,
  falling back to Deezer.

To rebuild `public/songs.json` (for example, to add a new year once its chart is out):

```bash
# 1. Save each year's Wikipedia page through the API, as wiki/YYYY.html:
#    https://en.wikipedia.org/w/api.php?action=parse&page=Billboard_Year-End_Hot_100_singles_of_YYYY&prop=text&format=json&formatversion=2
# 2. Parse the top 10s, then match previews (iTunes allows ~20 lookups/minute, so this is slow but resumable):
python3 scripts/parse_wiki.py wiki/ top10.json
python3 scripts/resolve_previews.py top10.json public/songs.json
```

## Project layout

```
server.js              zero-dependency Node server: static files + JSON API + JSON-file storage
public/index.html      page shell
public/app.js          the whole front end (lobby, listening, ranking, results)
public/scoring.js      5/3/1 scoring and stats, shared by the browser and the tests
public/styles.css      styles (mobile-first)
public/songs.json      top 10 songs per year with preview + artwork URLs
scripts/               data build scripts (Wikipedia parser, iTunes matcher)
test/                  node:test suites
```
