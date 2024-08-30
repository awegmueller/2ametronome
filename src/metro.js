// See: https://github.com/scottwhudson/metronome?tab=readme-ov-file
// See: https://grantjam.es/creating-a-simple-metronome-using-javascript-and-the-web-audio-api/

class DomUtil {
    toggleCssClass(element, className, condition) {
        let value = element.getAttribute('class') || '';
        if (value) {
            // attribute value exists
            let containsClassName = value.indexOf(className) > -1;
            if (condition) {
                if (!containsClassName) {
                    value += ' ' + className;
                }
            } else {
                if (containsClassName) {
                    value = value.replaceAll(className, '');
                }
            }
        } else {
            // attribute does not exist or is empty
            if (condition) {
                value = className;
            }
        }
        if (value) {
            element.setAttribute('class', value.trim());
        } else {
            element.removeAttribute('class');
        }
    }

    /**
     * @returns {[]}
     */
    elementsByTagName(parent, tagName) {
        return Array.prototype.slice.call(parent.getElementsByTagName(tagName));
    }
}

// -------------------

class Metronome {

    static BEATS_PER_BAR = 4;  // TODO: interpret 'measure' from song

    constructor(bpm, callback) {
        this.audioContext = null;
        this.bpm = bpm;
        this.lookahead = 25;          // How frequently to call scheduling function (in milliseconds)
        this.scheduleAheadTime = 0.1; // How far ahead to schedule audio (sec)
        this.nextNoteTime = 0.0;      // When the next note is due
        this.isRunning = false;
        this.intervalID = null;
        this.callback = callback;
        this.muted = false;

        this.currentBeatInBar = 0;
        this.currentBeat = 0; // Overall beats since start
    }

    nextBeep() {
        // Advance current note and time by a quarter note (crotchet if you're posh)
        let secondsPerBeat = 60.0 / this.bpm; // Notice this picks up the CURRENT tempo value to calculate beat length.
        this.nextNoteTime += secondsPerBeat; // Add beat length to last beat time

        this.currentBeat++;
        this.currentBeatInBar++; // Advance the beat number, wrap to zero
        if (this.currentBeatInBar === Metronome.BEATS_PER_BAR) {
            this.currentBeatInBar = 0;
        }
    }

    scheduleBeep(beat, beatInBar, time) {
        let bar = Math.floor(this.currentBeat / Metronome.BEATS_PER_BAR);
        this.callback(beat, bar, beatInBar, true);
        if (!this.muted) {
            this.beep(beatInBar, time);
        }
    }

    beep(beatInBar, time) {
        // Create an oscillator
        const osc = this.audioContext.createOscillator();
        const envelope = this.audioContext.createGain();

        osc.frequency.value = (beatInBar % Metronome.BEATS_PER_BAR === 0) ? 1000 : 800;
        envelope.gain.value = 1;
        envelope.gain.exponentialRampToValueAtTime(1, time + 0.001);
        envelope.gain.exponentialRampToValueAtTime(0.001, time + 0.02);

        osc.connect(envelope);
        envelope.connect(this.audioContext.destination);

        osc.start(time);
        osc.stop(time + 0.03);
    }

    scheduler() {
        // while there are notes that will need to play before the next interval, schedule them and advance the pointer.
        while (this.nextNoteTime < this.audioContext.currentTime + this.scheduleAheadTime) {
            this.scheduleBeep(this.currentBeat, this.currentBeatInBar, this.nextNoteTime);
            this.nextBeep();
        }
    }

    start() {
        if (this.isRunning) {
            return;
        }
        if (this.audioContext == null) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        this.isRunning = true;
        this.nextNoteTime = this.audioContext.currentTime + 0.05;
        this.intervalID = setInterval(() => this.scheduler(), this.lookahead);
    }

    stop(reset = false) {
        if (reset) {
            this.currentBeat = 0;
            this.currentBeatInBar = 0;
            this.muted = false;
            this.callback(0, 0, 0, false);
        }
        this.isRunning = false;
        clearInterval(this.intervalID);
    }

    setMuted(muted) {
        this.muted = muted;
    }
}

// -------------------
class Metro {

    static PLAYLIST_URL = './playlist.json';

    static STATE_PLAYING = 'playing';
    static STATE_PAUSED = 'paused';
    static STATE_STOPPED = 'stopped';

    static DEFAULT_MEASURE = '4/4';
    static DEFAULT_DURATION = '0:00';

    static NULL_SONG = {
      title: 'Play a song',
      bpm: 0,
      index: -1
    };

    constructor() {
        this.playlist = null;
        this.playlistRowTemplate = null;
        this.metronome = null;
        this.state = Metro.STATE_STOPPED;
        this.domUtil = new DomUtil();
        this.settings = new MetroSettings(this.onPlaylistUploaded.bind(this));
        this.currentSong = Metro.NULL_SONG;
    }

    startup() {
        this.settings.init();
        this.addEventListeners();
        this.loadPlaylist()
            .then(playlist => this.renderPlaylist(playlist));
    }

    addEventListeners() {
        document.getElementById('stopButton').addEventListener('click', this.onClickStopButton.bind(this));
        document.getElementById('pausePlayButton').addEventListener('click', this.onClickPausePlayButton.bind(this));
        document.getElementById('previousSongButton').addEventListener('click', this.onClickPreviousSongButton.bind(this));
        document.getElementById('nextSongButton').addEventListener('click', this.onClickNextSongButton.bind(this));
    }

    async loadPlaylist() {
        const response = await fetch(Metro.PLAYLIST_URL);
        if (!response.ok) { // check if response worked (no 404 errors etc...)
            throw new Error(response.statusText);
        }
        return response.json(); // get JSON from the response; returns a promise, which resolves to this data value
    }

    onPlaylistUploaded(playlist) {
        if (this.state !== Metro.STATE_STOPPED) {
            this.setState(Metro.STATE_STOPPED); // FIXME: deal with case that metronome is not initialized yet
        }
        this.renderPlaylist(playlist);
        this.setCurrentSong(Metro.NULL_SONG);
    }

    setCurrentSong(currentSong) {
        this.currentSong = currentSong;
        this.renderCurrentSong();
    }

    renderCurrentSong() {
        let song = this.currentSong;
        document.getElementById('currentSongNo').innerHTML = song.index === -1 ? '&nbsp;' : '' + (song.index + 1);
        document.getElementById('currentSongTitle').innerText = song.title;
        document.getElementById('currentSongBpm').innerText = '' + song.bpm;

        let songInfos = '';
        if (song.autoStop) {
            songInfos = 'Auto-Stop: ' + song.autoStop;
        } else if (song.autoSilence) {
            songInfos = 'Auto-Silence: ' + song.autoSilence;
        }
        document.getElementById('songInfos').innerText = songInfos;

        let navButtonsDisabled = song === Metro.NULL_SONG;
        this.domUtil.toggleCssClass(document.getElementById('previousSongButton'), 'disabled', navButtonsDisabled);
        this.domUtil.toggleCssClass(document.getElementById('nextSongButton'), 'disabled', navButtonsDisabled);
    }

    renderPlaylist(playlist) {
        console.log('Playlist loaded', playlist);
        this.playlist = playlist;

        // Use cached template or read from DOM when called for the first time
        if (!this.playlistRowTemplate) {
            this.playlistRowTemplate = document.getElementById('playlistRowTemplate');
            this.playlistRowTemplate.remove(); // Remove template from DOM
        }

        document.getElementById('playlistTitle').innerText = playlist.title;
        let tableBody = document.querySelector('#playlist > tbody');

        // Remove existing rows
        this.domUtil.elementsByTagName(tableBody, 'tr').forEach(tr => tr.remove());

        // Add new rows
        let numSongs = playlist.songs.length;
        let duration = 0;
        for (let i = 0; i < numSongs; i++) {
            let song = playlist.songs[i];
            if (!song.title) {
                throw new Error('playlist.json: missing mandatory "title" attribute');
            }
            if (!song.bpm) {
                throw new Error('playlist.json: missing mandatory "bpm" attribute');
            }
            song.index = i; // Append property 'index' (not configured)
            if (!song.measure) {
                song.measure = Metro.DEFAULT_MEASURE;
            }
            if (!song.duration) {
                song.duration = Metro.DEFAULT_DURATION;
            }
            this.setDurationInSeconds(song);
            let row = this.playlistRowTemplate.cloneNode(true);
            row.removeAttribute('id');
            row.getElementsByClassName('songNo')[0].innerText = i + 1;
            row.getElementsByClassName('songTitle')[0].innerText = song.title;
            row.getElementsByClassName('songBpm')[0].innerText = this.labelBpm(song.bpm);
            row.getElementsByClassName('playButton')[0].addEventListener('click',
                this.onClickPlaySong.bind(this, i));

            tableBody.appendChild(row);
            duration += song.durationInSeconds;
        }

        document.getElementById('playlistSubtitle').innerText = numSongs + ' Songs - Duration: ' + this.formatDuration(duration);
        document.getElementById('playlistContainer').scrollTo(0, 0);
    }

    formatDuration(seconds) {
        return this.padWithZero(Math.floor(seconds / 60)) + ':' + this.padWithZero(seconds % 60);
    }

    padWithZero(number) {
        if (number < 10) {
            return '0' + number;
        }
        return '' + number;
    }

    setDurationInSeconds(song) {
        let duration = song.duration;
        let parts = duration.split(":");
        if (parts.length !== 2) {
            throw new Error('Illegal format for duration. Expected: mm:ss, actual=' + duration);
        }
        let minutes = parseInt(parts[0]);
        let seconds = parseInt(parts[1]);
        song.durationInSeconds = minutes * 60 + seconds;
    }

    onClickPlaySong(songIndex) {
        this.playSong(songIndex);
    }

    playSong(songIndex) {
        let song = this.playlist.songs[songIndex];
        this.setCurrentSong(song);

        let table = document.getElementById('playlist');
        let trs = table.getElementsByTagName('tr');
        for (let i = 0; i < trs.length; i++) {
            this.domUtil.toggleCssClass(trs[i], 'now-playing', song.index === i);
        }

        this.newMetronome(song.bpm);
        this.setState(Metro.STATE_PLAYING);
    }

    newMetronome(bpm) {
        if (this.metronome) {
            this.metronome.stop();
        }
        this.metronome = new Metronome(bpm, this.onBeatChange.bind(this));
        this.metronome.start();
    }

    setState(state) {
        if (this.state === Metro.STATE_STOPPED) {
            if (state === Metro.STATE_PLAYING) {
                this.metronome.start();
            } else {
                throw new Error('illegal state');
            }
        } else if (this.state === Metro.STATE_PAUSED) {
            if (state === Metro.STATE_PLAYING) {
                this.metronome.start();
            } else if (state === Metro.STATE_STOPPED) {
                this.metronome.stop(true);
            } else {
                throw new Error('illegal state');
            }
        } else if (this.state === Metro.STATE_PLAYING) {
            if (state === Metro.STATE_PAUSED) {
                this.metronome.stop();
            } else if (state === Metro.STATE_STOPPED) {
                this.metronome.stop(true);
            } else if (state === Metro.STATE_PLAYING) { // New song clicked
                this.metronome.start();
            } else {
                throw new Error('illegal state');
            }
        } else {
            throw new Error('illegal state');
        }

        this.state = state;
        this.renderStopButton();
        this.renderPausePlayButton();
    }

    scrollSongIntoView(songIndex) {
        let trs = document.getElementById('playlist').getElementsByTagName('tr');
        trs[songIndex].scrollIntoView();
    }

    isButtonDisabled(element) {
        return element.getAttribute('class').indexOf('disabled') > -1;
    }

    onClickPreviousSongButton(event) {
        if (this.isButtonDisabled(event.target)) {
            return;
        }
        let index = this.currentSong.index - 1;
        if (index < 0) {
            index = this.playlist.songs.length - 1;
        }
        this.playSong(index);
        this.scrollSongIntoView(index);
    }

    onClickNextSongButton(event) {
        if (this.isButtonDisabled(event.target)) {
            return;
        }
        let index = this.currentSong.index + 1;
        if (index >= this.playlist.songs.length) {
            index = 0;
        }
        this.playSong(index);
        this.scrollSongIntoView(index);
    }

    onClickStopButton(event) {
        if (this.isButtonDisabled(event.target)) {
            return;
        }
        if (this.state === Metro.STATE_PLAYING || this.state === Metro.STATE_PAUSED) {
            this.setState(Metro.STATE_STOPPED);
        }
    }

    onClickPausePlayButton(event) {
        if (this.isButtonDisabled(event.target)) {
            return;
        }
        if (this.state === Metro.STATE_PLAYING) {
            this.setState(Metro.STATE_PAUSED);
        } else if (this.state === Metro.STATE_PAUSED || this.state === Metro.STATE_STOPPED) {
            this.setState(Metro.STATE_PLAYING);
        }
    }

    renderStopButton() {
        let $stopButton = document.getElementById('stopButton');
        let disabled = this.state === Metro.STATE_STOPPED;
        this.domUtil.toggleCssClass($stopButton, 'disabled', disabled);
    }

    renderPausePlayButton() {
        let $pausePlayButton = document.getElementById('pausePlayButton');
        let disabled = !this.currentSong;
        this.domUtil.toggleCssClass($pausePlayButton, 'disabled', disabled);
        if (this.state === Metro.STATE_PLAYING) {
            $pausePlayButton.setAttribute('src', './img/pause-circle-color.svg')
        } else if (this.state === Metro.STATE_PAUSED || this.state === Metro.STATE_STOPPED) {
            $pausePlayButton.setAttribute('src', './img/play-circle-color.svg')
        }
    }

    /**
     * 0 based values. We need to add 1 for values in the GUI, configuration.
     */
    onBeatChange(beat, bar, beatInBar, running) {
        this.renderBeat(beat, bar, beatInBar, running)

        if (this.currentSong.autoStop && (bar + 1) > this.currentSong.autoStop) {
            this.setState(Metro.STATE_STOPPED);
        }
        if (this.currentSong.autoSilence && (bar + 1) > this.currentSong.autoSilence) {
            this.mute();
        }
    }

    mute() {
        this.metronome.setMuted(true);
    }

    renderBeat(beat, bar, beatInBar, running) {
        document.getElementById('currentBar').innerText = running ? (bar + 1) : '-';
        document.getElementById('currentBeatInBar').innerText = running ? (beatInBar + 1) : 0;
        let $metronome = document.getElementById('metronome');
        if (!running) {
            $metronome.removeAttribute('class');
        } else if (beatInBar === 0) {
            $metronome.setAttribute('class', 'first-beat');
        } else {
            $metronome.setAttribute('class', 'beat-' + (beatInBar % 2));
        }
    }

    labelBpm(bpm) {
        return bpm + ' bpm';
    }
}

// ------------------
class MetroSettings {

    constructor(callback) {
        this.callback = callback;
    }

    init() {
        document.getElementById('fileInput').addEventListener('change', this.onFileInputChange.bind(this));
    }

    onFileInputChange(event) {
        const file = event.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    let playlist = JSON.parse(event.target.result);
                    this.callback(playlist);
                } catch (error) {
                    console.error('Failed to parse playlist JSON', error);
                }
            };
            reader.readAsText(file);
        }
    }
}

let metro = new Metro();
metro.startup();

// TODO: Playlist im local storage persistieren
// TODO: countIn anders visualisieren (grün) und andere töne
// TODO: Fortschrittsbalken (Dauer)
// TODO: Töne konfigurierbar(-er)
// TODO: autoStop ein/aus (Checkbox)

// DONE: Playlist hochladen, Metro#setPlaylist implementieren
// DONE: autoStop anzeigen
// DONE: property für autoSilence ergänzen
// DONE: Buttons für next/prev. song
// DONE: Spielzeit pro Song und Summe für Playlist
