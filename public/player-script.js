document.addEventListener('DOMContentLoaded', function () {

  const urlParams = new URLSearchParams(window.location.search);
  const contentId = urlParams.get('id');
  const contentType = urlParams.get('type');
  const STORAGE_KEY = `uafilms_progress_${contentType}_${contentId}`;

  let currentDub = "Original";
  let currentProvider = "Unknown";
  let isRestoring = false;

  // NEW: щоб UI не “відкочувався” назад на старе значення до loadedmetadata
  let isSwitching = false;

  // ========= URL / SOURCE HELPERS =========
  function normUrl(u) {
    if (!u) return '';
    try {
      const url = new URL(u, window.location.href);
      url.hash = '';
      return url.toString();
    } catch (e) {
      return String(u).split('#')[0];
    }
  }

  function sameUrl(a, b) {
    return normUrl(a) === normUrl(b);
  }

  function parseQualityNumber(q) {
    const m = String(q || '').match(/(\d{3,4})/);
    return m ? parseInt(m[1], 10) : -1;
  }

  function formatBitrate(bps) {
    const n = Number(bps);
    if (!isFinite(n) || n <= 0) return null;
    // quality-levels часто дає bitrate в bps
    if (n >= 1000000) return Math.round(n / 1000000) + " Mbps";
    if (n >= 1000) return Math.round(n / 1000) + " Kbps";
    return String(n) + " bps";
  }

  // ========= QUALITY LABEL FIX (2:1 / non-16:9 ladders) =========
  function guessStdPFromResolution(w, h) {
    const W = Number(w) || 0;
    const H = Number(h) || 0;

    // Якщо ladder 2:1 (3840x1920, 1920x960...) — брати "стандарт" по ширині:
    // 3840 -> 2160p, 1920 -> 1080p, 1280 -> 720p, 854 -> 480p
    if (W >= 3800) return 2160;
    if (W >= 1900) return 1080;
    if (W >= 1270) return 720;
    if (W >= 850) return 480;
    if (W >= 630) return 360;
    if (W >= 420) return 240;

    // fallback
    return H > 0 ? H : (W > 0 ? W : -1);
  }

  function levelResolution(lvl) {
    // quality-levels / VHS може тримати resolution у playlist.attributes.RESOLUTION
    const a = lvl && lvl.playlist && lvl.playlist.attributes ? lvl.playlist.attributes : null;

    const rw = (a && a.RESOLUTION && a.RESOLUTION.width) ? a.RESOLUTION.width : (lvl && lvl.width ? lvl.width : 0);
    const rh = (a && a.RESOLUTION && a.RESOLUTION.height) ? a.RESOLUTION.height : (lvl && lvl.height ? lvl.height : 0);

    return { w: Number(rw) || 0, h: Number(rh) || 0 };
  }

  function levelRank(lvl) {
    const r = levelResolution(lvl);
    const p = guessStdPFromResolution(r.w, r.h);
    const b = Number((lvl && (lvl.bitrate || lvl.bandwidth)) || 0) || 0;
    return { p: (p > 0 ? p : 0), b: (b > 0 ? b : 0) };
  }

  function getLevelLabel(lvl) {
    const r = levelResolution(lvl);
    const p = guessStdPFromResolution(r.w, r.h);

    if (p > 0) return p + "p";

    // якщо не вийшло визначити "стандарт" — покажемо реальну resolution
    if (r.w && r.h) return `${r.w}x${r.h}`;

    const br = Number((lvl && (lvl.bitrate || lvl.bandwidth)) || 0) || 0;
    if (br) {
      const fb = formatBitrate(br);
      if (fb) return fb;
    }

    if (lvl && typeof lvl.id !== 'undefined') return "Level " + lvl.id;
    return "Auto";
  }

  function findActiveManualSource(meta, player) {
    if (!meta || !meta.allSources || !meta.allSources.length) return null;
    const cur = player && player.currentSrc ? player.currentSrc() : '';
    if (!cur) return null;

    // 1) strict match
    let hit = meta.allSources.find(s => sameUrl(s.url, cur));
    if (hit) return hit;

    // 2) match without query (tokenized/redirected cases)
    try {
      const cu = new URL(cur, window.location.href);
      cu.search = '';
      const curNoQ = cu.toString();

      hit = meta.allSources.find(s => {
        try {
          const su = new URL(s.url, window.location.href);
          su.search = '';
          return su.toString() === curNoQ;
        } catch (e) {
          return false;
        }
      });
      if (hit) return hit;
    } catch (e) { }

    return null;
  }

  // ===== safeParse — НЕ МІНЯЄМО =====
  function safeParse(str) {
    if (!str) return null;
    try {
      return JSON.parse(str);
    } catch (e) {
      try {
        return new Function('return ' + str)();
      } catch (e2) {
        return null;
      }
    }
  }

  // === PRE-PROCESS PLAYLIST ===
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
            if (freshSource.poster) rawPlaylist[savedIdx].poster = freshSource.poster;

            currentDub = state.dub;
            currentProvider = state.provider;
          }
        }
      } else {
        if (rawPlaylist.length > 0 && rawPlaylist[0].meta && rawPlaylist[0].meta.allSources?.length > 0) {
          const firstSource = rawPlaylist[0].meta.allSources[0];
          currentDub = firstSource.dub || "Original";
          currentProvider = firstSource.provider;
        }
      }
    } catch (e) {
      console.error("Pre-load error:", e);
    }
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
            'playToggle', 'volumePanel', 'currentTimeDisplay', 'timeDivider',
            'durationDisplay', 'progressControl', 'SettingsButton', 'fullscreenToggle'
          ]
        },
        html5: {
          // IMPORTANT FIX for qualityLevels from VHS plugin:
          // force VHS (non-native) so qualityLevels will populate
          nativeVideoTracks: false,
          nativeAudioTracks: false,
          vhs: {
            overrideNative: true,
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

      if (typeof rawPlaylist !== 'undefined' && Array.isArray(rawPlaylist) && rawPlaylist.length > 0) {
        player.playlist(rawPlaylist);
        player.playlist.autoadvance(0);
      }

      function bindQualityLevelListeners() {
        if (!player.qualityLevels) return;

        const ql = player.qualityLevels();

        // щоб не навішувати дублікати
        if (ql.__uafilms_bound) return;
        ql.__uafilms_bound = true;

        const refresh = () => updateQualityMenu(player);

        ql.on('addqualitylevel', refresh);
        ql.on('removequalitylevel', refresh);
        ql.on('change', refresh);

        // ще раз після метаданих / маніфесту
        player.on('loadedmetadata', refresh);
        player.on('loadeddata', refresh);

        // VHS інколи додає рівні трохи пізніше
        setTimeout(refresh, 200);
        setTimeout(refresh, 800);
      }

      player.ready(function () {
        if (this.hotkeys) this.hotkeys({ volumeStep: 0.1, seekStep: 5 });

        if (this.mobileUi) {
          this.mobileUi({
            touchControls: { seekSeconds: 10, tapTimeout: 300, disableOnEnd: false },
            fullscreen: { enterOnRotate: true, lockOnRotate: true }
          });
        }

        bindQualityLevelListeners();

        player.textTracks().on('addtrack', () => updateSubsMenu(player));
        player.textTracks().on('change', () => updateSubsMenu(player));

        const isSeries = typeof rawPlaylist !== 'undefined' && rawPlaylist.length > 1;
        if (isSeries) buildSelectors(player);
        else if (header) header.style.display = 'none';

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
            let activeSource = meta.allSources.find(s => s.dub === currentDub && s.provider === currentProvider);
            if (!activeSource) activeSource = meta.allSources[0];

            if (activeSource) {
              currentDub = activeSource.dub || 'Original';
              currentProvider = activeSource.provider;
              syncTracks(player, activeSource);
            }
          }
        }

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
            } else {
              isRestoring = false;
            }
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
      window.openSubmenu = function (id) {
        const el = document.getElementById('submenu-' + id);
        if (el) el.classList.add('active');
      };
      window.closeSubmenu = function () {
        document.querySelectorAll('.settings-submenu').forEach(el => el.classList.remove('active'));
      };

      window.setSpeed = function (rate) {
        player.playbackRate(rate);
        updateSpeedMenu(player);
        closeSubmenu();
        saveProgress();
      };

      function updateSpeedMenu(player) {
        const rate = player.playbackRate();
        document.querySelectorAll('#submenu-speed .submenu-option').forEach(el => {
          el.classList.remove('selected');
          if (Math.abs(parseFloat(el.getAttribute('data-speed')) - rate) < 0.01) el.classList.add('selected');
        });
        const vs = document.getElementById('val-speed');
        if (vs) vs.innerText = rate === 1 ? 'Звичайна' : rate + 'x';
      }

      // ========================= AUDIO MENU (FIX VISUAL LIKE SUBS) =========================
      function updateAudioMenu(player) {
        const container = document.getElementById('audio-options');
        const label = document.getElementById('val-audio');
        if (!container || !label || !player.playlist) return;

        const idx = player.playlist.currentItem();
        const meta = rawPlaylist?.[idx]?.meta;
        const item = document.querySelector('.settings-item[onclick="openSubmenu(\'audio\')"]');

        if (!meta?.allSources?.length) return;

        // CRITICAL FIX:
        // НЕ синхронізуємо з currentSrc() поки йде перемикання, інакше UI відкотиться на стару озвучку
        if (!isSwitching) {
          const active = findActiveManualSource(meta, player);
          if (active) {
            currentDub = active.dub || 'Original';
            currentProvider = active.provider;
          }
        }

        const uniqueDubs = Array.from(new Set(meta.allSources.map(s => s.dub || 'Original')));

        if (uniqueDubs.length <= 1) {
          label.innerText = uniqueDubs[0] || 'Original';
          if (item) item.style.display = 'none';
          container.innerHTML = '';
          return;
        }

        if (item) item.style.display = 'flex';

        // як у субтитрах: лейбл завжди від currentDub
        label.innerText = currentDub || 'Original';

        container.innerHTML = '';

        uniqueDubs.forEach(dubName => {
          const div = document.createElement('div');
          div.className = 'submenu-option';
          div.innerText = dubName;

          if (dubName === (currentDub || 'Original')) div.classList.add('selected');

          div.onclick = function () {
            const variants = meta.allSources.filter(s => (s.dub || 'Original') === dubName);
            if (!variants.length) return;

            // вибираємо Auto якщо є, інакше найбільша цифра якості (1080/720)
            let target = variants.find(s => String(s.quality).toLowerCase() === 'auto') || null;
            if (!target) {
              const scored = variants
                .map(s => ({ s, score: parseQualityNumber(s.quality) }))
                .sort((a, b) => b.score - a.score);
              target = (scored[0] && scored[0].s) || variants[0];
            }
            if (!target) return;

            // ОПТИМІСТИЧНО, ЯК СУБТИТРИ: одразу міняємо UI, не чекаючи metadata
            currentDub = target.dub || 'Original';
            currentProvider = target.provider;

            label.innerText = currentDub;

            container.querySelectorAll('.submenu-option').forEach(x => x.classList.remove('selected'));
            div.classList.add('selected');

            // щоб не було “старої якості” під час переключення
            const qVal = document.getElementById('val-quality');
            if (qVal) qVal.innerText = 'Auto';

            switchSource(player, target, true);

            closeSubmenu();
          };

          container.appendChild(div);
        });
      }

      // ========================= QUALITY MENU (PLUGIN FIRST) =========================
      function updateQualityMenu(player) {
        const container = document.getElementById('quality-options');
        const val = document.getElementById('val-quality');
        if (!container || !val || !player.playlist) return;

        container.innerHTML = '';

        // 1) пробуємо отримати рівні з плагіна qualityLevels (VHS)
        const ql = player.qualityLevels ? player.qualityLevels() : null;

        const levels = [];
        if (ql && typeof ql.length === 'number') {
          for (let i = 0; i < ql.length; i++) {
            if (ql[i]) levels.push(ql[i]);
          }
        }

        // Вважаємо, що “реальні” рівні є, якщо:
        // - є хоча б один level з height або bitrate або width
        let hasPluginLevels = false;
        for (let i = 0; i < levels.length; i++) {
          if (levels[i].height || levels[i].bitrate || levels[i].width || levels[i].playlist) {
            hasPluginLevels = true;
            break;
          }
        }

        if (hasPluginLevels) {
          // Auto кнопка
          const autoDiv = document.createElement('div');
          autoDiv.className = 'submenu-option';
          autoDiv.innerText = 'Auto';

          // Auto = більше одного enabled або всі enabled
          let enabledCount = 0;
          for (let i = 0; i < levels.length; i++) if (levels[i].enabled) enabledCount++;
          const isAuto = enabledCount !== 1; // якщо не рівно 1 — вважаємо auto
          if (isAuto) {
            autoDiv.classList.add('selected');
            val.innerText = 'Auto';
          }

          autoDiv.onclick = function () {
            for (let i = 0; i < levels.length; i++) levels[i].enabled = true;
            val.innerText = 'Auto';
            closeSubmenu();
            highlightQuality(autoDiv);
          };
          container.appendChild(autoDiv);

          // ✅ FIX: сортуємо по "стандартній" p (через width), потім по bitrate
          const sorted = levels.slice().sort((a, b) => {
            const ar = levelRank(a);
            const br = levelRank(b);
            if (ar.p !== br.p) return br.p - ar.p;
            return br.b - ar.b;
          });

          sorted.forEach(lvl => {
            const div = document.createElement('div');
            div.className = 'submenu-option';
            div.innerText = getLevelLabel(lvl);

            // selected = лише цей enabled
            let selected = true;
            for (let i = 0; i < levels.length; i++) {
              const l = levels[i];
              if (l === lvl) selected = selected && l.enabled;
              else selected = selected && !l.enabled;
            }

            if (selected) {
              div.classList.add('selected');
              val.innerText = getLevelLabel(lvl);
            }

            div.onclick = function () {
              for (let i = 0; i < levels.length; i++) levels[i].enabled = false;
              lvl.enabled = true;
              val.innerText = getLevelLabel(lvl);
              closeSubmenu();
              highlightQuality(div);
            };

            container.appendChild(div);
          });

          // якщо нічого не підсвітилось — показуємо Auto
          if (!container.querySelector('.submenu-option.selected')) {
            autoDiv.classList.add('selected');
            val.innerText = 'Auto';
          }

          return;
        }

        // 2) fallback на manual qualities (якщо HLS рівні не прийшли)
        const idx = player.playlist.currentItem();
        const meta = rawPlaylist?.[idx]?.meta;

        if (meta?.allSources?.length) {
          // НЕ sync з currentSrc під час перемикання (щоб не скакало)
          if (!isSwitching) {
            const active = findActiveManualSource(meta, player);
            if (active) {
              currentDub = active.dub || 'Original';
              currentProvider = active.provider;
            }
          }

          const dubName = currentDub || 'Original';
          const manual = meta.allSources.filter(s => (s.dub || 'Original') === dubName);

          const uniqueByUrl = [];
          manual.forEach(s => {
            if (!uniqueByUrl.some(x => sameUrl(x.url, s.url))) uniqueByUrl.push(s);
          });

          if (uniqueByUrl.length > 1) {
            const curManual = findActiveManualSource(meta, player);

            const sortedManual = uniqueByUrl
              .map(s => ({ s, n: parseQualityNumber(s.quality) }))
              .sort((a, b) => b.n - a.n)
              .map(x => x.s);

            sortedManual.forEach(src => {
              const div = document.createElement('div');
              div.className = 'submenu-option';
              div.innerText = src.quality || 'Unknown';

              if (curManual && sameUrl(curManual.url, src.url)) {
                div.classList.add('selected');
                val.innerText = src.quality || 'Unknown';
              }

              div.onclick = function () {
                switchSource(player, src, true);
                closeSubmenu();
              };

              container.appendChild(div);
            });

            if (!container.querySelector('.submenu-option.selected')) {
              val.innerText = 'Auto';
            }
            return;
          }
        }

        // 3) нічого нема
        container.innerHTML = '<div style="padding:15px;text-align:center;color:#777;">Auto</div>';
        val.innerText = 'Auto';
      }

      function highlightQuality(target) {
        const q = document.getElementById('quality-options');
        if (!q) return;
        const opts = q.children;
        for (let i = 0; i < opts.length; i++) opts[i].classList.remove('selected');
        target.classList.add('selected');
      }

      // ========================= SWITCH SOURCE (FIX AUDIO UI LAG) =========================
      function switchSource(player, source, restoreTime) {
        const time = player.currentTime();
        const wasPaused = player.paused();

        // IMPORTANT: mark switching (prevents updateAudioMenu from syncing to old currentSrc)
        isSwitching = true;

        currentDub = source.dub || 'Original';
        currentProvider = source.provider;

        // UI як у субтитрах: міняємо одразу
        updateAudioMenu(player);
        updateQualityMenu(player);

        player.src({ src: source.url, type: source.type });
        if (source.poster) player.poster(source.poster);

        syncTracks(player, source);

        const finalize = () => {
          if (restoreTime) {
            try { player.currentTime(time); } catch (e) { }
          }
          if (!wasPaused) player.play();

          // switching finished
          isSwitching = false;

          updateAudioMenu(player);
          updateSpeedMenu(player);
          updateQualityMenu(player);
          saveProgress();
        };

        // loadedmetadata — основне
        player.one('loadedmetadata', finalize);

        // fallback якщо metadata дивно відпрацьовує
        player.one('loadeddata', () => {
          // якщо finalize вже був — це просто рефреш меню
          if (isSwitching) {
            isSwitching = false;
            updateAudioMenu(player);
            updateQualityMenu(player);
          }
        });
      }

      // ========================= SUBS MENU (AS-IS) =========================
      function updateSubsMenu(player) {
        const tracks = player.textTracks();
        const container = document.getElementById('subs-options');
        if (!container) return;
        container.innerHTML = '';

        const offDiv = document.createElement('div');
        offDiv.className = 'submenu-option selected';
        offDiv.innerText = 'Вимкнено';

        let anyShowing = false;
        for (let i = 0; i < tracks.length; i++) if (tracks[i].mode === 'showing') anyShowing = true;
        if (anyShowing) offDiv.classList.remove('selected');

        offDiv.onclick = function () {
          for (let i = 0; i < tracks.length; i++) tracks[i].mode = 'disabled';
          const vs = document.getElementById('val-subs');
          if (vs) vs.innerText = 'Вимк';
          closeSubmenu();
          highlightSubs(this);
        };
        container.appendChild(offDiv);

        let added = 0;
        for (let i = 0; i < tracks.length; i++) {
          let tr = tracks[i];
          if (tr.kind !== 'subtitles' && tr.kind !== 'captions') continue;

          let div = document.createElement('div');
          div.className = 'submenu-option';
          div.innerText = tr.label || tr.language || `Track ${i}`;

          if (tr.mode === 'showing') {
            div.classList.add('selected');
            const vs = document.getElementById('val-subs');
            if (vs) vs.innerText = tr.label || tr.language;
          }

          div.onclick = function () {
            for (let j = 0; j < tracks.length; j++) tracks[j].mode = 'disabled';
            tr.mode = 'showing';
            const vs = document.getElementById('val-subs');
            if (vs) vs.innerText = tr.label || tr.language;
            closeSubmenu();
            highlightSubs(this);
          };

          container.appendChild(div);
          added++;
        }

        if (added === 0) container.innerHTML = '<div style="padding:15px;text-align:center;color:#777;">Немає субтитрів</div>';
      }

      function highlightSubs(target) {
        const container = document.getElementById('subs-options');
        if (!container) return;
        const opts = container.children;
        for (let i = 0; i < opts.length; i++) opts[i].classList.remove('selected');
        target.classList.add('selected');
      }

      // ========================= SELECTORS =========================
      function buildSelectors(player) {
        if (typeof rawPlaylist === 'undefined') return;
        const seasons = {};
        rawPlaylist.forEach((item, index) => {
          const s = item.meta?.season || 1;
          const e = item.meta?.episode || (index + 1);
          if (!seasons[s]) seasons[s] = [];
          seasons[s].push({ ep: e, index: index });
        });

        const seasonSelect = document.getElementById('season-select');
        const epSelect = document.getElementById('episode-select');

        if (!seasonSelect || Object.keys(seasons).length === 0) return;

        seasonSelect.style.display = 'block';
        epSelect.style.display = 'block';
        seasonSelect.innerHTML = '';
        epSelect.innerHTML = '';

        Object.keys(seasons).sort((a, b) => a - b).forEach(sNum => {
          const opt = document.createElement('option');
          opt.value = sNum; opt.innerText = 'Сезон ' + sNum;
          seasonSelect.appendChild(opt);
        });

        function updateEpisodes(sNum) {
          epSelect.innerHTML = '';
          const eps = seasons[sNum];
          eps.sort((a, b) => a.ep - b.ep);
          eps.forEach(item => {
            const opt = document.createElement('option');
            opt.value = item.index; opt.innerText = 'Серія ' + item.ep;
            epSelect.appendChild(opt);
          });
        }

        seasonSelect.onchange = function () {
          updateEpisodes(this.value);
          if (seasons[this.value] && seasons[this.value][0]) {
            player.playlist.currentItem(seasons[this.value][0].index);
          }
        };

        epSelect.onchange = function () {
          player.playlist.currentItem(parseInt(this.value));
        };

        const firstSeason = Object.keys(seasons).sort((a, b) => a - b)[0];
        if (firstSeason) updateEpisodes(firstSeason);

        player.on('playlistitem', function () {
          const idx = player.playlist.currentItem();
          const currentItem = rawPlaylist[idx];
          if (currentItem && currentItem.meta) {
            const s = currentItem.meta.season;
            if (seasonSelect.value != s) {
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