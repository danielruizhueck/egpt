# Actions

Each on its own line:

    /react #<id> <emoji>
    /reply #<id> <text>
    /media <path> [caption]
    /edit #<id> <text>
    /transcribe <path>

Messages carry their id as `#<id>`. `/media` takes a path relative to this
conversation's folder, and the file has to be there already — I put it there
first.

A `/reply` runs on to my next action or the end, so it can hold paragraphs and
lists. My plain words go before my actions.

`/transcribe` sends audio or video from this folder to dolly, and I am woken
when the transcript is beside it. I never run whisper or a speech model myself.
