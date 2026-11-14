# Song Chooser (friends edition)

A live party game for you and your friends. Everyone joins one lobby, then you go through the years together.
Each year has the 10 biggest songs from the Billboard Year-End Hot 100 (**1960 to 2025**). You hear a
30-second preview of each, then drag your medals and your prediction onto songs:

| Token | What it means | Points |
|-------|---------------|--------|
| 🥇 | Your favorite | 5 to that song |
| 🥈 | Your 2nd favorite | 3 to that song |
| 🥉 | Your 3rd favorite | 1 to that song |
| 🔮 | Your guess for Billboard's actual #1 that year | **+1 for you** if you're right |

Medal points decide the group's favorite songs. 🔮 guesses are a running scoreboard: whoever guesses the most
#1s wins.

## How a game works

1. **Host a game.** Name it and choose the years (a decade is a good length). You're the host 👑.
2. **Pregame lobby.** Share the link or the 5-letter code. Friends type their name and pick a goofy icon
   (🦖 🦆 🌮 🤡 🥸 ...). Everyone gets a different one, and you can swap icons in the lobby. When everyone's in,
   the host taps **Start the game**.
3. **Each year, together.** Everyone is on the same year. On each phone the songs appear and play one at a time
   (**Next ›** skips ahead, **Show all songs** reveals the rest). Drag 🥇 🥈 🥉 and 🔮 onto songs, or tap a token
   and then tap a song. Drag a token off a song to take it back. Then **Lock in**. Icons at the top tick ✓ as
   people lock in. Until everyone has, you can unlock and change your picks.
4. **The reveal.** Once the last person locks in, everyone sees Billboard's real top 10 for that year at the same
   moment. Each song shows the icons of whoever medaled it or 🔮-guessed it, the group's points, and the 🔮
   scoreboard. After 15 seconds the whole group moves to the next year.
5. **Game over.** After the last year, the 🔮 champion is crowned, followed by the final scoreboard and the
   group's most-loved songs.

**Host controls:** remove a player (lobby ✕) · **Reveal now** if someone wandered off mid-year · **Pause** or
**Next year** during a reveal · **End the game now**.

**Results** (the Results tab, any time) cover every year played:
- **Years:** the group's #1 vs. Billboard's #1, and who placed what on every song.
- **Players:** 🔮 record, how mainstream each person's 🥇 picks are, and their "taste twin".
- **Hall of Fame:** most-loved songs, underdog wins and snubbed #1s.

On a new device, enter the same name to pick up where you left off. To change how long the reveal shows, start
the server with `REVEAL_SECONDS=20 npm start`.

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

### Clearing out games

Stop the server first (Ctrl+C), then:

```bash
npm run clear-games                  # lists every game, then deletes them all (asks you to type "yes")
npm run clear-games -- ABCDE         # delete just one game (or several codes)
npm run clear-games -- --list        # only list the games
```

A backup of `data/db.json` is saved next to it every time, so a mistake can be undone by copying the backup back.

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
