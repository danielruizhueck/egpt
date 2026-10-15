<!--
  INSTALL-eGPT.x.md: installs eGPT on a Mac. A TEXTECUTABLE (see config/skeletons/script.x.md,
  MANUAL.md section 3): plain-text steps that Claude executes with its tools.

  Unlike other textecutables, a PERSON runs this one, interactively: they open `claude` in the
  downloaded eGPT folder and say «instala eGPT». Do not run it with src/tools/textecute.mjs or from
  a heartbeat. It asks questions and waits for the answers.

  It reproduces the install done on a Mac on 2026-10-13, with the fixes learned that day.
-->

# Instalar eGPT en un Mac

## How to run this script (for Claude)

- Run the steps in order. Ask **one question at a time** and wait for the answer. Keep the questions
  plain: the person may not be technical.
- Narrate briefly as you go: one short line per step, saying what you are doing and why.
- **Speak the person's language.** The Spanish lines in «» are canonical; translate them if the
  person writes in another language.
- Keep a list of the answers, using these names: `NAME` (the assistant), `KEY`, `HOUSE`, `PERSON`,
  `FINAL`, `LEVEL`, `MODEL`, `VOICE`, `WA`, `ADMIN`, `IDS`.
- `CHECKOUT` is the folder this file is in: `git rev-parse --show-toplevel`. Run every command from
  there unless the step says otherwise.
- **Secrets.** These rules apply to the Beeper token and the `claude setup-token` token.
  - Never ask anyone to paste a token into this chat.
  - A token travels from the clipboard to the config file through a pipe (`pbpaste | …`). After
    that, empty the clipboard with `pbcopy </dev/null`.
  - Never print, echo or grep a token. Never pass one as a command argument, and never write one
    to any file other than `~/.egpt/config/config.yaml`.
  - Never leave a token file on the Desktop or anywhere else. On 2026-10-13 one was left on the
    Desktop.
  - Once the token is in `config.yaml`, **never open that file** with Read or `cat`. Change it only
    with the `node` snippets below, and check it with the masked view (step 7).
- **Be conservative.** The first install answers only in the admin group. Every other chat is
  recorded, never answered.
- If a step fails, say which step and why, then stop. Do not improvise around it, and do not edit
  eGPT's code.

### The Beeper helper

Many steps call Beeper Desktop's local API with the token from `config.yaml`. This is the
command, run from `CHECKOUT`. It never prints the token. In the steps below it is written as
`beeper METHOD PATH [BODY]`:

```sh
node --input-type=module -e '
import { readConfigSync } from "./src/tools/config-io.mjs";
const [method, path, body] = process.argv.slice(1);
const r = await fetch("http://127.0.0.1:23373" + path, { method, body, headers: {
  Authorization: "Bearer " + readConfigSync().beeper.main.token, "Content-Type": "application/json" } });
console.log(r.status, (await r.text()).slice(0, 4000));' METHOD PATH 'BODY'
```

URL-encode a chat id inside a path: `!abc:beeper.local` becomes `%21abc%3Abeeper.local`. If it
cannot connect, run `node src/tools/beeper-whoami.mjs --ports` to see which port Beeper took, and
use that port instead.

## 1. Bienvenida

Get the computer name with `scutil --get ComputerName`, then say:

> Hola, bienvenido a la era de asistentes super inteligentes.
> El nombre de este computador es <ComputerName>. Tu asistente "vive" ahí: tu computador es su "cuerpo".
> La e de eGPT viene de "e-ncarnado"; GPT viene de "Generar Probabilísticamente Texto".

Then give a short outline: a few questions, some programs, WhatsApp through Beeper, a test, and
how to stop it. Say it takes about an hour.

## 2. Is this the right machine?

- `uname -s` must print `Darwin`. If not, say this installer is only for Mac, and stop.
- If `${EGPT_HOME:-$HOME/.egpt}/config/config.yaml` or
  `~/Library/LaunchAgents/com.egpt.daemon.plist` exists, eGPT is already installed here. Say so,
  and stop. This installer never touches an existing install.

## 3. Questions (one at a time)

1. «¿Cómo se va a llamar tu asistente?» → `NAME`.
   - `KEY` is `NAME` in lowercase, without accents or spaces, matching `[a-z0-9][a-z0-9_-]*`.
   - `KEY` is both its handle and its identity in the config. People call it by writing `KEY`
     (for example «em, ¿qué tal?»).
2. The name of its house, which is this node. Suggest a short derivative of `NAME`, 2 or 3
   letters (for example, assistant «em» → house «om»), and ask «¿te gusta <sugerencia>?» → `HOUSE`.
   - It must match `[a-z0-9][a-z0-9_-]*`.
   - It is the node's signature, invisible in every message it sends. Another eGPT node that shares
     a chat with this one must not use the same name, or each will take the other's messages for
     its own.
3. «¿Cómo te llamas?» → `PERSON` (it shows up as `user_name`).
4. «¿Vas a usar eGPT, o también a programarlo?»
   - To use it: `FINAL=~/bin/egpt`.
   - To program it: `FINAL=~/src/egpt`.
   - Write `FINAL` as an absolute path. Everything you configure from here on points at `FINAL`.
     The folder itself moves there at the very end (step 13).
   - If `FINAL` already exists and is not `CHECKOUT`, ask what to do. Never overwrite it.
5. The level → `LEVEL`. Explain the three levels in plain words:
   - **Básico.** One WhatsApp number, and only the admin group can give it orders. This is what
     was installed on 2026-10-13.
   - **Básico 2.** Like Básico, plus «la caja»: outside the admin group, the assistant works inside
     a box of the operating system that limits what it can touch on the computer.
     - Check support now:
       `node -e "import('./src/posix-box.mjs').then(m=>process.exit(m.isPosixBoxPlatform('darwin')?0:1),()=>process.exit(1))"`
     - If it fails, say: «El nivel Básico 2 necesita una versión más nueva de eGPT; seguimos con el
       Básico.» Then set `LEVEL=1`.
   - **Intermedio.** A second WhatsApp number of its own. It hears your chats and replies from its
     own number. On Mac this is not ready yet. Explain the outline below, then continue with Básico
     (or Básico 2).
     - What it takes, as the Windows nodes do it (NODE-SHAPE.md, `setup/*beeper-s0*`):
       - A second Beeper Desktop install with its own data folder, logged in to the assistant's
         number, with its own token.
       - Config `beeper.primary`, your account (the ear), and `beeper.secondary`, its number (the
         mouth). Each has `account`, `token` and `phone`.
       - An admin group containing both numbers.
     - Not verified on macOS:
       - running two Beeper Desktops at once (`--user-data-dir`);
       - keeping both open after a restart;
       - renewing their tokens (on Windows that is `setup/renew-beeper-token.ps1`).
     - What already works: if the assistant only needs its own number, and does not need to read
       your chats, that is Básico with its number connected in Beeper instead of yours.
6. «¿Qué número de WhatsApp vas a conectar?» The assistant reads, and keeps a record of, every
   chat of the number connected in Beeper. It answers only in the admin group.
   - If they connect their own number, say plainly that their chats will be recorded on this Mac.
7. «¿Quién más puede darle órdenes?» These people join the admin group.
   - WhatsApp needs at least one person besides the connected number. That can be another number of
     their own, for example their personal one if they connect the business one.
   - Get each person's name as saved in that WhatsApp's contacts, or their number.
   - If there is nobody at all, stop. Say that a group of one does not exist in WhatsApp, and that
     this installer has not tested the alternative (the chat with oneself).
8. «¿Prefieres un asistente equilibrado o el más capaz? El más capaz es más lento y gasta más de tu
   plan de Claude.» Equilibrado → `MODEL=sonnet`; más capaz → `MODEL=opus`.
9. «¿Quieres que entienda notas de voz?» → `VOICE`. It needs about 3 GB free (`df -h ~`).

## 4. Programs

- **Homebrew.** Check with `brew --version`.
  - If it is missing, the person installs it in their own Terminal with the command from brew.sh.
    It asks for their Mac password, which is why they type it themselves, not you.
  - Then continue.
- **Node 22 or newer.** Check with `node -v`. Install with `brew install node`.
- **git.** Check with `git --version`. If macOS offers to install the developer tools, accept.
- If `VOICE`: `brew install ffmpeg whisper.cpp` (`whisper.cpp` used to be called `whisper-cpp`).
- In `CHECKOUT`: `npm ci`.

## 5. Beeper and WhatsApp

eGPT reaches WhatsApp through Beeper Desktop, which must stay open.

1. «Descarga Beeper Desktop desde beeper.com, ábrelo y entra con tu cuenta.» Wait for it.
2. «En Beeper, conecta WhatsApp con el número que elegiste (escaneas un código con el móvil).» Wait.
3. «En Beeper: Ajustes → Integraciones (Developers) → Desktop API: activa "Allow connections".»
   - Check: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:23373/.well-known/oauth-authorization-server`
     must print `200`.
4. eGPT will start by itself at login (step 11), so Beeper must too:
   «Haz que Beeper se abra solo al entrar en el Mac: clic derecho en su icono del Dock → Opciones →
   Abrir al iniciar sesión.» Wait for it.

## 6. Config file

```sh
mkdir -p ~/.egpt/config && chmod 700 ~/.egpt ~/.egpt/config
cp config/skeletons/config.yaml ~/.egpt/config/config.yaml && chmod 600 ~/.egpt/config/config.yaml
```

Edit `~/.egpt/config/config.yaml` with Edit now, before the token goes in. Keep the skeleton's
comments. Delete the `ken` and `wren` agents, and rename the `egpt` agent to `KEY`. The
uncommented keys must end up like this:

```yaml
beeper:
  main:
    account: "WhatsApp de PERSON"     # a label
    token: "PASTE_YOUR_TOKEN_HERE"     # stays like this; step 7 writes the real token
node_name: HOUSE
user_name: "PERSON"
wake_up:
  enabled: false                       # read only by a Windows script
agents:
  KEY:
    configuration:
      type: ccode
      model: MODEL
      effort: high
      personality: egpt
    handles: [KEY]
    default: true
    name: "NAME"
    conversation_defaults:
      allowed_users: []                # filled in at step 8
      access_level: regular            # unset = 'sandbox' (the OS box); without the box, every turn on a Mac is refused
      sandboxed: false
networks:
  whatsapp:
    chat_ids: []                       # filled in at step 8: the admin group
    allowed_users: []                  # filled in at step 8
  telegram: { chat_ids: [], allowed_users: [] }
  signal:   { chat_ids: [], allowed_users: [] }
dispatch:
  auto_default_mode: mute              # every chat is recorded and never answered, unless told otherwise
turn_timeout_ms: 600000
```

If `VOICE` is set, add this block. Use the real paths from `command -v whisper-cli ffmpeg` and
the real home folder; step 9 downloads the model.
Transcription stays off here and is switched on for the admin group only, at step 12. Wherever it
is on, a 🎧 appears on voice notes while they are transcribed, and the people in that chat would see
it.

```yaml
transcription_service:
  enabled: false
  posts_back: false
  use_config: main
  main:
    fallback_order: [local]
    local:
      type: whisper-cli
      command: /opt/homebrew/bin/whisper-cli
      model_path: /Users/<you>/.egpt/models/ggml-large-v3-q5_0.bin
      language: auto
      ffmpeg_command: /opt/homebrew/bin/ffmpeg
```

If `LEVEL=2`, also add the top-level line `sandbox_oauth_token: "PEGAR_AQUI"`, and change
`access_level: regular` to `access_level: sandbox`. Remove the line `sandboxed: false`: next to
`sandbox`, it stops the node from starting.

## 7. Beeper token

1. Say:
   «En Beeper: Ajustes → Integraciones (Developers) → Desktop API. Aprueba una conexión nueva,
   ponla en "never expire" y pulsa su botón de copiar. No la pegues aquí ni en ningún archivo:
   dime "listo" cuando esté copiada.»
2. Then run:
   `pbpaste | node setup/set-beeper-token.mjs main; pbcopy </dev/null`
   - It prints only the token's length and a fingerprint.
3. Check: `beeper GET /v1/accounts` must answer `200`.
   - Note the WhatsApp entry's `accountID` → `WA` (usually `whatsapp`).
   - Note the `matrix` entry's `user.id` (something like `@name:beeper.com`). This is the owner,
     and it goes into `IDS`.
4. `ls ~/Desktop ~/Documents ~/Downloads | grep -i token`. If they saved the token in a file, say
   so and offer to move it to the Trash.

**Masked view.** Use this from now on to look at the config:

```sh
node --input-type=module -e '
import { readConfigSync } from "./src/tools/config-io.mjs";
const c = readConfigSync();
if (c.beeper?.main?.token) c.beeper.main.token = "<oculto>";
if (c.sandbox_oauth_token) c.sandbox_oauth_token = "<oculto>";
console.log(JSON.stringify(c, null, 1));'
```

## 8. Admin group

1. For each person from question 3.7, run `beeper GET "/v1/accounts/WA/contacts?query=<name or number>"`.
   - Use the item whose `id` starts with `lid-`.
   - **Never a bare phone number.** On 2026-10-13 a group created with one came back "created"
     without that person in it. The API cannot add members later.
   - If there is no `lid-` item, look for the person in a chat this number already has with them:
     `beeper GET "/v1/chats/search?query=<name>&limit=5"`. Take the `id` from that chat's
     participants, which looks like `@whatsapp_lid-…:beeper.local`.
2. Propose a title, «Admin NAME». Let them change it, then create the group:
   `beeper POST /v1/chats '{"accountID":"WA","type":"group","participantIDs":["lid-…"],"title":"<title>"}'`
   - **A `404` with `"Chat not found: !<id>:beeper.local"` means it worked.** Creation is
     asynchronous, and that `<id>` is the new group.
   - Wait about 15 seconds, then run `beeper GET /v1/chats/<encoded id>`.
   - Everyone must be in `participants.items`. If someone is missing, create the group again with
     the right ids, and ask the person to delete the wrong group from their phone.
3. `ADMIN` is the id without `!` and `:beeper.local`.
   - `IDS` is the owner's id plus every other participant's `id` (`@whatsapp_lid-…:beeper.local`).
4. Write them into the config. `writeConfigKey` is the edit `/config set` uses: it replaces only
   the value and keeps the comments.

   ```sh
   node --input-type=module -e '
   import { writeConfigKey, CONFIG_YAML_PATH as f } from "./src/tools/config-io.mjs";
   const [admin, ids, key] = [process.argv[1], JSON.parse(process.argv[2]), process.argv[3]];
   await writeConfigKey(f, "networks.whatsapp.chat_ids", [admin]);
   await writeConfigKey(f, "networks.whatsapp.allowed_users", ids);
   await writeConfigKey(f, `agents.${key}.conversation_defaults.allowed_users`, ids);
   console.log("lista escrita");' 'ADMIN' '["@…", "@whatsapp_lid-…:beeper.local"]' 'KEY'
   ```
5. Check the result with the masked view.

## 9. Voice notes (only if `VOICE`)

The model is `ggml-large-v3-q5_0.bin`: large-v3, not turbo (chosen on 2026-10-13), with
`language: auto` (step 6).

```sh
mkdir -p ~/.egpt/models && curl -fL -o ~/.egpt/models/ggml-large-v3-q5_0.bin.part \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin \
  && mv ~/.egpt/models/ggml-large-v3-q5_0.bin.part ~/.egpt/models/ggml-large-v3-q5_0.bin
```

- The download is about 1.1 GB. Say: «La descarga es de 1,1 GB: según tu conexión, de unos minutos
  a media hora o más.»
- It can outlast the time limit of one command, so run it in the background and go on with the next
  steps. Before step 12, check that `~/.egpt/models/ggml-large-v3-q5_0.bin` exists (not `.part`).

## 10. La caja (only if `LEVEL=2`)

1. Say:
   «Abre la app Terminal y escribe `claude setup-token`. Se abrirá el navegador para que entres;
   al final verás un código largo. Cópialo, no lo pegues aquí, y dime "listo".»
2. Then run:

   ```sh
   pbpaste | node --input-type=module -e '
   import { readFileSync, writeFileSync } from "node:fs";
   import { spliceYamlScalar, CONFIG_YAML_PATH as f } from "./src/tools/config-io.mjs";
   const t = readFileSync(0, "utf8").trim();
   if (!/^\S{20,}$/.test(t)) { console.error("el portapapeles no tiene un token"); process.exit(1); }
   writeFileSync(f, spliceYamlScalar(readFileSync(f, "utf8"), ["sandbox_oauth_token"], { expect: "PEGAR_AQUI", to: t }));
   console.log("sandbox_oauth_token escrito (" + t.length + " caracteres)");'; pbcopy </dev/null
   ```
3. The admin group stays outside the box. At step 12 it gets `access_level all`, and on a Mac its
   `sandboxed` already defaults to false. Every other chat resolves to `sandbox`.

## 11. Start at login, and desktop icons

eGPT runs in the background as a LaunchAgent, `com.egpt.daemon`: macOS starts it when the person
logs in and starts it again if it crashes. No Terminal window has to stay open.

### The LaunchAgent

1. Collect: `HOMEDIR` = `echo $HOME`, `NODE` = `command -v node`, and `command -v claude`.
   - eGPT looks for `claude` in `HOMEDIR/.local/bin` first, then on the `PATH` below. If it is in
     neither, put its folder at the front of that `PATH`.
2. `mkdir -p ~/.egpt/config/logs ~/Library/LaunchAgents`. launchd does not create the log folder.
3. Write `~/Library/LaunchAgents/com.egpt.daemon.plist` with Write. Write every path out in full:
   launchd does not expand `~` or `$HOME`. `DIR` is `CHECKOUT` for now; step 13 changes it to
   `FINAL`.

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key>
     <string>com.egpt.daemon</string>
     <key>ProgramArguments</key>
     <array>
       <string>NODE</string>
       <string>egpt-daemon.mjs</string>
     </array>
     <key>WorkingDirectory</key>
     <string>DIR</string>
     <key>EnvironmentVariables</key>
     <dict>
       <key>EGPT_HOME</key>
       <string>HOMEDIR/.egpt</string>
       <key>EGPT_SESSION1</key>
       <string>1</string>
       <key>PATH</key>
       <string>HOMEDIR/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
       <key>LANG</key>
       <string>en_US.UTF-8</string>
     </dict>
     <key>RunAtLoad</key>
     <true/>
     <key>KeepAlive</key>
     <dict>
       <key>PathState</key>
       <dict>
         <key>HOMEDIR/.egpt/STOP</key>
         <false/>
       </dict>
       <key>SuccessfulExit</key>
       <false/>
     </dict>
     <key>ThrottleInterval</key>
     <integer>10</integer>
     <key>ProcessType</key>
     <string>Interactive</string>
     <key>StandardOutPath</key>
     <string>HOMEDIR/.egpt/config/logs/daemon-launchd.out.log</string>
     <key>StandardErrorPath</key>
     <string>HOMEDIR/.egpt/config/logs/daemon-launchd.err.log</string>
   </dict>
   </plist>
   ```

   Why each key. Change none of them without reading this.
   - `KeepAlive` = `{PathState: {HOMEDIR/.egpt/STOP: false}, SuccessfulExit: false}`. launchd
     ORs the two conditions:
     - While there is no STOP file, eGPT is kept alive, whatever made it exit.
     - While the STOP file exists, launchd relaunches it only after an error. `egpt-daemon.mjs`
       exits with 0 only when someone wanted it off: STOP (in the chat, the Detener icon, the
       lasso, or a STOP file present at boot), a stop signal (logout, `launchctl bootout`), or a
       second copy refusing to start. It handles `/upgrade`, `/restart` and `/rewind` (exit codes
       42, 43, 44) and spine crashes itself, without exiting.
     - So a STOPped eGPT stays down, and launchd watches the file: the moment it is deleted
       (`rm ~/.egpt/STOP`, or the Arrancar icon), launchd starts eGPT again by itself.
     - The path must be the profile's own STOP file: `HOMEDIR/.egpt` is `EGPT_HOME`.
     - Why not plain `KeepAlive: true`: on 2026-10-15 launchd relaunched a STOPped eGPT every 10
       seconds for an hour, 327 times, and each relaunch refused to start.
     - Why not only `SuccessfulExit: false`: a STOPped eGPT then stays down even after the file
       is deleted, until someone runs `launchctl kickstart`.
     - Tested on macOS 26 with a stand-in job: STOP plus exit 0 gave no relaunch for 25 seconds,
       and deleting the file started it within a second.
   - `ProgramArguments` runs `egpt-daemon.mjs`, never `egpt-spine.mjs`: the daemon is what brings
     the spine back after `/restart` and `/upgrade`.
   - `EGPT_SESSION1=1`: launchd runs eGPT inside the person's login session, the Mac equivalent of
     Session 1 on a Windows node; a Mac has no Session 0 service. Only a Session 1 daemon holds the
     browsers (`src/chrome-host.mjs`): without it eGPT launches no Chrome. At boot such a spine
     first asks another eGPT on this profile to hand over; when there is none, nothing happens.
   - `PATH`: launchd's own `PATH` has neither Homebrew (`node`, `ffmpeg`, `whisper-cli`) nor
     `~/.local/bin` (`claude`).
   - `LANG`: launchd sets no language; without it, the shell tools eGPT runs treat accented
     letters as raw bytes, not letters.
   - `RunAtLoad` starts it at login. `ThrottleInterval` keeps relaunches 10 seconds apart.
     `ProcessType Interactive` stops macOS from slowing it down as a background job.
   - The daemon and the spine write their output to the two `daemon-launchd` logs.
4. Check: `plutil -lint ~/Library/LaunchAgents/com.egpt.daemon.plist` must end in `OK`. Do not
   load it yet: step 12 does that, through the Arrancar icon.

### Desktop icons

Create these two files on the Desktop and `chmod +x` both. Write `FINAL` out in the Detener icon.
Double-click opens them in Terminal. macOS may ask for permission to use the Desktop folder; say
yes.

`~/Desktop/Arrancar eGPT.command`:

```zsh
#!/bin/zsh -l
# Arrancar eGPT: quita el freno (STOP) si lo hay y enciende eGPT. Si ya estaba encendido, lo
# reinicia. eGPT funciona en segundo plano: esta ventana se puede cerrar.
export EGPT_HOME="${EGPT_HOME:-$HOME/.egpt}"
S="gui/$(id -u)/com.egpt.daemon"
if [ -f "$EGPT_HOME/STOP" ]; then
  cat "$EGPT_HOME/STOP"; rm "$EGPT_HOME/STOP"; echo "Freno quitado."
  # launchd vigila el freno: al quitarlo, enciende eGPT él solo. Si no lo hizo, se le pide.
  sleep 3
  launchctl print "$S" 2>/dev/null | grep -q 'state = running' || launchctl kickstart "$S" 2>/dev/null
elif launchctl print "$S" >/dev/null 2>&1; then launchctl kickstart -k "$S"
fi
launchctl print "$S" >/dev/null 2>&1 || launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.egpt.daemon.plist"
sleep 5
if launchctl print "$S" 2>/dev/null | grep -q 'state = running'; then echo "eGPT está encendido. Puedes cerrar esta ventana."
else echo "eGPT no arrancó. Mira $EGPT_HOME/config/logs/daemon-launchd.err.log"; fi
```

`~/Desktop/Detener eGPT.command`:

```zsh
#!/bin/zsh -l
# Detener eGPT: pone el freno (el archivo STOP). eGPT se apaga en menos de un minuto y no
# vuelve a arrancar, tampoco al reiniciar el Mac, hasta que se quite el freno: doble clic en
# «Arrancar eGPT».
cd "FINAL" || exit 1
export EGPT_HOME="${EGPT_HOME:-$HOME/.egpt}"
node --input-type=module -e "import('./src/stop-guard.mjs').then((m) => console.log(m.writeStopFile({
  reason: 'Detener eGPT.command', who: process.env.USER, where: 'icono del escritorio' })
  ? 'Freno puesto: eGPT se apaga en menos de un minuto.' : 'eGPT ya estaba detenido.'))"
```

Check both with `zsh -n <file>`.

## 12. Trial run

The trial runs from `CHECKOUT`, before the move: the LaunchAgent points there until step 13.

1. Beeper must be open. Then `open "$HOME/Desktop/Arrancar eGPT.command"`: it loads the
   LaunchAgent, and launchd starts eGPT.
2. Check that launchd runs it:
   `launchctl print "gui/$(id -u)/com.egpt.daemon" | grep -E '^\s(state|pid|last exit code) = '`
   must show `state = running`.
   - Wait until `~/.egpt/state/spine.pid` exists and its process is alive.
   - `beeper GET /v1/chats/<encoded ADMIN>/messages?limit=5` must show «✅ egpt started».
   - If something fails, read the last lines of `daemon-launchd.err.log`, `daemon-launchd.out.log`
     and `beeper.log`, in `~/.egpt/config/logs/`. eGPT writes there, not to a window.
3. Say that you will write two orders in the admin group in their name. Then post each one with
   `beeper POST /v1/chats/<encoded ADMIN>/messages '{"text":"…"}'`:
   - `/agents mode on KEY`: it answers every message in this group.
   - `/agents access_level all KEY`: it has full access to the computer, only in this group.
   - Read the group's messages and check the node confirmed both.
4. If `VOICE`: the group's folder is the `conversation_path` of the `ADMIN` entry in
   `~/.egpt/config/conversations.yaml` (relative to the home folder). Create `config.yaml` in that
   folder:

   ```yaml
   transcription_service:
     enabled: true
   ```
5. «Escribe "hola NAME" en el grupo desde tu móvil.» Wait for the reply. If `VOICE`, also ask for
   a short voice note.
6. «Ahora escribe solo "stop" en el grupo. Así aprendes a detenerlo.»
   - The group must show «🛑 STOP received», and `~/.egpt/STOP` must exist.
   - The spine's process must be gone.
   - It must stay down. Wait 20 seconds (twice `ThrottleInterval`) and run the `launchctl print`
     line from 12.2 again: it must show `last exit code = 0` and must not show `state = running`.
     If eGPT came back, the plist's `KeepAlive` is wrong: fix it (step 11) before going on.
7. Say: «Ahora quito el freno, y eGPT vuelve a encenderse solo.» Run `rm ~/.egpt/STOP`.
   - Within 15 seconds the `launchctl print` line must show `state = running`, and the group
     «✅ egpt started».
   - If it stays down, the `PathState` key is missing or names another path: fix it (step 11),
     then start it with `launchctl kickstart "gui/$(id -u)/com.egpt.daemon"`.

## 13. Move and start (last command)

Run this as **one** Bash command, with absolute paths. It is the last command of the install,
because it moves the folder this session is working in. It unloads the LaunchAgent, moves the
folder, points the LaunchAgent at `FINAL`, and starts eGPT with the Arrancar icon, as the person
will.

```sh
T0=$(mktemp) && P="$HOME/Library/LaunchAgents/com.egpt.daemon.plist" \
  && { launchctl bootout "gui/$(id -u)/com.egpt.daemon" 2>/dev/null; true; } \
  && mkdir -p "$(dirname "FINAL")" && mv "CHECKOUT" "FINAL" \
  && plutil -replace WorkingDirectory -string "FINAL" "$P" && plutil -lint "$P" \
  && open "$HOME/Desktop/Arrancar eGPT.command" \
  && for i in {1..45}; do [ "$HOME/.egpt/state/spine.pid" -nt "$T0" ] && break; sleep 2; done; \
  [ "$HOME/.egpt/state/spine.pid" -nt "$T0" ] && echo "eGPT arrancó desde FINAL" || echo "eGPT no arrancó: mira ~/.egpt/config/logs/daemon-launchd.err.log"
```

- If `CHECKOUT` is already `FINAL`, leave out the `mkdir` and the `mv`.
- If `CHECKOUT/.git` is a file (a git worktree), replace the `mv` with
  `git -C "CHECKOUT" worktree move "CHECKOUT" "FINAL"`.

After it, run nothing more in this session.

## 14. Closing words

Say, in this order:

1. Where eGPT lives now (`FINAL`). It works in the background: the Terminal window «Arrancar
   eGPT» just opened can be closed, and closing Terminal does not stop eGPT.
2. «Escríbele en el grupo admin. En los demás chats solo escucha y guarda: no contesta.»
3. eGPT starts by itself when they turn on the Mac and log in, and comes back by itself if it
   crashes. Beeper opens at login too (step 5). If the Mac sleeps, the assistant does not answer
   until it wakes.
4. To change something later, open `claude` in `FINAL`.
5. Last, section 15.

## 15. Cómo detener eGPT

The last thing the install says. Say it word for word (translated if needed), heading included:

**Cómo detener eGPT**

- Escribe **stop** en el grupo admin. Solo esa palabra: da igual mayúsculas o minúsculas, y puede
  llevar un punto o un signo de exclamación al final. En cualquier otro chat, «stop» es texto
  normal.
- Puede hacerlo cualquiera de la lista de autorizados (`allowed_users`: tú y las personas que
  añadiste). STOP detiene toda la actividad de eGPT de forma estructural: lo para el propio
  programa, no depende de que el asistente obedezca.
- Qué pasa: contesta «🛑 STOP received», pone un freno (el archivo `~/.egpt/STOP`) y se apaga
  entero en este computador: deja de leer, de responder y de hacer sus tareas programadas.
  Mientras el freno exista, no vuelve a arrancar, tampoco al reiniciar el Mac.
- Sin WhatsApp: doble clic en **Detener eGPT**, en el Escritorio. Hace lo mismo; se apaga en
  menos de un minuto.
- Para volver a encenderlo: doble clic en **Arrancar eGPT**, en el Escritorio. Quita el freno, y
  eGPT se enciende solo en cuanto el freno desaparece. Borrar el archivo `~/.egpt/STOP` a mano
  hace lo mismo.
- Cerrar Beeper **no** lo detiene. eGPT sigue funcionando sin poder leer ni escribir en WhatsApp,
  termina lo que estaba haciendo y se reconecta cuando Beeper vuelve a abrirse.
- Cerrar Terminal tampoco lo detiene: funciona en segundo plano. Apagar el Mac sí, pero al volver
  a entrar arranca solo, salvo que el freno esté puesto.
- Todo esto detiene eGPT **solo en este computador**. Lo que tu asistente haya dejado funcionando
  en otro sitio sigue funcionando y hay que apagarlo donde vive. Si con eGPT se montó una
  automatización en la nube, STOP ya no puede contenerla. Por ejemplo:
  - activadores en la nube (Apps Script, Zapier, Make);
  - agentes o rutinas programadas en la nube;
  - webhooks;
  - otras sesiones de Claude en este computador con sus propias tareas programadas.
- Consejo: pídele a tu asistente que lleve una lista de todo lo que monte fuera de eGPT, y de cómo
  apagar cada cosa, en `files/AUTOMATIZACIONES.md`, dentro de la carpeta del grupo admin
  (`~/.egpt/conversations/whatsapp/<grupo>/files/`).
