document.addEventListener('DOMContentLoaded', function () {

    /* =====================================================
       INIT & GUARDS
    ===================================================== */

    const params = new URLSearchParams(location.search);
    const STORAGE_KEY = `uafilms_progress_${params.get('type')}_${params.get('id')}`;

    if (!window.videojs || !Array.isArray(window.rawPlaylist)) return;

    let player;
    let currentDub = null;
    let currentProvider = null;
    let isRestoring = false;

    /* =====================================================
       HELPERS (NO currentSrc FOR UI!)
    ===================================================== */

    function getMeta() {
        const idx = player.playlist.currentItem();
        return rawPlaylist?.[idx]?.meta || null;
    }

    function getSourceByState(meta) {
        if (!meta) return null;
        return (
            meta.allSources.find(s =>
                s.dub === currentDub && s.provider === currentProvider
            ) || meta.allSources[0]
        );
    }

    /* =====================================================
       RESTORE FROM STORAGE
    ===================================================== */

    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            const state = JSON.parse(saved);

            const idx = rawPlaylist.findIndex(i =>
                i.meta?.season === state.season &&
                i.meta?.episode === state.episode
            );

            if (idx !== -1) {
                const src = rawPlaylist[idx].meta.allSources.find(s =>
                    s.dub === state.dub && s.provider === state.provider
                );

                if (src) {
                    rawPlaylist[idx].sources = [{ src: src.url, type: src.type }];
                    rawPlaylist[idx].poster = src.poster || rawPlaylist[idx].poster;
                    currentDub = src.dub;
                    currentProvider = src.provider;
                }
            }
        }
    } catch (e) {
        console.warn('[player] restore failed:', e);
    }

    /* =====================================================
       VIDEO.JS INIT
    ===================================================== */

    const Button = videojs.getComponent('Button');

    class SettingsButton extends Button {
        createEl() {
            const el = super.createEl('button', {
                className: 'vjs-control vjs-button vjs-settings-btn',
                type: 'button'
            });
            el.innerHTML = '<span class="material-icons">settings</span>';
            return el;
        }
        handleClick(e) {
            e.preventDefault();
            e.stopPropagation();
            toggleMenu();
        }
    }

    videojs.registerComponent('SettingsButton', SettingsButton);

    player = videojs('my-video', {
        fill: true,
        playbackRates: [0.5, 1, 1.25, 1.5, 2],
        controlBar: {
            children: [
                'playToggle',
                'volumePanel',
                'currentTimeDisplay',
                'timeDivider',
                'durationDisplay',
                'progressControl',
                'SettingsButton',
                'fullscreenToggle'
            ]
        },
        html5: {
            nativeVideoTracks: true,
            nativeAudioTracks: true,
            vhs: { smoothQualityChange: true }
        }
    });

    player.playlist(rawPlaylist);
    player.playlist.autoadvance(0);

    /* =====================================================
       SETTINGS MENU ISOLATION (CRITICAL)
    ===================================================== */

    const menu = document.getElementById('settings-menu');

    if (menu) {
        menu.style.pointerEvents = 'auto';
        ['mousedown','mouseup','click','touchstart','touchend']
            .forEach(ev =>
                menu.addEventListener(ev, e => {
                    e.stopPropagation();
                })
            );
    }

    function toggleMenu() {
        if (!menu) return;
        const open = menu.classList.contains('active');
        menu.classList.toggle('active', !open);
        menu.style.display = open ? 'none' : 'flex';
        closeSubmenu();
    }

    function closeMenu() {
        if (!menu) return;
        menu.classList.remove('active');
        menu.style.display = 'none';
        closeSubmenu();
    }

    /* =====================================================
       🌍 GLOBAL UI FUNCTIONS (FIX FOR CONSOLE ERROR)
    ===================================================== */

    window.openSubmenu = function (id) {
        const el = document.getElementById('submenu-' + id);
        if (el) el.classList.add('active');
    };

    window.closeSubmenu = function () {
        document.querySelectorAll('.settings-submenu')
            .forEach(el => el.classList.remove('active'));
    };

    window.setSpeed = function (rate) {
        player.playbackRate(rate);
        updateSpeedMenu();
        closeSubmenu();
        saveProgress();
    };

    /* =====================================================
       PLAYER EVENTS
    ===================================================== */

    player.on('playlistitem', () => {
        const meta = getMeta();
        if (!meta) return;

        // INIT STATE IF EMPTY
        if (!currentDub || !currentProvider) {
            currentDub = meta.allSources[0].dub;
            currentProvider = meta.allSources[0].provider;
        }

        const src = getSourceByState(meta);

        currentDub = src.dub;
        currentProvider = src.provider;

        syncSubs(src);
        updateAudioMenu();
        updateSpeedMenu();
    });

    /* =====================================================
       AUDIO MENU (STATE-BASED, FINAL)
    ===================================================== */

    function updateAudioMenu() {
        const container = document.getElementById('audio-options');
        const label = document.getElementById('val-audio');
        if (!container || !label) return;

        const meta = getMeta();
        if (!meta || meta.allSources.length === 0) return;

        label.innerText = currentDub;

        if (meta.allSources.length === 1) {
            container.innerHTML = '';
            return;
        }

        container.innerHTML = '';

        const dubs = [...new Set(meta.allSources.map(s => s.dub))];

        dubs.forEach(dub => {
            const div = document.createElement('div');
            div.className = 'submenu-option';
            div.textContent = dub;

            if (dub === currentDub) {
                div.classList.add('selected');
            }

            div.onclick = () => {
                const src = meta.allSources.find(s =>
                s.dub === dub && s.provider === currentProvider
                ) || meta.allSources.find(s => s.dub === dub);
                if (src) switchSource(src);
            };

            container.appendChild(div);
        });
    }

    /* =====================================================
       SPEED MENU
    ===================================================== */

    function updateSpeedMenu() {
        const rate = player.playbackRate();
        const label = document.getElementById('val-speed');
        if (label) label.innerText = rate === 1 ? 'Звичайна' : rate + 'x';

        document.querySelectorAll('#submenu-speed .submenu-option')
            .forEach(el => {
                el.classList.remove('selected');
                if (parseFloat(el.dataset.speed) === rate) {
                    el.classList.add('selected');
                }
            });
    }

    /* =====================================================
       SWITCH SOURCE (ORDER MATTERS)
    ===================================================== */

    function switchSource(source) {
        const time = player.currentTime();
        const paused = player.paused();

        // 🔑 UI STATE FIRST
        currentDub = source.dub;
        currentProvider = source.provider;

        player.src({ src: source.url, type: source.type });
        if (source.poster) player.poster(source.poster);

        syncSubs(source);

        updateAudioMenu();
        updateSpeedMenu();
        closeSubmenu();

        player.one('loadedmetadata', () => {
            player.currentTime(time);
            if (!paused) player.play();
            updateAudioMenu();
            saveProgress();
        });
    }

    /* =====================================================
       SUBTITLES
    ===================================================== */

    function syncSubs(source) {
        const tracks = player.textTracks();
        for (let i = tracks.length - 1; i >= 0; i--) {
            if (tracks[i].kind === 'subtitles') {
                player.removeRemoteTextTrack(tracks[i]);
            }
        }

        source?.subtitles?.forEach(sub => {
            player.addRemoteTextTrack({
                kind: 'subtitles',
                label: sub.label,
                src: sub.url,
                srclang: sub.lang
            }, false);
        });
    }

    /* =====================================================
       SAVE PROGRESS
    ===================================================== */

    function saveProgress() {
        const meta = getMeta();
        if (!meta) return;

        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            season: meta.season,
            episode: meta.episode,
            time: player.currentTime(),
            speed: player.playbackRate(),
            dub: currentDub,
            provider: currentProvider
        }));
    }

});