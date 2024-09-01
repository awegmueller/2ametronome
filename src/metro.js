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
        this.tone = MetroSettings.TONE_CLICK;
        this.pitch = MetroSettings.PITCH_DEFAULT;

        this.currentBeatInBar = 0;
        this.currentBeat = 0; // Overall beats since start
    }

    nextTone() {
        // Advance current note and time by a quarter note (crotchet if you're posh)
        let secondsPerBeat = 60.0 / this.bpm; // Notice this picks up the CURRENT tempo value to calculate beat length.
        this.nextNoteTime += secondsPerBeat; // Add beat length to last beat time

        this.currentBeat++;
        this.currentBeatInBar++; // Advance the beat number, wrap to zero
        if (this.currentBeatInBar === Metronome.BEATS_PER_BAR) {
            this.currentBeatInBar = 0;
        }
    }

    scheduleTone(beat, beatInBar, time) {
        let bar = Math.floor(this.currentBeat / Metronome.BEATS_PER_BAR);
        this.callback(beat, bar, beatInBar, true);
        if (!this.muted) {
            switch (this.tone) {
                case MetroSettings.TONE_CLICK:
                    this.makeClickTone(beatInBar, time);
                    break;
                case MetroSettings.TONE_SINE:
                    this.makeSineTone(beatInBar, time);
                    break;
                default:
                    throw new Error('Unsupported tone "' + this.settings.tone + '"');
            }
        }
    }

    calcFrequency(frequency) {
        let modifier = 1;
        if (this.pitch === MetroSettings.PITCH_LOW) {
            modifier = 0.75;
        } else if (this.pitch === MetroSettings.PITCH_HIGH) {
            modifier = 1.5;
        }
        return frequency * modifier;
    }

    makeClickTone(beatInBar, time) {
        const osc = this.audioContext.createOscillator();
        const envelope = this.audioContext.createGain();

        osc.frequency.value = this.calcFrequency((beatInBar % Metronome.BEATS_PER_BAR === 0) ? 1200 : 1000);
        envelope.gain.value = 1;
        envelope.gain.exponentialRampToValueAtTime(1, time + 0.001);
        envelope.gain.exponentialRampToValueAtTime(0.001, time + 0.02);

        osc.connect(envelope);
        envelope.connect(this.audioContext.destination);

        osc.start(time);
        osc.stop(time + 0.03);
    }

    makeSineTone(beatInBar, time) {
        const frequency = this.calcFrequency((beatInBar % Metronome.BEATS_PER_BAR === 0) ? 1568 : 1046);
        const duration = 50;
        const osc = this.audioContext.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(frequency, this.audioContext.currentTime);

        const gainNode = this.audioContext.createGain();
        gainNode.gain.setValueAtTime(1, this.audioContext.currentTime);

        osc.connect(gainNode);
        gainNode.connect(this.audioContext.destination);

        osc.start(); // TODO: use time parameter
        osc.stop(this.audioContext.currentTime + duration / 1000); // duration in seconds
    }

    scheduler() {
        // while there are notes that will need to play before the next interval, schedule them and advance the pointer.
        while (this.nextNoteTime < this.audioContext.currentTime + this.scheduleAheadTime) {
            this.scheduleTone(this.currentBeat, this.currentBeatInBar, this.nextNoteTime);
            this.nextTone();
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

    setTone(tone) {
        this.tone = tone;
    }
    setPitch(pitch) {
        this.pitch = pitch;
    }

}

// -------------------
class Metro {

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
        this.settings = new MetroSettings(this.onSettingsChange.bind(this));
        this.currentSong = Metro.NULL_SONG;
    }

    startup() {
        this.initDomTemplates();
        this.settings.init();
        this.addEventListeners();
        if (this.settings.playlist) {
            this.setPlaylist(this.settings.playlist);
        }
        if (this.settings.songIndex > -1) {
            this.setCurrentSong(this.songAtIndex(this.settings.songIndex));
        }
    }

    initDomTemplates() {
        // Use cached template or read from DOM when called for the first time
        this.playlistRowTemplate = document.getElementById('playlistRowTemplate');
        this.playlistRowTemplate.remove(); // Remove template from DOM
    }

    addEventListeners() {
        document.getElementById('stopButton').addEventListener('click', this.onClickStopButton.bind(this));
        document.getElementById('pausePlayButton').addEventListener('click', this.onClickPausePlayButton.bind(this));
        document.getElementById('previousSongButton').addEventListener('click', this.onClickPreviousSongButton.bind(this));
        document.getElementById('nextSongButton').addEventListener('click', this.onClickNextSongButton.bind(this));
        document.getElementById('loadPlaylistLink').addEventListener('click', this.onClickPlaylistLink.bind(this));
        document.getElementById('settingsMenu').addEventListener('click', this.onClickSettingsMenu.bind(this));
        document.getElementById('closeSettingsMenu').addEventListener('click', this.onClickCloseSettingsMenu.bind(this));
    }

    onClickSettingsMenu(event) {
        this.toggleSettingsPopup(true);
    }

    onClickCloseSettingsMenu(event) {
        this.toggleSettingsPopup(false);
    }

    toggleSettingsPopup(settingsVisible) {
        this.domUtil.toggleCssClass(document.getElementById('metronomeContainer'), 'hidden', settingsVisible);
        this.domUtil.toggleCssClass(document.getElementById('playlistContainer'), 'hidden', settingsVisible);
        this.domUtil.toggleCssClass(document.getElementById('settingsPopup'), 'hidden', !settingsVisible);
    }

    onSettingsChange(event) {
        if (event.property === 'playlist') {
            if (this.state !== Metro.STATE_STOPPED) {
                this.setState(Metro.STATE_STOPPED);
            }
            this.toggleSettingsPopup(false);
            this.setPlaylist(event.value);
        } else if (event.property === 'tone') {
            this.metronome.setTone(event.value);
        } else if (event.property === 'pitch') {
            this.metronome.setPitch(event.value);
        }
    }

    setCurrentSong(currentSong) {
        this.currentSong = currentSong;
        this.settings.setSongIndex(currentSong.index);
        this.renderCurrentSong();
        this.renderPausePlayButton();
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

        let table = document.getElementById('playlist');
        let trs = table.getElementsByTagName('tr');
        for (let i = 0; i < trs.length; i++) {
            this.domUtil.toggleCssClass(trs[i], 'now-playing', song.index === i);
        }
    }

    setPlaylist(playlist) {
        console.log('setPlaylist', playlist);
        this.playlist = playlist;
        playlist.songs.forEach((song, i) => this.initSong(song, i));
        this.renderPlaylist();
        this.setCurrentSong(this.songAtIndex(0));
    }

    initSong(song, songIndex) {
        if (!song.title) {
            throw new Error('playlist.json: missing mandatory "title" attribute');
        }
        if (!song.bpm) {
            throw new Error('playlist.json: missing mandatory "bpm" attribute');
        }
        song.index = songIndex; // Append property 'index' (not configured)
        if (!song.measure) {
            song.measure = Metro.DEFAULT_MEASURE;
        }
        if (!song.duration) {
            song.duration = Metro.DEFAULT_DURATION;
        }
        this.initSongDurationInSeconds(song);
    }

    initSongDurationInSeconds(song) {
        let duration = song.duration;
        let parts = duration.split(":");
        if (parts.length !== 2) {
            throw new Error('Illegal format for duration. Expected: mm:ss, actual=' + duration);
        }
        let minutes = parseInt(parts[0]);
        let seconds = parseInt(parts[1]);
        song.durationInSeconds = minutes * 60 + seconds;
    }

    renderPlaylist(playlist) {
        this.domUtil.toggleCssClass(document.getElementById('playlistHeader'), 'hidden', false);
        this.domUtil.toggleCssClass(document.getElementById('playlistTableContainer'), 'hidden', false);
        this.domUtil.toggleCssClass(document.getElementById('playlistPlaceholder'), 'hidden', true);

        document.getElementById('playlistTitle').innerText = this.playlist.title;
        let tableBody = document.querySelector('#playlist > tbody');

        // Remove existing rows
        this.domUtil.elementsByTagName(tableBody, 'tr').forEach(tr => tr.remove());

        // Add new rows
        let songs = this.playlist.songs;
        let numSongs = songs.length;
        let duration = 0;
        for (let i = 0; i < numSongs; i++) {
            let song = songs[i];
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

    onClickPlaySong(songIndex) {
        this.playSong(songIndex);
    }

    songAtIndex(songIndex) {
        return this.playlist.songs[songIndex];
    }

    playSong(songIndex) {
        let song = this.songAtIndex(songIndex);
        this.setCurrentSong(song);
        this.newMetronome(song.bpm);
        this.setState(Metro.STATE_PLAYING);
    }

    newMetronome(bpm) {
        if (this.metronome) {
            this.metronome.stop();
        }
        this.metronome = new Metronome(bpm, this.onBeatChange.bind(this));
        this.metronome.setTone(this.settings.tone);
        this.metronome.setPitch(this.settings.pitch);
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

    onClickPlaylistLink(event) {
        document.getElementById('fileInput').click();
    }

    onClickPreviousSongButton(event) {
        if (this.isButtonDisabled(event.target)) {
            return;
        }
        let index = this.currentSong.index - 1;
        if (index < 0) {
            index = this.playlist.songs.length - 1;
        }
        this.navigateToSong(index);
    }

    onClickNextSongButton(event) {
        if (this.isButtonDisabled(event.target)) {
            return;
        }
        let index = this.currentSong.index + 1;
        if (index >= this.playlist.songs.length) {
            index = 0;
        }
        this.navigateToSong(index);
    }

    navigateToSong(index) {
        if (this.settings.autoPlayEnabled) {
            this.playSong(index);
        } else {
            if (this.state !== Metro.STATE_STOPPED) {
                this.setState(Metro.STATE_STOPPED);
            }
            this.setCurrentSong(this.songAtIndex(index));
        }
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
            this.newMetronome(this.currentSong.bpm);
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
        let disabled = this.currentSong === Metro.NULL_SONG;
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

        if (!this.settings.autoStopSilenceEnabled) {
            return;
        }
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

    static TONE_CLICK = 'click';
    static TONE_SINE = 'sine';

    static PITCH_HIGH = 'high';
    static PITCH_DEFAULT = 'default';
    static PITCH_LOW = 'low';

    constructor(callback) {
        this.callback = callback;
        this.playlist = null;
        this.songIndex = -1;
        this.tone = MetroSettings.TONE_CLICK;
        this.pitch = MetroSettings.PITCH_DEFAULT;
        this.autoPlayEnabled = true;
        this.autoStopSilenceEnabled = true;
    }

    init() {
        let storedSettings = localStorage.getItem('settings');
        if (storedSettings) {
            let settings = JSON.parse(storedSettings);
            this.playlist = settings.playlist;
            this.tone = settings.tone;
            this.pitch = settings.pitch;
            this.songIndex = settings.songIndex;
            this.autoPlayEnabled = settings.autoPlayEnabled;
            this.autoStopSilenceEnabled = settings.autoStopSilenceEnabled;
        } else {
            this.storeSettings();
        }
        this.checkRadio(this.tone);
        this.selectOption(this.pitch);
        this.checkCheckbox('autoPlayEnabled', this.autoPlayEnabled);
        this.checkCheckbox('autoStopSilenceEnabled', this.autoStopSilenceEnabled);
        this.addEventListeners();
    }

    checkRadio(value) {
        document.querySelectorAll('input[type="radio"]').forEach(radio => {
            if (radio.value === value) {
                radio.checked = true;
            }
        })
    }

    checkCheckbox(elementId, value) {
        document.getElementById(elementId).checked = value;
    }

    selectOption(value) {
        document.querySelectorAll('option').forEach(option => {
            option.selected = option.value === value;
        })
    }

    storeSettings() {
        localStorage.setItem('settings', JSON.stringify({
            playlist: this.playlist,
            songIndex: this.songIndex,
            tone: this.tone,
            pitch: this.pitch,
            autoPlayEnabled: this.autoPlayEnabled,
            autoStopSilenceEnabled: this.autoStopSilenceEnabled
        }));
    }

    addEventListeners() {
        document.getElementById('fileInput').addEventListener('change', this.onFileInputChange.bind(this));
        document.querySelectorAll('input[type="radio"]').forEach(radio =>
            radio.addEventListener('change', this.onToneRadioChange.bind(this)));
        document.getElementById('pitch').addEventListener('change', this.onPitchChange.bind(this));
        document.getElementById('autoPlayEnabled').addEventListener('change', this.onCheckboxChange.bind(this));
        document.getElementById('autoStopSilenceEnabled').addEventListener('change', this.onCheckboxChange.bind(this));
    }

    onPitchChange(event) {
        let pitch = event.target.value;
        console.log('Pitch changed ', pitch);
        this.pitch = pitch;
        this.storeSettings();
        this.callback({
            property: 'pitch',
            value: pitch
        })
    }

    onToneRadioChange(event) {
        let tone = event.target.value;
        console.log('Tone selected ', tone);
        this.tone = tone;
        this.storeSettings();
        this.callback({
            property: 'tone',
            value: tone
        })
    }

    onCheckboxChange(event) {
        let checkbox = event.target;
        console.log('Checkbox ' + checkbox.id + ' checked', checkbox.checked);
        this[checkbox.id] = checkbox.checked;
        this.storeSettings();
        this.callback({
            property: checkbox.id,
            value: checkbox.checked
        })
    }

    onFileInputChange(event) {
        let file = event.target.files[0];
        if (file) {
            let reader = new FileReader();
            reader.onload = (event) => {
                try {
                    let playlist = JSON.parse(event.target.result);
                    this.playlist = playlist;
                    this.storeSettings();
                    this.callback({
                        property: 'playlist',
                        value: playlist
                    });
                } catch (error) {
                    console.error('Failed to parse playlist JSON', error);
                }
            };
            reader.readAsText(file);
        }
    }

    setSongIndex(songIndex) {
        this.songIndex = songIndex;
        this.storeSettings();
    }
}

let metro = new Metro();
metro.startup();

// TODO: countIn anders visualisieren (grün) und andere töne
// TODO: Fortschrittsbalken (Dauer)
// TODO: build / class-files separieren

// DONE: Setup-Screen
// DONE: GUI drehbar landscape/portrait
// DONE: autoStop ein/aus (Settings)
// DONE: initial selektierten song korrekt darstellen und buttons enablen
// DONE: Playlist im local storage persistieren
// DONE: Töne konfigurierbar(-er)
// DONE: Playlist hochladen, Metro#setPlaylist implementieren
// DONE: autoStop anzeigen
// DONE: property für autoSilence ergänzen
// DONE: Buttons für next/prev. song
// DONE: Spielzeit pro Song und Summe für Playlist
