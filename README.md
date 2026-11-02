# Rezept-Agent

[Deutsch](README.de.md) · **English**

A Docker container in which AI agents (Claude Code) look after the recipes in [Tandoor](https://tandoor.dev): they import recipes from links, HelloFresh, Instagram reels, YouTube shorts, photos and pasted text, bring them up to a house standard and give them AI photos in one consistent style. You control everything from Slack and a small web UI. Changes are listed in the [CHANGELOG](CHANGELOG.md) (German).

| Agent / service | When | What it does |
|---|---|---|
| `rezepte` | via Slack | Creates recipe drafts in Tandoor from links (HelloFresh too), Instagram reels, YouTube shorts, photos and pasted recipe text in the recipe channel, and revises them on request. Started by the Slack bridge, not by the schedule. |
| `rezept-qualitaet` | 12:00 | Checks recipes without a status keyword against the standard (`agents/rezept-standard.md` / `.en.md`) and sends improvements to Slack as proposals (5 per run, at most 10 open). |
| `rezept-statistik` | 19:00 | Posts the daily numbers (total, checked, open, without picture) to the Slack channel. Not an agent – the Slack bridge does this. |

Nothing is changed in Tandoor without you: every import and every improvement first becomes a draft, and a person decides in Slack with **Apply / Discard / Leave as is**.

**Language:** German or English – in the web UI under **Settings → General → Language** (or `SPRACHE=de|en`). The language applies to new recipes and improvement proposals (the quality agent gradually translates existing recipes when it checks them), to all Slack messages and buttons, and to the web UI. English has its own standard ([`agents/rezept-standard.en.md`](agents/rezept-standard.en.md)) with English unit names (`tbsp`, `tsp`, `piece` …). The Slack commands are `/stats`, `/open`, `/recipe`, `/no-image`, `/new-image`, `/all-images`, `/check`, `/per-day`, `/neurons`, `/help`; the German names keep working. With `SLACK_APP_ID`/`SLACK_CONFIG_TOKEN` the bridge registers the English commands in Slack by itself. Status keywords in Tandoor (`geprüft`, `vorschlag-offen`, `nicht-bearbeiten`) and the logs stay German.

**AI photos:** Google Gemini "Nano Banana" (very realistic, paid), Cloudflare Workers AI (free) or OpenAI; if Google or OpenAI fails, Cloudflare steps in.

**Uniform picture style:** all AI photos use the same style – table, light, angle and tableware are defined in [`agents/bild-stil.md`](agents/bild-stil.md). New recipes always get an AI photo in this style, even if the source has its own photo; the agent only describes what the dish looks like (based on the source photo or the video stills). Change the style in that file (applies from the next picture, via GitHub without restart); `/all-images` brings all existing recipes to the style. `BILD_EINHEITLICH=aus` uses the source photo again.

## Setup with Portainer

The program comes as a **ready-made image** from GitHub: on every push to `main` (and every Monday with a fresh Claude Code) GitHub Actions builds `ghcr.io/sebastianinthewild/rezept-agent:latest` (`.github/workflows/image.yml`). `portainer/stack-host.yml` runs this image; the data lives in **one folder on the Docker host** (default `/home/sebastian/docker/rezepte`, change with `AGENTS_HOST_DIR`):

```
/home/sebastian/docker/rezepte/
  zeitplan.conf   when which agent runs (changes apply without restart)
  agents/         one folder per agent (agent.json + prompt.md), synced from GitHub every 10 minutes
  daten/          drafts, logs, backups, settings from the web UI
```

1. **Create the stack:** Portainer → Stacks → Add stack → **Repository**: URL of this repo, reference `refs/heads/main`, compose path `portainer/stack-host.yml`. Turn on **GitOps updates** (polling, e.g. 5 minutes, with **Re-pull image**) – then changes to the stack file arrive by themselves too.
2. **Image access:** if the repo is private, so is the image. Then add a GitHub token with `read:packages` in Portainer under **Registries → Add registry → GitHub** – or set the package to "Public" under GitHub → Packages → rezept-agent → Package settings.
3. **Deploy new images automatically** – one of these:
   - **Webhook (immediately):** turn on the **webhook** of the stack in Portainer, copy the URL and save it in the repo under Settings → Secrets → Actions as `PORTAINER_WEBHOOK`. After every build GitHub reloads the stack. Portainer must be reachable from the internet.
   - **What's Up Docker:** the labels in the stack let WUD detect new builds of `:latest`; with a Docker trigger in WUD the container is renewed automatically.

New or changed agents are simply pushed to GitHub (`agents/<name>/agent.json` + `prompt.md`, template `agents/_vorlage`): the container fetches `agents/` every 10 minutes (`AGENTS_SYNC`, "aus" = never) and picks them up without restart. Changes made directly on the host to agents from the repo are overwritten.

### Automatic updates

Everything that lands on `main` reaches the server by itself:

| What | How |
| --- | --- |
| `app/` (program), Claude Code | GitHub Actions builds a new image; Portainer webhook or WUD deploy it |
| `agents/` | from GitHub every 10 minutes (`AGENTS_SYNC`), without restart |
| `slack-app-manifest.yml` | part of the image; the Slack bridge pushes changes to Slack via the manifest API (`SLACK_APP_ID`, `SLACK_CONFIG_TOKEN`) and announces it in the channel. New permissions require reinstalling the app once by hand. |
| `portainer/stack-host.yml` | Portainer repository stack with **GitOps updates** |

Old folder variant (program in `app/` on the host, image `node`): there the sync also fetches `app/` and the manifest from GitHub and restarts afterwards (`APP_SYNC`, default on; only when `app/` is writable). With the image, `app/` and `npm/` on the host are no longer needed.

### Web UI

The web UI runs on port 8080 (`WEB_PORT`, password via `WEB_PASSWORT`).

- **Schedule:** set the times, see status and last run, start agents immediately with **Start now**, send the statistics with **Send now**, and set how many recipes the quality agent checks per day (default 5, stored in `daten/rezepte/einstellungen.json`).
- **Settings:** credentials and options – language, Claude, Tandoor, Slack, AI photos (provider, Google model, keys, style), videos, sync. They take precedence over the environment variables from Portainer and are stored in `daten/umgebung.json` (readable only by the container user). Empty field / "Delete entry" = use the value from Portainer again. Changes apply after **Restart now**. Tokens and keys can only be changed when `WEB_PASSWORT` is set and are only shown shortened (`••••1234`). `WEB_PASSWORT` itself stays in Portainer so you can't lock yourself out.

### Slack commands

Answers are only visible to you; `/check`, `/no-image`, `/new-image`, `/all-images` and `/per-day <number>` only work in the recipe channel. German names in brackets.

| Command | What it does |
| --- | --- |
| `/stats` (`/statistik`) | Recipe statistics: total, checked, open, still to check, without picture |
| `/open` (`/offen`) | Proposals waiting for a decision, with link |
| `/recipe <name>` (`/rezept`) | Search a recipe in Tandoor, with status |
| `/no-image [count \| name]` (`/ohne-bild`) | Recipes without a picture, each as its own message in the channel with a **🎨 Create picture** button (AI photo straight into Tandoor, then **🔄 Create another picture**). Default 5; recipes already shown come back after 7 days, with a name it searches specifically. Own photos are never replaced. |
| `/new-image <name \| ID>` (`/bild-neu`) | New AI picture from Google (`GOOGLE_BILD_MODELL`) for one recipe, even if it already has a photo. With several hits it lists them with IDs. |
| `/all-images` (`/bild-alle`) | Recreate all recipe pictures with Google. Asks twice (with count and estimated cost), only the person who asked can confirm. Runs in the background with progress and a **⏹️ Pause** button, continues after a restart, pauses after 3 errors in a row (e.g. Google quota). |
| `/check [count]` (`/pruefen`) | Start the quality check now; with a count it may check that many recipes on top of today's amount |
| `/per-day [count]` (`/pro-tag`) | Show or change recipes per day (like in the web UI) |
| `/neurons` (`/neuronen`) | Cloudflare neurons left today for AI photos |
| `/google` | Google usage this month: pictures, videos, estimated cost, today, last month and – with `GOOGLE_GUTHABEN` – remaining credit. A warning is posted once at 80 %. Estimated from the agent's own calls (Google doesn't expose the balance via the API key). |
| `/help` (`/hilfe`) | Overview |

With `/new-image` and `/all-images` the old picture is backed up to `daten/rezepte/sicherungen` first (180 days). If it can't be backed up, the recipe stays unchanged. Both use Google only, without Cloudflare as fallback, and don't count against `BILD_PRO_TAG`.

**Restart message:** after every container start (update, restart from the web UI, server reboot, crash) the agent posts to the recipe channel that it is running again – with the version (commit) and whether it was an update ("from … to …"). Turn it off with `NEUSTART_MELDUNG=aus` or in the web UI under Settings → Slack.

## Recipes from HelloFresh

Tandoor's own importer can't read HelloFresh pages. For HelloFresh links (all country sites, e.g. `hellofresh.com/recipes/…`) the container therefore reads the recipe itself from the page data: ingredients with amounts per number of servings (the agent takes 2 servings), steps with the ingredients used in each, utensils, times. Package amounts like "1 pack of cream" get the usual quantity added by the agent. If HelloFresh blocks the request, the agent asks for a screenshot of the recipe card or the text.

## Recipes from reels and shorts

Just send a link to an **Instagram reel** or **YouTube short** (also TikTok and regular YouTube videos up to 10 minutes) to the recipe channel:

1. `yt-dlp` fetches the caption and the video, `ffmpeg` grabs stills.
2. **Gemini** watches the video and writes down what is said and shown – ingredients, amounts, steps (uses `GEMINI_API_KEY`, model `GEMINI_VIDEO_MODELL`, default `gemini-flash-latest`; less than 1 cent per reel). Without a key there are only the caption and the stills.
3. The agent builds the recipe from that. If the caption links to a blog with the full recipe, it prefers that. The recipe photo is an AI photo in the uniform style; the agent uses the stills to describe the dish for it.

Instagram sometimes blocks requests without login. The agent then replies in the thread and asks for the caption as text or a screenshot. If that happens often, a cookie file of a (preferably second) Instagram account helps: `VIDEO_COOKIES=/data/daten/cookies.txt` (Netscape format, e.g. exported with a "Get cookies.txt" browser extension). Automated access is against Instagram's terms; the account may be blocked.

**Paste text:** longer text without a link (from about 80 characters or 3 lines), e.g. a copied caption, is also turned into a recipe.

## Credentials

As environment variables, in Portainer under "Environment variables" (template: `.env.example`) – or in the web UI under **Settings** (takes precedence, see above). Only `WEB_PASSWORT` always belongs in Portainer.

- **SPRACHE:** `de` (default) or `en`.
- **CLAUDE_CODE_OAUTH_TOKEN:** run `claude setup-token` on a computer with Claude Code.
- **TANDOOR_URL**, **TANDOOR_TOKEN:** Tandoor → Settings → API, scope "read write".
- **SLACK_BOT_TOKEN**, **SLACK_APP_TOKEN**, **SLACK_CHANNEL:** create the Slack app from `slack-app-manifest.yml`. Failed runs are also reported in the channel.
- **GEMINI_API_KEY:** for AI photos with Google Nano Banana and for reels/shorts (optional, about $0.03–0.04 per picture). Key at [aistudio.google.com](https://aistudio.google.com) → "Get API key", billing must be enabled. Choose the model with `GOOGLE_BILD_MODELL`: `gemini-nano-banana-2.1` (default), `gemini-2.5-flash-image` (older) or `gemini-3-pro-image` (best quality).
- **SLACK_APP_ID**, **SLACK_CONFIG_TOKEN:** optional, so changes to `slack-app-manifest.yml` (e.g. new commands, English command names) reach Slack by themselves. App ID under api.slack.com/apps → your app → Basic Information; token under api.slack.com/apps → at the bottom "Your App Configuration Tokens" → Generate Token, take the **refresh token** (`xoxe-1-…`). The container rotates it by itself afterwards (`daten/slack-config-token.json`).
- **BILD_ANBIETER:** optional `google`, `cloudflare` or `openai`; without it Google before Cloudflare before OpenAI. **BILD_PRO_TAG:** at most this many AI photos per day (default 10). **BILD_EINHEITLICH:** `an` (default) / `aus`.
- **CF_ACCOUNT_ID**, **CF_AI_TOKEN:** for AI photos (optional, free; fallback for Google). To show the free neurons after each photo and with `/neurons`, the token also needs "Account Analytics: Read".
- **OPENAI_API_KEY:** optional, for AI photos with OpenAI GPT Image (paid).
- **GEMINI_VIDEO_MODELL**, **VIDEO_MAX_SEKUNDEN**, **VIDEO_COOKIES:** optional, for reels and shorts (see above).
- **WEB_PASSWORT:** password for the web UI. Without it, credentials can't be changed there.

## Setup with Docker Compose

Builds the image locally from this repo (instead of pulling it from GitHub):

```sh
cp .env.example .env    # fill in
docker compose up -d --build
docker compose logs -f
```

## Usage

```sh
docker compose exec rezept-agent node /app/scheduler.mjs list
docker compose exec rezept-agent node /app/scheduler.mjs run rezept-qualitaet
```

## License

MIT · Author: SebastianInTheWild
