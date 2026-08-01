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
// Type definitions for the objects of a playlist JSON file. The format is documented for the user
// in howto-playlist.html. Every playlist we read is turned into these classes, so that the rest of
// the code never touches raw JSON.

class Song {

    static DEFAULT_MEASURE = '4/4';
    static DEFAULT_DURATION = '0:00';

    /**
     * @param data raw song object of a playlist JSON file
     * @param index 0 based position of the song in the playlist (derived, not configured)
     */
    constructor(data, index) {
        this.index = index; // Append property 'index' (not configured)
        this.title = data.title;
        this.bpm = data.bpm;
        this.measure = data.measure || Song.DEFAULT_MEASURE; // TODO: never read, see Metronome.BEATS_PER_BAR
        this.duration = data.duration || Song.DEFAULT_DURATION; // Format: m:ss
        this.durationInSeconds = Song.parseDuration(this.duration); // Derived, not configured
        this.autoStop = data.autoStop ? Song.durationOrBars(data.autoStop, data.bpm) : null;
        this.autoSilence = data.autoSilence ? Song.durationOrBars(data.autoSilence, data.bpm) : null;
        this.info = data.info || null; // Free text, displayed in #songInfo
    }

    /**
     * @throws Error if a mandatory property is missing
     */
    validate() {
        if (!this.title) {
            throw new Error('playlist.json: missing mandatory "title" attribute');
        }
        if (!this.bpm) {
            throw new Error('playlist.json: missing mandatory "bpm" attribute, song "' + this.title + '"');
        }
    }

    /**
     * @param duration in the format m:ss
     * @returns {number} the duration [s]
     */
    static parseDuration(duration) {
        let parts = duration.split(':');
        if (parts.length !== 2) {
            throw new Error('Illegal format for duration. Expected: m:ss, actual=' + duration);
        }
        return parseInt(parts[0]) * 60 + parseInt(parts[1]);
    }

    static durationOrBars(value, bpm) {
        if (typeof value === 'number') {
            return value;
        }
        // Assume duration format m:ss
        let durationInSeconds = Song.durationToSeconds(value);
        let beatsPerSecond = bpm / 60;
        let beats = durationInSeconds * beatsPerSecond;
        let bars = Math.ceil(beats / Metronome.BEATS_PER_BAR);
        return bars;
    }

    static durationToSeconds(duration) {
        let parts = duration.split(":");
        if (parts.length !== 2) {
            throw new Error('Illegal format for duration. Expected: mm:ss, actual=' + duration);
        }
        let minutes = parseInt(parts[0]);
        let seconds = parseInt(parts[1]);
        return minutes * 60 + seconds;
    }

    /**
     * @returns {string} label for auto stop / auto silence, empty if the song has neither
     */
    autoInfoLabel() {
        if (this.autoStop) {
            return 'Auto stop: ' + this.autoStop;
        }
        if (this.autoSilence) {
            return 'Auto silence: ' + this.autoSilence;
        }
        return '';
    }
}

class Playlist {

    static DEFAULT_TITLE = 'Playlist';

    /**
     * @param data raw playlist object of a playlist JSON file
     * @throws Error if the playlist or one of its songs is invalid
     */
    constructor(data) {
        // Note: a playlist file may also carry 'countIn', which is not supported yet (TODO)
        this.title = data.title || Playlist.DEFAULT_TITLE;
        this.songs = (data.songs || []).map((songData, index) => new Song(songData, index));
        this.validate();
    }

    validate() {
        if (!this.songs.length) {
            throw new Error('playlist.json: "songs" must contain at least one song');
        }
        this.songs.forEach(song => song.validate());
    }

    /**
     * @returns {Song}
     */
    songAt(index) {
        return this.songs[index];
    }

    /**
     * @returns {number} playing time of all songs [s]
     */
    durationInSeconds() {
        return this.songs.reduce((total, song) => total + song.durationInSeconds, 0);
    }
}

// -------------------

class Metronome {

    static VERSION = '1.01';

    static BEATS_PER_BAR = 4;  // TODO: interpret 'measure' from song
    static SCHEDULING_INTERVAL = 25; // [ms] How frequently to call scheduling function (in milliseconds)
    static SCHEDULE_AHEAD_TIME = 0.1; // [s] How far ahead to schedule audio (sec)

    constructor(bpm, callback) {
        this.audioContext = null;
        this.bpm = bpm;
        this.nextNoteTime = 0.0;      // When the next note is due
        this.isRunning = false;
        this.intervalID = null;
        this.callback = callback;
        this.muted = false;
        this.tone = MetroSettings.TONE_CLICK;
        this.pitch = MetroSettings.PITCH_DEFAULT;

        this.currentBeatInBar = 0;
        this.currentBeat = 0; // Overall beats since start
        this.loopDetection = 0;
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
        osc.stop(this.audioContext.currentTime + duration / 1000); // Duration in seconds
    }

    scheduler() {
        // This can happen on some smartphone browsers (like Chrome on Android), if the AudioContext is initialized
        // too fast or too often. It should not happen anymore, because we now call the #close method. But you never know...
        if (this.audioContext.currentTime === 0) {
            this.loopDetection++;
            if (this.loopDetection === 100) {
                let errorMessage = 'Sorry, the audio system appears to be broken. Please reload this app / page.';
                alert(errorMessage);
                throw new Error(errorMessage);
            }
        }

        // While there are notes that will need to play before the next interval, schedule them and advance the pointer.
        while (this.nextNoteTime < this.audioContext.currentTime + Metronome.SCHEDULE_AHEAD_TIME) {
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
        this.intervalID = setInterval(() => this.scheduler(), Metronome.SCHEDULING_INTERVAL);
    }

    dispose() {
        this.stop();
        this.audioContext.close();
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

    /**
     * Minimum size of each of the two main containers, as a fraction of the size the app has on the device.
     * Its height in portrait mode, its width in landscape mode.
     */
    static SPLIT_MIN = 0.33;

    /** Placeholder as long as no song is selected. Not validated on purpose: it has no bpm. */
    static NULL_SONG = new Song({title: 'Play a song', bpm: 0}, -1);

    constructor() {
        this.playlist = null;
        this.playlistRowTemplate = null;
        this.metronome = null;
        this.state = Metro.STATE_STOPPED;
        this.domUtil = new DomUtil();
        this.settings = new MetroSettings(this.onSettingsChange.bind(this));
        this.currentSong = Metro.NULL_SONG;
        this.drag = null; // Separator drag state, only set while dragging
        this.muted = false; // Muted by the user, see #muteButton
        this.autoSilenced = false; // Muted by the autoSilence of the current song
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
        this.renderMuteButton();
        this.applySplit();
        this.updatePlaylistMaxHeight();
    }

    /**
     * Called on every pointermove while dragging the separator: keep it free of console output.
     */
    updatePlaylistMaxHeight() {
        let $container = document.getElementById('playlistTableContainer');
        let playlistMaxHeight = Math.floor(window.innerHeight - $container.getBoundingClientRect().top);
        $container.setAttribute('style', 'max-height:' + playlistMaxHeight + 'px');
    }

    /**
     * Must stay in sync with the orientation media queries in metro.css.
     */
    isPortrait() {
        return window.matchMedia('(orientation: portrait)').matches;
    }

    /**
     * The size the two main containers share, i.e. without the separator.
     */
    availableSplitSize() {
        let $root = document.getElementById('rootContainer');
        let $separator = document.getElementById('separator');
        return this.isPortrait()
            ? $root.clientHeight - $separator.offsetHeight
            : $root.clientWidth - $separator.offsetWidth;
    }

    /**
     * @returns {number} minimum size of each container [px]: SPLIT_MIN of the size the app has on
     *          the device - its height in portrait mode, its width in landscape mode.
     */
    minSplitSize() {
        return Math.round(Metro.SPLIT_MIN * (this.isPortrait() ? window.innerHeight : window.innerWidth));
    }

    /**
     * @param size wanted size of #metronomeContainer [px]
     * @param available size shared by both containers [px], see availableSplitSize()
     * @returns {number} size of #metronomeContainer [px], keeping both containers at minSplitSize()
     */
    clampSplitSize(size, available) {
        let min = this.minSplitSize();
        if (2 * min > available) {
            // Both minimums do not fit, e.g. in a small desktop browser window: split evenly
            return Math.round(available / 2);
        }
        return Math.min(available - min, Math.max(min, size));
    }

    /**
     * Applies the stored size of the current orientation, if there is one.
     */
    applySplit() {
        this.renderSplit(this.isPortrait() ? this.settings.splitPortrait : this.settings.splitLandscape);
    }

    /**
     * @param fraction size of #metronomeContainer, 0..1 - or null to fall back to the sizes from the CSS
     */
    renderSplit(fraction) {
        let $metronomeContainer = document.getElementById('metronomeContainer');
        let $playlistContainer = document.getElementById('playlistContainer');

        // Always drop the inline sizes first: they are orientation specific and must not leak
        // into the other orientation on device rotation.
        [$metronomeContainer, $playlistContainer].forEach($container => {
            $container.style.width = '';
            $container.style.height = '';
        });
        if (!fraction) {
            return;
        }

        let available = this.availableSplitSize();
        let metronomeSize = this.clampSplitSize(Math.round(available * fraction), available);
        if (this.isPortrait()) {
            // Block layout: #playlistContainer simply takes what is left below the separator,
            // its scroll area is sized by updatePlaylistMaxHeight().
            $metronomeContainer.style.height = metronomeSize + 'px';
        } else {
            // Flex layout: both sizes have to add up, otherwise the flex items would shrink.
            $metronomeContainer.style.width = metronomeSize + 'px';
            $playlistContainer.style.width = (available - metronomeSize) + 'px';
        }
    }

    onPointerDownSeparator(event) {
        let $separator = document.getElementById('separator');
        let $metronomeContainer = document.getElementById('metronomeContainer');
        let portrait = this.isPortrait();
        // Route all following pointer events to the separator, whatever the pointer is dragged over
        $separator.setPointerCapture(event.pointerId);
        this.drag = {
            portrait: portrait,
            available: this.availableSplitSize(),
            startPosition: portrait ? event.clientY : event.clientX,
            startSize: portrait ? $metronomeContainer.offsetHeight : $metronomeContainer.offsetWidth,
            fraction: null
        };
        event.preventDefault();
    }

    onPointerMoveSeparator(event) {
        if (!this.drag) {
            return;
        }
        let delta = (this.drag.portrait ? event.clientY : event.clientX) - this.drag.startPosition;
        let available = this.drag.available;
        let metronomeSize = this.clampSplitSize(this.drag.startSize + delta, available);
        // Store the size as a fraction, so it survives a change of the window size
        this.drag.fraction = metronomeSize / available;
        this.renderSplit(this.drag.fraction);
        this.updatePlaylistMaxHeight();
    }

    onPointerUpSeparator(event) {
        if (!this.drag) {
            return;
        }
        let drag = this.drag;
        this.drag = null;
        if (drag.fraction === null) {
            return; // A click without a move: nothing changed
        }
        console.log('Separator dragged, ' + (drag.portrait ? 'portrait' : 'landscape') + ' size', drag.fraction);
        this.settings.setSplit(drag.portrait, drag.fraction);
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
        document.getElementById('muteButton').addEventListener('click', this.onClickMuteButton.bind(this));
        document.getElementById('settingsMenu').addEventListener('click', this.onClickSettingsMenu.bind(this));
        document.getElementById('closeSettingsMenu').addEventListener('click', this.onClickCloseSettingsMenu.bind(this));

        let $separator = document.getElementById('separator');
        $separator.addEventListener('pointerdown', this.onPointerDownSeparator.bind(this));
        $separator.addEventListener('pointermove', this.onPointerMoveSeparator.bind(this));
        let pointerUpHandler = this.onPointerUpSeparator.bind(this);
        $separator.addEventListener('pointerup', pointerUpHandler);
        $separator.addEventListener('pointercancel', pointerUpHandler);

        let deviceRotationHandler = this.onDeviceRotation.bind(this);
        window.addEventListener('resize', deviceRotationHandler, false);
        window.addEventListener('orientationchange', deviceRotationHandler, false);

        window.addEventListener('keyup', this.onKeyupWindow.bind(this));
    }

    onKeyupWindow(event) {
        if (event.keyCode === 80) { // P
            this.onClickPreviousSongButton(); 
        } else if (event.keyCode === 78) { // N
            this.onClickNextSongButton(); 
        } else if (event.keyCode === 32) { // Space
            this.onClickPausePlayButton();
        } else if (event.keyCode === 83) { // S
            this.onClickStopButton();
        } else if (event.keyCode === 77) { // M
            this.onClickMuteButton();
        }
    }

    onClickMuteButton(event) {
        this.muted = !this.muted;
        console.log('Muted by the user', this.muted);
        this.applyMuted();
        this.renderMuteButton();
    }

    /**
     * The metronome stays silent as long as the user muted it or the current song is auto silenced.
     */
    applyMuted() {
        if (this.metronome) {
            this.metronome.setMuted(this.muted || this.autoSilenced);
        }
    }

    renderMuteButton() {
        this.domUtil.toggleCssClass(document.getElementById('muteButton'), 'muted', this.muted);
    }
    
    onDeviceRotation(event) {
        this.applySplit(); // Before updatePlaylistMaxHeight: that one measures the resulting layout
        this.updatePlaylistMaxHeight();
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
        this.domUtil.toggleCssClass(document.getElementById('separator'), 'hidden', settingsVisible);
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

        // The optional info of the song, above the auto stop / auto silence label. Long texts are
        // ellipsized by the CSS, the full text is available as a tooltip.
        let $songInfo = document.getElementById('songInfo');
        $songInfo.innerText = song.info || '';
        $songInfo.setAttribute('title', song.info || '');
        document.getElementById('songAutoInfo').innerText = song.autoInfoLabel();

        let navButtonsDisabled = song === Metro.NULL_SONG;
        this.domUtil.toggleCssClass(document.getElementById('previousSongButton'), 'disabled', navButtonsDisabled);
        this.domUtil.toggleCssClass(document.getElementById('nextSongButton'), 'disabled', navButtonsDisabled);

        let table = document.getElementById('playlist');
        let trs = table.getElementsByTagName('tr');
        for (let i = 0; i < trs.length; i++) {
            this.domUtil.toggleCssClass(trs[i], 'now-playing', song.index === i);
        }
    }

    /**
     * @param playlist {Playlist} already validated, see MetroSettings
     */
    setPlaylist(playlist) {
        this.playlist = playlist;
        console.log('setPlaylist', playlist); // Output after init of songs
        this.renderPlaylist();
        this.setCurrentSong(this.songAtIndex(0));
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
        for (let i = 0; i < songs.length; i++) {
            let song = songs[i];
            let row = this.playlistRowTemplate.cloneNode(true);
            row.removeAttribute('id');
            row.getElementsByClassName('songNo')[0].innerText = i + 1;
            row.getElementsByClassName('songTitle')[0].innerText = song.title;
            row.getElementsByClassName('songBpm')[0].innerText = this.labelBpm(song.bpm);
            row.addEventListener('click', this.onClickPlaySong.bind(this, i));
            tableBody.appendChild(row);
        }

        document.getElementById('playlistSubtitle').innerText =
            songs.length + ' Songs - Duration: ' + this.formatDuration(this.playlist.durationInSeconds());
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

    /**
     * @returns {Song}
     */
    songAtIndex(songIndex) {
        return this.playlist.songAt(songIndex);
    }

    playSong(songIndex) {
        let song = this.songAtIndex(songIndex);
        this.setCurrentSong(song);
        this.newMetronome(song.bpm);
        this.setState(Metro.STATE_PLAYING);
    }

    newMetronome(bpm) {
        if (this.metronome) {
            this.metronome.dispose();
        }
        this.metronome = new Metronome(bpm, this.onBeatChange.bind(this));
        this.metronome.setTone(this.settings.tone);
        this.metronome.setPitch(this.settings.pitch);
        this.autoSilenced = false; // A new metronome plays the song from the start
        this.applyMuted(); // The mute of the user outlives the metronome instances
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

    isButtonDisabled(buttonId) {
        let button = document.getElementById(buttonId);
        return button.getAttribute('class').indexOf('disabled') > -1;
    }

    onClickPlaylistLink(event) {
        document.getElementById('fileInput').click();
    }

    onClickPreviousSongButton(event) {
        if (this.isButtonDisabled('previousSongButton')) {
            return;
        }
        let index = this.currentSong.index - 1;
        if (index < 0) {
            index = this.playlist.songs.length - 1;
        }
        this.navigateToSong(index);
    }

    onClickNextSongButton(event) {
        if (this.isButtonDisabled('nextSongButton')) {
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
        if (this.isButtonDisabled('stopButton')) {
            return;
        }
        if (this.state === Metro.STATE_PLAYING || this.state === Metro.STATE_PAUSED) {
            this.setState(Metro.STATE_STOPPED);
        }
    }

    onClickPausePlayButton(event) {
        if (this.isButtonDisabled('pausePlayButton')) {
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
            this.autoSilenced = true;
            this.applyMuted();
        }
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

    /** Raw playlist data, showcasing every property. Turned into a Playlist when it is loaded. */
    static DEMO_PLAYLIST = {
        title: 'Demo Playlist',
        songs: [
            {
                title: 'Echoes of Tomorrow',
                bpm: 128,
                duration: '3:26',
                info: 'Capo on 2nd fret'
            },
            {
                title: 'Dancing Shadows',
                bpm: 165,
                autoStop: 10,
                duration: '2:35',
                info: 'Drummer starts. 4 bars of intro'
            },
            {
                title: 'Silent Symphony',
                bpm: 72,
                autoSilence: '0:45',
                duration: '3:31'
            }
        ]
    };

    constructor(callback) {
        this.callback = callback;
        this.playlist = null;
        this.songIndex = -1;
        this.tone = MetroSettings.TONE_CLICK;
        this.pitch = MetroSettings.PITCH_DEFAULT;
        this.autoPlayEnabled = true;
        this.autoStopSilenceEnabled = true;
        // Size of #metronomeContainer as a fraction (0..1), per orientation.
        // null means: use the sizes defined in metro.css.
        this.splitPortrait = null;
        this.splitLandscape = null;
    }

    init() {
        let storedSettings = localStorage.getItem('settings');
        if (storedSettings) {
            let settings = JSON.parse(storedSettings);
            this.playlist = this.readPlaylist(settings.playlist);
            this.tone = settings.tone;
            this.pitch = settings.pitch;
            this.songIndex = settings.songIndex;
            this.autoPlayEnabled = settings.autoPlayEnabled;
            this.autoStopSilenceEnabled = settings.autoStopSilenceEnabled;
            // Settings stored by an older version have no split sizes
            this.splitPortrait = settings.splitPortrait || null;
            this.splitLandscape = settings.splitLandscape || null;
            if (!this.playlist) {
                this.songIndex = -1; // A song index without a playlist would break the startup
            }
        } else {
            this.storeSettings();
        }
        this.checkRadio(this.tone);
        this.selectOption(this.pitch);
        this.checkCheckbox('autoPlayEnabled', this.autoPlayEnabled);
        this.checkCheckbox('autoStopSilenceEnabled', this.autoStopSilenceEnabled);
        this.renderVersion();
        this.addEventListeners();
    }

    renderVersion() {
        let $versionInfo = document.getElementById('versionInfo');
        $versionInfo.innerText = 'Version ' + Metronome.VERSION;
    }

    /**
     * Turns a stored playlist into a Playlist. A playlist that no longer passes the validation must
     * not break the startup: we drop it and show the placeholder instead.
     *
     * @returns {Playlist|null}
     */
    readPlaylist(data) {
        if (!data) {
            return null;
        }
        try {
            return new Playlist(data);
        } catch (error) {
            console.error('Ignoring the stored playlist', error);
            return null;
        }
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
            autoStopSilenceEnabled: this.autoStopSilenceEnabled,
            splitPortrait: this.splitPortrait,
            splitLandscape: this.splitLandscape
        }));
    }

    addEventListeners() {
        document.getElementById('fileInput').addEventListener('change', this.onFileInputChange.bind(this));
        document.querySelectorAll('input[type="radio"]').forEach(radio =>
            radio.addEventListener('change', this.onToneRadioChange.bind(this)));
        document.getElementById('pitch').addEventListener('change', this.onPitchChange.bind(this));
        document.getElementById('autoPlayEnabled').addEventListener('change', this.onCheckboxChange.bind(this));
        document.getElementById('autoStopSilenceEnabled').addEventListener('change', this.onCheckboxChange.bind(this));
        document.getElementById('loadDemoPlaylistLink').addEventListener('click', this.onClickLoadDemoPlaylistLink.bind(this));
    }

    onClickLoadDemoPlaylistLink(event) {
        this.setPlaylist(new Playlist(MetroSettings.DEMO_PLAYLIST));
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
                    this.setPlaylist(new Playlist(JSON.parse(event.target.result)));
                } catch (error) {
                    console.error('Failed to read playlist JSON', error);
                    // Inform the user (without this, the file picker would appear to do nothing)
                    alert('Sorry, this playlist cannot be read:\n\n' + error.message);
                }
            };
            reader.readAsText(file);
        }
    }

    setPlaylist(playlist) {
        this.playlist = playlist;
        this.storeSettings();
        this.callback({
            property: 'playlist',
            value: playlist
        });
    }

    setSongIndex(songIndex) {
        this.songIndex = songIndex;
        this.storeSettings();
    }

    /**
     * @param portrait true for the portrait size, false for the landscape size
     * @param fraction size of #metronomeContainer, 0..1
     */
    setSplit(portrait, fraction) {
        if (portrait) {
            this.splitPortrait = fraction;
        } else {
            this.splitLandscape = fraction;
        }
        this.storeSettings();
    }
}

let metro = new Metro();
metro.startup();
