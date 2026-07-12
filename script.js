// ==UserScript==
// @name         EvoWars.io Auto Chém v4
// @match        ://evowars.io/
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // KHỞI TẠO ĐỊNH CẤU HÌNH & THÔNG SỐ ĐỒ HỌA NẾT MẢNH
    // ==========================================
    const config = {
        isEnabled: false,
        showMyRadius: true,
        showEnemyRadius: true,
        quickRespawn: false,
        respawnSpeed: parseFloat(GM_getValue("evo_respawnSpeed")) || 30.0,
        pingBuffer: parseFloat(GM_getValue("evo_pingBuffer")) || 1.01,
        BORDER_OFF: "#ff0000",
        BORDER_ON: "#00ff00",
        COLLISION: "#FFD700",
        HITBOX_COLOR: "#FF0000",       // Hitbox địch (Đỏ)
        MY_HITBOX_COLOR: "#00ffff",    // Hitbox bản thân (Xanh Neon)
        ENEMY_SWORD: "rgba(255, 0, 0, 0.25)",
        WIDTH: 0.5                     // KHÓA CỨNG: Độ dày nét vẽ siêu mảnh 0.5
    };

    // Bảng dữ liệu chuẩn của từng Level: [Factor, Distance, Degrees]
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

    function getLevelConfig(lv) {
        return LEVEL_DATA[lv] || LEVEL_DATA[41];
    }

    let liveHitboxScale = parseFloat(GM_getValue("myHitboxScale") || 0.85);
    if (liveHitboxScale < 0.50) liveHitboxScale = 0.50; // Giới hạn sàn an toàn tối thiểu

    let lastAttackTime = 0;
    let rt, me, canvas, ctx;

    let isFlicking = false;
    let flickExpiryTime = 0;
    let visualLockedAngle = 0;

    const targetHistory = new Map();
    let cachedPlayerTypes = [];
    let aiMemory = {};

    try {
        let savedMemory = GM_getValue("ai_bot_memory");
        if (savedMemory && typeof savedMemory === 'object') aiMemory = savedMemory;
        else if (typeof savedMemory === 'string') aiMemory = JSON.parse(savedMemory);
    } catch(e) { aiMemory = {}; }

    function getDefaultFactor(lv) {
        const config = getLevelConfig(lv);
        return config[0]; // Trả về hệ số factor từ bảng
    }

    function getDefaultCooldown(lv) {
        if (lv <= 5) return 200;
        if (lv <= 15) return 240;
        if (lv <= 25) return 300;
        if (lv <= 35) return 360;
        return 400;
    }

    // Tính độ dịch tâm tịnh tiến dựa trên thang đo động thực tế của vòng tròn chung
    function getHitboxShift(width) {
        let shiftFactor = liveHitboxScale - 0.71;
        return (width / 2) * (shiftFactor * 0.5); // Giảm bớt tỷ lệ dịch để cân đối tâm khi tăng size chung lên 0.85
    }

    function getTrueLevel(inst) {
        if (!inst) return 1;
        const vars = inst.instance_vars || inst.instvars;
        if (!vars) return 1;
        let rawLv = vars[10];
        return typeof rawLv === 'number' ? (rawLv + 1) : 1;
    }

    function isTeammate(a, b) {
        if (!a || !b) return false;
        const av = a.instance_vars || a.instvars;
        const bv = b.instance_vars || b.instvars;
        if (!av || !bv) return false;
        const ta = av[36], tb = bv[36];
        return ta !== 0 && ta !== undefined && ta === tb;
    }

    function getLevelParams(lv) {
        let levelKey = lv.toString();
        if (!aiMemory[levelKey] || typeof aiMemory[levelKey] !== 'object' || isNaN(aiMemory[levelKey].degreesBuffer)) {
            const config = getLevelConfig(lv);
            let defaultBuffer = config[2]; // Lấy góc chém (degrees) chuẩn từ bảng

            aiMemory[levelKey] = {
                degreesBuffer: defaultBuffer,
                predictionTicks: 4.5,
                missCount: 0,
                cooldownMS: getDefaultCooldown(lv)
            };
        }
        return aiMemory[levelKey];
    }

    function getGameRadius(w, trueLv) {
        let levelKey = trueLv.toString();
        let savedFactors = {};
        try { savedFactors = GM_getValue("myFactors") || {}; } catch(e){}
        let factor = parseFloat(savedFactors[levelKey]);
        if (isNaN(factor)) factor = getDefaultFactor(trueLv);
        return (w / 2) * 2.8 * factor;
    }

    function getPredictiveSwingAngle(trueLv, pInst, tInst, vX, vY, currentDist, myRadius, isOrbiting) {
        const params = getLevelParams(trueLv);
        let activeTicks = params.predictionTicks;

        if (isOrbiting) {
            activeTicks = 0.6;
        } else if (currentDist < myRadius * 0.70) {
            activeTicks = 0.1;
        }

        let futureX = tInst.x + (vX * activeTicks);
        let futureY = tInst.y + (vY * activeTicks);

        let dx = futureX - pInst.x;
        let dy = futureY - pInst.y;
        return Math.atan2(dy, dx) + (params.degreesBuffer * Math.PI / 180);
    }

    function hackRuntimeRender(runtime) {
        if (!runtime || runtime.DrawInstance_Hooked) return;
        runtime.DrawInstance_Hooked = true;
        const originalDraw = runtime.draw_instance || runtime.DrawInstance;
        if (typeof originalDraw === 'function') {
            const hookFunction = function(inst) {
                if (me && inst && inst.uid === me.uid && isFlicking && Date.now() < flickExpiryTime) {
                    inst.angle = visualLockedAngle;
                    if (inst.instvars) inst.instvars[2] = visualLockedAngle;
                }
                return originalDraw.apply(this, arguments);
            };
            if (runtime.draw_instance) runtime.draw_instance = hookFunction;
            else if (runtime.DrawInstance) runtime.DrawInstance = hookFunction;
        }
    }

    function performPerfectChop(runtime, targetInst, trueLv, vX, vY, currentDist, myRadius, isOrbiting) {
        let now = Date.now();
        const params = getLevelParams(trueLv);
        if (now - lastAttackTime < params.cooldownMS) return;
        if (me.instvars && (me.instvars[4] === 1 || me.instvars[6] === 1)) return;

        lastAttackTime = now;

        visualLockedAngle = me.instvars ? me.instvars[2] : me.angle;
        isFlicking = true;
        flickExpiryTime = Date.now() + 120;

        let myShift = getHitboxShift(me.width);
        let myCenterX = me.x + Math.cos(me.angle) * myShift;
        let myCenterY = me.y + Math.sin(me.angle) * myShift;

        let paramsInst = { x: myCenterX, y: myCenterY };
        const angle = getPredictiveSwingAngle(trueLv, paramsInst, targetInst, vX, vY, currentDist, myRadius, isOrbiting);

        const screenCenterX = window.innerWidth / 2;
        const screenCenterY = window.innerHeight / 2;
        const fakeMouseX = screenCenterX + Math.cos(angle) * 250;
        const fakeMouseY = screenCenterY + Math.sin(angle) * 250;

        const oldMouseX = runtime.mouseX; const oldMouseY = runtime.mouseY;
        const oldMousex = runtime.mousex; const oldMousey = runtime.mousey;

        runtime.mouseX = fakeMouseX; runtime.mouseY = fakeMouseY;
        runtime.mousex = fakeMouseX; runtime.mousey = fakeMouseY;

        if (runtime.types_by_index) {
            runtime.types_by_index.forEach(t => {
                t.instances?.forEach(inst => {
                    if (typeof inst.mouseX !== 'undefined') inst.mouseX = fakeMouseX;
                    if (typeof inst.mouseY !== 'undefined') inst.mouseY = fakeMouseY;
                });
            });
        }

        me.angle = angle;
        if (me.instvars) {
            me.instvars[2] = visualLockedAngle;
            me.instvars[3] = angle;
            me.instvars[4] = 1;
        }

        const gameCanvas = runtime.canvas || document.getElementById('canvas') || document.body;
        const eventOptions = { clientX: fakeMouseX, clientY: fakeMouseY, bubbles: true, button: 0, buttons: 1 };

        gameCanvas.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
        gameCanvas.dispatchEvent(new MouseEvent('mousedown', eventOptions));
        gameCanvas.dispatchEvent(new PointerEvent('pointerup', eventOptions));
        gameCanvas.dispatchEvent(new MouseEvent('mouseup', eventOptions));

        runtime.mouseX = oldMouseX; runtime.mouseY = oldMouseY;
        runtime.mousex = oldMousex; runtime.mousey = oldMousey;
    }

    function hookEngineTick() {
        if (!rt || rt.BotHooked) return;
        rt.BotHooked = true;

        const originalTick = rt.tick || rt.Tick;
        const newTick = function() {
            try { botLogicLoop(this); } catch(e) {}
            return originalTick.apply(this, arguments);
        };

        if (rt.tick) rt.tick = newTick;
        else if (rt.Tick) rt.Tick = newTick;
    }

    function botLogicLoop(runtime) {
        if (cachedPlayerTypes.length === 0 && runtime.types_by_index) {
            cachedPlayerTypes = runtime.types_by_index.filter(t => t.instvar_sids?.length > 40);
        }
        if (cachedPlayerTypes.length === 0) return;

        me = null;
        for (let t of cachedPlayerTypes) {
            if (t.instances) {
                let found = t.instances.find(i => Math.abs(i.x - runtime.running_layout.scrollX) < 1.5 && Math.abs(i.y - runtime.running_layout.scrollY) < 1.5);
                if (found) { me = found; break; }
            }
        }

        if (config.quickRespawn && !me) runtime.timescale = config.respawnSpeed;
        else if (runtime.timescale !== 1) runtime.timescale = 1;

        if (!me) return;

        let myTrueLevel = getTrueLevel(me);
        let pParams = getLevelParams(myTrueLevel);

        if (isFlicking) {
            const now = Date.now();
            const isStillSwinging = me.instvars && (me.instvars[4] === 1 || me.instvars[6] === 1);
            if (isStillSwinging && now >= flickExpiryTime) flickExpiryTime = now + 16;
            if (now < flickExpiryTime) {
                me.angle = visualLockedAngle;
                if (me.instvars) me.instvars[2] = visualLockedAngle;
            } else {
                isFlicking = false;
            }
        }

        const isWeaponReady = (Date.now() - lastAttackTime >= pParams.cooldownMS);
        const myRadiusGame = getGameRadius(me.width, myTrueLevel);

        let myShift = getHitboxShift(me.width);
        let myCenterX = me.x + Math.cos(me.angle) * myShift;
        let myCenterY = me.y + Math.sin(me.angle) * myShift;

        let targetData = null;
        const currentUids = new Set();
        let closestCalculatedDist = Infinity;
        let isTargetOrbiting = false;
        let finalTargetInstance = null;

        cachedPlayerTypes.forEach(t => {
            t.instances?.forEach(obj => {
                if (obj.uid === me.uid || obj.width <= 30 || isTeammate(me, obj)) return;

                let objShift = getHitboxShift(obj.width);
                let objCenterX = obj.x + Math.cos(obj.angle) * objShift;
                let objCenterY = obj.y + Math.sin(obj.angle) * objShift;

                let distGame = Math.hypot(objCenterX - myCenterX, objCenterY - myCenterY);
                if (obj.instvars && (obj.instvars[4] === 1 || obj.instvars[6] === 1)) return;

                currentUids.add(obj.uid);

                if (!targetHistory.has(obj.uid)) targetHistory.set(obj.uid, []);
                let history = targetHistory.get(obj.uid);
                history.push({ x: obj.x, y: obj.y, angle: obj.angle, t: Date.now() });
                if (history.length > 5) history.shift();

                let vX = 0, vY = 0; let orbitDetect = false;
                if (history.length > 1) {
                    let first = history[0]; let last = history[history.length - 1];
                    let dt = (last.t - first.t) / 16.66;
                    if (dt > 0) { vX = (last.x - first.x) / dt; vY = (last.y - first.y) / dt; }

                    let angleChangeSum = 0;
                    for (let i = 1; i < history.length; i++) {
                        let diff = Math.abs(history[i].angle - history[i-1].angle);
                        if (diff > Math.PI) diff = 2 * Math.PI - diff;
                        angleChangeSum += diff;
                    }
                    if (angleChangeSum > 0.5) orbitDetect = true;
                }

                const enemyHitboxRadiusGame = (obj.width / 2) * liveHitboxScale;
                const fastActivationDistanceGame = (myRadiusGame + enemyHitboxRadiusGame) * config.pingBuffer;

                if (distGame <= fastActivationDistanceGame && distGame < closestCalculatedDist) {
                    closestCalculatedDist = distGame;
                    targetData = { uid: obj.uid, vX: vX, vY: vY, dist: distGame };
                    isTargetOrbiting = orbitDetect;
                    finalTargetInstance = obj;
                }
            });
        });

        for (let key of targetHistory.keys()) {
            if (!currentUids.has(key)) targetHistory.delete(key);
        }

        if (targetData && config.isEnabled && isWeaponReady && finalTargetInstance) {
            performPerfectChop(runtime, finalTargetInstance, myTrueLevel, targetData.vX, targetData.vY, targetData.dist, myRadiusGame, isTargetOrbiting);
        }
    }

    function gameToScreen(x, y, layer) {
        if (layer && typeof layer.layerToCanvas === 'function') {
            return { x: layer.layerToCanvas(x, y, true), y: layer.layerToCanvas(x, y, false) };
        }
        const scaleX = layer ? layer.getScale() : 1;
        return {
            x: ((x - rt.running_layout.scrollX) * scaleX) + (window.innerWidth / 2),
            y: ((y - rt.running_layout.scrollY) * scaleX) + (window.innerHeight / 2)
        };
    }

    // ==========================================
    // KHÔNG GIAN RENDER CANVAS CHUẨN MẢNH 0.5
    // ==========================================
    function drawVisuals() {
        requestAnimationFrame(drawVisuals);
        if (!me || !rt) return;

        if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) {
            canvas.width = window.innerWidth; canvas.height = window.innerHeight;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const scale = me.layer ? me.layer.getScale() : 1;
        let drawScale = rt.canvas ? (rt.canvas.clientWidth / rt.canvas.width || 1) : 1;

        let myTrueLevel = getTrueLevel(me);
        let pParams = getLevelParams(myTrueLevel);
        const myRadiusGame = getGameRadius(me.width, myTrueLevel);
        const myRadiusScreen = myRadiusGame * scale * drawScale;

        let myShift = getHitboxShift(me.width);
        let myCenterX = me.x + Math.cos(me.angle) * myShift;
        let myCenterY = me.y + Math.sin(me.angle) * myShift;

        const myHitboxRadiusScreen = (me.width / 2) * scale * liveHitboxScale * drawScale;
        const myScreenPos = gameToScreen(myCenterX, myCenterY, me.layer);

        const isWeaponReady = (Date.now() - lastAttackTime >= pParams.cooldownMS);

        cachedPlayerTypes.forEach(t => {
            t.instances?.forEach(obj => {
                if (obj.uid === me.uid || obj.width <= 30 || isTeammate(me, obj)) return;

                let objShift = getHitboxShift(obj.width);
                let objCenterX = obj.x + Math.cos(obj.angle) * objShift;
                let objCenterY = obj.y + Math.sin(obj.angle) * objShift;

                const enemyHitboxRadiusScreen = (obj.width / 2) * scale * liveHitboxScale * drawScale;
                const enemyScreenPos = gameToScreen(objCenterX, objCenterY, obj.layer || me.layer);

                if (config.showEnemyRadius && !isNaN(enemyScreenPos.x)) {
                    const enemySwordRadiusGame = getGameRadius(obj.width, getTrueLevel(obj));
                    const enemySwordRadiusScreen = enemySwordRadiusGame * scale * drawScale;

                    ctx.lineWidth = config.WIDTH;

                    ctx.beginPath(); ctx.arc(enemyScreenPos.x, enemyScreenPos.y, enemySwordRadiusScreen, 0, Math.PI * 2); ctx.strokeStyle = config.ENEMY_SWORD; ctx.stroke();

                    // Vòng Hitbox địch
                    ctx.beginPath(); ctx.arc(enemyScreenPos.x, enemyScreenPos.y, enemyHitboxRadiusScreen, 0, Math.PI * 2); ctx.strokeStyle = config.HITBOX_COLOR; ctx.stroke();
                }
            });
        });

        if (config.showMyRadius && !isNaN(myScreenPos.x)) {
            ctx.lineWidth = config.WIDTH;

            const myRealScreenPos = gameToScreen(me.x, me.y, me.layer);
            ctx.beginPath(); ctx.arc(myRealScreenPos.x, myRealScreenPos.y, myRadiusScreen, 0, Math.PI * 2); ctx.setLineDash([12, 8]);
            ctx.strokeStyle = !config.isEnabled ? config.BORDER_OFF : (!isWeaponReady ? config.BORDER_ON : config.COLLISION);
            ctx.stroke(); ctx.setLineDash([]);

            // Vòng Xanh Neon: Mặc định gốc ban đầu 0.85
            ctx.beginPath(); ctx.arc(myScreenPos.x, myScreenPos.y, myHitboxRadiusScreen, 0, Math.PI * 2);
            ctx.strokeStyle = config.MY_HITBOX_COLOR;
            ctx.stroke();

            ctx.fillStyle = "#ffffff"; ctx.font = "bold 13px Arial"; ctx.shadowBlur = 4; ctx.shadowColor = "black";
            ctx.fillText([Ai Cấp ${myTrueLevel}] Góc (Phím 1/2): ${pParams.degreesBuffer.toFixed(1)}° | Đón Ticks: ${pParams.predictionTicks.toFixed(2)}, 30, window.innerHeight - 70);
            ctx.fillText([Thủ công] Tầm chém (P/O): ${myRadiusGame.toFixed(1)} | Hệ số Hitbox Gốc (C/V): ${liveHitboxScale.toFixed(2)}, 30, window.innerHeight - 50);
            ctx.fillText([Hệ thống] Hồi sinh nhanh (T): ${config.quickRespawn ? "BẬT" : "TẮT"} (${config.respawnSpeed}x) | Bù Ping: ${config.pingBuffer.toFixed(2)}x, 30, window.innerHeight - 30);
            ctx.shadowBlur = 0;
        }
    }

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

    window.addEventListener('keydown', (e) => {
        let key = e.key.toLowerCase();
        let trueLv = me ? getTrueLevel(me) : 1;
        let levelKey = trueLv.toString();

        if (key === 'u') { config.isEnabled = !config.isEnabled; showToast("Bot Auto Chém: " + (config.isEnabled ? "BẬT (ON)" : "TẮT (OFF)")); }
        if (key === 'q') { config.showMyRadius = !config.showMyRadius; showToast("Vòng chém bản thân: " + (config.showMyRadius ? "HIỆN" : "ẨN")); }
        if (key === 'e') { config.showEnemyRadius = !config.showEnemyRadius; showToast("Vòng tầm đánh địch: " + (config.showEnemyRadius ? "HIỆN" : "ẨN")); }
        if (key === 't') { config.quickRespawn = !config.quickRespawn; showToast("Hồi sinh nhanh: " + (config.quickRespawn ? "BẬT" : "TẮT")); }
        if (['g', 'b'].includes(key)) {
            config.respawnSpeed += (key === 'g' ? 5.0 : -5.0);
            config.respawnSpeed = Math.max(1.0, Math.min(100.0, config.respawnSpeed));
            GM_setValue("evo_respawnSpeed", config.respawnSpeed);
            showToast(Tốc độ Hồi sinh: ${config.respawnSpeed}x);
        }
        if (key === '[' || key === ']') {
            config.pingBuffer += (key === ']' ? 0.01 : -0.01);
            config.pingBuffer = Math.max(1.00, Math.min(1.20, config.pingBuffer));
            GM_setValue("evo_pingBuffer", config.pingBuffer);
            showToast(Hệ số Bù Ping: ${config.pingBuffer.toFixed(2)}x);
        }
        if (key === '1' || key === '2') {
            let p = getLevelParams(trueLv);
            p.degreesBuffer += (key === '1' ? 1.0 : -1.0);
            p.degreesBuffer = Math.max(45, Math.min(180, p.degreesBuffer)); // Đã nới rộng giới hạn min max góc
            GM_setValue("ai_bot_memory", aiMemory);
            showToast([Cấp ${trueLv}] Góc bù chém: ${p.degreesBuffer.toFixed(1)}°);
        }
        if (['p', 'o'].includes(key)) {
            let savedFactors = {};
            try { savedFactors = GM_getValue("myFactors") || {}; } catch(e){}
            let currentFactor = parseFloat(savedFactors[levelKey]);
            if (isNaN(currentFactor)) currentFactor = getDefaultFactor(trueLv);

            currentFactor = (currentFactor + (key === 'p' ? 0.02 : -0.02));
            savedFactors[levelKey] = currentFactor.toFixed(3);
            GM_setValue("myFactors", savedFactors);
            showToast([Cấp ${trueLv}] Tầm chém (Radius): ${currentFactor.toFixed(2)});
        }
        if (['c', 'v'].includes(key)) {
            liveHitboxScale += (key === 'c' ? 0.01 : -0.01);
            if (liveHitboxScale < 0.50) liveHitboxScale = 0.50;
            GM_setValue("myHitboxScale", liveHitboxScale.toFixed(2));
            showToast([Hệ thống] Thay đổi Hitbox Chung: ${liveHitboxScale.toFixed(2)});
        }
        if (['m', 'n'].includes(key)) {
            let p = getLevelParams(trueLv);
            p.cooldownMS += (key === 'm' ? 10 : -10);
            p.cooldownMS = Math.max(100, Math.min(1000, p.cooldownMS));
            GM_setValue("ai_bot_memory", aiMemory);
            showToast([Cấp ${trueLv}] Hồi kiếm: ${p.cooldownMS}ms);
        }
        if (key === 'l') { aiMemory = {}; GM_setValue("ai_bot_memory", {}); GM_setValue("myFactors", {}); showToast("Đã Dọn Sạch Bộ Nhớ!"); }
    });

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

    canvas = document.createElement('canvas'); ctx = canvas.getContext('2d');
    canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:999999;';
    document.body.appendChild(canvas);

    setTimeout(init, 1000);
})();