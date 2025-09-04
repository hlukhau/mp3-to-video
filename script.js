// Video Generator Application
class VideoGenerator {
    constructor() {
        this.currentProject = null;
        this.images = [];
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
        // slight sepia tint (a bit stronger with intensity)
        this.ctx.fillStyle = `rgba(112, 66, 20, ${0.06 + 0.04 * (I.alpha)})`;
        this.ctx.fillRect(0, 0, w, h);
        // vignette
        const grd = this.ctx.createRadialGradient(w/2, h/2, Math.min(w,h)/3, w/2, h/2, Math.max(w,h)/1.1);
        grd.addColorStop(0, 'rgba(0,0,0,0)');
        grd.addColorStop(1, `rgba(0,0,0,${0.25 + 0.25 * I.alpha})`);
        this.ctx.fillStyle = grd;
        this.ctx.fillRect(0, 0, w, h);
        // scratches
        this.ctx.globalAlpha = 0.12 + 0.25 * I.alpha;
        this.ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        const sCount = Math.max(2, Math.round(10 * I.count));
        for (let i = 0; i < sCount; i++) {
            const sx = (this.noise01(currentTime * 0.2, i * 17) * 1.1 - 0.05) * w; // allow slightly offscreen
            const jitter = this.noise11(currentTime * 4, i * 31) * 12;
            const y1 = -10;
            const y2 = h + 10;
            this.ctx.beginPath();
            this.ctx.moveTo(sx, y1);
            this.ctx.lineTo(sx + jitter, y2);
            this.ctx.lineWidth = (0.4 + this.noise01(currentTime * 0.7, i * 13) * 1.8) * I.size;
            this.ctx.stroke();
        }
        // dust particles
        for (let i = 0, n = Math.max(5, Math.round(80 * I.count)); i < n; i++) {
            const x = this.noise01(currentTime * 0.9, i * 101) * w;
            const y = this.noise01(currentTime * 0.7, i * 97) * h;
            const r = (0.2 + this.noise01(currentTime * 1.3, i * 29) * 1.4) * I.size;
            this.ctx.fillStyle = `rgba(255,255,255,${0.08 + 0.1 * I.alpha})`;
            this.ctx.beginPath();
            this.ctx.arc(x, y, r, 0, Math.PI * 2);
            this.ctx.fill();
        }
        this.ctx.restore();
    }

    // Elegant copyright overlay in top-right corner (so it doesn't overlap bottom subtitles)
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
        const burstsPerSec = 0.8 + 1.8 * I.count;
        const activeBursts = Math.max(1, Math.round(3 * I.count));
        for (let b = 0; b < activeBursts; b++) {
            const seed = b * 997;
            // Each burst gets its own phase offset so they are not synchronized
            const phase = (currentTime * burstsPerSec + this.noise01(b * 0.37, 0)) % 1;
            const life = phase; // 0..1
            const alive = life < 0.95; // short fade-out gap
            if (!alive) continue;
            // Randomize center per burst slowly over time
            const cx = this.noise01(currentTime * 0.2, seed * 0.13) * (w * 0.8) + w * 0.1;
            const cy = this.noise01(currentTime * 0.25, seed * 0.31) * (h * 0.5) + h * 0.2;
            const particles = Math.max(18, Math.round(44 * I.count));
            for (let p = 0; p < particles; p++) {
                // Assign each particle its own slight angular speed and curvature for chaos
                const baseAng = (p / particles) * Math.PI * 2;
                const angJitter = this.noise11(currentTime * 1.3, seed + p * 17) * 0.4;
                const angle = baseAng + angJitter * life;
                const radius = Math.pow(life, 0.55) * Math.min(w, h) * (0.25 + 0.15 * this.noise01(currentTime*0.9, p));
                const x = cx + Math.cos(angle) * radius;
                const y = cy + Math.sin(angle) * radius;
                const alpha = Math.max(0, 1 - life) * (0.8 + 0.2 * this.noise01(currentTime*2.1, p));
                const hue = (seed + p * 23 + Math.floor(this.noise01(currentTime, p) * 120)) % 360;
                this.ctx.fillStyle = `hsla(${hue}, 90%, 60%, ${alpha})`;
                this.ctx.beginPath();
                this.ctx.arc(x, y, (1.6 + this.noise01(currentTime, p) * 1.2) * I.size, 0, Math.PI * 2);
                this.ctx.fill();
            }
        }
        this.ctx.restore();
    }

    drawStarsEffect(currentTime, w, h) {
        this.ctx.save();
        const I = this.getIntensityScales();
        const count = Math.max(40, Math.round(((w * h) / 16000 + 60) * I.count));
        for (let i = 0; i < count; i++) {
            // Slower gentle drift
            const vx = (this.noise11(currentTime * 0.08, i * 3) * 8) + 2 * (i % 3);
            const vy = this.noise11(currentTime * 0.09, i * 7) * 4;
            const baseX = (i * 97) % (w + 200) - 100;
            const baseY = (i * 57) % (h + 200) - 100;
            const x = ((baseX + currentTime * vx) % (w + 200)) - 100;
            const y = ((baseY + currentTime * (6 + vy)) % (h + 200)) - 100;
            const tw = 0.25 + 0.75 * this.noise01(currentTime * (1.8 + (i % 5) * 0.25), i * 11);
            this.ctx.fillStyle = `rgba(255,255,255,${tw})`;
            const sz = Math.max(1, Math.round(1 + this.noise01(0, i) * 2 * I.size));
            this.ctx.fillRect(x, y, sz, sz);
        }
        this.ctx.restore();
    }

    // Galaxy: rotating spiral arms, twinkling stars, inclined view from slightly above and inside
    drawGalaxyEffect(currentTime, w, h) {
        this.ctx.save();
        const I = this.getIntensityScales();
        // Camera/view params
        const cx = w * 0.48;  // center slightly left of center
        const cy = h * 0.58;  // a bit lower to feel "from above"
        const tilt = 0.65;    // inclination of the disk (0..1); y compressed
        const armCount = 4;   // spiral arms
        const pitch = 0.28;   // spiral tightness
        const baseRadius = Math.min(w, h) * 0.95; // galaxy approximate radius
        const rotBase = 0.12; // base rotation speed (rad/s)
        const rotGain = 0.7;  // inner parts rotate faster

        const count = Math.max(180, Math.round(((w * h) / 9000) * I.count));
        for (let i = 0; i < count; i++) {
            // Seeds
            const seed = (i * 16807) % 2147483647;
            const r01 = ((seed ^ 0x9e3779b9) & 0xffff) / 0xffff; // 0..1
            const r02 = ((seed * 48271) % 2147483647) / 2147483647;

            // Radial distance with denser inner region
            const radius = 20 + Math.pow(r01, 1.2) * baseRadius;

            // Assign to an arm and compute spiral angle via logarithmic spiral approximation
            const arm = i % armCount;
            const armOffset = (arm / armCount) * Math.PI * 2;
            const spiralTheta = armOffset + pitch * Math.log(1 + radius);

            // Differential rotation (inner faster)
            const rNorm = Math.min(1, radius / baseRadius);
            const angSpeed = rotBase + rotGain * Math.pow(1 - rNorm, 1.3);
            const rotation = currentTime * angSpeed;

            // Add subtle wobble to avoid rigid arms
            const wobble = this.noise11(currentTime * 0.6, i * 0.11) * (0.08 + 0.12 * (1 - rNorm));
            const theta = spiralTheta + rotation + wobble + r02 * 0.4;

            // Position with inclination (tilt) and slight vertical parallax
            const x = cx + Math.cos(theta) * radius;
            const y = cy + Math.sin(theta) * radius * tilt - rNorm * 12; // small vertical offset to feel above the plane

            if (x < -120 || x > w + 120 || y < -120 || y > h + 120) continue;

            // Size and twinkle (brighter towards the core)
            const coreFactor = 1 - rNorm;
            const baseSize = 1 + Math.floor(2 + coreFactor * 2 + (i % 5 === 0 ? 1 : 0));
            const size = baseSize * I.size;
            const tw = 0.35 + 0.65 * this.noise01(currentTime * (1.6 + (i % 5) * 0.4), i * 7 + radius * 0.0015);

            // Color: warmer in core, cooler on outskirts
            const hue = Math.round(200 - coreFactor * 40 + (i % 7));
            const sat = 30 + Math.round(coreFactor * 20);
            const lum = 60 + Math.round(coreFactor * 20);
            this.ctx.fillStyle = `hsla(${hue}, ${sat}%, ${lum}%, ${tw})`;

            // Draw star point and small cross
            this.ctx.fillRect(x, y, size, size);
            this.ctx.globalAlpha = Math.min(1, tw * 0.6 * I.alpha);
            this.ctx.fillRect(x - size, y, 1, 1);
            this.ctx.fillRect(x + size, y, 1, 1);
            this.ctx.fillRect(x, y - size, 1, 1);
            this.ctx.fillRect(x, y + size, 1, 1);
            this.ctx.globalAlpha = 1;
        }

        // Nebula-like soft glow along arms
        const armGlow = this.ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.1, cx, cy, Math.max(w, h));
        armGlow.addColorStop(0, `rgba(255, 230, 200, ${0.06 + 0.06 * I.alpha})`);
        armGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
        this.ctx.fillStyle = armGlow;
        this.ctx.fillRect(0, 0, w, h);

        // Peripheral cool tint
        const cool = this.ctx.createRadialGradient(w * 0.7, h * 0.35, Math.min(w, h) * 0.2, w * 0.7, h * 0.35, Math.max(w, h));
        cool.addColorStop(0, `rgba(120, 150, 255, ${0.035 + 0.045 * I.alpha})`);
        cool.addColorStop(1, 'rgba(0, 0, 0, 0)');
        this.ctx.fillStyle = cool;
        this.ctx.fillRect(0, 0, w, h);

        this.ctx.restore();
    }

    drawRainEffect(currentTime, w, h) {
        this.ctx.save();
        const I = this.getIntensityScales();
        this.ctx.globalAlpha = 0.35 + 0.45 * I.alpha;
        this.ctx.strokeStyle = 'rgba(200, 200, 255, 0.35)';
        const drops = Math.max(30, Math.round(((w*h) / 12000) * I.count));
        const wind = this.noise11(currentTime * 0.3, 5) * 120; // px/s lateral
        for (let i = 0; i < drops; i++) {
            const seed = i * 97;
            const len = (10 + this.noise01(currentTime * 0.9, seed) * 16) * I.size;
            const thickness = 0.6 + this.noise01(currentTime * 1.1, seed * 1.7) * 1.2;
            const fallSpeed = 220 + this.noise01(currentTime * 0.5, seed * 2.3) * 260; // px/s
            const baseX = (i * 53) % (w + 200) - 100;
            const baseY = (i * 131) % (h + 200) - 100;
            const sway = this.noise11(currentTime * 2.2, seed * 0.7) * 10; // local curvature
            const t = (currentTime + (seed % 1000) / 997) % 1000;
            const x = (baseX + (t * (wind + 300)) % (w + 200)) - 100 + sway;
            const y = (baseY + (t * fallSpeed) % (h + 200)) - 100;
            const dx = -len * (0.4 + this.noise01(currentTime, seed) * 0.5);
            const dy = len;
            this.ctx.beginPath();
            this.ctx.moveTo(x, y);
            this.ctx.lineTo(x + dx, y + dy);
            this.ctx.lineWidth = Math.max(0.7, thickness);
            this.ctx.stroke();
        }
        this.ctx.restore();
    }

    drawCloudsEffect(currentTime, w, h) {
        this.ctx.save();
        const I = this.getIntensityScales();
        const layers = 3;
        for (let i = 0; i < layers; i++) {
            const alpha = (0.06 + i * 0.05) * I.alpha;
            this.ctx.fillStyle = `rgba(255,255,255,${alpha})`;
            const count = Math.max(3, Math.round((12 - i * 3) * I.count));
            for (let j = 0; j < count; j++) {
                const r = (w + h) * (0.035 + i*0.02) * (0.6 + this.noise01(currentTime*0.7, j+i*17)*0.9) * I.size;
                const nx = this.noise11(currentTime * (0.03 + i*0.02), j * 13 + i*7);
                const ny = this.noise11(currentTime * (0.025 + i*0.015), j * 19 + i*11);
                const x = nx * (w*0.55) + w/2;
                const y = ny * (h*0.4) + h/2;
                this.ctx.beginPath();
                this.ctx.arc(x, y, r, 0, Math.PI * 2);
                this.ctx.fill();
            }
        }
        // slight bluish tint
        this.ctx.fillStyle = `rgba(180, 200, 255, ${0.04 + 0.04 * I.alpha})`;
        this.ctx.fillRect(0, 0, w, h);
        this.ctx.restore();
    }

    drawSubtitles(currentTime, canvasWidth, canvasHeight) {
        // Old behavior: horizontally moving (marquee-like) subtitles at the bottom.
        if (!this.subtitles.length) return;
        const fontSize = Math.max(16, Math.round(canvasHeight * 0.045));
        this.ctx.save();
        this.ctx.globalAlpha = 1;
        this.ctx.shadowColor = 'transparent';
        this.ctx.shadowBlur = 0;
        this.ctx.font = `${fontSize}px sans-serif`;
        this.ctx.textBaseline = 'middle';
        this.ctx.textAlign = 'left';

        const active = this.subtitles
            .filter(s => currentTime >= s.start && currentTime <= s.start + s.duration)
            .sort((a, b) => a.start - b.start);
        if (!active.length) return;
        // show the earliest active subtitle only (old behavior)
        const sub = active[0];

        const padding = Math.round(fontSize * 0.5);
        const lineHeight = Math.round(fontSize * 1.6);
        const lineGap = Math.max(6, Math.round(fontSize * 0.25));
        const speed = Math.max(80, Math.round(canvasWidth * 0.15)); // px/sec

        const t = Math.max(0, currentTime - sub.start);
        const text = sub.text || '';
        const metrics = this.ctx.measureText(text);
        const textWidth = Math.ceil(metrics.width);
        const totalWidth = textWidth + padding * 2;
        const x = Math.round(canvasWidth - t * speed);
        const y = canvasHeight - (lineHeight + lineGap);
        this.drawRoundedRect(x, y, totalWidth, lineHeight, Math.max(8, Math.round(fontSize * 0.3)), 'rgba(0,0,0,0.6)');
        this.ctx.fillStyle = '#FFFFFF';
        this.ctx.fillText(text, x + padding, y + lineHeight / 2);
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
            imageUpload: document.getElementById('imageUpload'),
            imageList: document.getElementById('imageList'),
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

        // Image upload
        this.elements.imageUpload.addEventListener('change', (e) => this.handleImageUpload(e));
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
            // Update all image timestamps that exceed new duration
            this.images.forEach(image => {
                if (image.timestamp > this.videoDuration) {
                    image.timestamp = Math.min(image.timestamp, this.videoDuration);
                    image.timestampDisplay = this.formatTime(image.timestamp);
                }
            });
            this.renderImageList();
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
        const imageFiles = files.filter(file => file.type.startsWith('image/'));
        this.processImageFiles(imageFiles);
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

    handleImageUpload(e) {
        const files = Array.from(e.target.files);
        this.processImageFiles(files);
    }

    processImageFiles(files) {
        // Auto-create project on first asset import
        this.ensureProjectExists();

        files.forEach(file => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const defaultTime = Math.min(this.images.length * 2, this.videoDuration);
                    const imageData = {
                        id: Date.now() + Math.random(),
                        name: file.name,
                        src: e.target.result,
                        timestamp: defaultTime, // Default 2 seconds apart, but not exceeding video duration
                        timestampDisplay: this.formatTime(defaultTime), // MM:SS format
                        element: img,
                        width: img.naturalWidth,
                        height: img.naturalHeight
                    };
                    
                    this.images.push(imageData);
                    this.renderImageList();
                    this.updateTimeline();
                    this.updateGenerateButton();
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        });
    }

    renderImageList() {
        this.elements.imageList.innerHTML = '';
        
        // Sort images by timestamp before rendering
        const sortedImages = [...this.images].sort((a, b) => a.timestamp - b.timestamp);
        
        sortedImages.forEach((image, index) => {
            const imageItem = document.createElement('div');
            imageItem.className = 'image-item fade-in';
            
            imageItem.innerHTML = `
                <img src="${image.src}" alt="${image.name}" class="image-preview">
                <div class="image-info">
                    <div class="image-name">${image.name}</div>
                    <input type="text" 
                           class="timestamp-input" 
                           value="${this.formatTime(image.timestamp)}" 
                           placeholder="MM:SS"
                           pattern="[0-9]{1,2}:[0-9]{2}"
                           title="Формат: MM:SS (например, 01:30)">
                    <button class="remove-image" onclick="videoGen.removeImage('${image.id}')">
                        Удалить
                    </button>
                </div>
            `;
            
            const timestampInput = imageItem.querySelector('.timestamp-input');
            timestampInput.addEventListener('change', (e) => {
                const newTime = this.parseTime(e.target.value);
                if (newTime <= this.videoDuration) {
                    image.timestamp = newTime;
                    image.timestampDisplay = this.formatTime(newTime);
                    e.target.value = this.formatTime(newTime); // Normalize display
                    this.updateTimeline();
                    this.renderImageList(); // Re-render list to show sorted order
                } else {
                    e.target.value = this.formatTime(image.timestamp); // Revert to previous value
                    this.showNotification(`Время не может превышать ${this.formatTime(this.videoDuration)}`, 'warning');
                }
            });
            
            // Format input on blur
            timestampInput.addEventListener('blur', (e) => {
                const time = this.parseTime(e.target.value);
                e.target.value = this.formatTime(time);
            });
            
            this.elements.imageList.appendChild(imageItem);
        });
    }

    removeImage(imageId) {
        const index = this.images.findIndex(img => img.id === imageId);
        if (index !== -1) {
            this.images.splice(index, 1);
            this.renderImageList();
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
        this.elements.audioFileName.textContent = file.name;
        this.elements.audioPlayer.style.display = 'block';
        
        // Автоматически определяем длительность видео по аудио
        this.elements.audioElement.addEventListener('loadedmetadata', () => {
            const audioDuration = Math.ceil(this.elements.audioElement.duration);
            this.videoDuration = audioDuration;
            this.elements.videoDuration.value = audioDuration;
            
            // Обновляем временные метки изображений, если они превышают новую длительность
            this.images.forEach(image => {
                if (image.timestamp > this.videoDuration) {
                    image.timestamp = Math.min(image.timestamp, this.videoDuration);
                    image.timestampDisplay = this.formatTime(image.timestamp);
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
            this.renderImageList();
            this.renderSubtitleList();
            this.showNotification(`Длительность видео установлена по аудио: ${this.formatTime(audioDuration)}`, 'success');
        });
        
        this.updateGenerateButton();
        this.showNotification('Аудиофайл загружен успешно!', 'success');
    }

    updateTimeline() {
        this.updateTimeDisplay();
        
        if (this.images.length === 0) {
            this.elements.timeline.innerHTML = '<p style="text-align: center; color: #718096;">Добавьте изображения для отображения временной шкалы</p>';
            return;
        }

        const timelineHTML = `
            <div class="timeline-track">
                ${this.images.map(image => {
                    const position = (image.timestamp / this.videoDuration) * 100;
                    return `
                        <div class="timeline-marker" style="left: ${position}%">
                            <img src="${image.src}" class="timeline-image" alt="${image.name}">
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
        const canGenerate = this.currentProject && this.images.length > 0;
        this.elements.generateVideo.disabled = !canGenerate;
    }

    lockUI() {
        // Disable image upload
        this.elements.imageUpload.disabled = true;
        
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
        document.querySelectorAll('.remove-image').forEach(btn => {
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
        // Enable image upload
        this.elements.imageUpload.disabled = false;
        
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
        document.querySelectorAll('.remove-image').forEach(btn => {
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
            // Sort images by timestamp
            const sortedImages = [...this.images].sort((a, b) => a.timestamp - b.timestamp);
            
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
            await this.animateVideo(sortedImages, width, height, fps, runId);
            
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
        }
    }

    async animateVideo(sortedImages, width, height, fps, runId) {
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
                    this.renderVideoFrame(sortedImages, videoTime, width, height);
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

    renderVideoFrame(sortedImages, currentTime, canvasWidth, canvasHeight) {
        // Find current image based on timestamp (same logic as preview)
        let currentImage = sortedImages[0];
        for (let i = sortedImages.length - 1; i >= 0; i--) {
            if (currentTime >= sortedImages[i].timestamp) {
                currentImage = sortedImages[i];
                break;
            }
        }
        
        // Clear canvas first
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        
        // Draw current image if exists (same as preview)
        if (currentImage) {
            this.drawAnimatedImage(currentImage, currentTime, canvasWidth, canvasHeight);
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
        this.ctx.drawImage(img, x, y, scaledWidth, scaledHeight);
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
        if (this.images.length === 0) {
            alert('Добавьте изображения для предварительного просмотра');
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
        const sortedImages = [...this.images].sort((a, b) => a.timestamp - b.timestamp);
        this.renderVideoFrame(sortedImages, currentTime, this.canvas.width, this.canvas.height);
    }

    resetProject() {
        this.currentProject = null;
        this.images = [];
        this.subtitles = [];
        this.audioFile = null;
        this.generatedVideoBlob = null;
        
        // Reset UI
        this.elements.currentProject.style.display = 'none';
        this.elements.imageList.innerHTML = '';
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
        // Serialize images to data URLs
        const images = await Promise.all(this.images.map(imgData => this.serializeImage(imgData)));
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
        const payload = { version: 1, settings, images, audio, subtitles };
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
        if (!data || !data.settings) throw new Error('Invalid project');
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
            this.elements.audioFileName.textContent = this.audioFile.name;
        }
        // Images
        this.images = [];
        if (Array.isArray(data.images)) {
            for (const im of data.images) {
                const imageEl = await this.createImageFromDataURL(im.dataUrl);
                this.images.push({
                    id: Date.now() + Math.random(),
                    name: im.name || 'image',
                    src: im.dataUrl,
                    element: imageEl,
                    timestamp: im.timestamp || 0,
                    timestampDisplay: this.formatTime(im.timestamp || 0)
                });
            }
        }
        // Subtitles
        this.subtitles = Array.isArray(data.subtitles) ? data.subtitles.map(s => ({ id: s.id || (Date.now()+Math.random()), text: s.text || '', start: s.start || 0, duration: s.duration || 3 })) : [];
        // UI updates
        this.renderImageList();
        this.renderSubtitleList();
        this.updateTimeline();
        // Render an initial preview frame to show images/effects/subtitles after load
        this.previewCurrentTime = 0;
        this.renderPreviewFrame(0);
        this.updateGenerateButton();
    }

    async serializeImage(imgData) {
        const name = imgData.name || 'image';
        const srcDataUrl = await this.imageToDataURL(imgData.element);
        return { name, timestamp: imgData.timestamp || 0, dataUrl: srcDataUrl };
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
