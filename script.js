// Video Generator Application
class VideoGenerator {
    constructor() {
        this.currentProject = null;
        this.mediaItems = []; // Changed from images to mediaItems to support both images and videos
        this.subtitles = [];
        this.audioFile = null;
        this.videoDuration = 30;
        this.isGenerating = false;
        this.currentMediaRecorder = null;
        this.previewAnimation = null;
        this.previewPlaying = false;
        this.previewStartTime = null;
        this.previewCurrentTime = 0;
        this.canvas = null;
        this.ctx = null;
        this.videoFrameCache = new Map(); // Cache for extracted video frames
        this.lastRenderedFrame = null; // Cache last rendered frame to reduce flickering
        
        this.initializeElements();
        this.bindEvents();
        this.setupCanvas();
        this.updateTimeDisplay();
    }

    // Create (or reuse) a single AudioContext + MediaElementSource for the app
    async ensureSharedAudioPipeline() {
        if (!this.audioFile || !this.elements.audioElement?.src) return null;
        // Create shared context if missing
        if (!this.sharedAudioContext) {
            this.sharedAudioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 44100,
                latencyHint: 'playback'
            });
        }
        if (this.sharedAudioContext.state === 'suspended') {
            try { await this.sharedAudioContext.resume(); } catch {}
        }
        // Create one MediaElementSource per media element lifetime
        if (!this.mediaElementSource) {
            this.mediaElementSource = this.sharedAudioContext.createMediaElementSource(this.elements.audioElement);
        }
        // Keep a monitor path for preview/listen, created once
        if (!this.monitorGainNode) {
            this.monitorGainNode = this.sharedAudioContext.createGain();
            this.monitorGainNode.gain.value = 1.0;
            this.mediaElementSource.connect(this.monitorGainNode);
            this.monitorGainNode.connect(this.sharedAudioContext.destination);
        }
        return this.sharedAudioContext;
    }

    // Ensure a project exists; if not, create one with a sensible default name and update UI
    ensureProjectExists() {
        if (this.currentProject) return;
        const suggested = (this.elements.projectName?.value || '').trim();
        const dt = new Date();
        const hh = String(dt.getHours()).padStart(2, '0');
        const mm = String(dt.getMinutes()).padStart(2, '0');
        const name = suggested || `Проект ${hh}:${mm}`;
        this.currentProject = name;
        if (this.elements.currentProject) this.elements.currentProject.style.display = 'block';
        if (this.elements.projectTitle) this.elements.projectTitle.textContent = name;
        if (this.elements.projectName) this.elements.projectName.value = '';
        this.updateGenerateButton();
        this.showNotification(`Проект "${name}" создан автоматически`, 'info');
    }

    // Subtitles management
    addSubtitle() {
        const text = (this.elements.subtitleText?.value || '').trim();
        const startStr = this.elements.subtitleStart?.value || '00:00';
        const duration = Math.max(1, parseInt(this.elements.subtitleDuration?.value || '5', 10));
        if (!text) {
            this.showNotification('Введите текст титров', 'warning');
            return;
        }
        const start = this.parseTime(startStr);
        if (start > this.videoDuration) {
            this.showNotification(`Начало титров не может превышать ${this.formatTime(this.videoDuration)}`, 'warning');
            return;
        }
        const entry = {
            id: Date.now() + Math.random(),
            text,
            start,
            duration
        };
        // Clamp to video duration
        if (entry.start + entry.duration > this.videoDuration) {
            entry.duration = Math.max(1, this.videoDuration - entry.start);
        }
        this.subtitles.push(entry);
        // Reset inputs
        if (this.elements.subtitleText) this.elements.subtitleText.value = '';
        if (this.elements.subtitleStart) this.elements.subtitleStart.value = '';
        if (this.elements.subtitleDuration) this.elements.subtitleDuration.value = '5';
        this.renderSubtitleList();
        this.showNotification('Титр добавлен', 'success');
    }

    removeSubtitle(id) {
        const idx = this.subtitles.findIndex(s => s.id === id);
        if (idx !== -1) {
            this.subtitles.splice(idx, 1);
            this.renderSubtitleList();
        }
    }

    renderSubtitleList() {
        if (!this.elements.subtitleList) return;
        this.elements.subtitleList.innerHTML = '';
        const sorted = [...this.subtitles].sort((a, b) => a.start - b.start);
        sorted.forEach(sub => {
            const row = document.createElement('div');
            row.className = 'subtitle-item';
            row.innerHTML = `
                <div class="subtitle-info" style="width:100%; display:flex; align-items:center; gap:12px;">
                    <input type="text" class="subtitle-text input-field" style="flex:3; min-width:260px;" value="${this.escapeHtml(sub.text)}" placeholder="Текст">
                    <input type="text" class="subtitle-start input-field" style="width:110px;" value="${this.formatTime(sub.start)}" placeholder="MM:SS" pattern="[0-9]{1,2}:[0-9]{2}">
                    <input type="number" class="subtitle-duration input-field" style="width:90px;" value="${sub.duration}" min="1" max="300">
                    <button class="remove-subtitle" data-id="${sub.id}">Удалить</button>
                </div>
            `;
            const removeBtn = row.querySelector('.remove-subtitle');
            removeBtn.addEventListener('click', () => this.removeSubtitle(sub.id));
            // Edit handlers
            const textInput = row.querySelector('.subtitle-text');
            const startInput = row.querySelector('.subtitle-start');
            const durInput = row.querySelector('.subtitle-duration');
            textInput.addEventListener('change', (e) => {
                sub.text = e.target.value.trim();
            });
            startInput.addEventListener('change', (e) => {
                const newStart = this.parseTime(e.target.value);
                if (newStart <= this.videoDuration) {
                    sub.start = newStart;
                    // Clamp duration to fit into video
                    if (sub.start + sub.duration > this.videoDuration) {
                        sub.duration = Math.max(1, this.videoDuration - sub.start);
                        durInput.value = String(sub.duration);
                    }
                    startInput.value = this.formatTime(sub.start);
                    this.renderSubtitleList();
                } else {
                    e.target.value = this.formatTime(sub.start);
                    this.showNotification(`Время не может превышать ${this.formatTime(this.videoDuration)}`, 'warning');
                }
            });
            durInput.addEventListener('change', (e) => {
                let d = parseInt(e.target.value, 10);
                if (!Number.isFinite(d) || d < 1) d = 1;
                if (sub.start + d > this.videoDuration) {
                    d = Math.max(1, this.videoDuration - sub.start);
                }
                sub.duration = d;
                e.target.value = String(sub.duration);
            });
            this.elements.subtitleList.appendChild(row);
        });
    }

    // Video effects overlay
    drawEffect(currentTime, w, h) {
        if (!this.elements.videoEffect) return;
        const effect = this.elements.videoEffect.value || 'none';
        if (effect === 'none') return;
        switch (effect) {
            case 'film':
                this.drawFilmEffect(currentTime, w, h);
                break;
            case 'film_marks':
                this.drawFilmMarksEffect(currentTime, w, h);
                break;
            case 'rain':
                this.drawRainEffect(currentTime, w, h);
                break;
            case 'clouds':
                this.drawCloudsEffect(currentTime, w, h);
                break;
            case 'fireworks':
                this.drawFireworksEffect(currentTime, w, h);
                break;
            case 'stars':
                this.drawStarsEffect(currentTime, w, h);
                break;
            case 'galaxy':
                this.drawGalaxyEffect(currentTime, w, h);
                break;
        }
    }

    // Intensity helpers
    getEffectIntensity() {
        const val = parseInt(this.elements?.effectIntensity?.value || '50', 10);
        if (!Number.isFinite(val)) return 50;
        return Math.min(100, Math.max(0, val));
    }
    getIntensityScales() {
        const s = this.getEffectIntensity(); // 0..100
        const count = 0.2 + s / 50; // 0.2 .. 2.2
        const size = 0.7 + (s / 100) * 0.8; // 0.7 .. 1.5
        const alpha = 0.5 + (s / 100) * 0.5; // 0.5 .. 1.0
        return { count, size, alpha };
    }

    // --- Lightweight noise helpers for chaotic motion (deterministic yet time-varying) ---
    // Returns 0..1 pseudo-random value depending on time and seed
    noise01(t, seed = 0, freq = 1) {
        // Combine a couple of trig waves for a cheap noise-like function
        const x = t * freq + seed * 0.123;
        const v = Math.sin(x * 2.3 + Math.cos(x * 0.7) * 1.9 + seed * 1.17);
        return 0.5 + 0.5 * v;
    }
    // Returns -1..1
    noise11(t, seed = 0, freq = 1) {
        return this.noise01(t, seed, freq) * 2 - 1;
    }

    drawFilmEffect(currentTime, w, h) {
        this.ctx.save();
        const I = this.getIntensityScales();
        
        // Enhanced sepia tint with subtle color variations
        const sepiaR = 112 + this.noise11(currentTime * 0.5, 1) * 20;
        const sepiaG = 66 + this.noise11(currentTime * 0.4, 2) * 15;
        const sepiaB = 20 + this.noise11(currentTime * 0.3, 3) * 10;
        this.ctx.fillStyle = `rgba(${sepiaR}, ${sepiaG}, ${sepiaB}, ${0.08 + 0.06 * I.alpha})`;
        this.ctx.fillRect(0, 0, w, h);
        
        // Film grain - realistic noise texture
        this.drawFilmGrain(currentTime, w, h, I);
        
        // Gate weave / frame jitter overlays (simulate subtle camera/film movement without shifting content)
        const weaveX = this.noise11(currentTime * 1.7, 321) * 2.0;
        const weaveY = this.noise11(currentTime * 1.3, 654) * 1.5;
        const edgeDark = 0.06 + 0.06 * I.alpha;
        this.ctx.fillStyle = `rgba(0,0,0,${edgeDark})`;
        // Thin dark borders that wobble
        this.ctx.fillRect(0, 0, Math.max(0, 3 + weaveX), h);
        this.ctx.fillRect(w - Math.max(0, 3 - weaveX), 0, Math.max(0, 3 - weaveX), h);
        this.ctx.fillRect(0, 0, w, Math.max(0, 3 + weaveY));
        this.ctx.fillRect(0, h - Math.max(0, 4 - weaveY), w, Math.max(0, 4 - weaveY));

        // Enhanced vignette with irregular edges
        const vignetteIntensity = 0.3 + 0.3 * I.alpha;
        for (let i = 0; i < 3; i++) {
            const offsetX = this.noise11(currentTime * 0.1, i * 10) * 20;
            const offsetY = this.noise11(currentTime * 0.08, i * 15) * 15;
            const grd = this.ctx.createRadialGradient(
                w/2 + offsetX, h/2 + offsetY, Math.min(w,h)/4, 
                w/2 + offsetX, h/2 + offsetY, Math.max(w,h)/1.2
            );
            grd.addColorStop(0, 'rgba(0,0,0,0)');
            grd.addColorStop(1, `rgba(0,0,0,${vignetteIntensity * (0.3 + i * 0.1)})`);
            this.ctx.fillStyle = grd;
            this.ctx.fillRect(0, 0, w, h);
        }
        
        // Film flicker effect
        const flickerIntensity = 0.05 + 0.1 * I.alpha;
        const flicker = this.noise11(currentTime * 12, 100) * flickerIntensity;
        if (Math.abs(flicker) > 0.02) {
            this.ctx.fillStyle = flicker > 0 ? 
                `rgba(255,255,255,${Math.abs(flicker)})` : 
                `rgba(0,0,0,${Math.abs(flicker)})`;
            this.ctx.fillRect(0, 0, w, h);
        }

        // Light leaks from edges (occasional)
        const leakChance = this.noise01(currentTime * 0.2, 777);
        if (leakChance > 0.75) {
            const side = (leakChance > 0.88) ? 'left' : 'right';
            const leak = this.ctx.createLinearGradient(side === 'left' ? 0 : w, 0, side === 'left' ? Math.min(200, w*0.25) : w - Math.min(200, w*0.25), 0);
            const a = (leakChance - 0.75) * 0.6 * (0.6 + 0.6 * I.alpha);
            const c1 = `rgba(255, 120, 60, ${a})`;
            const c2 = `rgba(255, 200, 150, ${a * 0.6})`;
            const c3 = 'rgba(255, 255, 255, 0)';
            leak.addColorStop(0, c1);
            leak.addColorStop(0.4, c2);
            leak.addColorStop(1, c3);
            this.ctx.fillStyle = leak;
            this.ctx.fillRect(0, 0, w, h);
        }
        
        // Enhanced scratches with varying opacity and width
        this.ctx.globalAlpha = 0.15 + 0.3 * I.alpha;
        this.ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        const scratchCount = Math.max(3, Math.round(12 * I.count));
        
        for (let i = 0; i < scratchCount; i++) {
            const scratchLife = (currentTime * (0.3 + i * 0.1)) % 2; // 2 second cycle
            if (scratchLife > 1.5) continue; // Scratch appears for 1.5 out of 2 seconds
            
            const x = this.noise01(currentTime * 0.1, i * 50) * w;
            const scratchHeight = (0.3 + this.noise01(0, i) * 0.7) * h;
            const y1 = this.noise01(currentTime * 0.05, i * 30) * (h - scratchHeight);
            const y2 = y1 + scratchHeight;
            
            // Varying scratch width and opacity
            const width = (0.5 + this.noise01(0, i) * 1.5) * I.size;
            const opacity = (0.4 + this.noise01(scratchLife * 5, i) * 0.6) * (1.5 - scratchLife);
            
            this.ctx.lineWidth = width;
            this.ctx.globalAlpha = opacity * I.alpha;
            this.ctx.beginPath();
            this.ctx.moveTo(x, y1);
            this.ctx.lineTo(x + this.noise11(currentTime, i) * 5, y2);
            this.ctx.stroke();
        }

        // Occasional cue mark (reel change dot) top-right
        if (((currentTime / 10) | 0) % 2 === 0 && (currentTime % 10) > 8.5) {
            this.ctx.globalAlpha = 0.4 * I.alpha;
            this.ctx.fillStyle = 'rgba(255,255,255,0.9)';
            const r = Math.min(10, Math.max(6, Math.round(Math.min(w, h) * 0.01)));
            this.ctx.beginPath();
            this.ctx.arc(w - r * 1.5, r * 1.5, r, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.globalAlpha = 1;
        }
        
        // Hair and debris
        this.drawFilmDebris(currentTime, w, h, I);
        
        // Enhanced dust particles with varying sizes and movement
        this.ctx.globalAlpha = 1;
        const dustCount = Math.max(8, Math.round(120 * I.count));
        for (let i = 0; i < dustCount; i++) {
            const dustLife = (currentTime * (0.5 + i * 0.02)) % 3; // 3 second cycle
            const dustOpacity = Math.sin(dustLife * Math.PI / 3) * 0.3; // Fade in/out
            
            if (dustOpacity < 0.05) continue;
            
            const x = (this.noise01(currentTime * 0.8, i * 101) * w + currentTime * (10 + i % 20)) % (w + 100) - 50;
            const y = (this.noise01(currentTime * 0.6, i * 97) * h + currentTime * (5 + i % 15)) % (h + 100) - 50;
            const r = (0.3 + this.noise01(currentTime * 1.1, i * 29) * 2.0) * I.size;
            
            // Different types of dust particles
            const dustType = i % 3;
            let dustColor;
            switch (dustType) {
                case 0: // White dust
                    dustColor = `rgba(255,255,255,${dustOpacity * I.alpha})`;
                    break;
                case 1: // Dark spots
                    dustColor = `rgba(50,30,20,${dustOpacity * I.alpha})`;
                    break;
                default: // Sepia dust
                    dustColor = `rgba(200,150,100,${dustOpacity * I.alpha})`;
            }
            
            this.ctx.fillStyle = dustColor;
            this.ctx.beginPath();
            this.ctx.arc(x, y, r, 0, Math.PI * 2);
            this.ctx.fill();
        }

        // Film burn effect (rare brief appearance)
        const burnChance = this.noise01(currentTime * 0.12, 4242);
        if (burnChance > 0.97) {
            const bx = this.noise01(currentTime * 0.3, 12) * w;
            const by = this.noise01(currentTime * 0.27, 34) * h;
            const br = 20 + 60 * (burnChance - 0.97) / 0.03;
            // Inner charred area
            const g1 = this.ctx.createRadialGradient(bx, by, 0, bx, by, br);
            g1.addColorStop(0, 'rgba(0,0,0,0.8)');
            g1.addColorStop(0.7, 'rgba(30,10,0,0.7)');
            g1.addColorStop(1, 'rgba(0,0,0,0)');
            this.ctx.fillStyle = g1;
            this.ctx.beginPath();
            this.ctx.arc(bx, by, br, 0, Math.PI * 2);
            this.ctx.fill();
            // Hot rim
            const g2 = this.ctx.createRadialGradient(bx, by, br * 0.6, bx, by, br * 1.1);
            g2.addColorStop(0, 'rgba(255,180,80,0.35)');
            g2.addColorStop(1, 'rgba(255,180,80,0)');
            this.ctx.fillStyle = g2;
            this.ctx.beginPath();
            this.ctx.arc(bx, by, br * 1.1, 0, Math.PI * 2);
            this.ctx.fill();
        }
        
        this.ctx.restore();
    }

    drawFilmGrain(currentTime, w, h, I) {
        // Create realistic film grain texture
        const grainIntensity = 0.02 + 0.04 * I.alpha;
        const grainSize = Math.max(1, Math.round(2 * I.size));
        const grainCount = Math.round((w * h) / (grainSize * grainSize * 4));
        
        for (let i = 0; i < grainCount; i++) {
            const x = (this.noise01(currentTime * 10, i * 123) * w) % w;
            const y = (this.noise01(currentTime * 8, i * 456) * h) % h;
            const brightness = this.noise11(currentTime * 15, i * 789);
            const alpha = Math.abs(brightness) * grainIntensity;
            
            const color = brightness > 0 ? 255 : 0;
            this.ctx.fillStyle = `rgba(${color},${color},${color},${alpha})`;
            this.ctx.fillRect(x, y, grainSize, grainSize);
        }
    }

    drawFilmDebris(currentTime, w, h, I) {
        // Hair-like scratches and debris
        this.ctx.globalAlpha = 0.1 + 0.2 * I.alpha;
        this.ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        
        const debrisCount = Math.max(2, Math.round(6 * I.count));
        for (let i = 0; i < debrisCount; i++) {
            const debrisLife = (currentTime * (0.2 + i * 0.05)) % 4; // 4 second cycle
            if (debrisLife > 2) continue; // Appears for half the cycle
            
            const startX = this.noise01(currentTime * 0.05, i * 200) * w;
            const startY = this.noise01(currentTime * 0.03, i * 300) * h;
            const length = (20 + this.noise01(0, i) * 40) * I.size;
            const angle = this.noise11(0, i * 100) * Math.PI * 2;
            
            const endX = startX + Math.cos(angle) * length;
            const endY = startY + Math.sin(angle) * length * 0.6; // Flatten vertically
            const width = (0.5 + this.noise01(0, i) * 1.5) * I.size;
            
            this.ctx.lineWidth = width;
            this.ctx.beginPath();
            this.ctx.moveTo(startX, startY);
            this.ctx.lineTo(endX, endY);
            this.ctx.stroke();
        }
    }

    drawCopyrightOverlay(canvasWidth, canvasHeight) {
        const text = (this.elements?.copyrightText?.value || '').trim();
        if (!text) return;
        this.ctx.save();
        // Style
        const fontSize = Math.max(12, Math.round(canvasHeight * 0.03));
        this.ctx.font = `${fontSize}px sans-serif`;
        this.ctx.textBaseline = 'top';
        this.ctx.textAlign = 'right';
        const paddingX = Math.round(fontSize * 0.6);
        const paddingY = Math.round(fontSize * 0.4);
        const margin = Math.max(8, Math.round(canvasHeight * 0.02));
        const metrics = this.ctx.measureText(text);
        const textWidth = Math.ceil(metrics.width);
        const textHeight = Math.round(fontSize * 1.2);
        const boxW = textWidth + paddingX * 2;
        const boxH = textHeight + paddingY * 2;
        const x = canvasWidth - margin;
        const y = margin;
        // Shadow for better readability
        this.ctx.shadowColor = 'rgba(0,0,0,0.7)';
        this.ctx.shadowBlur = Math.max(2, Math.round(fontSize * 0.25));
        // Background pill
        this.drawRoundedRect(x - boxW, y, boxW, boxH, Math.round(boxH/2), 'rgba(0,0,0,0.45)');
        // Text
        this.ctx.fillStyle = 'rgba(255,255,255,0.92)';
        this.ctx.fillText(text, x - paddingX, y + paddingY);
        this.ctx.restore();
    }

    drawFilmMarksEffect(currentTime, w, h) {
        this.ctx.save();
        // subtle noise tint
        const I = this.getIntensityScales();
        this.ctx.fillStyle = `rgba(255,255,255,${0.02 + 0.03 * I.alpha})`;
        this.ctx.fillRect(0, 0, w, h);
        // corner circles (registration marks)
        this.ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        this.ctx.lineWidth = (1.5 + this.noise01(currentTime*1.7, 7) * 2) * I.size;
        const r = Math.max(10, Math.min(w, h) * 0.04 * I.size);
        const offset = r + 8;
        const centers = [
            [offset, offset],
            [w - offset, offset],
            [offset, h - offset],
            [w - offset, h - offset]
        ];
        centers.forEach(([cx, cy], i) => {
            const jitter = this.noise11(currentTime * 2.5, i * 19) * 2.2;
            this.ctx.beginPath();
            this.ctx.arc(cx + jitter, cy + jitter, r, 0, Math.PI * 2);
            this.ctx.stroke();
        });
        // arrows along edges
        const arrowCount = Math.max(4, Math.round(8 * I.count));
        this.ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        for (let i = 0; i < arrowCount; i++) {
            const t = (i / arrowCount + (currentTime * (0.07 + this.noise01(currentTime*0.3, i)*0.08))) % 1;
            const x = 20 + t * (w - 40);
            // top
            this.drawArrow(x, 30, 0);
            // bottom
            this.drawArrow(w - x, h - 30, Math.PI);
        }
        this.ctx.restore();
    }

    drawArrow(x, y, angle) {
        this.ctx.save();
        this.ctx.translate(x, y);
        this.ctx.rotate(angle);
        this.ctx.beginPath();
        this.ctx.moveTo(-12, -6);
        this.ctx.lineTo(8, -6);
        this.ctx.lineTo(8, -12);
        this.ctx.lineTo(20, 0);
        this.ctx.lineTo(8, 12);
        this.ctx.lineTo(8, 6);
        this.ctx.lineTo(-12, 6);
        this.ctx.closePath();
        this.ctx.stroke();
        this.ctx.restore();
    }

    drawFireworksEffect(currentTime, w, h) {
        this.ctx.save();
        const I = this.getIntensityScales();
        const launchesPerSec = 0.5 + 1.5 * I.count;
        const activeShells = Math.max(2, Math.round(3 + 3 * I.count));

        for (let s = 0; s < activeShells; s++) {
            const seed = s * 911;
            const phase = (currentTime * launchesPerSec + this.noise01(seed * 0.37, 0)) % 1; // 0..1

            // Launch phase (0..0.35), Burst phase (0.35..0.65), Ember phase (0.65..1)
            const isLaunch = phase < 0.35;
            const isBurst = phase >= 0.35 && phase < 0.65;
            const isEmber = phase >= 0.65 && phase < 1.0;

            // Launch position and target burst center
            const launchX = this.noise01(currentTime * 0.05, seed) * (w * 0.8) + w * 0.1;
            const targetX = this.noise01(currentTime * 0.12, seed * 1.7) * (w * 0.6) + w * 0.2;
            const targetY = this.noise01(currentTime * 0.13, seed * 2.3) * (h * 0.35) + h * 0.08;

            if (isLaunch) {
                const t = phase / 0.35; // 0..1
                const y = h - t * (h - targetY);
                const x = launchX + (targetX - launchX) * (0.8 * t + 0.2 * t * t);
                const glow = 0.6 + 0.4 * this.noise01(currentTime * 8, seed);

                // Rocket core
                this.ctx.globalAlpha = (0.8 * glow) * I.alpha;
                this.ctx.fillStyle = 'rgba(255, 230, 150, 1)';
                this.ctx.beginPath();
                this.ctx.arc(x, y, 2.2 * I.size, 0, Math.PI * 2);
                this.ctx.fill();

                // Tail flame
                this.drawRadialGlow(x, y + 6, 10 * I.size, 'rgba(255,180,80,1)', 0.55 * glow * I.alpha);
                this.drawRadialGlow(x, y + 12, 16 * I.size, 'rgba(255,120,40,1)', 0.35 * glow * I.alpha);

                // Spark trail
                const sparks = 14;
                for (let i = 0; i < sparks; i++) {
                    const ang = Math.PI + (i / sparks) * 0.6 - 0.3;
                    const dist = 8 + i * 1.7;
                    const sx = x + Math.cos(ang) * dist;
                    const sy = y + Math.sin(ang) * dist + i * 1.6;
                    this.ctx.globalAlpha = (0.5 - i / sparks * 0.5) * I.alpha;
                    this.ctx.fillStyle = 'rgba(255,220,150,1)';
                    this.ctx.beginPath();
                    this.ctx.arc(sx, sy, Math.max(0.6, 1.2 - i * 0.05) * I.size, 0, Math.PI * 2);
                    this.ctx.fill();
                }

                // Smoke puffs along trail
                for (let i = 0; i < 3; i++) {
                    const f = i / 3;
                    this.drawSmokePuff(x + this.noise11(currentTime * 0.5, seed + i) * 4,
                                       y + 10 + f * 20,
                                       10 + 14 * f,
                                       0.15 * (1 - t) * I.alpha);
                }
                continue;
            }

            // Burst center
            const cx = targetX;
            const cy = targetY;

            // Explosion flash on burst start
            if (phase < 0.38) {
                const f = (0.38 - phase) / 0.03; // 0..1 shortly
                this.drawRadialGlow(cx, cy, 48 * I.size, 'rgba(255,255,255,1)', 0.6 * f * I.alpha);
                this.drawRadialGlow(cx, cy, 90 * I.size, 'rgba(255,200,120,1)', 0.35 * f * I.alpha);
            }

            // Choose firework style deterministically per shell
            const type = seed % 5; // 0: Peony, 1: Chrysanthemum, 2: Willow, 3: Palm, 4: Crackle
            const particleCount = Math.max(60, Math.round(120 * I.count));
            const life = isBurst ? (phase - 0.35) / 0.3 : (phase - 0.65) / 0.35; // 0..1 within each stage

            for (let p = 0; p < particleCount; p++) {
                const a0 = (p / particleCount) * Math.PI * 2;
                const jitter = this.noise11(currentTime * 0.6, seed + p * 17) * 0.25;
                let ang = a0 + jitter;

                // Polar speed profile by type
                let v0;
                if (type === 2) { // Willow - slower with gravity droop
                    v0 = 120 + 40 * this.noise01(0, seed + p);
                } else if (type === 3) { // Palm - emphasize vertical streaks
                    ang = Math.round(ang / (Math.PI / 6)) * (Math.PI / 6);
                    v0 = 160 + 60 * this.noise01(0, seed + p);
                } else {
                    v0 = 140 + 60 * this.noise01(0, seed + p);
                }

                // Radial distance over time with decay
                const decay = 0.92;
                const speed = v0 * Math.pow(decay, (isBurst ? life : (0.3 + life)) * 60);
                const r = speed * (isBurst ? life : (0.3 + life));

                // Gravity droop for willow and general arc
                const gy = (type === 2 ? 220 : 150) * (isBurst ? life * life : (0.3 + life) * (0.3 + life));
                const x = cx + Math.cos(ang) * r;
                const y = cy + Math.sin(ang) * r + gy;
                if (y > h + 60) continue;

                // Color selection
                const palettes = [
                    [45, 60, 75],     // gold range
                    [10, 20, 30],     // orange-red
                    [200, 260, 300],  // blue-purple
                    [100, 120, 140],  // green
                    [0, 45, 60]       // crackle: warm
                ];
                const hues = palettes[type];
                const hue = hues[(p + seed) % hues.length] + this.noise11(0, p) * 15;
                const sat = 80 + this.noise01(0, p) * 20;
                const lum = 50 + this.noise01(0, seed + p) * 40;

                // Alpha by stage
                const stageLife = isBurst ? (1 - life) : (1 - life) * 0.8;
                const alpha = Math.max(0, stageLife) * (0.8 + 0.2 * this.noise01(currentTime * 3, p));
                const size = (isBurst ? 1.6 : 1.2) * (1.0 + this.noise01(0, p)) * I.size * stageLife;

                // Glow + core
                this.drawRadialGlow(x, y, size * 3.2, `hsla(${hue}, ${sat}%, ${lum}%, 1)`, 0.3 * alpha * I.alpha);
                this.ctx.globalAlpha = alpha * I.alpha;
                this.ctx.fillStyle = `hsla(${hue}, ${Math.min(100, sat + 15)}%, ${Math.min(90, lum + 15)}%, 1)`;
                this.ctx.beginPath();
                this.ctx.arc(x, y, Math.max(0.8, size), 0, Math.PI * 2);
                this.ctx.fill();

                // Trailing streaks
                if (p % 3 === 0) {
                    this.ctx.globalAlpha = 0.45 * alpha * I.alpha;
                    this.ctx.strokeStyle = `hsla(${hue}, ${sat}%, ${lum}%, 1)`;
                    this.ctx.lineWidth = Math.max(0.6, size * 0.45);
                    this.ctx.beginPath();
                    this.ctx.moveTo(x - Math.cos(ang) * 14, y - Math.sin(ang) * 14);
                    this.ctx.lineTo(x, y);
                    this.ctx.stroke();
                }

                // Crackle micro-sparks for type 4 near the end
                if (type === 4 && isEmber && (p % 8 === 0)) {
                    const m = 4;
                    for (let k = 0; k < m; k++) {
                        const aa = ang + this.noise11(currentTime * 2, seed + p * 31 + k) * 0.6;
                        const rr = 6 + 10 * this.noise01(0, k + p);
                        const mx = x + Math.cos(aa) * rr;
                        const my = y + Math.sin(aa) * rr;
                        this.ctx.globalAlpha = 0.5 * alpha * I.alpha;
                        this.ctx.fillStyle = `hsla(${hue}, ${sat}%, ${Math.min(90, lum + 10)}%, 1)`;
                        this.ctx.beginPath();
                        this.ctx.arc(mx, my, 0.7, 0, Math.PI * 2);
                        this.ctx.fill();
                    }
                }
            }

            // Residual smoke cloud after burst
            const smokeAlpha = (isEmber ? (1 - (phase - 0.65) / 0.35) : (isBurst ? 0.5 : 0)) * (0.2 + 0.3 * I.alpha);
            if (smokeAlpha > 0.02) {
                for (let i = 0; i < 4; i++) {
                    this.drawSmokePuff(cx + this.noise11(currentTime * 0.2, seed + i) * 18,
                                       cy + this.noise11(currentTime * 0.25, seed + 77 + i) * 14,
                                       22 + i * 10,
                                       smokeAlpha * (0.7 - i * 0.12));
                }
            }
        }
        
        this.ctx.restore();
    }

    // Helper: soft radial glow
    drawRadialGlow(x, y, r, color, alpha) {
        if (alpha <= 0) return;
        const grd = this.ctx.createRadialGradient(x, y, 0, x, y, r);
        // Use provided color at center
        grd.addColorStop(0, color);
        // Create a transparent version of the color for outer edge
        let transparent;
        if (typeof color === 'string' && color.startsWith('rgba(')) {
            transparent = color.replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/, 'rgba($1,$2,$3,0)');
        } else if (typeof color === 'string' && color.startsWith('hsla(')) {
            transparent = color.replace(/hsla\(([^,]+),([^,]+),([^,]+),[^)]+\)/, 'hsla($1,$2,$3,0)');
        } else {
            transparent = 'rgba(255,255,255,0)';
        }
        grd.addColorStop(1, transparent);
        this.ctx.globalAlpha = alpha;
        this.ctx.fillStyle = grd;
        this.ctx.beginPath();
        this.ctx.arc(x, y, r, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.globalAlpha = 1;
    }

    // Helper: smoke puff
    drawSmokePuff(x, y, r, alpha) {
        if (alpha <= 0) return;
        const g = this.ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(200, 200, 200, ${Math.min(0.35, alpha)})`);
        g.addColorStop(1, 'rgba(200,200,200,0)');
        this.ctx.globalAlpha = 1;
        this.ctx.fillStyle = g;
        this.ctx.beginPath();
        this.ctx.arc(x, y, r, 0, Math.PI * 2);
        this.ctx.fill();
    }

    drawStarsEffect(currentTime, w, h) {
        this.ctx.save();
        const I = this.getIntensityScales();
        const count = Math.max(40, Math.round(((w * h) / 16000) * I.count));
        for (let i = 0; i < count; i++) {
            // Slower gentle drift
            const vx = (this.noise11(currentTime * 0.08, i * 3) * 8) + 2 * (i % 3);
            const vy = this.noise11(currentTime * 0.09, i * 7) * 4;
            const baseX = (i * 97) % (w + 200) - 100;
            const baseY = (i * 57) % (h + 200) - 100;
            const sway = this.noise11(currentTime * 2.2, i * 0.7) * 10; // local curvature
            const seed = i * 97; // Define seed variable
            const t = (currentTime + (seed % 1000) / 997) % 1000;
            const x = ((baseX + currentTime * vx) % (w + 200)) - 100 + sway;
            const y = ((baseY + currentTime * (6 + vy)) % (h + 200)) - 100;
            const tw = 0.25 + 0.75 * this.noise01(currentTime * (1.8 + (i % 5) * 0.25), i * 11);
            this.ctx.fillStyle = `rgba(255,255,255,${tw})`;
            const sz = Math.max(1, Math.round(1 + this.noise01(0, i) * 2 * I.size));
            this.ctx.fillRect(x, y, sz, sz);
        }
        this.ctx.restore();
    }

    // Galaxy: rotating spiral arms, twinkling stars, view from inside galaxy disk looking up
    drawGalaxyEffect(currentTime, w, h) {
        this.ctx.save();
        const I = this.getIntensityScales();
        
        // Camera/view params - we are inside the galaxy disk, looking up/around
        const cx = w * 0.5;   // center horizontally in middle
        const cy = h * 1.1;   // center below the screen but not too far (so stars are visible)
        const tilt = 0.7;     // moderate inclination - we see the disk from slightly above
        const armCount = 4;   // spiral arms
        const pitch = 0.18;   // slightly tighter spiral for more definition
        const baseRadius = Math.min(w, h) * 3.0; // large radius but not too massive
        const rotBase = 0.015; // slower base rotation speed
        const rotGain = 0.35;  // moderate difference in rotation speeds

        const totalCount = Math.max(800, Math.round(((w * h) / 2500) * I.count)); // significantly more stars
        const armStarRatio = 0.6; // 60% of stars in spiral arms, 40% background
        const armStarCount = Math.round(totalCount * armStarRatio);
        const backgroundStarCount = totalCount - armStarCount;
        
        // Draw spiral arm stars
        for (let i = 0; i < armStarCount; i++) {
            this.drawArmStar(i, currentTime, w, h, cx, cy, tilt, armCount, pitch, baseRadius, rotBase, rotGain, I);
        }
        
        // Draw background stars between arms
        for (let i = 0; i < backgroundStarCount; i++) {
            this.drawBackgroundStar(i + armStarCount, currentTime, w, h, cx, cy, tilt, baseRadius, rotBase, rotGain, I);
        }

        // Subtle nebula glow from center - adjusted scale
        const nebulaGlow = this.ctx.createRadialGradient(
            cx, cy, Math.min(w, h) * 0.2, 
            cx, cy, Math.max(w, h) * 1.5
        );
        nebulaGlow.addColorStop(0, `rgba(210, 225, 245, ${0.06 + 0.07 * I.alpha})`); // brighter for visibility
        nebulaGlow.addColorStop(0.7, `rgba(170, 190, 220, ${0.03 + 0.04 * I.alpha})`);
        nebulaGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
        this.ctx.fillStyle = nebulaGlow;
        this.ctx.fillRect(0, 0, w, h);

        // Subtle spiral arm density enhancements
        for (let arm = 0; arm < armCount; arm++) {
            const armAngle = (arm / armCount) * Math.PI * 2 + currentTime * 0.008;
            const armX = cx + Math.cos(armAngle) * baseRadius * 0.8;
            const armY = cy + Math.sin(armAngle) * baseRadius * 0.8 * tilt;
            
            const armGlow = this.ctx.createRadialGradient(
                armX, armY, 20,
                armX, armY, baseRadius * 0.6
            );
            armGlow.addColorStop(0, `rgba(230, 240, 255, ${0.03 + 0.04 * I.alpha})`); // brighter for visibility
            armGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
            
            this.ctx.fillStyle = armGlow;
            this.ctx.fillRect(0, 0, w, h);
        }

        this.ctx.restore();
    }

    drawArmStar(i, currentTime, w, h, cx, cy, tilt, armCount, pitch, baseRadius, rotBase, rotGain, I) {
        // Seeds
        const seed = (i * 16807) % 2147483647;
        const r01 = ((seed ^ 0x9e3779b9) & 0xffff) / 0xffff; // 0..1
        const r02 = ((seed * 48271) % 2147483647) / 2147483647;

        // Radial distance - distribute across all visible area
        const radius = 40 + Math.pow(r01, 0.8) * baseRadius;

        // Distance from center (for size and rotation calculations)
        const distanceFromCenter = radius;
        const maxVisibleDistance = baseRadius;
        const normalizedDistance = Math.min(1, distanceFromCenter / maxVisibleDistance);

        // Assign to an arm and compute spiral angle
        const arm = i % armCount;
        const armOffset = (arm / armCount) * Math.PI * 2;
        
        // Moderate spiral for visible but not sharp arms
        const spiralTheta = armOffset + pitch * Math.log(1 + radius * 0.7);

        // Slower differential rotation - closer stars rotate moderately faster
        const proximityFactor = 1 - normalizedDistance; // closer = higher value
        const angSpeed = rotBase + rotGain * Math.pow(proximityFactor, 1.0);
        const rotation = currentTime * angSpeed;

        // Moderate randomness to make arms subtle but visible
        const armRandomness = this.noise11(currentTime * 0.15, i * 0.1) * (0.12 + 0.2 * normalizedDistance);
        const positionRandomness = r02 * 0.4;
        const theta = spiralTheta + rotation + armRandomness + positionRandomness;

        // Position with moderate inclination - stars distributed across screen
        const x = cx + Math.cos(theta) * radius;
        const y = cy + Math.sin(theta) * radius * tilt;

        // Render stars across the entire visible area
        if (x < -40 || x > w + 40 || y < -40 || y > h + 40) return;

        // Size based on proximity to center - slightly smaller stars
        const baseSizeFromProximity = 0.6 + proximityFactor * 2.0; // slightly reduced base size
        const randomSizeVariation = 0.5 + (i % 12) * 0.12; // more variation with smaller range
        const size = Math.max(0.4, baseSizeFromProximity * randomSizeVariation * I.size * 0.9); // 10% smaller

        // Enhanced twinkling - brighter and more dynamic
        const twinkleSpeed = 0.8 + proximityFactor * 1.5; // faster twinkling
        const twinkleIntensity = 0.4 + proximityFactor * 0.6; // much brighter twinkling
        const twinkle = 0.5 + twinkleIntensity * this.noise01(currentTime * twinkleSpeed, i * 7 + radius * 0.002);

        // Color: subtle variation, closer stars slightly warmer
        const hue = Math.round(185 + proximityFactor * 35 + (i % 11) * 1.5);
        const sat = 25 + Math.round(proximityFactor * 25);
        const lum = 60 + Math.round(proximityFactor * 25); // brighter base luminosity
        const alpha = twinkle * (0.6 + proximityFactor * 0.4); // brighter alpha
        
        this.ctx.fillStyle = `hsla(${hue}, ${sat}%, ${lum}%, ${alpha})`;

        // Draw star with subtle cross pattern
        this.ctx.fillRect(x - size/2, y - size/2, size, size);
        
        // Add subtle cross pattern for larger stars
        if (size > 1.0) { // adjusted threshold for cross pattern
            this.ctx.globalAlpha = alpha * 0.6; // brighter cross
            const crossSize = size * 1.1; // cross size
            this.ctx.fillRect(x - crossSize, y - 0.3, crossSize * 2, 0.6);
            this.ctx.fillRect(x - 0.3, y - crossSize, 0.6, crossSize * 2);
            this.ctx.globalAlpha = 1;
        }
    }

    drawBackgroundStar(i, currentTime, w, h, cx, cy, tilt, baseRadius, rotBase, rotGain, I) {
        // Seeds
        const seed = (i * 23456) % 2147483647; // Different seed pattern for background stars
        const r01 = ((seed ^ 0x12345678) & 0xffff) / 0xffff; // 0..1
        const r02 = ((seed * 67890) % 2147483647) / 2147483647;

        // More uniform radial distribution for background stars
        const radius = 60 + Math.pow(r01, 0.6) * baseRadius * 0.9; // Slightly different distribution

        // Distance from center (for size and rotation calculations)
        const distanceFromCenter = radius;
        const maxVisibleDistance = baseRadius;
        const normalizedDistance = Math.min(1, distanceFromCenter / maxVisibleDistance);

        // Random angle - not tied to spiral arms
        const randomAngle = r02 * Math.PI * 2;
        
        // Slower differential rotation - closer stars rotate moderately faster
        const proximityFactor = 1 - normalizedDistance; // closer = higher value
        const angSpeed = rotBase + rotGain * Math.pow(proximityFactor, 0.8); // Slightly different rotation
        const rotation = currentTime * angSpeed;

        // More random positioning for background stars
        const backgroundRandomness = this.noise11(currentTime * 0.1, i * 0.15) * 0.3;
        const theta = randomAngle + rotation + backgroundRandomness;

        // Position with moderate inclination - stars distributed across screen
        const x = cx + Math.cos(theta) * radius;
        const y = cy + Math.sin(theta) * radius * tilt;

        // Render stars across the entire visible area
        if (x < -40 || x > w + 40 || y < -40 || y > h + 40) return;

        // Background stars are generally smaller and dimmer
        const baseSizeFromProximity = 0.4 + proximityFactor * 1.5; // smaller than arm stars
        const randomSizeVariation = 0.4 + (i % 15) * 0.08; // more variation, smaller range
        const size = Math.max(0.3, baseSizeFromProximity * randomSizeVariation * I.size * 0.8); // 20% smaller

        // Dimmer twinkling for background stars
        const twinkleSpeed = 0.6 + proximityFactor * 1.2; // slightly slower twinkling
        const twinkleIntensity = 0.3 + proximityFactor * 0.4; // dimmer twinkling
        const twinkle = 0.4 + twinkleIntensity * this.noise01(currentTime * twinkleSpeed, i * 5 + radius * 0.001);

        // Color: cooler colors for background stars
        const hue = Math.round(200 + proximityFactor * 25 + (i % 13) * 1.2);
        const sat = 20 + Math.round(proximityFactor * 20);
        const lum = 45 + Math.round(proximityFactor * 20); // dimmer base luminosity
        const alpha = twinkle * (0.4 + proximityFactor * 0.3); // dimmer alpha
        
        this.ctx.fillStyle = `hsla(${hue}, ${sat}%, ${lum}%, ${alpha})`;

        // Draw star (no cross pattern for background stars to keep them subtle)
        this.ctx.fillRect(x - size/2, y - size/2, size, size);
    }

    drawRainEffect(currentTime, w, h) {
        this.ctx.save();
        const I = this.getIntensityScales();
        
        // Rain parameters
        const dropCount = Math.max(80, Math.round(((w * h) / 8000) * I.count));
        const wind = this.noise11(currentTime * 0.2, 5) * 80; // gentler wind
        
        // Draw atmospheric mist/fog first (background layer)
        this.drawRainAtmosphere(currentTime, w, h, I);
        
        // Draw rain drops in multiple layers for depth
        this.drawRainLayer(currentTime, w, h, I, dropCount * 0.3, 0.3, 180, wind * 0.5); // Far layer
        this.drawRainLayer(currentTime, w, h, I, dropCount * 0.5, 0.6, 250, wind * 0.7); // Middle layer  
        this.drawRainLayer(currentTime, w, h, I, dropCount * 0.2, 1.0, 320, wind); // Close layer
        
        // Draw splash effects on ground
        this.drawRainSplashes(currentTime, w, h, I);
        
        this.ctx.restore();
    }
    
    drawRainAtmosphere(currentTime, w, h, I) {
        // Create subtle atmospheric haze
        const atmosphereGradient = this.ctx.createLinearGradient(0, 0, 0, h);
        atmosphereGradient.addColorStop(0, `rgba(220, 230, 240, ${0.02 + 0.03 * I.alpha})`);
        atmosphereGradient.addColorStop(0.7, `rgba(200, 210, 220, ${0.04 + 0.06 * I.alpha})`);
        atmosphereGradient.addColorStop(1, `rgba(180, 190, 200, ${0.06 + 0.08 * I.alpha})`);
        
        this.ctx.fillStyle = atmosphereGradient;
        this.ctx.fillRect(0, 0, w, h);
        
        // Add moving mist patches
        for (let i = 0; i < 5; i++) {
            const seed = i * 123;
            const mistX = ((seed * 67) % (w + 400)) - 200 + currentTime * (10 + i * 5);
            const mistY = ((seed * 89) % (h + 200)) - 100;
            const mistSize = 100 + (i * 50);
            
            const mistGradient = this.ctx.createRadialGradient(
                mistX % (w + 400) - 200, mistY, 0,
                mistX % (w + 400) - 200, mistY, mistSize
            );
            mistGradient.addColorStop(0, `rgba(240, 245, 250, ${0.03 + 0.04 * I.alpha})`);
            mistGradient.addColorStop(1, 'rgba(240, 245, 250, 0)');
            
            this.ctx.fillStyle = mistGradient;
            this.ctx.fillRect(0, 0, w, h);
        }
    }
    
    drawRainLayer(currentTime, w, h, I, dropCount, opacity, fallSpeed, wind) {
        for (let i = 0; i < dropCount; i++) {
            const seed = i * 97 + fallSpeed;
            const dropSize = 0.8 + this.noise01(currentTime * 0.8, seed) * 2.5;
            const dropLength = 8 + dropSize * 4;
            
            // Drop position with cycling
            const baseX = (seed * 53) % (w + 300) - 150;
            const baseY = (seed * 131) % (h + 300) - 150;
            const t = (currentTime + (seed % 1000) / 997) % 1000;
            
            // Wind effect and natural sway
            const windEffect = wind + this.noise11(currentTime * 0.5, seed) * 20;
            const sway = this.noise11(currentTime * 1.5, seed * 0.3) * 8;
            
            const x = (baseX + t * windEffect) % (w + 300) - 150 + sway;
            const y = (baseY + t * fallSpeed) % (h + 300) - 150;
            
            // Skip if outside visible area
            if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
            
            // Drop transparency and color
            const dropAlpha = (0.4 + 0.6 * this.noise01(currentTime * 2, seed)) * opacity * I.alpha;
            
            // Draw teardrop shape
            this.ctx.save();
            this.ctx.globalAlpha = dropAlpha;
            
            // Drop body (ellipse)
            this.ctx.fillStyle = `rgba(220, 230, 240, ${0.8})`;
            this.ctx.beginPath();
            this.ctx.ellipse(x, y, dropSize * 0.6, dropLength * 0.5, Math.PI * 0.1, 0, Math.PI * 2);
            this.ctx.fill();
            
            // Drop highlight (makes it look wet and reflective)
            this.ctx.fillStyle = `rgba(255, 255, 255, ${0.6})`;
            this.ctx.beginPath();
            this.ctx.ellipse(x - dropSize * 0.2, y - dropLength * 0.2, dropSize * 0.3, dropLength * 0.2, Math.PI * 0.1, 0, Math.PI * 2);
            this.ctx.fill();
            
            // Drop tail (streak effect)
            this.ctx.strokeStyle = `rgba(200, 215, 230, ${0.5})`;
            this.ctx.lineWidth = Math.max(0.5, dropSize * 0.3);
            this.ctx.lineCap = 'round';
            this.ctx.beginPath();
            this.ctx.moveTo(x, y - dropLength * 0.3);
            this.ctx.lineTo(x + windEffect * 0.1, y - dropLength);
            this.ctx.stroke();
            
            this.ctx.restore();
        }
    }
    
    drawRainSplashes(currentTime, w, h, I) {
        const splashCount = Math.max(15, Math.round(((w * h) / 15000) * I.count));
        
        for (let i = 0; i < splashCount; i++) {
            const seed = i * 157;
            const splashX = (seed * 73) % w;
            const splashY = h - 20 - this.noise01(currentTime, seed) * 40; // Near bottom
            
            // Splash timing (appears and disappears quickly)
            const splashTime = (currentTime * 3 + (seed % 100) / 100) % 2;
            if (splashTime > 0.3) continue; // Short-lived splashes
            
            const splashAlpha = (0.3 - splashTime) * I.alpha;
            const splashSize = 2 + this.noise01(currentTime * 4, seed) * 4;
            
            this.ctx.save();
            this.ctx.globalAlpha = splashAlpha;
            
            // Draw splash particles
            for (let j = 0; j < 6; j++) {
                const angle = (j / 6) * Math.PI * 2;
                const distance = splashSize * (0.5 + splashTime * 2);
                const particleX = splashX + Math.cos(angle) * distance;
                const particleY = splashY + Math.sin(angle) * distance * 0.3; // Flatter splash
                
                this.ctx.fillStyle = `rgba(200, 220, 240, ${0.7})`;
                this.ctx.beginPath();
                this.ctx.arc(particleX, particleY, 0.5 + splashTime, 0, Math.PI * 2);
                this.ctx.fill();
            }
            
            // Central splash
            this.ctx.fillStyle = `rgba(255, 255, 255, ${0.8})`;
            this.ctx.beginPath();
            this.ctx.arc(splashX, splashY, splashSize * 0.5, 0, Math.PI * 2);
            this.ctx.fill();
            
            this.ctx.restore();
        }
        
        // Add water accumulation effect at bottom
        const waterGradient = this.ctx.createLinearGradient(0, h - 30, 0, h);
        waterGradient.addColorStop(0, 'rgba(180, 200, 220, 0)');
        waterGradient.addColorStop(1, `rgba(160, 180, 200, ${0.1 + 0.15 * I.alpha})`);
        
        this.ctx.fillStyle = waterGradient;
        this.ctx.fillRect(0, h - 30, w, 30);
    }

    // Realistic clouds effect with distinct cloud formations and natural shapes
    drawCloudsEffect(currentTime, w, h) {
        this.ctx.save();
        const I = this.getIntensityScales();
        
        // Sky gradient background
        const skyGradient = this.ctx.createLinearGradient(0, 0, 0, h);
        skyGradient.addColorStop(0, `rgba(135, 206, 235, ${0.1 + 0.15 * I.alpha})`); // Sky blue
        skyGradient.addColorStop(0.7, `rgba(176, 224, 230, ${0.05 + 0.1 * I.alpha})`); // Powder blue
        skyGradient.addColorStop(1, `rgba(220, 240, 250, ${0.02 + 0.05 * I.alpha})`); // Very light blue
        this.ctx.fillStyle = skyGradient;
        this.ctx.fillRect(0, 0, w, h);
        
        // Draw multiple cloud layers
        this.drawCloudFormations(currentTime, w, h, I, 0.4, 8, 'background'); // Far clouds
        this.drawCloudFormations(currentTime, w, h, I, 0.7, 12, 'middle'); // Middle clouds
        this.drawCloudFormations(currentTime, w, h, I, 1.0, 18, 'foreground'); // Close clouds
        
        this.ctx.restore();
    }

    drawCloudFormations(currentTime, w, h, I, depthFactor, speed, layer) {
        const cloudCount = Math.max(2, Math.round(5 * I.count * depthFactor));
        
        for (let i = 0; i < cloudCount; i++) {
            const seed = i * 137 + layer.charCodeAt(0) * 1000;
            
            // Cloud position with slow movement
            const baseX = (seed * 73) % (w + 600) - 300;
            const baseY = (seed * 97) % (h * 0.6); // Keep clouds in upper 60% of screen
            const driftX = currentTime * speed * (0.8 + (seed % 5) * 0.1);
            const driftY = this.noise11(currentTime * 0.02, seed + 200) * 15;
            
            const cloudX = (baseX + driftX) % (w + 600) - 300;
            const cloudY = baseY + driftY;
            
            // Cloud size based on depth
            const baseSize = (120 + (seed % 180)) * depthFactor * I.size;
            const sizeVariation = 0.8 + this.noise01(currentTime * 0.01, seed) * 0.4;
            const cloudSize = baseSize * sizeVariation;
            
            // Generate cloud shape using noise-based approach
            this.drawRealisticCloud(cloudX, cloudY, cloudSize, seed, currentTime, depthFactor, I);
        }
    }

    drawRealisticCloud(centerX, centerY, size, seed, currentTime, depthFactor, I) {
        // Cloud properties
        const segments = 32; // Number of points to define cloud outline
        const points = [];
        const baseRadius = size * 0.5;
        
        // Generate cloud outline using noise
        for (let i = 0; i < segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            const noiseValue = this.noise01(
                Math.cos(angle) * 0.5 + currentTime * 0.005, 
                Math.sin(angle) * 0.5 + seed * 0.001
            );
            
            // Create fluffy, irregular cloud shape
            const radiusVariation = 0.6 + noiseValue * 0.8;
            const radius = baseRadius * radiusVariation;
            
            // Add some larger bumps for cloud puffiness
            const bumpNoise = this.noise01(
                Math.cos(angle * 3) * 0.3 + currentTime * 0.003,
                Math.sin(angle * 3) * 0.3 + seed * 0.002
            );
            const bumpRadius = radius * (1 + bumpNoise * 0.4);
            
            const x = centerX + Math.cos(angle) * bumpRadius;
            const y = centerY + Math.sin(angle) * bumpRadius * 0.7; // Flatten vertically
            
            points.push({ x, y });
        }
        
        // Draw cloud with multiple layers for depth
        this.drawCloudLayers(points, centerX, centerY, size, depthFactor, I);
    }

    drawCloudLayers(points, centerX, centerY, size, depthFactor, I) {
        // Cloud shadow (bottom layer)
        this.ctx.globalAlpha = (0.15 + 0.1 * depthFactor) * I.alpha;
        this.ctx.fillStyle = 'rgba(100, 120, 140, 0.8)';
        this.drawCloudShape(points, 2, 4); // Offset shadow
        
        // Main cloud body
        this.ctx.globalAlpha = (0.7 + 0.2 * depthFactor) * I.alpha;
        this.ctx.fillStyle = `rgba(240, 248, 255, ${0.85 + 0.1 * depthFactor})`;
        this.drawCloudShape(points, 0, 0);
        
        // Cloud highlights (top layer)
        this.ctx.globalAlpha = (0.4 + 0.3 * depthFactor) * I.alpha;
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        
        // Create highlight shape (upper portion of cloud)
        const highlightPoints = points.map((point, i) => {
            const angle = (i / points.length) * Math.PI * 2;
            const isTop = Math.sin(angle) < 0.3; // Upper portion
            const shrinkFactor = isTop ? 0.7 : 0.3;
            
            return {
                x: centerX + (point.x - centerX) * shrinkFactor,
                y: centerY + (point.y - centerY) * shrinkFactor - size * 0.1
            };
        });
        
        this.drawCloudShape(highlightPoints, 0, 0);
        
        // Reset alpha
        this.ctx.globalAlpha = 1;
    }

    drawCloudShape(points, offsetX, offsetY) {
        if (points.length < 3) return;
        
        this.ctx.beginPath();
        this.ctx.moveTo(points[0].x + offsetX, points[0].y + offsetY);
        
        // Use quadratic curves for smooth cloud edges
        for (let i = 1; i < points.length; i++) {
            const current = points[i];
            const next = points[(i + 1) % points.length];
            
            // Control point for smooth curve
            const controlX = current.x + offsetX;
            const controlY = current.y + offsetY;
            const endX = (current.x + next.x) / 2 + offsetX;
            const endY = (current.y + next.y) / 2 + offsetY;
            
            this.ctx.quadraticCurveTo(controlX, controlY, endX, endY);
        }
        
        // Close the path back to start
        const firstPoint = points[0];
        const lastPoint = points[points.length - 1];
        const controlX = lastPoint.x + offsetX;
        const controlY = lastPoint.y + offsetY;
        const endX = firstPoint.x + offsetX;
        const endY = firstPoint.y + offsetY;
        
        this.ctx.quadraticCurveTo(controlX, controlY, endX, endY);
        this.ctx.closePath();
        this.ctx.fill();
    }

    drawSubtitles(currentTime, canvasWidth, canvasHeight) {
        if (!this.subtitles.length) return;
        
        const fontSize = Math.max(16, Math.round(canvasHeight * 0.045));
        this.ctx.save();
        this.ctx.globalAlpha = 1;
        this.ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
        this.ctx.shadowBlur = 4;
        this.ctx.shadowOffsetX = 2;
        this.ctx.shadowOffsetY = 2;
        this.ctx.font = `bold ${fontSize}px Arial, sans-serif`;
        this.ctx.textBaseline = 'middle';
        this.ctx.textAlign = 'left';

        // Find active subtitles that should be displayed at current time
        const active = this.subtitles
            .filter(s => currentTime >= s.start && currentTime < s.start + s.duration)
            .sort((a, b) => a.start - b.start);
            
        if (!active.length) {
            this.ctx.restore();
            return;
        }

        // Display the first active subtitle with marquee effect
        const sub = active[0];
        const text = sub.text || '';
        
        // Calculate relative time within subtitle duration for movement
        const relativeTime = currentTime - sub.start;
        const progress = relativeTime / sub.duration; // 0 to 1
        
        // Measure text dimensions
        const metrics = this.ctx.measureText(text);
        const textWidth = Math.ceil(metrics.width);
        
        // Calculate marquee movement
        // Text starts from right edge and moves to left edge
        const startX = canvasWidth; // Start from right edge
        const endX = -textWidth; // End when text completely exits left
        const totalDistance = startX - endX;
        
        // Calculate current X position based on progress through subtitle duration
        const currentX = startX - (progress * totalDistance);
        
        // Y position - center vertically in bottom third of screen
        const y = canvasHeight - Math.round(canvasHeight * 0.15);
        
        // Add fade-in/fade-out effect for smooth appearance
        let alpha = 1;
        const fadeTime = 0.2; // 0.2 seconds for fade in/out
        
        if (relativeTime < fadeTime) {
            // Fade in
            alpha = relativeTime / fadeTime;
        } else if (relativeTime > sub.duration - fadeTime) {
            // Fade out
            alpha = (sub.duration - relativeTime) / fadeTime;
        }
        
        alpha = Math.max(0, Math.min(1, alpha));
        
        // Draw moving text with shadow and fade effect
        this.ctx.globalAlpha = alpha;
        this.ctx.fillStyle = '#FFFFFF';
        this.ctx.fillText(text, currentX, y);
        
        this.ctx.restore();
    }

    drawRoundedRect(x, y, w, h, r, fillStyle) {
        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.moveTo(x + r, y);
        this.ctx.lineTo(x + w - r, y);
        this.ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        this.ctx.lineTo(x + w, y + h - r);
        this.ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        this.ctx.lineTo(x + r, y + h);
        this.ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        this.ctx.lineTo(x, y + r);
        this.ctx.quadraticCurveTo(x, y, x + r, y);
        this.ctx.closePath();
        this.ctx.fillStyle = fillStyle;
        this.ctx.fill();
        this.ctx.restore();
    }

    escapeHtml(str) {
        return str.replace(/[&<>"]+/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    }

    initializeElements() {
        // Get DOM elements
        this.elements = {
            projectName: document.getElementById('projectName'),
            createProject: document.getElementById('createProject'),
            currentProject: document.getElementById('currentProject'),
            projectTitle: document.getElementById('projectTitle'),
            saveProject: document.getElementById('saveProject'),
            importProject: document.getElementById('importProject'),
            mediaUpload: document.getElementById('mediaUpload'),
            mediaList: document.getElementById('mediaList'),
            audioUpload: document.getElementById('audioUpload'),
            audioPlayer: document.getElementById('audioPlayer'),
            audioElement: document.getElementById('audioElement'),
            audioFileName: document.getElementById('audioFileName'),
            // Subtitles controls
            subtitleText: document.getElementById('subtitleText'),
            subtitleStart: document.getElementById('subtitleStart'),
            subtitleDuration: document.getElementById('subtitleDuration'),
            addSubtitle: document.getElementById('addSubtitle'),
            subtitleList: document.getElementById('subtitleList'),
            videoDuration: document.getElementById('videoDuration'),
            timeline: document.getElementById('timeline'),
            videoResolution: document.getElementById('videoResolution'),
            videoFPS: document.getElementById('videoFPS'),
            videoEffect: document.getElementById('videoEffect'),
            effectIntensity: document.getElementById('effectIntensity'),
            // New: copyright text
            copyrightText: document.getElementById('copyrightText'),
            generateVideo: document.getElementById('generateVideo'),
            progress: document.getElementById('progress'),
            progressFill: document.querySelector('.progress-fill'),
            progressPercent: document.getElementById('progressPercent'),
            previewCanvas: document.getElementById('previewCanvas'),
            playPreview: document.getElementById('playPreview'),
            pausePreview: document.getElementById('pausePreview'),
            previewSeeker: document.getElementById('previewSeeker'),
            currentTime: document.getElementById('currentTime'),
            totalTime: document.getElementById('totalTime'),
            resultSection: document.querySelector('.result-section'),
            resultVideo: document.getElementById('resultVideo'),
            downloadVideo: document.getElementById('downloadVideo'),
            createNewProject: document.getElementById('createNewProject')
        };
    }

    bindEvents() {
        // Project creation
        this.elements.createProject.addEventListener('click', () => this.createProject());
        this.elements.projectName.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.createProject();
        });
        // Project IO
        if (this.elements.saveProject) this.elements.saveProject.addEventListener('click', () => this.saveProject());
        if (this.elements.importProject) this.elements.importProject.addEventListener('change', (e) => this.loadProjectFromFile(e));

        // Media upload (images and videos)
        this.elements.mediaUpload.addEventListener('change', (e) => this.handleMediaUpload(e));
        this.setupDragAndDrop();

        // Audio upload
        this.elements.audioUpload.addEventListener('change', (e) => this.handleAudioUpload(e));

        // Subtitles add
        if (this.elements.addSubtitle) {
            this.elements.addSubtitle.addEventListener('click', () => this.addSubtitle());
        }

        // Video settings
        this.elements.videoDuration.addEventListener('change', (e) => {
            this.videoDuration = parseInt(e.target.value);
            this.updateTimeline();
            this.updateTimeDisplay();
            // Update all media timestamps that exceed new duration
            this.mediaItems.forEach(item => {
                if (item.timestamp > this.videoDuration) {
                    item.timestamp = Math.min(item.timestamp, this.videoDuration);
                    item.timestampDisplay = this.formatTime(item.timestamp);
                }
            });
            this.renderMediaList();
            this.onSettingsChanged();
        });
        // React to resolution/fps changes to allow re-generation and update preview canvas size
        this.elements.videoResolution.addEventListener('change', () => this.onSettingsChanged());
        this.elements.videoFPS.addEventListener('change', () => this.onSettingsChanged());
        if (this.elements.videoEffect) this.elements.videoEffect.addEventListener('change', () => this.onSettingsChanged());
        if (this.elements.effectIntensity) {
            // live preview on input, and mark settings changed on change
            this.elements.effectIntensity.addEventListener('input', () => this.renderPreviewFrame(this.previewCurrentTime || 0));
            this.elements.effectIntensity.addEventListener('change', () => this.onSettingsChanged());
        }
        // Live update preview when copyright text changes
        if (this.elements.copyrightText) {
            this.elements.copyrightText.addEventListener('input', () => {
                this.renderPreviewFrame(this.previewCurrentTime || 0);
            });
        }

        // Video generation: single handler toggles start/stop
        this.elements.generateVideo.addEventListener('click', () => {
            if (this.isGenerating) {
                this.stopGeneration();
            } else {
                this.generateVideo();
            }
        });

        // Preview controls
        this.elements.playPreview.addEventListener('click', () => this.playPreview());
        this.elements.pausePreview.addEventListener('click', () => this.pausePreview());
        this.elements.previewSeeker.addEventListener('input', (e) => this.seekPreview(e));

        // Result actions
        this.elements.downloadVideo.addEventListener('click', () => this.downloadVideo());
        this.elements.createNewProject.addEventListener('click', () => this.resetProject());
    }

    setupCanvas() {
        this.canvas = this.elements.previewCanvas;
        this.ctx = this.canvas.getContext('2d');
        this.canvas.width = 640;
        this.canvas.height = 360;
    }

    setupDragAndDrop() {
        const uploadArea = document.querySelector('.upload-area');
        
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            uploadArea.addEventListener(eventName, this.preventDefaults, false);
        });

        ['dragenter', 'dragover'].forEach(eventName => {
            uploadArea.addEventListener(eventName, () => uploadArea.classList.add('dragover'), false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            uploadArea.addEventListener(eventName, () => uploadArea.classList.remove('dragover'), false);
        });

        uploadArea.addEventListener('drop', (e) => this.handleDrop(e), false);
    }

    preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    handleDrop(e) {
        const files = Array.from(e.dataTransfer.files);
        const mediaFiles = files.filter(file => 
            file.type.startsWith('image/') || file.type.startsWith('video/')
        );
        this.processMediaFiles(mediaFiles);
    }

    createProject() {
        const projectName = this.elements.projectName.value.trim();
        if (!projectName) {
            alert('Пожалуйста, введите название проекта');
            return;
        }

        // store as string for simpler serialization
        this.currentProject = projectName;

        this.elements.currentProject.style.display = 'block';
        this.elements.projectTitle.textContent = projectName;
        this.elements.projectName.value = '';
        
        this.updateGenerateButton();
        this.showNotification('Проект создан успешно!', 'success');
    }

    handleMediaUpload(e) {
        const files = Array.from(e.target.files);
        this.processMediaFiles(files);
    }

    async processMediaFiles(files) {
        // Auto-create project on first asset import
        this.ensureProjectExists();

        for (const file of files) {
            if (file.type.startsWith('image/')) {
                await this.processImageFile(file);
            } else if (file.type.startsWith('video/')) {
                await this.processVideoFile(file);
            }
        }
    }

    async processImageFile(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const defaultTime = this.getNextAvailableTimestamp();
                    const imageData = {
                        id: Date.now() + Math.random(),
                        name: file.name,
                        src: e.target.result,
                        type: 'image',
                        timestamp: defaultTime,
                        timestampDisplay: this.formatTime(defaultTime),
                        element: img,
                        width: img.naturalWidth,
                        height: img.naturalHeight
                    };
                    
                    this.mediaItems.push(imageData);
                    this.renderMediaList();
                    this.updateTimeline();
                    this.updateGenerateButton();
                    resolve();
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        });
    }

    async processVideoFile(file) {
        return new Promise((resolve) => {
            const video = document.createElement('video');
            const url = URL.createObjectURL(file);
            
            video.addEventListener('loadedmetadata', async () => {
                const videoDuration = video.duration;
                const startTime = this.getNextAvailableTimestamp();
                
                // Create video data object
                const videoData = {
                    id: Date.now() + Math.random(),
                    name: file.name,
                    src: url,
                    type: 'video',
                    timestamp: startTime,
                    timestampDisplay: this.formatTime(startTime),
                    duration: videoDuration,
                    element: video,
                    width: video.videoWidth,
                    height: video.videoHeight,
                    file: file
                };
                
                // Extract frames for preview and processing
                await this.extractVideoFrames(videoData);
                
                this.mediaItems.push(videoData);
                this.renderMediaList();
                this.updateTimeline();
                this.updateGenerateButton();
                
                this.showNotification(`Видео "${file.name}" загружено (${this.formatTime(videoDuration)})`, 'success');
                resolve();
            });
            
            video.addEventListener('error', () => {
                this.showNotification(`Ошибка загрузки видео "${file.name}"`, 'error');
                URL.revokeObjectURL(url);
                resolve();
            });
            
            video.src = url;
        });
    }

    getNextAvailableTimestamp() {
        if (this.mediaItems.length === 0) return 0;
        
        // Find the latest timestamp + duration
        let maxEndTime = 0;
        this.mediaItems.forEach(item => {
            const endTime = item.timestamp + (item.duration || 2); // Default 2 seconds for images
            if (endTime > maxEndTime) {
                maxEndTime = endTime;
            }
        });
        
        return Math.min(maxEndTime, this.videoDuration);
    }

    async extractVideoFrames(videoData) {
        const video = videoData.element;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        // Set canvas size to video dimensions
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        
        // Extract frames at key intervals (every 0.1 seconds for smooth playback)
        const frameInterval = 0.1;
        const totalFrames = Math.ceil(videoData.duration / frameInterval);
        const frames = [];
        
        for (let i = 0; i < totalFrames; i++) {
            const time = i * frameInterval;
            if (time >= videoData.duration) break;
            
            video.currentTime = time;
            await new Promise(resolve => {
                const onSeeked = () => {
                    video.removeEventListener('seeked', onSeeked);
                    // Minimal delay to ensure frame is ready
                    setTimeout(resolve, 10);
                };
                video.addEventListener('seeked', onSeeked);
            });
            
            // Draw frame to canvas and extract as compressed image for better performance
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const frameDataUrl = canvas.toDataURL('image/jpeg', 0.9); // Use JPEG with high quality for better performance
            
            // Pre-load the image to avoid flickering during playback
            const frameImage = new Image();
            frameImage.src = frameDataUrl;
            await new Promise(resolve => {
                frameImage.onload = resolve;
                frameImage.onerror = resolve; // Continue even if image fails to load
            });
            
            frames.push({
                time: time,
                dataUrl: frameDataUrl,
                image: frameImage // Store pre-loaded image
            });
        }
        
        // Cache frames for this video
        this.videoFrameCache.set(videoData.id, frames);
        
        // Set preview frame (first frame)
        if (frames.length > 0) {
            videoData.previewFrame = frames[0].dataUrl;
        }
    }

    renderMediaList() {
        this.elements.mediaList.innerHTML = '';
        
        // Sort media items by timestamp before rendering
        const sortedItems = [...this.mediaItems].sort((a, b) => a.timestamp - b.timestamp);
        
        sortedItems.forEach((item, index) => {
            const mediaItem = document.createElement('div');
            mediaItem.className = 'media-item fade-in';
            
            // Different display for images vs videos
            let previewHtml = '';
            let typeIcon = '';
            let durationInfo = '';
            
            if (item.type === 'image') {
                previewHtml = `<img src="${item.src}" alt="${item.name}" class="media-preview">`;
                typeIcon = '🖼️';
            } else if (item.type === 'video') {
                previewHtml = `<img src="${item.previewFrame || item.src}" alt="${item.name}" class="media-preview">`;
                typeIcon = '🎬';
                durationInfo = `<span class="duration-info">${this.formatTime(item.duration)}</span>`;
            }
            
            mediaItem.innerHTML = `
                ${previewHtml}
                <div class="media-info">
                    <div class="media-name">${typeIcon} ${item.name} ${durationInfo}</div>
                    <input type="text" 
                           class="timestamp-input" 
                           value="${this.formatTime(item.timestamp)}" 
                           placeholder="MM:SS"
                           pattern="[0-9]{1,2}:[0-9]{2}"
                           title="Формат: MM:SS (например, 01:30)">
                    <button class="remove-media" onclick="videoGen.removeMediaItem('${item.id}')">
                        Удалить
                    </button>
                </div>
            `;
            
            const timestampInput = mediaItem.querySelector('.timestamp-input');
            timestampInput.addEventListener('change', (e) => {
                const newTime = this.parseTime(e.target.value);
                if (newTime <= this.videoDuration) {
                    item.timestamp = newTime;
                    item.timestampDisplay = this.formatTime(newTime);
                    e.target.value = this.formatTime(newTime); // Normalize display
                    this.updateTimeline();
                    this.renderMediaList(); // Re-render list to show sorted order
                } else {
                    e.target.value = this.formatTime(item.timestamp); // Revert to previous value
                    this.showNotification(`Время не может превышать ${this.formatTime(this.videoDuration)}`, 'warning');
                }
            });
            
            // Format input on blur
            timestampInput.addEventListener('blur', (e) => {
                const time = this.parseTime(e.target.value);
                e.target.value = this.formatTime(time);
            });
            
            this.elements.mediaList.appendChild(mediaItem);
        });
    }

    removeMediaItem(itemId) {
        const index = this.mediaItems.findIndex(item => item.id === itemId);
        if (index !== -1) {
            const item = this.mediaItems[index];
            
            // Clean up video resources
            if (item.type === 'video') {
                this.videoFrameCache.delete(itemId);
                if (item.src && item.src.startsWith('blob:')) {
                    URL.revokeObjectURL(item.src);
                }
            }
            
            this.mediaItems.splice(index, 1);
            this.renderMediaList();
            this.updateTimeline();
            this.renderSubtitleList();
            this.updateGenerateButton();
        }
    }

    handleAudioUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        // Auto-create project when adding audio without a project
        this.ensureProjectExists();

        this.audioFile = file;
        const url = URL.createObjectURL(file);
        
        this.elements.audioElement.src = url;
        this.elements.audioPlayer.style.display = 'block';
        
        // Автоматически определяем длительность видео по аудио
        this.elements.audioElement.addEventListener('loadedmetadata', () => {
            const audioDuration = Math.ceil(this.elements.audioElement.duration);
            this.videoDuration = audioDuration;
            this.elements.videoDuration.value = audioDuration;
            
            // Обновляем временные метки медиа, если они превышают новую длительность
            this.mediaItems.forEach(item => {
                if (item.timestamp > this.videoDuration) {
                    item.timestamp = Math.min(item.timestamp, this.videoDuration);
                    item.timestampDisplay = this.formatTime(item.timestamp);
                }
            });
            // Обновляем титры, если их начало выходит за пределы длительности
            this.subtitles.forEach(sub => {
                if (sub.start > this.videoDuration) {
                    sub.start = Math.min(sub.start, this.videoDuration);
                }
                // Сократить длительность, чтобы не выходить за видео
                if (sub.start + sub.duration > this.videoDuration) {
                    sub.duration = Math.max(1, this.videoDuration - sub.start);
                }
            });
            
            this.updateTimeline();
            this.renderMediaList();
            this.renderSubtitleList();
            this.showNotification(`Длительность видео установлена по аудио: ${this.formatTime(audioDuration)}`, 'success');
        });
        
        this.updateGenerateButton();
        this.showNotification('Аудиофайл загружен успешно!', 'success');
    }

    updateTimeline() {
        this.updateTimeDisplay();
        
        if (this.mediaItems.length === 0) {
            this.elements.timeline.innerHTML = '<p style="text-align: center; color: #718096;">Добавьте изображения или видео для отображения временной шкалы</p>';
            return;
        }

        const timelineHTML = `
            <div class="timeline-track">
                ${this.mediaItems.map(item => {
                    const position = (item.timestamp / this.videoDuration) * 100;
                    const width = item.type === 'video' ? Math.min((item.duration / this.videoDuration) * 100, 100 - position) : 2;
                    const previewSrc = item.type === 'video' ? (item.previewFrame || item.src) : item.src;
                    const typeIcon = item.type === 'video' ? '🎬' : '🖼️';
                    
                    return `
                        <div class="timeline-marker ${item.type}" style="left: ${position}%; width: ${width}%;">
                            <img src="${previewSrc}" class="timeline-image" alt="${item.name}">
                            <span class="timeline-icon">${typeIcon}</span>
                        </div>
                    `;
                }).join('')}
            </div>
            <div style="display: flex; justify-content: space-between; margin-top: 10px; font-size: 0.9rem; color: #718096;">
                <span>00:00</span>
                <span>${this.formatTime(this.videoDuration)}</span>
            </div>
        `;
        
        this.elements.timeline.innerHTML = timelineHTML;
    }

    updateGenerateButton() {
        const canGenerate = this.currentProject && this.mediaItems.length > 0;
        this.elements.generateVideo.disabled = !canGenerate;
    }

    lockUI() {
        // Disable media upload
        this.elements.mediaUpload.disabled = true;
        
        // Disable audio upload
        this.elements.audioUpload.disabled = true;
        
        // Disable all timestamp inputs
        document.querySelectorAll('.timestamp-input').forEach(input => {
            input.disabled = true;
        });
        
        // Disable video settings
        this.elements.videoResolution.disabled = true;
        this.elements.videoFPS.disabled = true;
        this.elements.videoDuration.disabled = true;
        if (this.elements.videoEffect) this.elements.videoEffect.disabled = true;
        
        // Disable remove buttons
        document.querySelectorAll('.remove-media').forEach(btn => {
            btn.disabled = true;
        });

        // Disable preview controls and creating new project
        if (this.elements.playPreview) this.elements.playPreview.disabled = true;
        if (this.elements.pausePreview) this.elements.pausePreview.disabled = true;
        if (this.elements.createNewProject) this.elements.createNewProject.disabled = true;
        if (this.elements.saveProject) this.elements.saveProject.disabled = true;
        if (this.elements.importProject) this.elements.importProject.disabled = true;

        // Disable subtitles controls
        if (this.elements.subtitleText) this.elements.subtitleText.disabled = true;
        if (this.elements.subtitleStart) this.elements.subtitleStart.disabled = true;
        if (this.elements.subtitleDuration) this.elements.subtitleDuration.disabled = true;
        if (this.elements.addSubtitle) this.elements.addSubtitle.disabled = true;
        document.querySelectorAll('.remove-subtitle').forEach(btn => btn.disabled = true);
        
        // Change generate button to stop button
        this.elements.generateVideo.querySelector('.btn-text').textContent = 'Остановить генерацию';
    }

    unlockUI() {
        // Enable media upload
        this.elements.mediaUpload.disabled = false;
        
        // Enable audio upload
        this.elements.audioUpload.disabled = false;
        
        // Enable all timestamp inputs
        document.querySelectorAll('.timestamp-input').forEach(input => {
            input.disabled = false;
        });
        
        // Enable video settings
        this.elements.videoResolution.disabled = false;
        this.elements.videoFPS.disabled = false;
        this.elements.videoDuration.disabled = false;
        if (this.elements.videoEffect) this.elements.videoEffect.disabled = false;
        
        // Enable remove buttons
        document.querySelectorAll('.remove-media').forEach(btn => {
            btn.disabled = false;
        });

        // Enable preview controls and creating new project
        if (this.elements.playPreview) this.elements.playPreview.disabled = false;
        if (this.elements.pausePreview) this.elements.pausePreview.disabled = false;
        if (this.elements.createNewProject) this.elements.createNewProject.disabled = false;
        if (this.elements.saveProject) this.elements.saveProject.disabled = false;
        if (this.elements.importProject) this.elements.importProject.disabled = false;

        // Enable subtitles controls
        if (this.elements.subtitleText) this.elements.subtitleText.disabled = false;
        if (this.elements.subtitleStart) this.elements.subtitleStart.disabled = false;
        if (this.elements.subtitleDuration) this.elements.subtitleDuration.disabled = false;
        if (this.elements.addSubtitle) this.elements.addSubtitle.disabled = false;
        document.querySelectorAll('.remove-subtitle').forEach(btn => btn.disabled = false);
        
        // Restore generate button
        this.elements.generateVideo.disabled = false;
    }

    onSettingsChanged() {
        // Hide previous result as it may be outdated
        if (this.elements.resultSection) {
            this.elements.resultSection.style.display = 'none';
        }
        // Update preview canvas size to selected resolution for accurate preview
        if (!this.isGenerating && this.elements.videoResolution) {
            const [w, h] = this.elements.videoResolution.value.split('x').map(Number);
            if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
                this.canvas.width = w;
                this.canvas.height = h;
            }
        }
        // Normalize Generate button state after settings change
        this.isGenerating = false;
        if (this.elements.generateVideo) {
            const txt = this.elements.generateVideo.querySelector('.btn-text');
            if (txt) txt.textContent = 'Генерировать видео';
            const spinner = this.elements.generateVideo.querySelector('.loading-spinner');
            if (spinner) spinner.style.display = 'none';
            if (this.elements.progress) this.elements.progress.style.display = 'none';
            this.elements.generateVideo.disabled = false;
        }
        // Ensure generate button is enabled if requirements are met
        this.updateGenerateButton();
    }

    stopGeneration() {
        if (!this.isGenerating) return;
        
        this.isGenerating = false;
        // Invalidate any ongoing animateVideo loop
        this.activeGenerationId = (this.activeGenerationId || 0) + 1;
        
        // Stop MediaRecorder if active
        if (this.currentMediaRecorder && this.currentMediaRecorder.state === 'recording') {
            this.currentMediaRecorder.stop();
        }
        
        // Stop audio
        if (this.audioFile && this.elements.audioElement.src) {
            this.elements.audioElement.pause();
            this.elements.audioElement.currentTime = 0;
            this.elements.audioElement.loop = false;
        }
        
        // Disconnect per-run recording nodes, but keep shared context/source alive
        if (this.recordingGainNode) {
            try { this.recordingGainNode.disconnect(); } catch {}
            this.recordingGainNode = null;
        }
        if (this.recordingDestination) {
            try { this.recordingDestination.disconnect && this.recordingDestination.disconnect(); } catch {}
            this.recordingDestination = null;
        }
        // Stop any leftover media tracks
        if (this.currentFinalStream) {
            this.currentFinalStream.getTracks().forEach(t => t.stop());
            this.currentFinalStream = null;
        }
        if (this.currentVideoStream) {
            this.currentVideoStream.getTracks().forEach(t => t.stop());
            this.currentVideoStream = null;
        }
        
        this.unlockUI();
        this.elements.generateVideo.querySelector('.btn-text').textContent = 'Генерировать видео';
        this.elements.generateVideo.querySelector('.loading-spinner').style.display = 'none';
        this.elements.progress.style.display = 'none';
        
        this.showNotification('Генерация остановлена', 'warning');

        // Clear canvas to avoid perceived frame accumulation
        try {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        } catch {}
    }

    async generateVideo() {
        if (this.isGenerating) return;
        
        // Ensure preview is stopped to avoid competing with recording loop
        if (this.previewPlaying) {
            this.pausePreview();
        }

        this.isGenerating = true;
        // Establish a new generation run id
        this.activeGenerationId = (this.activeGenerationId || 0) + 1;
        const runId = this.activeGenerationId;
        this.lockUI(); // Block UI during generation
        this.elements.generateVideo.querySelector('.btn-text').textContent = 'Генерация...';
        this.elements.generateVideo.querySelector('.loading-spinner').style.display = 'block';
        this.elements.progress.style.display = 'block';
        
        try {
            // Sort media items by timestamp
            const sortedMediaItems = [...this.mediaItems].sort((a, b) => a.timestamp - b.timestamp);
            
            // Get video settings
            const [width, height] = this.elements.videoResolution.value.split('x').map(Number);
            const fps = parseInt(this.elements.videoFPS.value);
            
            // Ensure canvas is sized to target resolution BEFORE capturing the stream
            this.canvas.width = width;
            this.canvas.height = height;
            
            // Create video stream from canvas
            const videoStream = this.canvas.captureStream(fps);
            this.currentVideoStream = videoStream;
            
            // Create combined stream with audio if available
            let finalStream = videoStream;
            
            if (this.audioFile && this.elements.audioElement.src) {
                try {
                    // Ensure shared audio pipeline and create per-run recording branch
                    const audioContext = await this.ensureSharedAudioPipeline();
                    const destination = audioContext.createMediaStreamDestination();
                    const gainNode = audioContext.createGain();
                    // route: mediaElementSource -> gainNode -> destination (record only)
                    this.mediaElementSource.connect(gainNode);
                    gainNode.connect(destination);
                    // Set gain level and ensure no clipping
                    gainNode.gain.value = 0.8;

                    console.log(`Audio context sample rate: ${audioContext.sampleRate}Hz`);
                    console.log(`Audio element duration: ${this.elements.audioElement.duration}s`);
                    console.log(`Audio element ready state: ${this.elements.audioElement.readyState}`);

                    // Create combined stream with video and audio tracks
                    finalStream = new MediaStream();
                    
                    // Add video tracks
                    videoStream.getVideoTracks().forEach(track => {
                        finalStream.addTrack(track);
                    });
                    
                    // Add audio tracks
                    destination.stream.getAudioTracks().forEach(track => {
                        finalStream.addTrack(track);
                    });
                    
                    // Store per-run nodes/streams for cleanup
                    this.recordingDestination = destination;
                    this.recordingGainNode = gainNode;
                    this.currentFinalStream = finalStream;
                    
                    this.showNotification('Аудио будет включено в видео!', 'success');
                } catch (error) {
                    console.warn('Не удалось подключить аудио:', error);
                    this.showNotification('Аудио не удалось включить в видео. Попробуйте другой браузер.', 'warning');
                    finalStream = videoStream;
                }
            }
            
            // Use WebM format with VP9 codec for best compatibility with audio
            const mimeType = 'video/webm;codecs=vp9';
            const fileExtension = 'webm';
            
            const mediaRecorder = new MediaRecorder(finalStream, {
                mimeType: mimeType
            });
            
            // Store MediaRecorder reference for stop functionality
            this.currentMediaRecorder = mediaRecorder;
            
            // Store file extension for download
            this.currentFileExtension = fileExtension;
            
            const chunks = [];
            mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
            
            mediaRecorder.onstop = () => {
                const blob = new Blob(chunks, { type: mimeType });
                
                // Log video duration for debugging
                console.log(`Generated video blob size: ${blob.size} bytes`);
                console.log(`Expected duration: ${this.videoDuration} seconds`);
                
                // Now stop audio and cleanup after recording is complete
                if (this.audioFile && this.elements.audioElement.src) {
                    this.elements.audioElement.pause();
                    this.elements.audioElement.currentTime = 0;
                    this.elements.audioElement.loop = false; // Disable looping
                    console.log('Audio stopped after recording completion');
                }
                
                // Stop and clear media streams
                if (this.currentFinalStream) {
                    this.currentFinalStream.getTracks().forEach(t => t.stop());
                    this.currentFinalStream = null;
                }
                if (this.currentVideoStream) {
                    this.currentVideoStream.getTracks().forEach(t => t.stop());
                    this.currentVideoStream = null;
                }
                // Disconnect per-run recording branch (keep shared pipeline for next runs)
                if (this.recordingGainNode) {
                    try { this.recordingGainNode.disconnect(); } catch {}
                    this.recordingGainNode = null;
                }
                if (this.recordingDestination) {
                    try { this.recordingDestination.disconnect && this.recordingDestination.disconnect(); } catch {}
                    this.recordingDestination = null;
                }

                // Clear MediaRecorder reference
                this.currentMediaRecorder = null;
                
                this.showVideoResult(blob);
                
                // Notify user about successful generation
                if (this.audioFile) {
                    this.showNotification(`Видео с аудиодорожкой сгенерировано! Длительность: ${this.videoDuration}с`, 'success');
                } else {
                    this.showNotification(`Видео сгенерировано! Длительность: ${this.videoDuration}с`, 'success');
                }
            };
            
            // Start recording with timeslice for better data collection
            const recordingStartTime = performance.now();
            mediaRecorder.start(100); // Collect data every 100ms
            
            console.log(`Starting video recording for ${this.videoDuration} seconds`);
            console.log(`Total frames to render: ${this.videoDuration * fps}`);
            
            // Start audio playback for recording if available
            if (this.audioFile && this.elements.audioElement.src) {
                this.elements.audioElement.currentTime = 0;
                this.elements.audioElement.loop = false; // Do not loop; let silence after end
                console.log(`Audio duration: ${this.elements.audioElement.duration}s, Video duration: ${this.videoDuration}s`);
                
                // Add event listeners to monitor audio playback
                this.elements.audioElement.addEventListener('pause', () => {
                    console.log('Audio paused unexpectedly during recording');
                });
                
                this.elements.audioElement.play().catch(error => {
                    console.error('Audio playback failed:', error);
                });
            }
            
            // Animate and record
            await this.animateVideo(sortedMediaItems, width, height, fps, runId);
            
            // Add delay to ensure all frames are captured before stopping
            console.log('Animation completed, waiting for final frames...');
            await new Promise(resolve => setTimeout(resolve, 1000)); // Increased delay
            
            // Additional check: ensure we've recorded for the full duration
            const recordingDuration = (performance.now() - recordingStartTime) / 1000;
            console.log(`Actual recording duration: ${recordingDuration.toFixed(2)}s`);
            
            if (recordingDuration < this.videoDuration) {
                const additionalWait = (this.videoDuration - recordingDuration + 0.5) * 1000;
                console.log(`Waiting additional ${additionalWait}ms to reach full duration`);
                await new Promise(resolve => setTimeout(resolve, additionalWait));
            }
            
            // Stop recording
            console.log('Stopping MediaRecorder...');
            mediaRecorder.stop();
            
            // Wait for MediaRecorder to fully stop before cleaning up audio
            // This ensures audio continues until the very end of recording
            
            // Cleanup audio context
            if (this.recordingAudioContext) {
                // Disconnect nodes before closing context
                if (this.recordingGainNode) {
                    this.recordingGainNode.disconnect();
                }
                this.recordingAudioContext.close();
                this.recordingAudioContext = null;
                this.recordingGainNode = null;
            }
            
        } catch (error) {
            console.error('Ошибка генерации видео:', error);
            alert('Произошла ошибка при генерации видео. Попробуйте снова.');
        } finally {
            this.isGenerating = false;
            this.currentMediaRecorder = null; // Clear MediaRecorder reference
            // Invalidate any pending animation loop
            this.activeGenerationId = (this.activeGenerationId || 0) + 1;
            // Ensure streams are stopped even on error
            if (this.currentFinalStream) {
                this.currentFinalStream.getTracks().forEach(t => t.stop());
                this.currentFinalStream = null;
            }
            if (this.currentVideoStream) {
                this.currentVideoStream.getTracks().forEach(t => t.stop());
                this.currentVideoStream = null;
            }
            if (this.recordingGainNode) {
                try { this.recordingGainNode.disconnect(); } catch {}
                this.recordingGainNode = null;
            }
            if (this.recordingDestination) {
                try { this.recordingDestination.disconnect && this.recordingDestination.disconnect(); } catch {}
                this.recordingDestination = null;
            }
            this.unlockUI(); // Unlock UI after generation
            this.elements.generateVideo.querySelector('.btn-text').textContent = 'Генерировать видео';
            this.elements.generateVideo.querySelector('.loading-spinner').style.display = 'none';
            this.elements.progress.style.display = 'none';
            
            this.showNotification('Генерация остановлена', 'warning');

            // Clear canvas to avoid perceived frame accumulation
            try {
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            } catch {}
        }
    }

    async animateVideo(sortedMediaItems, width, height, fps, runId) {
        return new Promise((resolve) => {
            this.canvas.width = width;
            this.canvas.height = height;
            
            const frameTime = 1000 / fps;
            const totalFrames = this.videoDuration * fps;
            let currentFrame = 0;
            let lastFrameTime = performance.now();
            
            const animate = (currentTime) => {
                // Abort if a new generation has started or current was cancelled
                if (!this.isGenerating || this.activeGenerationId !== runId) {
                    return resolve();
                }
                // Fixed-timestep frame scheduling to reduce jitter and drift
                let elapsed = currentTime - lastFrameTime;
                let framesRendered = 0;
                while (elapsed >= frameTime && currentFrame < totalFrames) {
                    const videoTime = currentFrame / fps;
                    const progress = (currentFrame / totalFrames) * 100;
                    this.elements.progressFill.style.width = `${progress}%`;
                    this.elements.progressPercent.textContent = `${Math.round(progress)}%`;
                    this.renderVideoFrame(sortedMediaItems, videoTime, width, height);
                    currentFrame++;
                    lastFrameTime += frameTime;
                    elapsed -= frameTime;
                    framesRendered++;
                    // Safety: avoid rendering too many catch-up frames in a single RAF
                    if (framesRendered > 5) break;
                }
                
                if (currentFrame < totalFrames) {
                    requestAnimationFrame(animate);
                } else {
                    // Add extra frames to ensure complete recording
                    setTimeout(() => resolve(), 200);
                }
            };
            
            requestAnimationFrame(animate);
        });
    }

    renderVideoFrame(sortedMediaItems, currentTime, canvasWidth, canvasHeight) {
        // Find the current media item to display
        let currentMediaItem = null;
        
        for (let i = sortedMediaItems.length - 1; i >= 0; i--) {
            const item = sortedMediaItems[i];
            const itemEndTime = item.timestamp + (item.duration || 2); // Default 2 seconds for images
            
            if (currentTime >= item.timestamp && currentTime < itemEndTime) {
                currentMediaItem = item;
                break;
            }
        }
        
        // If no media item found, use the last one that has passed
        if (!currentMediaItem && sortedMediaItems.length > 0) {
            for (let i = sortedMediaItems.length - 1; i >= 0; i--) {
                if (currentTime >= sortedMediaItems[i].timestamp) {
                    currentMediaItem = sortedMediaItems[i];
                    break;
                }
            }
        }
        
        // Only clear and redraw if we have a media item to avoid unnecessary flashing
        if (currentMediaItem) {
            // Clear canvas first
            this.ctx.fillStyle = '#000000';
            this.ctx.fillRect(0, 0, canvasWidth, canvasHeight);
            
            // Draw current media item
            if (currentMediaItem.type === 'image') {
                this.drawAnimatedImage(currentMediaItem, currentTime, canvasWidth, canvasHeight);
            } else if (currentMediaItem.type === 'video') {
                this.drawVideoFrame(currentMediaItem, currentTime, canvasWidth, canvasHeight);
            }
        } else {
            // Just fill with black if no media item
            this.ctx.fillStyle = '#000000';
            this.ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        }

        // Apply selected video effect overlay first
        this.drawEffect(currentTime, canvasWidth, canvasHeight);
        // Then draw subtitles on top so text is not obscured by effects
        this.drawSubtitles(currentTime, canvasWidth, canvasHeight);
        // Finally, draw copyright overlay in bottom-right
        this.drawCopyrightOverlay(canvasWidth, canvasHeight);
    }

    drawAnimatedImage(imageData, currentTime, canvasWidth, canvasHeight) {
        const img = imageData.element;
        
        // Calculate scale to make image larger than canvas (cover effect)
        const scaleX = canvasWidth / img.naturalWidth;
        const scaleY = canvasHeight / img.naturalHeight;
        const baseScale = Math.max(scaleX, scaleY) * 1.15; // 15% larger than needed to cover
        
        // Very subtle and smooth scale animation
        const scaleVariation = 0.02 * Math.sin(currentTime * 0.2); // Much slower and smaller variation
        const scale = baseScale * (1 + scaleVariation);
        
        const scaledWidth = img.naturalWidth * scale;
        const scaledHeight = img.naturalHeight * scale;
        
        // Calculate movement range to keep image covering the canvas
        const maxMoveX = Math.max(0, (scaledWidth - canvasWidth) / 2);
        const maxMoveY = Math.max(0, (scaledHeight - canvasHeight) / 2);
        
        // Very subtle and smooth movement using different frequencies
        const moveX = maxMoveX * 0.15 * Math.sin(currentTime * 0.1); // Much slower movement
        const moveY = maxMoveY * 0.15 * Math.cos(currentTime * 0.13); // Slightly different frequency
        
        const x = (canvasWidth - scaledWidth) / 2 + moveX;
        const y = (canvasHeight - scaledHeight) / 2 + moveY;
        
        // Draw image with smooth transitions and anti-aliasing
        this.ctx.save();
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';
        this.ctx.globalAlpha = 1;
        this.ctx.shadowColor = 'transparent';
        this.ctx.shadowBlur = 0;
        this.ctx.drawImage(img, x, y, scaledWidth, scaledHeight);
        this.ctx.restore();
    }

    drawVideoFrame(videoData, currentTime, canvasWidth, canvasHeight) {
        // Calculate the relative time within the video
        const videoStartTime = videoData.timestamp;
        const relativeTime = currentTime - videoStartTime;
        
        // Clamp relative time to video duration
        const clampedTime = Math.max(0, Math.min(relativeTime, videoData.duration));
        
        // Use cached frames for consistent results
        const frames = this.videoFrameCache.get(videoData.id);
        if (!frames || frames.length === 0) {
            // For restored video items without frames, show warning and draw preview frame if available
            if (videoData.isRestored && videoData.previewFrame) {
                console.warn('No cached frames for restored video, using preview frame');
                const img = new Image();
                img.onload = () => {
                    this.drawScaledVideoFrame(img, canvasWidth, canvasHeight);
                };
                img.src = videoData.previewFrame;
                return;
            }
            
            // Fallback: draw a black rectangle if no frames available
            this.ctx.fillStyle = '#000000';
            this.ctx.fillRect(0, 0, canvasWidth, canvasHeight);
            console.warn('No frames available for video:', videoData.name);
            return;
        }
        
        // Find the closest frame using simple linear interpolation
        let closestFrame = frames[0];
        let minDiff = Math.abs(clampedTime - frames[0].time);
        
        for (let i = 1; i < frames.length; i++) {
            const diff = Math.abs(clampedTime - frames[i].time);
            if (diff < minDiff) {
                minDiff = diff;
                closestFrame = frames[i];
            }
        }
        
        // Draw the cached frame
        this.drawFrameFromDataUrl(closestFrame.dataUrl, canvasWidth, canvasHeight, closestFrame.image);
    }

    drawFrameFromDataUrl(dataUrl, canvasWidth, canvasHeight, preloadedImage = null) {
        // Always use pre-loaded image if available - no fallbacks to avoid flickering
        if (preloadedImage && preloadedImage.complete && preloadedImage.naturalWidth > 0) {
            this.drawScaledVideoFrame(preloadedImage, canvasWidth, canvasHeight);
            return;
        }
        
        // If no pre-loaded image, don't try to create new one - just draw black
        // This prevents flickering from async image loading
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        console.warn('No pre-loaded image available for video frame');
    }

    drawScaledVideoFrame(img, canvasWidth, canvasHeight) {
        // Calculate scaling to fit the frame within the canvas while maintaining aspect ratio
        const imgAspect = img.naturalWidth / img.naturalHeight;
        const canvasAspect = canvasWidth / canvasHeight;
        
        let drawWidth, drawHeight, drawX, drawY;
        
        if (imgAspect > canvasAspect) {
            // Image is wider than canvas - fit to width
            drawWidth = canvasWidth;
            drawHeight = canvasWidth / imgAspect;
            drawX = 0;
            drawY = (canvasHeight - drawHeight) / 2;
        } else {
            // Image is taller than canvas - fit to height
            drawHeight = canvasHeight;
            drawWidth = canvasHeight * imgAspect;
            drawX = (canvasWidth - drawWidth) / 2;
            drawY = 0;
        }
        
        // Use more efficient rendering approach
        this.ctx.save();
        
        // Enable high-quality rendering for smoother video
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';
        
        // Clear only the area we're going to draw to reduce flickering
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        
        // Draw the image with pixel-perfect rendering
        this.ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
        
        this.ctx.restore();
    }

    showVideoResult(blob) {
        const url = URL.createObjectURL(blob);
        this.elements.resultVideo.src = url;
        this.elements.resultSection.style.display = 'block';
        
        // Store blob for download
        this.generatedVideoBlob = blob;
        
        this.showNotification('Видео успешно сгенерировано!', 'success');
        
        // Scroll to result
        this.elements.resultSection.scrollIntoView({ behavior: 'smooth' });
    }

    downloadVideo() {
        if (!this.generatedVideoBlob) return;
        
        const extension = this.currentFileExtension || 'webm';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(this.generatedVideoBlob);
        const projName = typeof this.currentProject === 'string' ? this.currentProject : (this.currentProject?.name || 'project');
        a.download = `${projName}_video.${extension}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        this.showNotification(`Видео загружено в формате ${extension.toUpperCase()}!`, 'success');
    }

    playPreview() {
        if (this.mediaItems.length === 0) {
            alert('Добавьте изображения или видео для предварительного просмотра');
            return;
        }
        
        if (!this.previewPlaying) {
            this.previewPlaying = true;
            this.previewStartTime = Date.now() - (this.previewCurrentTime * 1000);
            
            // Запускаем аудио, если есть
            if (this.audioFile && this.elements.audioElement.src) {
                this.elements.audioElement.currentTime = this.previewCurrentTime;
                this.elements.audioElement.play();
            }
            
            this.startPreviewAnimation();
        }
    }

    pausePreview() {
        this.previewPlaying = false;
        
        if (this.previewAnimation) {
            cancelAnimationFrame(this.previewAnimation);
            this.previewAnimation = null;
        }
        
        // Останавливаем аудио
        if (this.audioFile && this.elements.audioElement.src) {
            this.elements.audioElement.pause();
        }
    }

    seekPreview(e) {
        const progress = parseFloat(e.target.value);
        const currentTime = (progress / 100) * this.videoDuration;
        
        this.previewCurrentTime = currentTime;
        this.previewStartTime = Date.now() - (currentTime * 1000);
        
        // Синхронизируем аудио
        if (this.audioFile && this.elements.audioElement.src) {
            this.elements.audioElement.currentTime = currentTime;
        }
        
        this.updateTimeDisplay();
        this.renderPreviewFrame(currentTime);
    }

    startPreviewAnimation() {
        const animate = () => {
            if (!this.previewPlaying) return;
            
            const elapsed = Date.now() - this.previewStartTime;
            const currentTime = elapsed / 1000;
            const progress = Math.min(currentTime / this.videoDuration, 1);
            
            this.previewCurrentTime = currentTime;
            this.elements.previewSeeker.value = progress * 100;
            this.updateTimeDisplay();
            this.renderPreviewFrame(currentTime);
            
            if (progress < 1 && this.previewPlaying) {
                this.previewAnimation = requestAnimationFrame(animate);
            } else if (progress >= 1) {
                this.previewPlaying = false;
                this.previewCurrentTime = 0;
                if (this.audioFile && this.elements.audioElement.src) {
                    this.elements.audioElement.pause();
                    this.elements.audioElement.currentTime = 0;
                }
            }
        };
        
        animate();
    }

    renderPreviewFrame(currentTime) {
        // Keep preview rendering identical to video rendering
        const sortedMediaItems = [...this.mediaItems].sort((a, b) => a.timestamp - b.timestamp);
        this.renderVideoFrame(sortedMediaItems, currentTime, this.canvas.width, this.canvas.height);
    }

    resetProject() {
        this.currentProject = null;
        this.mediaItems = [];
        this.subtitles = [];
        this.audioFile = null;
        this.generatedVideoBlob = null;
        this.videoFrameCache.clear();
        
        // Reset UI
        this.elements.currentProject.style.display = 'none';
        this.elements.mediaList.innerHTML = '';
        if (this.elements.subtitleList) this.elements.subtitleList.innerHTML = '';
        this.elements.audioPlayer.style.display = 'none';
        this.elements.resultSection.style.display = 'none';
        this.elements.timeline.innerHTML = '';
        if (this.elements?.effectIntensity) this.elements.effectIntensity.value = '50';
        if (this.elements?.copyrightText) {
            this.elements.copyrightText.value = '';
        }
        
        // Clear canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        this.updateGenerateButton();
        this.showNotification('Проект сброшен. Создайте новый проект.', 'info');
    }

    // ---------- Project Save / Load ----------
    async saveProject() {
        if (!this.currentProject) {
            this.showNotification('Сначала создайте проект', 'warning');
            return;
        }
        // Gather settings
        const settings = {
            name: typeof this.currentProject === 'string' ? this.currentProject : (this.currentProject?.name || 'Проект'),
            duration: this.videoDuration,
            resolution: this.elements.videoResolution?.value || `${this.canvas.width}x${this.canvas.height}`,
            fps: parseInt(this.elements.videoFPS?.value || '30', 10),
            effect: this.elements.videoEffect?.value || 'none',
            intensity: parseInt(this.elements?.effectIntensity?.value || '50', 10),
            copyright: (this.elements?.copyrightText?.value || '').trim()
        };
        // Serialize media items to data URLs
        const mediaItems = await Promise.all(this.mediaItems.map(item => this.serializeMediaItem(item)));
        // Serialize audio to data URL if present
        let audio = null;
        if (this.audioFile) {
            const audioDataUrl = await this.blobToDataURL(this.audioFile);
            audio = { name: this.audioFile.name, type: this.audioFile.type, dataUrl: audioDataUrl };
        } else if (this.elements.audioElement?.src && this.elements.audioElement.src.startsWith('data:')) {
            audio = { name: 'audio', type: 'audio/mpeg', dataUrl: this.elements.audioElement.src };
        }
        // Subtitles
        const subtitles = this.subtitles.map(s => ({ id: s.id, text: s.text, start: s.start, duration: s.duration }));
        const payload = { version: 2, settings, mediaItems, audio, subtitles };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const safeName = settings.name?.replace(/[^\w\-]+/g, '_') || 'project';
        a.download = `${safeName}.vgproj.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        this.showNotification('Проект сохранен', 'success');
    }

    async loadProjectFromFile(e) {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            await this.loadProjectFromJSON(data);
            this.showNotification('Проект загружен', 'success');
        } catch (err) {
            console.error(err);
            this.showNotification('Не удалось загрузить проект: неверный формат файла', 'error');
        } finally {
            // reset input so same file can be selected again later
            e.target.value = '';
        }
    }

    async loadProjectFromJSON(data) {
        if (!data) {
            console.warn('Empty project data, using defaults');
            data = { settings: { name: 'Проект' } };
        }
        if (!data.settings) {
            console.warn('Missing settings in project data, using defaults');
            data.settings = { name: 'Проект' };
        }
        
        // Reset current state
        this.resetProject();
        
        // Set project
        this.currentProject = data.settings.name || 'Проект';
        this.elements.currentProject.style.display = 'block';
        this.elements.projectTitle.textContent = this.currentProject;
        
        // Settings
        if (this.elements.videoDuration) {
            this.videoDuration = parseInt(data.settings.duration || 30, 10);
            this.elements.videoDuration.value = String(this.videoDuration);
        }
        if (this.elements.videoResolution && data.settings.resolution) {
            this.elements.videoResolution.value = data.settings.resolution;
        }
        if (this.elements.videoFPS && data.settings.fps) {
            this.elements.videoFPS.value = String(data.settings.fps);
        }
        if (this.elements.videoEffect && data.settings.effect) {
            this.elements.videoEffect.value = data.settings.effect;
        }
        if (this.elements.effectIntensity) {
            const v = Number.isFinite(parseInt(data.settings?.intensity, 10)) ? String(parseInt(data.settings.intensity, 10)) : '50';
            this.elements.effectIntensity.value = v;
        }
        // Set copyright text if provided
        if (this.elements?.copyrightText) {
            this.elements.copyrightText.value = data.settings?.copyright || '';
        }
        this.onSettingsChanged();
        this.updateTimeDisplay();
        
        // Audio
        if (data.audio?.dataUrl) {
            const audioBlob = this.dataURLToBlob(data.audio.dataUrl);
            this.audioFile = new File([audioBlob], data.audio.name || 'audio', { type: data.audio.type || audioBlob.type });
            const audioUrl = URL.createObjectURL(this.audioFile);
            this.elements.audioElement.src = audioUrl;
            this.elements.audioPlayer.style.display = 'block';
        }
        
        // Media Items (backward compatibility with old 'images' format)
        this.mediaItems = [];
        
        // Handle new format (version 2+)
        if (Array.isArray(data.mediaItems)) {
            for (const item of data.mediaItems) {
                if (item.type === 'image') {
                    const imageEl = await this.createImageFromDataURL(item.dataUrl);
                    this.mediaItems.push({
                        id: Date.now() + Math.random(),
                        name: item.name || 'image',
                        src: item.dataUrl,
                        type: 'image',
                        element: imageEl,
                        timestamp: item.timestamp || 0,
                        timestampDisplay: this.formatTime(item.timestamp || 0),
                        width: imageEl.naturalWidth,
                        height: imageEl.naturalHeight
                    });
                } else if (item.type === 'video') {
                    // For saved video items, restore from cached frames
                    const videoId = Date.now() + Math.random();
                    const videoItem = {
                        id: videoId,
                        name: item.name || 'video',
                        src: item.previewFrame || item.dataUrl,
                        type: 'video',
                        timestamp: item.timestamp || 0,
                        timestampDisplay: this.formatTime(item.timestamp || 0),
                        duration: item.duration || 10,
                        width: item.width || 1920,
                        height: item.height || 1080,
                        previewFrame: item.previewFrame,
                        isRestored: true // Mark as restored from saved project
                    };
                    
                    // Restore cached frames if available
                    if (item.frames && Array.isArray(item.frames)) {
                        const restoredFrames = [];
                        for (const frameData of item.frames) {
                            // Pre-load each frame image
                            const frameImage = new Image();
                            frameImage.src = frameData.dataUrl;
                            await new Promise(resolve => {
                                frameImage.onload = resolve;
                                frameImage.onerror = resolve;
                            });
                            
                            restoredFrames.push({
                                time: frameData.time,
                                dataUrl: frameData.dataUrl,
                                image: frameImage
                            });
                        }
                        
                        // Cache the restored frames
                        this.videoFrameCache.set(videoId, restoredFrames);
                    }
                    
                    this.mediaItems.push(videoItem);
                }
            }
        }
        // Handle old format (version 1) - backward compatibility
        else if (Array.isArray(data.images)) {
            for (const im of data.images) {
                const imageEl = await this.createImageFromDataURL(im.dataUrl);
                this.mediaItems.push({
                    id: Date.now() + Math.random(),
                    name: im.name || 'image',
                    src: im.dataUrl,
                    type: 'image',
                    element: imageEl,
                    timestamp: im.timestamp || 0,
                    timestampDisplay: this.formatTime(im.timestamp || 0),
                    width: imageEl.naturalWidth,
                    height: imageEl.naturalHeight
                });
            }
        }
        
        // Subtitles
        this.subtitles = Array.isArray(data.subtitles) ? data.subtitles.map(s => ({ id: s.id || (Date.now()+Math.random()), text: s.text || '', start: s.start || 0, duration: s.duration || 3 })) : [];
        
        // UI updates
        this.renderMediaList();
        this.renderSubtitleList();
        this.updateTimeline();
        
        // Render an initial preview frame to show images/effects/subtitles after load
        this.previewCurrentTime = 0;
        this.renderPreviewFrame(0);
        
        this.updateGenerateButton();
    }

    async serializeMediaItem(itemData) {
        const name = itemData.name || 'media';
        const timestamp = itemData.timestamp || 0;
        
        if (itemData.type === 'image') {
            const srcDataUrl = await this.imageToDataURL(itemData.element);
            return { 
                name, 
                timestamp, 
                type: 'image',
                dataUrl: srcDataUrl,
                width: itemData.width,
                height: itemData.height
            };
        } else if (itemData.type === 'video') {
            // For video items, save all cached frames for restoration
            const frames = this.videoFrameCache.get(itemData.id);
            const serializedFrames = frames ? frames.map(frame => ({
                time: frame.time,
                dataUrl: frame.dataUrl
            })) : [];
            
            return { 
                name, 
                timestamp, 
                type: 'video',
                duration: itemData.duration,
                width: itemData.width,
                height: itemData.height,
                previewFrame: itemData.previewFrame,
                frames: serializedFrames // Save all frames for restoration
            };
        }
        
        // Fallback for unknown types
        return { name, timestamp, type: 'unknown' };
    }

    imageToDataURL(imgEl) {
        return new Promise((resolve) => {
            try {
                const w = imgEl.naturalWidth || imgEl.width;
                const h = imgEl.naturalHeight || imgEl.height;
                const off = document.createElement('canvas');
                off.width = w;
                off.height = h;
                const ictx = off.getContext('2d');
                ictx.drawImage(imgEl, 0, 0, w, h);
                resolve(off.toDataURL('image/png'));
            } catch (e) {
                console.warn('Failed to convert image, fallback to src');
                resolve(imgEl.src);
            }
        });
    }

    blobToDataURL(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    dataURLToBlob(dataUrl) {
        const parts = dataUrl.split(',');
        const match = parts[0].match(/data:(.*?);base64/);
        const mime = match ? match[1] : 'application/octet-stream';
        const bstr = atob(parts[1]);
        let n = bstr.length;
        const u8arr = new Uint8Array(n);
        while (n--) u8arr[n] = bstr.charCodeAt(n);
        return new Blob([u8arr], { type: mime });
    }

    createImageFromDataURL(dataUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = dataUrl;
        });
    }

    // Time formatting utilities
    formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    parseTime(timeString) {
        if (typeof timeString === 'number') return Math.max(0, Math.floor(timeString));
        if (!timeString || !timeString.includes(':')) return 0;
        const parts = timeString.split(':');
        if (parts.length !== 2) return 0;
        let minutes = parseInt(parts[0], 10);
        let seconds = parseInt(parts[1], 10);
        if (isNaN(minutes)) minutes = 0;
        if (isNaN(seconds)) seconds = 0;
        // Clamp seconds to [0,59] to avoid accidental minute jumps like 01:90
        seconds = Math.min(Math.max(seconds, 0), 59);
        const total = (Math.max(0, minutes) * 60) + seconds;
        return total;
    }

    updateTimeDisplay() {
        if (this.elements.totalTime) {
            this.elements.totalTime.textContent = this.formatTime(this.videoDuration);
        }
        if (this.elements.currentTime) {
            this.elements.currentTime.textContent = this.formatTime(this.previewCurrentTime || 0);
        }
    }

    showNotification(message, type = 'info') {
        // Create notification element
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 15px 20px;
            border-radius: 8px;
            color: white;
            font-weight: 600;
            z-index: 1000;
            animation: slideIn 0.3s ease-out;
            max-width: 300px;
        `;
        
        // Set background color based on type
        const colors = {
            success: '#48bb78',
            error: '#e53e3e',
            info: '#667eea',
            warning: '#ed8936'
        };
        notification.style.backgroundColor = colors[type] || colors.info;
        
        notification.textContent = message;
        document.body.appendChild(notification);
        
        // Add slide-in animation
        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideIn {
                from {
                    transform: translateX(100%);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }
        `;
        document.head.appendChild(style);
        
        // Remove notification after 3 seconds
        setTimeout(() => {
            notification.style.animation = 'slideIn 0.3s ease-out reverse';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }, 3000);
    }
}

// Initialize the application
const videoGen = new VideoGenerator();

// Make removeImage function globally accessible
window.videoGen = videoGen;
