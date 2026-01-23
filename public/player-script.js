document.addEventListener('DOMContentLoaded', function() {
    
    const urlParams = new URLSearchParams(window.location.search);
    const contentId = urlParams.get('id');
    const contentType = urlParams.get('type');
    const STORAGE_KEY = `uafilms_progress_${contentType}_${contentId}`;

    let currentDub = "Original";
    let currentProvider = "Unknown";
    let isRestoring = false; 

    // === КРОК 0: PRE-PROCESS PLAYLIST ===
    if (typeof rawPlaylist !== 'undefined' && Array.isArray(rawPlaylist)) {
        try {
            const savedJson = localStorage.getItem(STORAGE_KEY);
            if (savedJson) {
                const state = JSON.parse(savedJson);
                const savedIdx = rawPlaylist.findIndex(item => 
                    item.meta.season === state.season && item.meta.episode === state.episode
                );
                
                if (savedIdx !== -1) {
                     const freshSource = rawPlaylist[savedIdx].meta.allSources.find(s => 
                         s.dub === state.dub && s.provider === state.provider
                     );
                     
                     if (freshSource) {
                         rawPlaylist[savedIdx].sources = [{ src: freshSource.url, type: freshSource.type }];
                         if(freshSource.poster) rawPlaylist[savedIdx].poster = freshSource.poster;

                         currentDub = state.dub;
                         currentProvider = state.provider;
                     }
                }
            } else {
                // ВИПРАВЛЕННЯ: Якщо немає збереження, ініціалізуємо змінні з першого елемента першого відео
                if (rawPlaylist.length > 0 && rawPlaylist[0].meta && rawPlaylist[0].meta.allSources?.length > 0) {
                    const firstSource = rawPlaylist[0].meta.allSources[0];
                    currentDub = firstSource.dub || "Original";
                    currentProvider = firstSource.provider;
                }
            }
        } catch (e) { console.error("Pre-load error:", e); }
    }

    if (typeof videojs !== 'undefined') {
        const Button = videojs.getComponent('Button');
        class SettingsButton extends Button {
            constructor(player, options) {
                super(player, options);
                this.addClass('vjs-settings-btn');
                this.controlText('Налаштування');
            }
            createEl() {
                const el = super.createEl('button', {
                    className: 'vjs-control vjs-button vjs-settings-btn',
                    type: 'button',
                });
                const icon = videojs.dom.createEl('span', {
                    className: 'material-icons icon-placeholder',
                    innerHTML: 'settings',
                    style: 'pointer-events: none;' 
                });
                if (el.firstChild) el.insertBefore(icon, el.firstChild);
                else el.appendChild(icon);
                return el;
            }
            handleClick(event) {
                const menu = document.getElementById('settings-menu');
                if (menu) {
                    event.stopPropagation();
                    if (menu.style.display === 'flex') {
                        menu.classList.remove('active');
                        menu.style.display = 'none';
                    } else {
                        menu.style.display = 'flex';
                        requestAnimationFrame(() => menu.classList.add('active'));
                        document.querySelectorAll('.settings-submenu').forEach(el => el.classList.remove('active'));
                    }
                }
            }
        }
        videojs.registerComponent('SettingsButton', SettingsButton);

        const videoElement = document.getElementById('my-video');
        if (videoElement) {
            const player = videojs('my-video', {
                fluid: false, 
                fill: true,
                playbackRates: [0.5, 1, 1.25, 1.5, 2],
                preferFullWindow: true, 
                controlBar: {
                    children: [
                        'playToggle', 'volumePanel', 'currentTimeDisplay', 'timeDivider', 'durationDisplay', 'progressControl', 'SettingsButton', 'fullscreenToggle'
                    ]
                },
                html5: { 
                    nativeVideoTracks: true,
                    nativeAudioTracks: true,
                    vhs: { 
                        enableLowInitialPlaylist: true,
                        smoothQualityChange: true
                    }
                }
            });

            const playerContainer = player.el();
            const header = document.getElementById('player-header');
            const menu = document.getElementById('settings-menu');
            
            if (playerContainer) {
                if (header) playerContainer.appendChild(header);
                if (menu) playerContainer.appendChild(menu);
            }

            const wrapper = document.querySelector('.player-wrapper');

            player.on('play', () => { 
                if (wrapper) wrapper.classList.remove('paused'); 
                if (menu) { menu.classList.remove('active'); menu.style.display = 'none'; }
            });
            player.on('pause', () => { 
                if (wrapper) wrapper.classList.add('paused'); 
                saveProgress(); 
            });
            player.on('useractive', () => { 
                if (wrapper) wrapper.classList.add('paused'); 
            });
            player.on('userinactive', () => { 
                if (!player.paused() && wrapper) wrapper.classList.remove('paused'); 
            });

            player.on('mousedown', (e) => {
                if (menu && menu.style.display === 'flex') {
                    const target = e.target;
                    const isMenu = target.closest('#settings-menu');
                    const isBtn = target.closest('.vjs-settings-btn');
                    if (!isMenu && !isBtn) {
                        menu.classList.remove('active');
                        menu.style.display = 'none';
                    }
                }
            });

            if(typeof rawPlaylist !== 'undefined' && Array.isArray(rawPlaylist) && rawPlaylist.length > 0) {
                player.playlist(rawPlaylist);
                player.playlist.autoadvance(0);
            }

            player.ready(function() {
                if(this.hotkeys) this.hotkeys({ volumeStep: 0.1, seekStep: 5 });
                
                if (this.mobileUi) {
                    this.mobileUi({
                        touchControls: { seekSeconds: 10, tapTimeout: 300, disableOnEnd: false },
                        fullscreen: { enterOnRotate: true, lockOnRotate: true }
                    });
                }

                if (player.qualityLevels) {
                    const ql = player.qualityLevels();
                    ql.on('addqualitylevel', () => updateQualityMenu(player));
                    ql.on('change', () => updateQualityMenu(player));
                }
                
                player.textTracks().on('addtrack', () => updateSubsMenu(player));
                player.textTracks().on('change', () => updateSubsMenu(player));

                const isSeries = typeof rawPlaylist !== 'undefined' && rawPlaylist.length > 1;
                if(isSeries) buildSelectors(player);
                else if(header) header.style.display = 'none';

                restoreProgress();

                setInterval(() => {
                    if (!player.paused() && !isRestoring && player.currentTime() > 5) saveProgress();
                }, 5000);

                player.on('ratechange', () => {
                    updateSpeedMenu(player);
                    saveProgress();
                });
                
                if (wrapper) wrapper.classList.add('paused');
            });

            player.on('playlistitem', () => {
                const idx = player.playlist.currentItem();
                const meta = rawPlaylist[idx]?.meta;
                
                if (!isRestoring) {
                    if (meta && meta.allSources && meta.allSources.length > 0) {
                        // 1. Спробуємо знайти джерело, яке відповідає ВЖЕ ОБРАНІЙ озвучці
                        let activeSource = meta.allSources.find(s => s.dub === currentDub && s.provider === currentProvider);

                        // 2. Якщо такої озвучки в цій серії немає — беремо першу доступну
                        if (!activeSource) {
                            activeSource = meta.allSources[0];
                        }

                        if (activeSource) {
                            // Оновлюємо глобальний стан
                            currentDub = activeSource.dub || 'Original';
                            currentProvider = activeSource.provider;
                            
                            // Якщо URL відрізняється (наприклад, перейшли на наступну серію, а там дефолт інший)
                            const currentSrc = player.currentSrc();
                            // Проста перевірка: якщо поточне джерело не містить URL вибраного (на випадок зміни серії)
                            // Але VideoJS сам міняє source при playlistitem, тому тут головне оновити змінні state.
                            
                            syncTracks(player, activeSource);
                        }
                    }
                }
                // ВИПРАВЛЕННЯ: Обов'язково оновлюємо меню після зміни айтему
                updateAudioMenu(player);
                updateQualityMenu(player);
            });

            function syncTracks(player, source) {
                const tracks = player.textTracks();
                for (let i = tracks.length - 1; i >= 0; i--) {
                    if (tracks[i].kind === 'subtitles') {
                        player.removeRemoteTextTrack(tracks[i]);
                    }
                }
                if (source.subtitles && source.subtitles.length > 0) {
                    source.subtitles.forEach(sub => {
                        player.addRemoteTextTrack({
                            kind: 'subtitles',
                            label: sub.label,
                            src: sub.url,
                            srclang: sub.lang
                        }, false);
                    });
                }
                updateSubsMenu(player);
            }

            function saveProgress() {
                if (isRestoring || !rawPlaylist || rawPlaylist.length === 0 || player.currentTime() < 1) return;
                const idx = player.playlist.currentItem();
                const meta = rawPlaylist[idx].meta;
                const state = {
                    season: meta.season,
                    episode: meta.episode,
                    time: player.currentTime(),
                    speed: player.playbackRate(),
                    dub: currentDub,
                    provider: currentProvider,
                    timestamp: Date.now()
                };
                localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            }

            function restoreProgress() {
                try {
                    const savedJson = localStorage.getItem(STORAGE_KEY);
                    if (!savedJson) {
                        // ВИПРАВЛЕННЯ: Якщо немає збереження, встановлюємо дефолтні значення з поточного (першого) відео
                        const idx = player.playlist.currentItem();
                        if (idx >= 0 && rawPlaylist[idx] && rawPlaylist[idx].meta && rawPlaylist[idx].meta.allSources?.length > 0) {
                            const def = rawPlaylist[idx].meta.allSources[0];
                            currentDub = def.dub || "Original";
                            currentProvider = def.provider;
                        }
                        
                        updateSpeedMenu(player);
                        updateAudioMenu(player);
                        updateQualityMenu(player);
                        return;
                    }

                    const state = JSON.parse(savedJson);
                    isRestoring = true;
                    
                    if (state.speed) player.playbackRate(state.speed);
                    updateSpeedMenu(player);
                    
                    currentDub = state.dub || "Original";
                    currentProvider = state.provider || "Unknown";

                    let foundIndex = -1;
                    if (state.season && state.episode) {
                        foundIndex = rawPlaylist.findIndex(item => 
                            item.meta.season === state.season && item.meta.episode === state.episode
                        );
                    }

                    const applyTime = () => {
                        if (state.time > 0) {
                            if (player.readyState() >= 1) {
                                player.currentTime(state.time);
                                isRestoring = false;
                            } else {
                                player.one('loadedmetadata', () => {
                                    player.currentTime(state.time);
                                    isRestoring = false;
                                });
                            }
                        } else isRestoring = false;
                    };

                    if (foundIndex !== -1 && foundIndex !== player.playlist.currentItem()) {
                        player.playlist.currentItem(foundIndex);
                        player.one('loadedmetadata', applyTime);
                    } else {
                        applyTime();
                    }
                    updateAudioMenu(player);
                    updateQualityMenu(player);

                } catch (e) {
                    console.error("Restore error", e);
                    isRestoring = false;
                }
            }

            // --- UI HELPERS ---
            window.openSubmenu = function(id) { const el = document.getElementById('submenu-' + id); if(el) el.classList.add('active'); };
            window.closeSubmenu = function() { document.querySelectorAll('.settings-submenu').forEach(el => el.classList.remove('active')); };
            
            window.setSpeed = function(rate) {
                player.playbackRate(rate);
                updateSpeedMenu(player);
                closeSubmenu();
                saveProgress();
            };

            function updateSpeedMenu(player) {
                const rate = player.playbackRate();
                document.querySelectorAll('#submenu-speed .submenu-option').forEach(el => {
                    el.classList.remove('selected');
                    if(Math.abs(parseFloat(el.getAttribute('data-speed')) - rate) < 0.01) el.classList.add('selected');
                });
                document.getElementById('val-speed').innerText = rate === 1 ? 'Звичайна' : rate + 'x';
            }

            function updateAudioMenu(player) {
                const container = document.getElementById('audio-options');
                const label = document.getElementById('val-audio');
                if (!container || !player.playlist) return;
                
                const idx = player.playlist.currentItem();
                if (!rawPlaylist[idx]) return;
                const meta = rawPlaylist[idx].meta;
                
                const item = document.querySelector('.settings-item[onclick="openSubmenu(\'audio\')"]');
                if (!meta || !meta.allSources || meta.allSources.length <= 1) {
                    if(meta && meta.allSources.length > 0) label.innerText = meta.allSources[0].dub || "Original";
                    if(item) item.style.display = 'none';
                    return;
                }
                if(item) item.style.display = 'flex';
                
                container.innerHTML = '';
                label.innerText = currentDub;

                const uniqueDubs = new Set();
                meta.allSources.forEach(s => uniqueDubs.add(s.dub || 'Original'));

                uniqueDubs.forEach(dubName => {
                    const div = document.createElement('div');
                    div.className = 'submenu-option';
                    div.innerText = dubName;
                    
                    if (dubName === currentDub) div.classList.add('selected');

                    div.onclick = function() {
                        const variants = meta.allSources.filter(s => (s.dub || 'Original') === dubName);
                        // Шукаємо найкращу якість (Auto або першу)
                        let targetSource = variants.find(s => s.quality === 'Auto') || variants[0];
                        
                        switchSource(player, targetSource, true);
                        closeSubmenu();
                    };
                    container.appendChild(div);
                });
            }

            function updateQualityMenu(player) {
                const container = document.getElementById('quality-options');
                if(!container) return;
                
                const idx = player.playlist.currentItem();
                if (!rawPlaylist[idx]) return;
                const meta = rawPlaylist[idx].meta;

                container.innerHTML = '';

                // Нативні рівні (для HLS)
                const nativeLevels = player.qualityLevels ? player.qualityLevels() : [];
                let hasRealNativeLevels = false;
                for(let i=0; i<nativeLevels.length; i++) if(nativeLevels[i].height) hasRealNativeLevels = true;

                // "Ручні" рівні для ПОТОЧНОЇ озвучки
                const currentDubSources = meta.allSources.filter(s => 
                    (s.dub || 'Original') === currentDub && 
                    s.provider === currentProvider // Важливо: provider може бути різним для однакових dub, але тут ми фільтруємо
                );
                
                // Якщо ми в UEmbed, у нас один провайдер, одна назва dub, але багато sources з різною quality.
                // Але якщо ми змінили dub, currentProvider теж оновився. 
                // Трюк: для UEmbed provider однаковий. 
                // Для CinemaOS provider різний? Ні, ми їх прибрали. 
                
                // Увага: якщо у нас UEmbed, provider='uembed', dub='English'.
                // allSources має English-1080p, English-720p. 
                // currentDub='English', currentProvider='uembed'.
                // currentDubSources знайде їх усі.
                
                const hasManualQualities = currentDubSources.length > 1;

                if (hasRealNativeLevels) {
                    const autoDiv = document.createElement('div');
                    autoDiv.className = 'submenu-option selected';
                    autoDiv.innerText = 'Auto';
                    autoDiv.onclick = function() {
                        for(let i=0; i < nativeLevels.length; i++) nativeLevels[i].enabled = true;
                        document.getElementById('val-quality').innerText = 'Auto';
                        closeSubmenu();
                        highlightQuality(this);
                    };
                    container.appendChild(autoDiv);

                    for(let i=0; i < nativeLevels.length; i++) {
                        let lvl = nativeLevels[i];
                        if(!lvl.height) continue;
                        let div = document.createElement('div');
                        div.className = 'submenu-option';
                        div.innerText = lvl.height + 'p';
                        div.onclick = function() {
                            for(let j=0; j < nativeLevels.length; j++) nativeLevels[j].enabled = false;
                            lvl.enabled = true;
                            document.getElementById('val-quality').innerText = lvl.height + 'p';
                            closeSubmenu();
                            highlightQuality(this);
                        };
                        container.appendChild(div);
                    }
                } else if (hasManualQualities) {
                    currentDubSources.forEach(src => {
                         const div = document.createElement('div');
                         div.className = 'submenu-option';
                         div.innerText = src.quality || 'Unknown';
                         
                         const currentSrcUrl = player.currentSrc();
                         if (currentSrcUrl && currentSrcUrl.includes(src.url)) {
                             div.classList.add('selected');
                             document.getElementById('val-quality').innerText = src.quality || 'Unknown';
                         }
                         
                         div.onclick = function() {
                             switchSource(player, src, true);
                             closeSubmenu();
                         };
                         container.appendChild(div);
                    });
                } else {
                     container.innerHTML = '<div style="padding:15px;text-align:center;color:#777;">Auto</div>';
                     document.getElementById('val-quality').innerText = 'Auto';
                }
            }

            function highlightQuality(target) {
                const opts = document.getElementById('quality-options').children;
                for(let i=0; i<opts.length; i++) opts[i].classList.remove('selected');
                target.classList.add('selected');
            }

            function switchSource(player, source, restoreTime) {
                 const time = player.currentTime();
                 const wasPaused = player.paused();
                 
                 currentDub = source.dub || 'Original';
                 currentProvider = source.provider;

                 player.src({ src: source.url, type: source.type });
                 if(source.poster) player.poster(source.poster);
                 
                 syncTracks(player, source);
                 
                 player.one('loadedmetadata', () => {
                     if (restoreTime) player.currentTime(time);
                     if(!wasPaused) player.play();
                     
                     updateAudioMenu(player);
                     updateSpeedMenu(player);
                     updateQualityMenu(player);
                 });
                 
                 saveProgress();
            }

            function updateSubsMenu(player) {
                const tracks = player.textTracks();
                const container = document.getElementById('subs-options');
                if(!container) return;
                container.innerHTML = '';
                const offDiv = document.createElement('div');
                offDiv.className = 'submenu-option selected';
                offDiv.innerText = 'Вимкнено';
                
                let anyShowing = false;
                for(let i=0; i<tracks.length; i++) if(tracks[i].mode === 'showing') anyShowing = true;
                if(anyShowing) offDiv.classList.remove('selected');

                offDiv.onclick = function() {
                    for(let i=0; i<tracks.length; i++) tracks[i].mode = 'disabled';
                    document.getElementById('val-subs').innerText = 'Вимк';
                    closeSubmenu();
                    highlightSubs(this);
                };
                container.appendChild(offDiv);

                let added = 0;
                for(let i=0; i < tracks.length; i++) {
                    let tr = tracks[i];
                    if(tr.kind !== 'subtitles' && tr.kind !== 'captions') continue;
                    let div = document.createElement('div');
                    div.className = 'submenu-option';
                    div.innerText = tr.label || tr.language || `Track ${i}`;
                    if(tr.mode === 'showing') {
                        div.classList.add('selected');
                        document.getElementById('val-subs').innerText = tr.label || tr.language;
                    }
                    div.onclick = function() {
                        for(let j=0; j<tracks.length; j++) tracks[j].mode = 'disabled';
                        tr.mode = 'showing';
                        document.getElementById('val-subs').innerText = tr.label || tr.language;
                        closeSubmenu();
                        highlightSubs(this);
                    };
                    container.appendChild(div);
                    added++;
                }
                if(added === 0) container.innerHTML = '<div style="padding:15px;text-align:center;color:#777;">Немає субтитрів</div>';
            }
            function highlightSubs(target) {
                const opts = document.getElementById('subs-options').children;
                for(let i=0; i<opts.length; i++) opts[i].classList.remove('selected');
                target.classList.add('selected');
            }

            function buildSelectors(player) {
                if (typeof rawPlaylist === 'undefined') return;
                const seasons = {}; 
                rawPlaylist.forEach((item, index) => {
                    const s = item.meta?.season || 1;
                    const e = item.meta?.episode || (index + 1);
                    if(!seasons[s]) seasons[s] = [];
                    seasons[s].push({ ep: e, index: index });
                });
                
                const seasonSelect = document.getElementById('season-select');
                const epSelect = document.getElementById('episode-select');
                
                if(!seasonSelect || Object.keys(seasons).length === 0) return;
                
                seasonSelect.style.display = 'block';
                epSelect.style.display = 'block';
                seasonSelect.innerHTML = ''; 
                epSelect.innerHTML = '';
                
                Object.keys(seasons).sort((a,b)=>a-b).forEach(sNum => {
                    const opt = document.createElement('option');
                    opt.value = sNum; opt.innerText = 'Сезон ' + sNum;
                    seasonSelect.appendChild(opt);
                });

                function updateEpisodes(sNum) {
                    epSelect.innerHTML = '';
                    const eps = seasons[sNum];
                    eps.sort((a,b) => a.ep - b.ep);
                    eps.forEach(item => {
                        const opt = document.createElement('option');
                        opt.value = item.index; opt.innerText = 'Серія ' + item.ep;
                        epSelect.appendChild(opt);
                    });
                }

                seasonSelect.onchange = function() { 
                    updateEpisodes(this.value);
                    if(seasons[this.value] && seasons[this.value][0]) {
                        player.playlist.currentItem(seasons[this.value][0].index);
                    }
                };
                epSelect.onchange = function() { 
                    player.playlist.currentItem(parseInt(this.value)); 
                };

                const firstSeason = Object.keys(seasons).sort((a,b)=>a-b)[0];
                if(firstSeason) updateEpisodes(firstSeason);

                player.on('playlistitem', function() {
                    const idx = player.playlist.currentItem();
                    const currentItem = rawPlaylist[idx];
                    if(currentItem && currentItem.meta) {
                        const s = currentItem.meta.season;
                        if(seasonSelect.value != s) {
                            seasonSelect.value = s;
                            updateEpisodes(s);
                        }
                        epSelect.value = idx;
                    }
                });
            }
        }
    }
});