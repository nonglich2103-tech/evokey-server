// ==UserScript==
// @name         EvoWars.io Auto Chém v5 (Hoàn thiện tối đa)
// @match        https://evowars.io/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // CẤU HÌNH CHÍNH
    // ==========================================
    const config = {
        isEnabled: false,
        showMyRadius: true,
        showEnemyRadius: true,
        quickRespawn: false,
        respawnSpeed: parseFloat(GM_getValue("evo_respawnSpeed")) || 30.0,
        pingBuffer: parseFloat(GM_getValue("evo_pingBuffer")) || 1.01,
        // Lọc cấp thấp
        filterLowLevel: GM_getValue("evo_filterLowLevel", true),
        lowLevelThreshold: parseInt(GM_getValue("evo_lowLevelThreshold", 15)),
        // Màu sắc
        BORDER_OFF: "#ff0000",
        BORDER_ON: "#00ff00",
        COLLISION: "#FFD700",
        HITBOX_COLOR: "#FF0000",
        MY_HITBOX_COLOR: "#00ffff",
        ENEMY_SWORD: "rgba(255, 0, 0, 0.25)",
        WIDTH: 0.5
    };

    // Bảng dữ liệu level
    const LEVEL_DATA = {
        1: [1.06, 200, 125],
        2: [1.27, 235, 90],
        3: [1.25, 245, 125],
        4: [1.20, 260, 125],
        5: [1.27, 300, 133],
        6: [1.27, 340, 125],
        7: [1.39, 380, 131],
        8: [1.43, 343, 130],
        9: [1.43, 350, 125],
        10: [1.41, 470, 133],
        11: [1.55, 510, 129],
        12: [1.47, 520, 133],
        13: [1.49, 555, 134],
        14: [1.53, 595, 125],
        15: [1.60, 650, 129],
        16: [1.51, 655, 131],
        17: [1.53, 660, 125],
        18: [1.57, 695, 125],
        19: [1.53, 690, 125],
        20: [1.55, 710, 130],
        21: [1.57, 775, 130],
        22: [1.63, 805, 136],
        23: [1.59, 680, 122],
        24: [1.65, 870, 125],
        25: [1.68, 940, 137],
        26: [1.65, 975, 130],
        27: [1.81, 1050, 125],
        28: [1.73, 1095, 125],
        29: [1.61, 1000, 140],
        30: [1.57, 995, 125],
        31: [1.65, 1050, 130],
        32: [1.73, 1145, 134],
        33: [1.66, 1120, 139],
        34: [1.65, 1125, 124],
        35: [1.64, 1145, 135],
        36: [1.77, 1250, 122],
        37: [1.85, 1300, 125],
        38: [2.03, 1300, 125],
        39: [2.09, 1300, 125],
        40: [2.09, 1300, 125],
        41: [2.11, 1300, 125]
    };

    // Biến toàn cục
    let liveHitboxScale = parseFloat(GM_getValue("myHitboxScale") || 0.85);
    if (liveHitboxScale < 0.50) liveHitboxScale = 0.50;
    let lastAttackTime = 0;
    let rt, me, canvas, ctx;
    let isFlicking = false;
    let flickExpiryTime = 0;
    let visualLockedAngle = 0;
    const targetHistory = new Map();
    let cachedPlayerTypes = [];
    let aiMemory = {};

    // Đọc bộ nhớ AI
    try {
        let saved = GM_getValue("ai_bot_memory");
        if (saved && typeof saved === 'object') aiMemory = saved;
        else if (typeof saved === 'string') aiMemory = JSON.parse(saved);
    } catch(e) { aiMemory = {}; }

    // ==========================================
    // HÀM TIỆN ÍCH
    // ==========================================
    function getLevelConfig(lv) {
        return LEVEL_DATA[lv] || LEVEL_DATA[41];
    }

    function getDefaultFactor(lv) {
        return getLevelConfig(lv)[0];
    }

    function getDefaultCooldown(lv) {
        if (lv <= 5) return 200;
        if (lv <= 15) return 240;
        if (lv <= 25) return 300;
        if (lv <= 35) return 360;
        return 400;
    }

    function getHitboxShift(width) {
        let shiftFactor = liveHitboxScale - 0.71;
        return (width / 2) * (shiftFactor * 0.5);
    }

    function getTrueLevel(inst) {
        if (!inst) return 1;
        const vars = inst.instance_vars || inst.instvars;
        if (!vars) return 1;
        let raw = vars[10];
        return typeof raw === 'number' ? (raw + 1) : 1;
    }

    function isTeammate(a, b) {
        if (!a || !b) return false;
        const av = a.instance_vars || a.instvars;
        const bv = b.instance_vars || b.instvars;
        if (!av || !bv) return false;
        return av[36] !== 0 && av[36] === bv[36];
    }

    function getLevelParams(lv) {
        let key = lv.toString();
        if (!aiMemory[key] || typeof aiMemory[key] !== 'object' || isNaN(aiMemory[key].degreesBuffer)) {
            const cfg = getLevelConfig(lv);
            aiMemory[key] = {
                degreesBuffer: cfg[2],
                predictionTicks: 4.5,
                missCount: 0,
                cooldownMS: getDefaultCooldown(lv)
            };
        }
        return aiMemory[key];
    }

    function getGameRadius(w, trueLv) {
        let key = trueLv.toString();
        let saved = {};
        try { saved = GM_getValue("myFactors") || {}; } catch(e){}
        let factor = parseFloat(saved[key]);
        if (isNaN(factor)) factor = getDefaultFactor(trueLv);
        return (w / 2) * 2.8 * factor;
    }

    function getPredictiveSwingAngle(trueLv, pInst, tInst, vX, vY, currentDist, myRadius, isOrbiting) {
        const params = getLevelParams(trueLv);
        let ticks = params.predictionTicks;
        if (isOrbiting) ticks = 0.6;
        else if (currentDist < myRadius * 0.70) ticks = 0.1;

        let fx = tInst.x + vX * ticks;
        let fy = tInst.y + vY * ticks;
        let dx = fx - pInst.x;
        let dy = fy - pInst.y;
        return Math.atan2(dy, dx) + (params.degreesBuffer * Math.PI / 180);
    }

    function gameToScreen(x, y, layer) {
        if (layer && typeof layer.layerToCanvas === 'function') {
            return { x: layer.layerToCanvas(x, y, true), y: layer.layerToCanvas(x, y, false) };
        }
        const scale = layer ? layer.getScale() : 1;
        const sx = (x - rt.running_layout.scrollX) * scale + (window.innerWidth / 2);
        const sy = (y - rt.running_layout.scrollY) * scale + (window.innerHeight / 2);
        return { x: sx, y: sy };
    }

    // ==========================================
    // HACK RENDER VÀ TICK
    // ==========================================
    function hackRuntimeRender(runtime) {
        if (!runtime || runtime.DrawInstance_Hooked) return;
        runtime.DrawInstance_Hooked = true;
        const original = runtime.draw_instance || runtime.DrawInstance;
        if (typeof original === 'function') {
            const hook = function(inst) {
                if (me && inst && inst.uid === me.uid && isFlicking && Date.now() < flickExpiryTime) {
                    inst.angle = visualLockedAngle;
                    if (inst.instvars) inst.instvars[2] = visualLockedAngle;
                }
                return original.apply(this, arguments);
            };
            if (runtime.draw_instance) runtime.draw_instance = hook;
            else if (runtime.DrawInstance) runtime.DrawInstance = hook;
        }
    }

    function hookEngineTick() {
        if (!rt || rt.BotHooked) return;
        rt.BotHooked = true;
        const original = rt.tick || rt.Tick;
        const newTick = function() {
            try { botLogicLoop(this); } catch(e) {}
            return original.apply(this, arguments);
        };
        if (rt.tick) rt.tick = newTick;
        else if (rt.Tick) rt.Tick = newTick;
    }

    // ==========================================
    // LOGIC BOT CHÍNH
    // ==========================================
    function botLogicLoop(runtime) {
        // Khởi tạo danh sách player type
        if (cachedPlayerTypes.length === 0 && runtime.types_by_index) {
            cachedPlayerTypes = runtime.types_by_index.filter(t => t.instvar_sids?.length > 40);
        }
        if (cachedPlayerTypes.length === 0) return;

        // Tìm me
        me = null;
        for (let t of cachedPlayerTypes) {
            if (t.instances) {
                let found = t.instances.find(i => Math.abs(i.x - runtime.running_layout.scrollX) < 1.5 && Math.abs(i.y - runtime.running_layout.scrollY) < 1.5);
                if (found) { me = found; break; }
            }
        }

        // Tăng tốc hồi sinh
        if (config.quickRespawn && !me) runtime.timescale = config.respawnSpeed;
        else if (runtime.timescale !== 1) runtime.timescale = 1;

        if (!me) return;

        let myLevel = getTrueLevel(me);
        let params = getLevelParams(myLevel);

        // Xử lý flick góc (hiệu ứng ảo)
        if (isFlicking) {
            const now = Date.now();
            const swinging = me.instvars && (me.instvars[4] === 1 || me.instvars[6] === 1);
            if (swinging && now >= flickExpiryTime) flickExpiryTime = now + 16;
            if (now < flickExpiryTime) {
                me.angle = visualLockedAngle;
                if (me.instvars) me.instvars[2] = visualLockedAngle;
            } else {
                isFlicking = false;
            }
        }

        const isWeaponReady = (Date.now() - lastAttackTime >= params.cooldownMS);
        const myRadiusGame = getGameRadius(me.width, myLevel);
        const myShift = getHitboxShift(me.width);
        const myCenterX = me.x + Math.cos(me.angle) * myShift;
        const myCenterY = me.y + Math.sin(me.angle) * myShift;

        let targetData = null;
        let closestDist = Infinity;
        let isOrbiting = false;
        let finalTarget = null;
        const currentUids = new Set();

        // Duyệt tất cả đối tượng
        for (let t of cachedPlayerTypes) {
            if (!t.instances) continue;
            for (let obj of t.instances) {
                if (obj.uid === me.uid || obj.width <= 30 || isTeammate(me, obj)) continue;

                // --- Lọc cấp thấp ---
                if (config.filterLowLevel) {
                    let enemyLevel = getTrueLevel(obj);
                    if (myLevel - enemyLevel >= config.lowLevelThreshold) {
                        continue; // Bỏ qua
                    }
                }

                // Tính khoảng cách
                let objShift = getHitboxShift(obj.width);
                let objCX = obj.x + Math.cos(obj.angle) * objShift;
                let objCY = obj.y + Math.sin(obj.angle) * objShift;
                let dist = Math.hypot(objCX - myCenterX, objCY - myCenterY);

                // Bỏ qua nếu đang tấn công (cooldown ảo)
                if (obj.instvars && (obj.instvars[4] === 1 || obj.instvars[6] === 1)) continue;

                currentUids.add(obj.uid);

                // Lưu lịch sử di chuyển
                if (!targetHistory.has(obj.uid)) targetHistory.set(obj.uid, []);
                let history = targetHistory.get(obj.uid);
                history.push({ x: obj.x, y: obj.y, angle: obj.angle, t: Date.now() });
                if (history.length > 5) history.shift();

                // Tính vận tốc và phát hiện xoay
                let vx = 0, vy = 0, orbit = false;
                if (history.length > 1) {
                    let first = history[0];
                    let last = history[history.length - 1];
                    let dt = (last.t - first.t) / 16.66;
                    if (dt > 0) { vx = (last.x - first.x) / dt; vy = (last.y - first.y) / dt; }

                    let angleSum = 0;
                    for (let i = 1; i < history.length; i++) {
                        let diff = Math.abs(history[i].angle - history[i-1].angle);
                        if (diff > Math.PI) diff = 2 * Math.PI - diff;
                        angleSum += diff;
                    }
                    if (angleSum > 0.5) orbit = true;
                }

                const enemyHitboxRadiusGame = (obj.width / 2) * liveHitboxScale;
                const threshold = (myRadiusGame + enemyHitboxRadiusGame) * config.pingBuffer;

                if (dist <= threshold && dist < closestDist) {
                    closestDist = dist;
                    targetData = { uid: obj.uid, vx, vy, dist };
                    isOrbiting = orbit;
                    finalTarget = obj;
                }
            }
        }

        // Xóa các uid không còn tồn tại
        for (let key of targetHistory.keys()) {
            if (!currentUids.has(key)) targetHistory.delete(key);
        }

        // Thực hiện chém
        if (targetData && config.isEnabled && isWeaponReady && finalTarget) {
            performPerfectChop(runtime, finalTarget, myLevel, targetData.vx, targetData.vy, targetData.dist, myRadiusGame, isOrbiting);
        }
    }

    // ==========================================
    // THỰC HIỆN CHÉM (PERFECT CHOP)
    // ==========================================
    function performPerfectChop(runtime, targetInst, trueLv, vX, vY, currentDist, myRadius, isOrbiting) {
        let now = Date.now();
        const params = getLevelParams(trueLv);
        if (now - lastAttackTime < params.cooldownMS) return;
        if (me.instvars && (me.instvars[4] === 1 || me.instvars[6] === 1)) return;

        lastAttackTime = now;

        // Lưu góc hiện tại để flick
        visualLockedAngle = me.instvars ? me.instvars[2] : me.angle;
        isFlicking = true;
        flickExpiryTime = Date.now() + 120;

        // Tính tâm thực của người chơi
        let myShift = getHitboxShift(me.width);
        let myCX = me.x + Math.cos(me.angle) * myShift;
        let myCY = me.y + Math.sin(me.angle) * myShift;
        let pInst = { x: myCX, y: myCY };

        // Tính góc chém dự đoán
        const angle = getPredictiveSwingAngle(trueLv, pInst, targetInst, vX, vY, currentDist, myRadius, isOrbiting);

        // Tạo tọa độ ảo trên màn hình
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;
        const fakeX = centerX + Math.cos(angle) * 250;
        const fakeY = centerY + Math.sin(angle) * 250;

        // Lưu giá trị cũ
        const oldMouseX = runtime.mouseX !== undefined ? runtime.mouseX : undefined;
        const oldMouseY = runtime.mouseY !== undefined ? runtime.mouseY : undefined;
        const oldMousex = runtime.mousex !== undefined ? runtime.mousex : undefined;
        const oldMousey = runtime.mousey !== undefined ? runtime.mousey : undefined;

        // Gán mouse ảo
        if (runtime.mouseX !== undefined) runtime.mouseX = fakeX;
        if (runtime.mouseY !== undefined) runtime.mouseY = fakeY;
        if (runtime.mousex !== undefined) runtime.mousex = fakeX;
        if (runtime.mousey !== undefined) runtime.mousey = fakeY;

        // Cập nhật mouse cho tất cả instance
        if (runtime.types_by_index) {
            for (let t of runtime.types_by_index) {
                if (t.instances) {
                    for (let inst of t.instances) {
                        if (typeof inst.mouseX !== 'undefined') inst.mouseX = fakeX;
                        if (typeof inst.mouseY !== 'undefined') inst.mouseY = fakeY;
                    }
                }
            }
        }

        // Cập nhật góc người chơi
        me.angle = angle;
        if (me.instvars) {
            me.instvars[2] = visualLockedAngle;
            me.instvars[3] = angle;
            me.instvars[4] = 1;
        }

        // Kích hoạt sự kiện chuột
        const gameCanvas = runtime.canvas || document.getElementById('canvas') || document.body;
        const evtOpts = { clientX: fakeX, clientY: fakeY, bubbles: true, button: 0, buttons: 1 };
        gameCanvas.dispatchEvent(new PointerEvent('pointerdown', evtOpts));
        gameCanvas.dispatchEvent(new MouseEvent('mousedown', evtOpts));
        gameCanvas.dispatchEvent(new PointerEvent('pointerup', evtOpts));
        gameCanvas.dispatchEvent(new MouseEvent('mouseup', evtOpts));

        // Khôi phục mouse
        if (oldMouseX !== undefined) runtime.mouseX = oldMouseX;
        if (oldMouseY !== undefined) runtime.mouseY = oldMouseY;
        if (oldMousex !== undefined) runtime.mousex = oldMousex;
        if (oldMousey !== undefined) runtime.mousey = oldMousey;
    }

    // ==========================================
    // RENDER CANVAS
    // ==========================================
    function drawVisuals() {
        requestAnimationFrame(drawVisuals);
        if (!me || !rt) return;

        if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const scale = me.layer ? me.layer.getScale() : 1;
        let drawScale = rt.canvas ? (rt.canvas.clientWidth / rt.canvas.width || 1) : 1;

        let myLevel = getTrueLevel(me);
        let params = getLevelParams(myLevel);
        const myRadiusGame = getGameRadius(me.width, myLevel);
        const myRadiusScreen = myRadiusGame * scale * drawScale;

        let myShift = getHitboxShift(me.width);
        let myCX = me.x + Math.cos(me.angle) * myShift;
        let myCY = me.y + Math.sin(me.angle) * myShift;
        const myScreenPos = gameToScreen(myCX, myCY, me.layer);
        const myHitboxRadiusScreen = (me.width / 2) * scale * liveHitboxScale * drawScale;
        const isWeaponReady = (Date.now() - lastAttackTime >= params.cooldownMS);

        // Vẽ địch
        for (let t of cachedPlayerTypes) {
            if (!t.instances) continue;
            for (let obj of t.instances) {
                if (obj.uid === me.uid || obj.width <= 30 || isTeammate(me, obj)) continue;

                // Kiểm tra lọc cấp thấp để quyết định có vẽ hay không
                let shouldDraw = true;
                if (config.filterLowLevel) {
                    let enemyLevel = getTrueLevel(obj);
                    if (myLevel - enemyLevel >= config.lowLevelThreshold) {
                        shouldDraw = false; // Không vẽ đối tượng bị lọc
                    }
                }
                if (!shouldDraw) continue;

                let objShift = getHitboxShift(obj.width);
                let objCX = obj.x + Math.cos(obj.angle) * objShift;
                let objCY = obj.y + Math.sin(obj.angle) * objShift;
                const enemyScreenPos = gameToScreen(objCX, objCY, obj.layer || me.layer);
                const enemyHitboxRadiusScreen = (obj.width / 2) * scale * liveHitboxScale * drawScale;

                if (config.showEnemyRadius && !isNaN(enemyScreenPos.x)) {
                    const enemySwordRadiusGame = getGameRadius(obj.width, getTrueLevel(obj));
                    const enemySwordRadiusScreen = enemySwordRadiusGame * scale * drawScale;

                    ctx.lineWidth = config.WIDTH;
                    // Vòng tầm chém địch
                    ctx.beginPath();
                    ctx.arc(enemyScreenPos.x, enemyScreenPos.y, enemySwordRadiusScreen, 0, Math.PI * 2);
                    ctx.strokeStyle = config.ENEMY_SWORD;
                    ctx.stroke();

                    // Vòng hitbox địch
                    ctx.beginPath();
                    ctx.arc(enemyScreenPos.x, enemyScreenPos.y, enemyHitboxRadiusScreen, 0, Math.PI * 2);
                    ctx.strokeStyle = config.HITBOX_COLOR;
                    ctx.stroke();
                }
            }
        }

        // Vẽ bản thân
        if (config.showMyRadius && !isNaN(myScreenPos.x)) {
            ctx.lineWidth = config.WIDTH;

            const myRealPos = gameToScreen(me.x, me.y, me.layer);
            ctx.beginPath();
            ctx.arc(myRealPos.x, myRealPos.y, myRadiusScreen, 0, Math.PI * 2);
            ctx.setLineDash([12, 8]);
            ctx.strokeStyle = !config.isEnabled ? config.BORDER_OFF : (!isWeaponReady ? config.BORDER_ON : config.COLLISION);
            ctx.stroke();
            ctx.setLineDash([]);

            // Hitbox xanh
            ctx.beginPath();
            ctx.arc(myScreenPos.x, myScreenPos.y, myHitboxRadiusScreen, 0, Math.PI * 2);
            ctx.strokeStyle = config.MY_HITBOX_COLOR;
            ctx.stroke();

            // Thông tin
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 13px Arial";
            ctx.shadowBlur = 4;
            ctx.shadowColor = "black";
            ctx.fillText(`[Level ${myLevel}] Góc (1/2): ${params.degreesBuffer.toFixed(1)}° | Ticks: ${params.predictionTicks.toFixed(2)}`, 30, window.innerHeight - 110);
            ctx.fillText(`Tầm chém (P/O): ${myRadiusGame.toFixed(1)} | Hitbox (C/V): ${liveHitboxScale.toFixed(2)}`, 30, window.innerHeight - 90);
            ctx.fillText(`Hồi sinh (T): ${config.quickRespawn ? "BẬT" : "TẮT"} (${config.respawnSpeed}x) | Ping ([/]): ${config.pingBuffer.toFixed(2)}x`, 30, window.innerHeight - 70);
            ctx.fillText(`Lọc cấp thấp (F): ${config.filterLowLevel ? "BẬT" : "TẮT"} | Ngưỡng (;/'): ${config.lowLevelThreshold} cấp`, 30, window.innerHeight - 50);
            ctx.shadowBlur = 0;
        }
    }

    // ==========================================
    // TOAST NOTIFICATION
    // ==========================================
    function showToast(text) {
        let toast = document.getElementById("evo-toast");
        if (!toast) {
            toast = document.createElement("div");
            toast.id = "evo-toast";
            toast.style.cssText = "position:fixed; top:20px; left:50%; transform:translateX(-50%); background:rgba(0,0,0,0.85); color:#0f0; padding:10px 20px; font-family:sans-serif; font-size:13px; font-weight:bold; border-radius:5px; z-index:9999999; pointer-events:none; transition: opacity 0.2s;";
            document.body.appendChild(toast);
        }
        toast.innerText = text;
        toast.style.opacity = "1";
        clearTimeout(toast.hideTimeout);
        toast.hideTimeout = setTimeout(() => { toast.style.opacity = "0"; }, 1500);
    }

    // ==========================================
    // BÀN PHÍM TẮT
    // ==========================================
    window.addEventListener('keydown', (e) => {
        const key = e.key.toLowerCase();
        let trueLv = me ? getTrueLevel(me) : 1;
        let lvKey = trueLv.toString();

        // Bật/tắt bot
        if (key === 'u') {
            config.isEnabled = !config.isEnabled;
            showToast("Bot: " + (config.isEnabled ? "BẬT" : "TẮT"));
        }
        // Hiển thị vòng bản thân
        if (key === 'q') {
            config.showMyRadius = !config.showMyRadius;
            showToast("Vòng bản thân: " + (config.showMyRadius ? "HIỆN" : "ẨN"));
        }
        // Hiển thị vòng địch
        if (key === 'e') {
            config.showEnemyRadius = !config.showEnemyRadius;
            showToast("Vòng địch: " + (config.showEnemyRadius ? "HIỆN" : "ẨN"));
        }
        // Hồi sinh nhanh
        if (key === 't') {
            config.quickRespawn = !config.quickRespawn;
            showToast("Hồi sinh nhanh: " + (config.quickRespawn ? "BẬT" : "TẮT"));
        }
        // Tăng/giảm tốc hồi sinh
        if (key === 'g' || key === 'b') {
            config.respawnSpeed += (key === 'g' ? 5 : -5);
            config.respawnSpeed = Math.max(1, Math.min(100, config.respawnSpeed));
            GM_setValue("evo_respawnSpeed", config.respawnSpeed);
            showToast(`Tốc độ hồi sinh: ${config.respawnSpeed}x`);
        }
        // Bù ping
        if (key === '[' || key === ']') {
            config.pingBuffer += (key === ']' ? 0.01 : -0.01);
            config.pingBuffer = Math.max(1.00, Math.min(1.20, config.pingBuffer));
            GM_setValue("evo_pingBuffer", config.pingBuffer);
            showToast(`Bù ping: ${config.pingBuffer.toFixed(2)}x`);
        }
        // Góc chém
        if (key === '1' || key === '2') {
            let p = getLevelParams(trueLv);
            p.degreesBuffer += (key === '1' ? 1 : -1);
            p.degreesBuffer = Math.max(45, Math.min(180, p.degreesBuffer));
            GM_setValue("ai_bot_memory", aiMemory);
            showToast(`[Lv ${trueLv}] Góc: ${p.degreesBuffer.toFixed(1)}°`);
        }
        // Tầm chém
        if (key === 'p' || key === 'o') {
            let savedFactors = {};
            try { savedFactors = GM_getValue("myFactors") || {}; } catch(e){}
            let cur = parseFloat(savedFactors[lvKey]);
            if (isNaN(cur)) cur = getDefaultFactor(trueLv);
            cur += (key === 'p' ? 0.02 : -0.02);
            savedFactors[lvKey] = cur.toFixed(3);
            GM_setValue("myFactors", savedFactors);
            showToast(`[Lv ${trueLv}] Tầm: ${cur.toFixed(2)}`);
        }
        // Hitbox scale
        if (key === 'c' || key === 'v') {
            liveHitboxScale += (key === 'c' ? 0.01 : -0.01);
            liveHitboxScale = Math.max(0.50, liveHitboxScale);
            GM_setValue("myHitboxScale", liveHitboxScale.toFixed(2));
            showToast(`Hitbox: ${liveHitboxScale.toFixed(2)}`);
        }
        // Cooldown
        if (key === 'm' || key === 'n') {
            let p = getLevelParams(trueLv);
            p.cooldownMS += (key === 'm' ? 10 : -10);
            p.cooldownMS = Math.max(100, Math.min(1000, p.cooldownMS));
            GM_setValue("ai_bot_memory", aiMemory);
            showToast(`[Lv ${trueLv}] CD: ${p.cooldownMS}ms`);
        }
        // Xóa bộ nhớ
        if (key === 'l') {
            aiMemory = {};
            GM_setValue("ai_bot_memory", {});
            GM_setValue("myFactors", {});
            showToast("Đã xóa bộ nhớ AI!");
        }
        // Lọc cấp thấp
        if (key === 'f') {
            config.filterLowLevel = !config.filterLowLevel;
            GM_setValue("evo_filterLowLevel", config.filterLowLevel);
            showToast("Lọc cấp thấp: " + (config.filterLowLevel ? "BẬT" : "TẮT"));
        }
        // Tăng ngưỡng
        if (key === ';') {
            config.lowLevelThreshold = Math.min(50, config.lowLevelThreshold + 1);
            GM_setValue("evo_lowLevelThreshold", config.lowLevelThreshold);
            showToast(`Ngưỡng lọc: ${config.lowLevelThreshold}`);
        }
        // Giảm ngưỡng
        if (key === "'") {
            config.lowLevelThreshold = Math.max(0, config.lowLevelThreshold - 1);
            GM_setValue("evo_lowLevelThreshold", config.lowLevelThreshold);
            showToast(`Ngưỡng lọc: ${config.lowLevelThreshold}`);
        }
    });

    // ==========================================
    // KHỞI TẠO
    // ==========================================
    function init() {
        rt = typeof cr_getC2Runtime !== 'undefined' ? cr_getC2Runtime() : null;
        if (rt?.running_layout) {
            hookEngineTick();
            hackRuntimeRender(rt);
            drawVisuals();
        } else {
            setTimeout(init, 200);
        }
    }

    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d');
    canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:999999;';
    document.body.appendChild(canvas);

    setTimeout(init, 1000);
})();