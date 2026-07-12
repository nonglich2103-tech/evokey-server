// ==UserScript==
// @name         Auto chém v2
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Bản sửa lỗi khoảng trắng ẩn và bổ sung Canvas vẽ vòng render + Tự động lấy hệ số Factor theo cấp
// @match        *://evowars.io/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Nhận diện cấp độ chính xác từ dữ liệu game
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

    const config = {
        isEnabled: false,
        showMyRadius: true,
        showEnemyRadius: true,
        pingBuffer: 1.01,
        BORDER_OFF: "#ff0000",
        BORDER_ON: "#00ff00",
        COLLISION: "#FFD700",
        HITBOX_COLOR: "#FF0000",
        ENEMY_SWORD: "rgba(255, 0, 0, 0.25)",
        WIDTH: 1.5
    };

    let liveHitboxScale = parseFloat(GM_getValue("myHitboxScale") || 0.92);
    let lastAttackTime = 0;
    let rt, me, canvas, ctx;

    const targetHistory = new Map();
    let cachedPlayerTypes = [];

    // Danh sách hệ số Factor mặc định theo yêu cầu
    function getDefaultFactor(lv) {
        switch(lv) {
            case 1: return 1.06;
            case 2: return 1.27;
            case 3: return 1.25;
            case 4: return 1.20;
            case 5: return 1.27;
            case 6: return 1.27;
            case 7: return 1.39;
            case 8: return 1.43;
            case 9: return 1.43;
            case 10: return 1.41;
            case 11: return 1.55;
            case 12: return 1.47;
            case 13: return 1.49;
            case 14: return 1.53;
            case 15: return 1.60;
            case 16: return 1.51;
            case 17: return 1.53;
            case 18: return 1.57;
            case 19: return 1.53;
            case 20: return 1.55;
            case 21: return 1.57;
            case 22: return 1.63;
            case 23: return 1.59;
            case 24: return 1.65;
            case 25: return 1.68;
            case 26: return 1.65;
            case 27: return 1.81;
            case 28: return 1.73;
            case 29: return 1.61;
            case 30: return 1.57;
            case 31: return 1.65;
            case 32: return 1.73;
            case 33: return 1.66;
            case 34: return 1.65;
            case 35: return 1.64;
            case 36: return 1.77;
            case 37: return 1.85;
            case 38: return 2.03;
            case 39: return 2.09;
            case 40: return 2.09;
            case 41: return 2.11;
            default: return 1.15; // Dự phòng cho các cấp lớn hơn 41
        }
    }

    // Tốc độ hồi chiêu động theo nhóm cấp độ
    function getCooldownMS(lv) {
        if (lv <= 5) return 220;
        if (lv <= 15) return 260;
        if (lv <= 25) return 320;
        return 380;
    }

    // Góc bù tối ưu cố định theo phân khúc cấp độ
    function getFixedAngleBuffer(lv) {
        if ([27, 28].includes(lv)) return 122;
        if ([30, 36].includes(lv)) return 126;
        if (lv > 25) return 130;
        return 135;
    }

    // Hàm lấy tầm kiếm dựa trên bộ nhớ (hoặc lấy mặc định từ danh sách)
    function getRadius(w, scale, drawScale, trueLv) {
        let savedFactors = GM_getValue("myFactors") || {};
        let levelKey = trueLv.toString();
        let factor = parseFloat(savedFactors[levelKey] || getDefaultFactor(trueLv));
        return (w / 2) * scale * 2.8 * factor * drawScale;
    }

    // Thuật toán dự đoán hướng chạy tuyến tính
    function getPredictiveAngle(trueLv, pInst, tInst, vX, vY) {
        let predictionTicks = 3.0;

        let futureX = tInst.x + (vX * predictionTicks);
        let futureY = tInst.y + (vY * predictionTicks);

        let dx = futureX - pInst.x;
        let dy = futureY - pInst.y;
        let baseAngle = Math.atan2(dy, dx);

        let angleBuffer = getFixedAngleBuffer(trueLv);
        return baseAngle + (angleBuffer * Math.PI / 180);
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

    function performSlash(target, player, trueLv, vX, vY) {
        let now = Date.now();
        let cooldown = getCooldownMS(trueLv);
        if (now - lastAttackTime < cooldown) return;
        if (player.instvars && (player.instvars[4] === 1 || player.instvars[6] === 1)) return;
        if (target.instvars && (target.instvars[4] === 1 || target.instvars[6] === 1)) return;

        lastAttackTime = now;

        const angle = getPredictiveAngle(trueLv, player, target, vX, vY);

        const fx = (window.innerWidth/2 + Math.cos(angle) * 180) | 0;
        const fy = (window.innerHeight/2 + Math.sin(angle) * 180) | 0;
        const snap = {clientX: fx, clientY: fy, bubbles: true, button: 0};

        player.angle = angle;
        if (player.instvars) {
            player.instvars[2] = angle;
            player.instvars[3] = angle;
            player.instvars[4] = 1;
        }

        document.dispatchEvent(new MouseEvent('mousedown', snap));
        document.dispatchEvent(new MouseEvent('mouseup', snap));
    }

    // Hệ thống phím tắt điều chỉnh bộ nhớ dữ liệu U, Q, E, P, O, C, V
    window.addEventListener('keydown', (e) => {
        let key = e.key.toLowerCase();
        if (key === 'u') config.isEnabled = !config.isEnabled;
        if (key === 'q') config.showMyRadius = !config.showMyRadius;
        if (key === 'e') config.showEnemyRadius = !config.showEnemyRadius;

        // Tăng giảm cự ly tầm kiếm theo cấp độ hiện tại
        if (['p', 'o'].includes(key)) {
            let lv = me ? getTrueLevel(me) : 1;
            let levelKey = lv.toString();
            let savedFactors = GM_getValue("myFactors") || {};
            let currentFactor = parseFloat(savedFactors[levelKey] || getDefaultFactor(lv));
            savedFactors[levelKey] = (currentFactor + (key === 'p' ? 0.03 : -0.01)).toFixed(2);
            GM_setValue("myFactors", savedFactors);
        }

        // Tăng giảm tỷ lệ chính xác của vòng Hitbox địch
        if (['c', 'v'].includes(key)) {
            liveHitboxScale += (key === 'c' ? 0.02 : -0.02);
            GM_setValue("myHitboxScale", liveHitboxScale.toFixed(2));
        }
    });

    function update() {
        requestAnimationFrame(update);
        rt = typeof cr_getC2Runtime !== 'undefined' ? cr_getC2Runtime() : null;
        if (!rt?.running_layout) return;

        if (cachedPlayerTypes.length === 0 && rt.types_by_index) {
            cachedPlayerTypes = rt.types_by_index.filter(t => t.instvar_sids?.length > 40);
        }
        if (cachedPlayerTypes.length === 0) return;

        me = null;
        for (let t of cachedPlayerTypes) {
            if (t.instances) {
                let found = t.instances.find(i => Math.abs(i.x - rt.running_layout.scrollX) < 1.5 && Math.abs(i.y - rt.running_layout.scrollY) < 1.5);
                if (found) { me = found; break; }
            }
        }

        if (!me) return;

        let myTrueLevel = getTrueLevel(me);
        let currentCooldown = getCooldownMS(myTrueLevel);
        const isWeaponReady = (Date.now() - lastAttackTime >= currentCooldown);

        if (!canvas) return; // Bảo vệ nếu chưa có canvas

        if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) {
            canvas.width = window.innerWidth; canvas.height = window.innerHeight;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const scale = me.layer ? me.layer.getScale() : 1;
        let drawScale = rt.canvas ? (rt.canvas.clientWidth / rt.canvas.width || 1) : 1;

        const myRadius = getRadius(me.width, scale, drawScale, myTrueLevel);
        const myScreenPos = gameToScreen(me.x, me.y, me.layer);

        let bestTarget = null;
        const currentUids = new Set();
        let closestDist = Infinity;
        let targetVelocity = { x: 0, y: 0 };

        cachedPlayerTypes.forEach(t => {
            t.instances?.forEach(obj => {
                if (obj.uid === me.uid || obj.width <= 30 || isTeammate(me, obj)) return;
                if (obj.instvars && (obj.instvars[4] === 1 || obj.instvars[6] === 1)) return;

                currentUids.add(obj.uid);

                if (!targetHistory.has(obj.uid)) targetHistory.set(obj.uid, []);
                let history = targetHistory.get(obj.uid);
                history.push({ x: obj.x, y: obj.y, t: Date.now() });
                if (history.length > 4) history.shift();

                const enemyTrueLv = getTrueLevel(obj);
                const enemyHitboxRadius = (obj.width / 2) * scale * liveHitboxScale * drawScale;

                const enemyScreenPos = gameToScreen(obj.x, obj.y, obj.layer || me.layer);
                const currentDist = Math.hypot(enemyScreenPos.x - myScreenPos.x, enemyScreenPos.y - myScreenPos.y);

                let vX = 0, vY = 0;
                if (history.length > 1) {
                    let first = history[0]; let last = history[history.length - 1];
                    let dt = (last.t - first.t) / 16.66;
                    if (dt > 0) { vX = (last.x - first.x) / dt; vY = (last.y - first.y) / dt; }
                }

                const activationDistance = (myRadius + enemyHitboxRadius) * config.pingBuffer;

                if (currentDist <= activationDistance && currentDist < closestDist) {
                    closestDist = currentDist;
                    bestTarget = obj;
                    targetVelocity = { x: vX, y: vY };
                }

                if (config.showEnemyRadius && !isNaN(enemyScreenPos.x)) {
                    const enemySwordRadius = getRadius(obj.width, scale, drawScale, enemyTrueLv);
                    ctx.lineWidth = config.WIDTH;
                    ctx.beginPath(); ctx.arc(enemyScreenPos.x, enemyScreenPos.y, enemySwordRadius, 0, Math.PI * 2); ctx.strokeStyle = config.ENEMY_SWORD; ctx.stroke();
                    ctx.beginPath(); ctx.arc(enemyScreenPos.x, enemyScreenPos.y, enemyHitboxRadius, 0, Math.PI * 2); ctx.strokeStyle = config.HITBOX_COLOR; ctx.stroke();
                }
            });
        });

        for (let key of targetHistory.keys()) {
            if (!currentUids.has(key)) targetHistory.delete(key);
        }

        if (bestTarget && config.isEnabled && isWeaponReady) {
            performSlash(bestTarget, me, myTrueLevel, targetVelocity.x, targetVelocity.y);
        }

        if (config.showMyRadius && !isNaN(myScreenPos.x)) {
            let savedFactors = GM_getValue("myFactors") || {};
            let currentFactor = parseFloat(savedFactors[myTrueLevel.toString()] || getDefaultFactor(myTrueLevel));

            ctx.lineWidth = config.WIDTH;
            ctx.beginPath(); ctx.arc(myScreenPos.x, myScreenPos.y, myRadius, 0, Math.PI * 2); ctx.setLineDash([8, 6]);
            ctx.strokeStyle = !config.isEnabled ? config.BORDER_OFF : (!isWeaponReady ? config.BORDER_ON : (bestTarget ? config.COLLISION : config.BORDER_ON));
            ctx.stroke(); ctx.setLineDash([]);

            ctx.fillStyle = "#ffffff"; ctx.font = "bold 12px Arial"; ctx.shadowBlur = 3; ctx.shadowColor = "black";
            ctx.fillText(`[Auto Chém] U: Bật/Tắt (${config.isEnabled ? "BẬT" : "TẮT"}) | Q/E: Ẩn hiện vòng`, 30, window.innerHeight - 70);
            ctx.fillText(`[Cấp: ${myTrueLevel}] Hệ số tầm đánh (P/O): ${currentFactor.toFixed(2)}`, 30, window.innerHeight - 50);
            ctx.fillText(`Tỷ lệ Hitbox địch (C/V): ${parseFloat(liveHitboxScale).toFixed(2)}`, 30, window.innerHeight - 30);
            ctx.shadowBlur = 0;
        }
    }

    // Bộ khởi tạo lớp phủ vẽ đè (Canvas Setup) tránh lỗi không hiển thị
    setTimeout(() => {
        canvas = document.createElement('canvas');
        canvas.style.position = 'fixed';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.pointerEvents = 'none'; // Không cản trở click chuột vào game
        canvas.style.zIndex = '99999';       // Luôn nổi lên trên cùng
        document.body.appendChild(canvas);
        ctx = canvas.getContext('2d');

        update();
    }, 1000);
})();
