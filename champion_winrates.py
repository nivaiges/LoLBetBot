#!/usr/bin/env python3
"""
champion_winrates.py  --  Riot "winrate engine"

Computes per-(player, champion) win rate restricted to a single queue, using the
Riot Match-V5 API. Dependency-free (stdlib only). Runs on YOUR machine, where the
Riot API key and network access to riotgames.com live.

WHAT IT DOES
  1. Resolves each player's PUUID (from a Riot ID like "Faker#KR1", or accepts a
     raw PUUID directly).
  2. Pulls that player's match IDs for the given --queue (paginated, 100 at a time).
  3. Fetches each match, finds the player's participant, and tallies wins for the
     champion you asked about (case/punctuation-insensitive, with alias handling
     for names like Rek'Sai / Wukong / Nunu & Willump).
  4. Prints a table  player | champion | wins | games | winrate  and writes a CSV.
     Fewer than --min-games (default 3) games -> winrate shown as "N/A".

RATE LIMITS (personal/dev key): 20 req/sec and 100 req/2 min. Both are enforced
below with a sliding-window limiter. On HTTP 429 it sleeps Retry-After and retries.
Match JSON is cached under --cache-dir so re-runs are cheap and resumable.

------------------------------------------------------------------------------
USAGE
------------------------------------------------------------------------------
1) Find the right queue id first (the "new premade 5v5 ranked" mode is ambiguous):

     python champion_winrates.py --env-file .env --probe "YourName#TAG"

   This prints the queueId + gameMode of that player's recent 20 games alongside
   Riot's queues.json descriptions, so you can pick the exact id.

2) Then run the engine for a specific queue, e.g. queue 440 (Ranked Flex 5v5):

     python champion_winrates.py --queue 440 --input pairs.csv --out winrates.csv

   pairs.csv (header row; column names are auto-detected, order doesn't matter):
       player,champion
       Faker#KR1,Yone
       Faker#KR1,Azir
       SomeOne#NA1,Rek'Sai

   Or pass pairs inline instead of a file:
     python champion_winrates.py --queue 440 --pairs "Faker#KR1:Yone,Faker#KR1:Azir"

API KEY: read from --api-key, else env var RIOT_API_KEY, else the RIOT_API_KEY
line in the --env-file (default: ./.env). Dev keys rotate every 24h; a 401/403
means yours expired -> regenerate at https://developer.riotgames.com/
"""

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque

# --------------------------------------------------------------------------- #
# Config / constants
# --------------------------------------------------------------------------- #
DEFAULT_PLATFORM = "na1"       # summoner/platform host prefix
DEFAULT_REGION = "americas"    # match-v5 + account-v1 regional host prefix
QUEUES_JSON_URL = "https://static.developer.riotgames.com/docs/lol/queues.json"

# Champions whose display name differs from the API's internal championName,
# beyond simple punctuation stripping. Keys/values are compared after normalize().
CHAMP_ALIASES = {
    "wukong": "monkeyking",
    "nunuwillump": "nunu",
    "nunuandwillump": "nunu",
    "renataglasc": "renata",
    "drmundo": "drmundo",
}


def normalize_champ(name):
    """Lowercase and strip everything but a-z0-9, then apply alias map.
    Rek'Sai -> reksai, Cho'Gath -> chogath, Kai'Sa -> kaisa, K'Sante -> ksante,
    Wukong -> monkeyking, Nunu & Willump -> nunu, etc."""
    key = re.sub(r"[^a-z0-9]", "", (name or "").lower())
    return CHAMP_ALIASES.get(key, key)


# --------------------------------------------------------------------------- #
# Rate limiter: enforces N requests per window for multiple windows at once.
# --------------------------------------------------------------------------- #
class RateLimiter:
    def __init__(self, limits):
        # limits: list of (max_requests, window_seconds)
        self.limits = [(n, w, deque()) for (n, w) in limits]

    def acquire(self):
        while True:
            now = time.monotonic()
            wait = 0.0
            for n, w, dq in self.limits:
                while dq and now - dq[0] > w:
                    dq.popleft()
                if len(dq) >= n:
                    wait = max(wait, w - (now - dq[0]) + 0.01)
            if wait <= 0:
                for _, _, dq in self.limits:
                    dq.append(time.monotonic())
                return
            time.sleep(wait)


# 20 req/sec and 100 req/2min, kept a hair under the limits for safety.
LIMITER = RateLimiter([(18, 1.0), (95, 120.0)])


# --------------------------------------------------------------------------- #
# HTTP with retry / 429 handling
# --------------------------------------------------------------------------- #
class RiotError(Exception):
    pass


def riot_get(url, api_key, max_retries=6):
    for attempt in range(max_retries):
        LIMITER.acquire()
        req = urllib.request.Request(url, headers={
            "X-Riot-Token": api_key,
            "User-Agent": "Mozilla/5.0 (compatible; KampCrog-WinrateEngine/1.0)",
            "Accept": "application/json",
            "Accept-Language": "en-US,en;q=0.9",
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            code = e.code
            if code == 429:
                retry_after = int(e.headers.get("Retry-After", "5"))
                sys.stderr.write(f"  429 rate-limited; sleeping {retry_after}s...\n")
                time.sleep(retry_after + 0.5)
                continue
            if code in (500, 502, 503, 504):
                back = 2 ** attempt
                sys.stderr.write(f"  {code} server error; retrying in {back}s...\n")
                time.sleep(back)
                continue
            if code in (401, 403):
                raise RiotError(
                    f"{code} Unauthorized/Forbidden -- your Riot API key is invalid "
                    f"or expired. Regenerate at https://developer.riotgames.com/"
                ) from e
            if code == 404:
                return None
            raise RiotError(f"HTTP {code} for {url}: {e.read().decode('utf-8', 'ignore')}") from e
        except urllib.error.URLError as e:
            back = 2 ** attempt
            sys.stderr.write(f"  network error ({e.reason}); retrying in {back}s...\n")
            time.sleep(back)
    raise RiotError(f"Gave up after {max_retries} retries: {url}")


# --------------------------------------------------------------------------- #
# Riot API wrappers
# --------------------------------------------------------------------------- #
def resolve_puuid(identifier, api_key, region):
    """Accept a raw PUUID (78 chars, no '#') or a Riot ID 'gameName#tagLine'."""
    if "#" not in identifier and len(identifier) >= 70:
        return identifier  # already a PUUID
    if "#" not in identifier:
        raise RiotError(
            f"'{identifier}' is neither a PUUID nor a Riot ID (needs gameName#tagLine)."
        )
    game_name, tag_line = identifier.rsplit("#", 1)
    url = (
        f"https://{region}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/"
        f"{urllib.parse.quote(game_name)}/{urllib.parse.quote(tag_line)}"
    )
    data = riot_get(url, api_key)
    if not data or "puuid" not in data:
        raise RiotError(f"Could not resolve PUUID for '{identifier}'.")
    return data["puuid"]


def get_match_ids(puuid, api_key, region, queue, cap):
    ids, start = [], 0
    while start < cap:
        count = min(100, cap - start)
        url = (
            f"https://{region}.api.riotgames.com/lol/match/v5/matches/by-puuid/"
            f"{puuid}/ids?queue={queue}&start={start}&count={count}"
        )
        batch = riot_get(url, api_key) or []
        ids.extend(batch)
        if len(batch) < count:
            break
        start += count
    return ids


def get_match(match_id, api_key, region, cache_dir):
    cache_path = os.path.join(cache_dir, match_id + ".json") if cache_dir else None
    if cache_path and os.path.exists(cache_path):
        with open(cache_path, "r", encoding="utf-8") as f:
            return json.load(f)
    url = f"https://{region}.api.riotgames.com/lol/match/v5/matches/{match_id}"
    data = riot_get(url, api_key)
    if cache_path and data is not None:
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(data, f)
    return data


# --------------------------------------------------------------------------- #
# Probe mode: help identify the ambiguous queue id
# --------------------------------------------------------------------------- #
def probe(identifier, api_key, region, cache_dir):
    puuid = resolve_puuid(identifier, api_key, region)
    url = (
        f"https://{region}.api.riotgames.com/lol/match/v5/matches/by-puuid/"
        f"{puuid}/ids?start=0&count=20"
    )
    ids = riot_get(url, api_key) or []
    if not ids:
        print("No recent matches found for that player.")
        return
    # queues.json for descriptions
    qmap = {}
    try:
        with urllib.request.urlopen(QUEUES_JSON_URL, timeout=30) as r:
            for q in json.loads(r.read().decode("utf-8")):
                qmap[q["queueId"]] = f'{q.get("map","")} / {q.get("description") or "—"}'
    except Exception as e:
        sys.stderr.write(f"(could not fetch queues.json: {e})\n")

    print(f"\nRecent 20 matches for {identifier}:")
    print(f"{'queueId':>8}  {'gameMode':<14}  description")
    print("-" * 70)
    seen = {}
    for mid in ids:
        m = get_match(mid, api_key, region, cache_dir)
        if not m:
            continue
        info = m["info"]
        qid = info.get("queueId")
        gm = info.get("gameMode", "")
        seen.setdefault(qid, [gm, 0])
        seen[qid][1] += 1
    for qid, (gm, cnt) in sorted(seen.items(), key=lambda kv: -kv[1][1]):
        desc = qmap.get(qid, "(not in queues.json)")
        print(f"{qid:>8}  {gm:<14}  {desc}   [{cnt} of last 20]")
    print("\nPick the queueId that matches your 'premade 5v5 ranked' mode and pass "
          "it via --queue. (Solo/Duo=420, Flex 5v5=440.)")


# --------------------------------------------------------------------------- #
# Core: winrate for one (player, champion)
# --------------------------------------------------------------------------- #
def compute_winrate(puuid, champ_norm, match_ids, api_key, region, cache_dir):
    wins = games = 0
    for mid in match_ids:
        m = get_match(mid, api_key, region, cache_dir)
        if not m:
            continue
        for p in m["info"]["participants"]:
            if p.get("puuid") != puuid:
                continue
            if normalize_champ(p.get("championName", "")) == champ_norm:
                games += 1
                if p.get("win"):
                    wins += 1
            break
    return wins, games


# --------------------------------------------------------------------------- #
# Input parsing
# --------------------------------------------------------------------------- #
def load_pairs_from_csv(path):
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))
    if not rows:
        return []
    header = [h.strip().lower() for h in rows[0]]

    def find_col(cands):
        for i, h in enumerate(header):
            if any(c in h for c in cands):
                return i
        return None

    pi = find_col(["player", "riot id", "riotid", "summoner", "puuid", "account"])
    ci = find_col(["champion", "champ"])
    if pi is None or ci is None:
        raise SystemExit(
            f"Could not auto-detect player/champion columns in {path}. "
            f"Header was: {rows[0]}. Rename a column to include 'player' and 'champion'."
        )
    pairs = []
    for r in rows[1:]:
        if len(r) <= max(pi, ci):
            continue
        player, champ = r[pi].strip(), r[ci].strip()
        if player and champ:
            pairs.append((player, champ))
    return pairs


def load_pairs_inline(spec):
    pairs = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if ":" not in chunk:
            raise SystemExit(f"--pairs item '{chunk}' must be 'Player#TAG:Champion'.")
        player, champ = chunk.rsplit(":", 1)
        pairs.append((player.strip(), champ.strip()))
    return pairs


def read_api_key(args):
    if args.api_key:
        return args.api_key
    if os.environ.get("RIOT_API_KEY"):
        return os.environ["RIOT_API_KEY"]
    if args.env_file and os.path.exists(args.env_file):
        with open(args.env_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("RIOT_API_KEY"):
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if val:
                        return val
    raise SystemExit(
        "No API key. Pass --api-key, set RIOT_API_KEY, or put RIOT_API_KEY=... in "
        f"the --env-file (looked at: {args.env_file})."
    )


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description="Riot per-(player,champion) winrate engine.")
    ap.add_argument("--api-key", help="Riot API key (else RIOT_API_KEY env / .env file).")
    ap.add_argument("--env-file", default=".env", help="Path to .env holding RIOT_API_KEY.")
    ap.add_argument("--platform", default=DEFAULT_PLATFORM, help="Platform host (default na1).")
    ap.add_argument("--region", default=DEFAULT_REGION, help="Regional host (default americas).")
    ap.add_argument("--queue", type=int, help="Queue id to restrict to (REQUIRED unless --probe).")
    ap.add_argument("--input", help="CSV with player + champion columns.")
    ap.add_argument("--pairs", help="Inline pairs: 'Player#TAG:Champ,Player#TAG:Champ'.")
    ap.add_argument("--out", default="winrates.csv", help="Output CSV path.")
    ap.add_argument("--cap", type=int, default=500, help="Max match ids per player (default 500).")
    ap.add_argument("--min-games", type=int, default=3, help="Below this -> N/A (default 3).")
    ap.add_argument("--cache-dir", default=".riot_cache", help="Match JSON cache dir ('' to disable).")
    ap.add_argument("--probe", metavar="PLAYER", help="Print recent queueIds for a player and exit.")
    args = ap.parse_args()

    api_key = read_api_key(args)
    cache_dir = args.cache_dir or None
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)

    if args.probe:
        probe(args.probe, api_key, args.region, cache_dir)
        return

    if args.queue is None:
        raise SystemExit("--queue is required (or use --probe first to find it).")
    if not args.input and not args.pairs:
        raise SystemExit("Provide --input CSV or --pairs.")

    pairs = load_pairs_from_csv(args.input) if args.input else load_pairs_inline(args.pairs)
    if not pairs:
        raise SystemExit("No (player, champion) pairs found.")

    # Resolve each distinct player once, and cache its match-id list once.
    puuid_cache, matchids_cache = {}, {}
    results = []
    for player, champ in pairs:
        try:
            if player not in puuid_cache:
                puuid_cache[player] = resolve_puuid(player, api_key, args.region)
            puuid = puuid_cache[player]
            if puuid not in matchids_cache:
                sys.stderr.write(f"Fetching match ids for {player} (queue {args.queue})...\n")
                matchids_cache[puuid] = get_match_ids(
                    puuid, api_key, args.region, args.queue, args.cap
                )
            mids = matchids_cache[puuid]
            sys.stderr.write(f"  {player} / {champ}: scanning {len(mids)} matches...\n")
            wins, games = compute_winrate(
                puuid, normalize_champ(champ), mids, api_key, args.region, cache_dir
            )
        except RiotError as e:
            sys.stderr.write(f"  ERROR for {player}/{champ}: {e}\n")
            results.append((player, champ, "", "", "ERROR", f"{champ} (ERR)"))
            continue

        if games < args.min_games:
            wr_disp = "N/A"
            cell = f"{champ} (N/A)"
        else:
            pct = round(wins / games * 100)
            wr_disp = f"{pct}%"
            cell = f"{champ} ({pct}%)"
        results.append((player, champ, wins, games, wr_disp, cell))

    # Print table
    print()
    print(f"Queue {args.queue}  |  min sample = {args.min_games} games")
    print(f"{'player':<22} {'champion':<14} {'W':>4} {'G':>4} {'winrate':>8}   suggested cell")
    print("-" * 82)
    for player, champ, wins, games, wr, cell in results:
        print(f"{player:<22} {champ:<14} {str(wins):>4} {str(games):>4} {wr:>8}   {cell}")

    # Write CSV
    with open(args.out, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["player", "champion", "wins", "games", "winrate",
                    "suggested_cell", f"queue_{args.queue}"])
        for row in results:
            w.writerow(list(row) + [args.queue])
    print(f"\nWrote {len(results)} rows to {args.out}")
    low = [r for r in results if r[4] in ("N/A", "ERROR")]
    if low:
        print(f"NOTE: {len(low)} pair(s) had insufficient sample (<{args.min_games}) or errored "
              f"and are flagged N/A/ERROR.")


if __name__ == "__main__":
    main()
