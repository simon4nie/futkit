// ==UserScript==
// @name         EA FC 26 金银特技批量进化工具
// @namespace    futkit
// @version      1.0.3
// @description  EA FC 26 — 批量金银特技进化 (下拉多选 + 分组模板 + 个人微调)
// @author       PolarSpark
// @match        https://www.ea.com/ea-sports-fc/ultimate-team/web-app/*
// @match        https://www.easports.com/*/ea-sports-fc/ultimate-team/web-app/*
// @match        https://www.ea.com/*/ea-sports-fc/ultimate-team/web-app/*
// Vercel部署
// @downloadURL  https://futkit-kohl.vercel.app/scripts/ea_evo_batch.user.js
// @updateURL    https://futkit-kohl.vercel.app/scripts/ea_evo_batch.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      utas.mob.v5.prd.futc-ext.gcp.ea.com
// @run-at       document-end
// ==/UserScript==

(function () {
    "use strict";

    // ═══════════════ CONSTANTS ═══════════════
    var EA = "https://utas.mob.v5.prd.futc-ext.gcp.ea.com";
    var GAME = "/ut/game/fc26";
    var EXEC_INTERVAL_MIN = 2000, EXEC_INTERVAL_MAX = 6000;
    var MAX_RETRIES = 3;
    var MAX_GOLD = 3, MAX_SILVER = 8;

    function randomInterval() {
        var ms = EXEC_INTERVAL_MIN + Math.random() * (EXEC_INTERVAL_MAX - EXEC_INTERVAL_MIN);
        return Math.round(ms * 100) / 100;
    }

    var POS_GROUPS = [
        { name: "ST", label: "前锋", positions: ["ST", "CF"] },
        { name: "LW/RW/LM/RM", label: "边路", positions: ["LW", "RW", "LM", "RM"] },
        { name: "CAM", label: "前腰", positions: ["CAM"] },
        { name: "CM", label: "中前卫", positions: ["CM"] },
        { name: "CDM", label: "后腰", positions: ["CDM"] },
        { name: "CB", label: "中后卫", positions: ["CB"] },
        { name: "LB/RB", label: "边后卫", positions: ["LB", "RB", "LWB", "RWB"] },
        { name: "GK", label: "门将", positions: ["GK"] },
    ];

    var RARITY_OPTIONS = [
        { key: "rf94", label: "璀璨明星", rf: 94 },
        { key: "rf98", label: "国家骄傲", rf: 98 },
        { key: "rf109", label: "荣耀猎手", rf: 109 },
        { key: "rf30", label: "FUT生日", rf: 30 },
    ];

    var goldSlots = [];
    var silverSlots = [];
    var _traitIconBase = "";

    // Position code → abbreviation map (populated at init from page's PlayerPosition enum)
    var POS_CODE_MAP = {};

    function initPosCodeMap() {
        try {
            var uw = unsafeWindow;
            var pp = uw.PlayerPosition;
            if (pp) {
                var keys = Object.keys(pp).filter(function (k) { return isNaN(parseInt(k, 10)); });
                POS_CODE_MAP = {};
                keys.forEach(function (k) { POS_CODE_MAP[pp[k]] = k; });
            }
        } catch (e) { log("位置映射加载失败: " + e.message, "warn"); }
    }

    function posCodeToName(code) {
        return POS_CODE_MAP[code] || ("?" + code);
    }

    // ═══════════════ STATE ═══════════════
    var players = [];
    var selPlayers = new Set();
    var groupGoldPs = {};      // {posGroupName: [slotId, ...]}
    var groupSilverPs = {};    // {posGroupName: [slotId, ...]}
    var groupApplied = {};     // {posGroupName: true} — tracks "applied but not yet reset" state
    var playerGoldPs = {};     // {playerId: [slotId, ...]}
    var playerSilverPs = {};   // {playerId: [slotId, ...]}
    var activeTab = POS_GROUPS[0].name;
    var selRarities = new Set(["rf94", "rf98", "rf109", "rf30"]);
    var hideCompleted = true;
    var running = false, wasStopped = false, stopFlag = false;
    var queue = [], qi = 0;
    var completedEvo = {};     // "pid:sid" → true, tracks items already applied
    var logs = [];
    var clubPlayerCount = 0;
    var panelOpen = false;
    var dataLoaded = false;
    var allItemsCache = null;

    // Dropdown state
    var ddOpen = false;
    var ddType = null;   // 'group-gold' | 'group-silver' | 'player-{pid}-gold' | 'player-{pid}-silver'

    // ═══════════════ HELPERS ═══════════════
    function $(id) { return document.getElementById(id); }
    function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
    function ts() {
        var t = new Date();
        return t.getHours().toString().padStart(2, "0") + ":" +
            t.getMinutes().toString().padStart(2, "0") + ":" +
            t.getSeconds().toString().padStart(2, "0");
    }
    function log(msg, type) {
        type = type || "info";
        logs.push({ time: ts(), msg: msg, type: type });
        if (logs.length > 200) logs.shift();
        renderLogs();
    }
    function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function slotById(id) {
        var all = goldSlots.concat(silverSlots);
        for (var i = 0; i < all.length; i++) { if (all[i].id === id) return all[i]; }
        return null;
    }
    var allSlots = goldSlots.concat(silverSlots);

    // EA internal academy playstyle ID (301-336) → icon file ID (0-35)
    function traitIconId(internalId) { return internalId - 301; }

    function slotByTraitId(traitId) {
        for (var i = 0; i < allSlots.length; i++) { if (allSlots[i].traitId === traitId) return allSlots[i]; }
        allSlots = goldSlots.concat(silverSlots);
        for (var j = 0; j < allSlots.length; j++) { if (allSlots[j].traitId === traitId) return allSlots[j]; }
        return null;
    }

    function isGoldSlot(sid) {
        for (var i = 0; i < goldSlots.length; i++) { if (goldSlots[i].id === sid) return true; }
        return false;
    }

    // ═══════════════ PLAYER TRAIT HELPERS ═══════════════

    // EA slot names already end with + for gold, so strip trailing + before re-adding
    function traitDisplayName(slotName, isGold) {
        var name = slotName || "?";
        // Strip trailing + or ++ from EA slot names
        while (name.charAt(name.length - 1) === "+") name = name.slice(0, -1);
        return name + (isGold ? "+" : "");
    }
    function getAcademyGoldCount(player) {
        if (!player.academyAttributes) return 0;
        var count = 0;
        player.academyAttributes.forEach(function (a) { if (a.totalBonus === 2) count++; });
        return count;
    }
    function getAcademySilverCount(player) {
        if (!player.academyAttributes) return 0;
        var count = 0;
        player.academyAttributes.forEach(function (a) { if (a.totalBonus === 1) count++; });
        return count;
    }
    function getExistingTraitIds(player) {
        if (!player.academyAttributes) return [];
        return player.academyAttributes.map(function (a) { return a.id; });
    }

    function getPosGroup(player) {
        for (var i = 0; i < POS_GROUPS.length; i++) {
            if (POS_GROUPS[i].positions.indexOf(player.position) !== -1) return POS_GROUPS[i].name;
        }
        return POS_GROUPS[POS_GROUPS.length - 1].name;
    }

    function hasExistingEvo(player) {
        return player.academyAttributes && player.academyAttributes.length > 0;
    }

    // Same-card duplicate detection (same resourceId = same base card)
    function sameCardGroup(player) {
        var rid = player.resourceId;
        return players.filter(function (p) { return p.resourceId === rid; });
    }

    // Card is locked because another copy already has academy evo
    function isCardLocked(player) {
        if (hasExistingEvo(player)) return false;
        var same = sameCardGroup(player);
        return same.some(function (p) { return p.id !== player.id && hasExistingEvo(p); });
    }

    // Card is blocked because another copy is selected (and none evolved yet)
    function isCardDupBlocked(player) {
        if (hasExistingEvo(player)) return false;
        if (isCardLocked(player)) return false;
        var same = sameCardGroup(player);
        return same.some(function (p) { return p.id !== player.id && selPlayers.has(p.id); });
    }

    function getEffectiveSlots(playerId) {
        return {
            gold: playerGoldPs[playerId] || [],
            silver: playerSilverPs[playerId] || []
        };
    }

    // ═══════════════ DATA LOADING ═══════════════

    function getUtasSid() {
        try {
            var uw = unsafeWindow;
            if (uw.services && uw.services.Authentication && uw.services.Authentication.utasSession) {
                return uw.services.Authentication.utasSession.id;
            }
        } catch (e) {}
        return null;
    }

    function fetchCategorySlots(catId) {
        var sid = getUtasSid();
        if (!sid) return Promise.reject(new Error("无法获取 UT 会话令牌，请确保已登录 EA"));
        return new Promise(function (resolve, reject) {
            var allSlotsData = [];
            function loadPage(offset) {
                var url = EA + GAME + "/academy/category/" + catId + "?offset=" + offset + "&count=20&sortOrder=asc&slotStatus=NOT_STARTED";
                GM_xmlhttpRequest({
                    method: "GET", url: url, timeout: 20000,
                    headers: { "X-UT-SID": sid },
                    onload: function (r) {
                        if (r.status === 401 || r.status === 404) {
                            var newSid = getUtasSid();
                            if (newSid && newSid !== sid) {
                                log("  令牌过期，刷新后重试...", "warn");
                                sid = newSid;
                                loadPage(offset);
                                return;
                            }
                        }
                        if (r.status !== 200) {
                            log("  加载进化数据 HTTP " + r.status + ": " + (r.responseText || "").substring(0, 150), "warn");
                            if (allSlotsData.length > 0) { resolve(allSlotsData); return; }
                            reject(new Error("category " + catId + " HTTP " + r.status));
                            return;
                        }
                        try {
                            var resp = JSON.parse(r.responseText);
                            var slots = resp.slots || [];
                            var rewardCount = 0;
                            slots.forEach(function (s) {
                                if (s.numberOfRepetitions !== -1) return;
                                if (s.academyTopRewards && s.academyTopRewards.length > 0) {
                                    s.academyTopRewards.forEach(function (reward) {
                                        if (reward.maxValue !== 3 && reward.maxValue !== 8) return;
                                        allSlotsData.push({
                                            id: s.id, slotName: s.slotName,
                                            traitId: reward.value, maxValue: reward.maxValue
                                        });
                                        rewardCount++;
                                    });
                                }
                            });
                            if (slots.length >= 20) { loadPage(offset + 20); }
                            else { resolve(allSlotsData); }
                        } catch (e) {
                            log("  加载进化数据 parse: " + e.message + " | " + (r.responseText || "").substring(0, 100), "warn");
                            if (allSlotsData.length > 0) resolve(allSlotsData);
                            else reject(e);
                        }
                    },
                    onerror: function () { reject(new Error("cat " + catId + " 网络错误")); },
                    ontimeout: function () { reject(new Error("cat " + catId + " 超时")); }
                });
            }
            loadPage(0);
        });
    }

    function loadHubAndSlots() {
        log("加载进化数据...", "info");
        var sid = getUtasSid();
        return Promise.all([fetchCategorySlots(9), fetchCategorySlots(23), fetchCategorySlots(25)]).then(function (results) {
            var raw = [].concat(results[0], results[1], results[2]);

            goldSlots = [];
            silverSlots = [];
            raw.forEach(function (s) {
                if (s.maxValue === 3) goldSlots.push(s);
                else if (s.maxValue === 8) silverSlots.push(s);
            });

            var seenG = {}, seenS = {};
            goldSlots = goldSlots.filter(function (s) { if (seenG[s.id]) return false; seenG[s.id] = true; return true; });
            silverSlots = silverSlots.filter(function (s) { if (seenS[s.id]) return false; seenS[s.id] = true; return true; });
            // Sort by traitId ascending
            goldSlots.sort(function (a, b) { return a.traitId - b.traitId; });
            silverSlots.sort(function (a, b) { return a.traitId - b.traitId; });

            log("金特技加载: " + goldSlots.length + " 项", "ok");
            log("银特技加载: " + silverSlots.length + " 项", "ok");

            allSlots = goldSlots.concat(silverSlots);

            // Validate loaded config: remove stale slot IDs that don't match current slots
            var validSlotIds = {};
            allSlots.forEach(function (s) { validSlotIds[s.id] = true; });
            function cleanSlotIds(obj) {
                if (!obj) return;
                Object.keys(obj).forEach(function (key) {
                    obj[key] = obj[key].filter(function (sid) { return validSlotIds[sid]; });
                });
            }
            cleanSlotIds(groupGoldPs);
            cleanSlotIds(groupSilverPs);
            cleanSlotIds(playerGoldPs);
            cleanSlotIds(playerSilverPs);

            if (goldSlots.length === 0 && silverSlots.length === 0) {
                log("未找到任何特技进化数据", "warn");
            }
        });
    }

    function loadClubPlayers() {
        return new Promise(function (resolve, reject) {
            try {
                var uw = unsafeWindow;
                var Club = uw.services && uw.services.Club;
                var getApp = uw.getAppMain;
                if (!Club || !getApp) { reject(new Error("页面 services 尚未就绪，请刷新后重试")); return; }

                var controller = getApp().getRootViewController();
                Club.getStats().observe(controller, function _onStats(e, t) {
                    e.unobserve(controller);
                    if (!t.success) { reject(new Error("getStats 失败")); return; }

                    var playerCount = 0;
                    (t.response.stats || []).forEach(function (s) {
                        if (s.type === "players") playerCount = s.count || 0;
                    });
                    clubPlayerCount = playerCount;
                    log("俱乐部共有 " + playerCount + " 名球员", "info");

                    if (playerCount === 0) { resolve([]); return; }

                    var allItems = [];
                    var seenIds = {};
                    var PAGE_SIZE = 200;

                    function loadPage(offset) {
                        var criteria = new uw.UTSearchCriteriaDTO();
                        criteria.type = "player";
                        criteria.sortBy = "ovr";
                        criteria.sort = "desc";
                        criteria.count = PAGE_SIZE;
                        criteria.offset = offset;
                        criteria.searchAltPositions = true;

                        Club.search(criteria).observe(controller, function _onPage(p, pt) {
                            p.unobserve(controller);
                            if (pt.success && pt.response) {
                                var items = pt.response.items || pt.response.itemData || [];
                                var newCount = 0;
                                if (items.length > 0) {
                                    if (allItems.length === 0) {
                                        var f = items[0];
                                        var sd = f._staticData || {};
                                        log("  首条: id=" + f.id + " rf=" + f.rareflag + " pos=" + f.preferredPosition + " rating=" + f.rating + " name=" + (sd.name || f.name || "?"), "info");
                                    }
                                    items.forEach(function (it) {
                                        if (!seenIds[it.id]) {
                                            seenIds[it.id] = true;
                                            allItems.push(it);
                                            newCount++;
                                        }
                                    });
                                }
                                log("  第" + (offset / PAGE_SIZE + 1) + "页: " + items.length + " 条, 新增 " + newCount + " (累计 " + allItems.length + "/" + playerCount + ")", "info");
                                if (allItems.length < playerCount && offset < playerCount) {
                                    loadPage(offset + PAGE_SIZE);
                                } else {
                                    log("全部球员加载完成: " + allItems.length + " 人 (去重后)", "ok");
                                    enrichAcademyAttributes(allItems).then(function () { resolve(allItems); });
                                }
                            } else {
                                log("  第" + (offset / PAGE_SIZE + 1) + "页请求失败", "warn");
                                resolve(allItems);
                            }
                        });
                    }

                    loadPage(0);
                });
            } catch (e) {
                reject(new Error("loadClubPlayers: " + e.message));
            }
        });
    }

    function enrichAcademyAttributes(allItems) {
        var hasAA = allItems.length > 0 && allItems[0].hasOwnProperty("academyAttributes");
        if (hasAA) return Promise.resolve();

        var sid = getUtasSid();
        if (!sid) return Promise.resolve();

        return new Promise(function (resolve) {
            var PAGE_SIZE = 200;
            var allRawItems = [];

            function fetchPage(start) {
                var body = JSON.stringify({
                    count: PAGE_SIZE, start: start,
                    sortBy: "ovr", sort: "desc", type: "player",
                    searchAltPositions: true
                });
                GM_xmlhttpRequest({
                    method: "POST",
                    url: EA + GAME + "/club",
                    headers: { "Content-Type": "application/json", "X-UT-SID": sid },
                    data: body, timeout: 30000,
                    onload: function (r) {
                        if (r.status !== 200) { log("  enrich HTTP " + r.status, "warn"); finish(); return; }
                        try {
                            var resp = JSON.parse(r.responseText);
                            var items = resp.items || resp.itemData || [];
                            allRawItems = allRawItems.concat(items);
                            if (items.length >= PAGE_SIZE) {
                                fetchPage(start + PAGE_SIZE);
                            } else {
                                finish();
                            }
                        } catch (e) { log("  enrich 解析失败: " + e.message, "warn"); finish(); }
                    },
                    onerror: function () { log("  enrich 网络错误", "warn"); finish(); },
                    ontimeout: function () { log("  enrich 超时", "warn"); finish(); }
                });
            }

            function finish() {
                var aaMap = {};
                allRawItems.forEach(function (it) {
                    if (it.academyAttributes && it.academyAttributes.length > 0) {
                        aaMap[it.id] = it.academyAttributes;
                    }
                });
                var enriched = 0;
                allItems.forEach(function (it) {
                    if (aaMap[it.id]) {
                        it.academyAttributes = aaMap[it.id];
                        enriched++;
                    }
                });
                log("已补充 " + enriched + " 名球员的 已进化特技（共扫描 " + allRawItems.length + " 人）", "ok");
                resolve();
            }

            fetchPage(0);
        });
    }

    function processPlayers(allItems) {
        var rfList = [];
        selRarities.forEach(function (key) {
            RARITY_OPTIONS.forEach(function (r) { if (r.key === key) rfList.push(r.rf); });
        });
        var rfSet = new Set(rfList);

        rfList.forEach(function (rf) {
            var cnt = 0;
            allItems.forEach(function (it) { if (it.rareflag === rf) cnt++; });
        });

        var filtered = allItems.filter(function (it) { return rfSet.has(it.rareflag); });

        var posCount = {};
        POS_GROUPS.forEach(function (g) { posCount[g.name] = 0; });

        filtered.forEach(function (it) {
            var code = it.preferredPosition;
            var posName = (typeof code === "string") ? code : posCodeToName(code);
            var gp = null;
            for (var i = 0; i < POS_GROUPS.length; i++) {
                if (POS_GROUPS[i].positions.indexOf(posName) !== -1) { gp = POS_GROUPS[i].name; break; }
            }
            if (gp) posCount[gp]++;
        });
        players = filtered.map(function (it) {
            // Filter academyAttributes: exclude id=0 and id=1, sort gold (totalBonus=2) first
            var rawAttrs = it.academyAttributes || [];
            var filteredAttrs = rawAttrs.filter(function (a) { return a.id !== 0 && a.id !== 1; });
            filteredAttrs.sort(function (a, b) { return b.totalBonus - a.totalBonus; }); // gold first

            // Resolve name: try _staticData first (has name/firstName/lastName), then other fields
            var sd = it._staticData || {};
            var resolvedName = sd.name || sd.knownAs || it.displayName || it.name || it._name || it.commonName || "";
            if (!resolvedName && (sd.firstName || it.firstName)) {
                var fn = sd.firstName || it.firstName || "";
                var ln = sd.lastName || it.lastName || "";
                resolvedName = (ln + " " + fn).trim();
            }
            // Try to get guidAssetId from various sources (raw API field for EA CDN image URL)
            var guidAssetId = it.guidAssetId || it._guidAssetId || sd.guidAssetId || null;
            // Also check _staticData.assetId for non-zero value (service layer gives 0 for _assetId)
            var realAssetId = it._assetId || it.assetId;
            if ((!realAssetId || realAssetId === 0) && sd.assetId && sd.assetId !== 0) {
                realAssetId = sd.assetId;
            }

            return {
                id: it.id,
                resourceId: it.definitionId || it.resourceId,
                assetId: realAssetId,
                guidAssetId: guidAssetId,
                iconId: it.iconId || it.headshotId || it.headshotAssetId || null,
                rating: it.rating || it._rating,
                position: (typeof it.preferredPosition === "string") ? it.preferredPosition : posCodeToName(it.preferredPosition),
                rf: it.rareflag,
                academyAttributes: filteredAttrs,
                name: resolvedName,
                _staticData: it._staticData || null,
                _metaData: it._metaData || null,
                _raw: it
            };
        });

        players.sort(function (a, b) { return b.rating - a.rating; });

        var newActive = null;
        POS_GROUPS.forEach(function (g) { if (!newActive && posCount[g.name] > 0) newActive = g.name; });
        if (newActive) activeTab = newActive;

        loadPlayerNames().then(function () {
            renderAll();
            saveConfigToStorage();
        });
    }

    function loadPlayerNames() {
        var needNames = players.filter(function (p) { return !p.name || p.name === ""; });
        var needGuid = players.filter(function (p) { return !p.guidAssetId; });
        log("解析名称头像: 缺名字 " + needNames.length + " 人, 缺头像 " + needGuid.length + " 人, 总 " + players.length + " 人", "info");

        try {
            var uw = unsafeWindow;
            var repos = uw.repositories;

            // Approach 1: repos.Item.staticData — get guidAssetId + names
            if (repos && repos.Item && repos.Item.staticData && typeof repos.Item.staticData.get === "function") {
                var sdRepo = repos.Item.staticData;
                var nameCount = 0, iconCount = 0, guidCount = 0, hitCount = 0;
                players.forEach(function (p) {
                    try {
                        var d = sdRepo.get(p.resourceId) || sdRepo.get(p.id);
                        if (d) {
                            hitCount++;
                            var n = d.name || d.knownAs || "";
                            if (!n && d.firstName) n = d.lastName ? (d.lastName + " " + d.firstName) : d.firstName;
                            if (n && (!p.name || p.name === "")) { p.name = n; nameCount++; }
                            var icon = d.iconId || d.headshotId || d.headshotAssetId || d.portraitId;
                            if (icon && !p.iconId) { p.iconId = icon; iconCount++; }
                            var gid = d.guidAssetId;
                            if (gid && !p.guidAssetId) { p.guidAssetId = gid; guidCount++; }
                        }
                    } catch (e2) {}
                });
                log("  staticData: " + hitCount + " 命中, " + nameCount + " 名字, " + guidCount + " 头像", "info");
                if (nameCount >= needNames.length && needGuid.length === 0) { log("名称头像解析完成", "ok"); return Promise.resolve(); }
            }

            // Approach 2: repositories.Item.club items — try to get names from club items
            if (repos && repos.Item && repos.Item.club) {
                var clubItems = repos.Item.club.items;
                if (clubItems && typeof clubItems.values === "function") {
                    var vals = clubItems.values();
                    if (vals) {
                        var arr = [];
                        if (typeof Symbol !== "undefined" && vals[Symbol.iterator]) arr = Array.from(vals);
                        log("  club items: " + arr.length + " 条", "info");
                        if (arr.length > 0) {
                            var nameMap = {};
                            arr.forEach(function (item) {
                                var n = item.name || item._name || item.playerName || item.commonName || "";
                                if (!n && item.firstName) n = item.lastName ? (item.lastName + " " + item.firstName) : item.firstName;
                                if (n) nameMap[item.id] = n;
                            });
                            var fromPage = 0;
                            needNames.forEach(function (p) {
                                if (nameMap[p.id]) { p.name = nameMap[p.id]; fromPage++; }
                            });
                            log("  club items 匹配名字: " + fromPage + "/" + needNames.length, "info");
                            if (fromPage > 0) {
                                if (fromPage >= needNames.length) { log("名称头像解析完成(club)", "ok"); return Promise.resolve(); }
                            }
                        }
                    }
                }
            }
        } catch (e) {
            log("读取页面数据失败: " + e.message, "warn");
        }

        // Fallback: GM cache
        var cache = {};
        try { cache = JSON.parse(GM_getValue("fc-player-names-v2", "{}")); } catch (e) {}

        var fromCache = 0;
        needNames.forEach(function (p) {
            if (cache[p.resourceId]) { p.name = cache[p.resourceId]; fromCache++; }
        });
        if (fromCache >= needNames.length) {
            return Promise.resolve();
        }

        // Fallback: fut.to (may return 0 names)
        return new Promise(function (resolve) {
            GM_xmlhttpRequest({
                method: "GET",
                url: "https://api.fut.to/26/playermeta.json",
                timeout: 15000,
                onload: function (r) {
                    try {
                        var meta = JSON.parse(r.responseText);
                        var loaded = 0;
                        needNames.forEach(function (p) {
                            if (!p.name || p.name === "") {
                                var info = meta[p.resourceId];
                                if (info && info[2]) {
                                    p.name = info[2];
                                    cache[p.resourceId] = info[2];
                                    loaded++;
                                }
                            }
                        });
                        GM_setValue("fc-player-names-v2", JSON.stringify(cache));
                    } catch (e) { log("fut.to 解析失败: " + e.message, "warn"); }
                    resolve();
                },
                onerror: function () { log("fut.to 不可用", "warn"); resolve(); },
                ontimeout: function () { log("fut.to 超时", "warn"); resolve(); }
            });
        });
    }

    function showLoading() {
        var el = $("fc-batch-loading");
        if (el) el.classList.add("show");
    }
    function hideLoading() {
        var el = $("fc-batch-loading");
        if (el) el.classList.remove("show");
    }

    function doFullDataLoad() {
        if (dataLoaded) return;
        dataLoaded = true;
        showLoading();
        log("开始加载数据...", "info");

        loadHubAndSlots().then(function () {
            return loadClubPlayers();
        }).then(function (allItems) {
            allItemsCache = allItems;
            processFromCache(allItems);
        }).catch(function (e) {
            log("加载失败: " + e.message, "err");
            $("fc-batch-player-list").innerHTML = '<div class="fc-empty" style="color:#f87171">加载失败: ' + esc(e.message) + '<br>请检查网络后点击刷新重试</div>';
            dataLoaded = false;
            hideLoading();
        });
    }

    function processFromCache(allItems) {
        processPlayers(allItems);
        var validIds = {};
        players.forEach(function (p) { validIds[p.id] = true; });
        [playerGoldPs, playerSilverPs].forEach(function (store) {
            Object.keys(store).forEach(function (k) {
                if (!validIds[parseInt(k)]) delete store[k];
            });
        });
        selPlayers.forEach(function (pid) {
            if (!validIds[pid]) selPlayers.delete(pid);
        });
        var seenRid = {};
        var toRemove = [];
        selPlayers.forEach(function (pid) {
            var p = null;
            for (var i = 0; i < players.length; i++) { if (players[i].id === pid) { p = players[i]; break; } }
            if (!p || hasExistingEvo(p)) return;
            if (seenRid[p.resourceId]) { toRemove.push(pid); }
            else { seenRid[p.resourceId] = true; }
        });
        toRemove.forEach(function (pid) { selPlayers.delete(pid); });
        saveConfigToStorage();
        hideLoading();
    }

    function refilterPlayers() {
        if (!allItemsCache) { doFullDataLoad(); return; }
        processFromCache(allItemsCache);
    }

    // ═══════════════ EVOLUTION EXECUTION ═══════════════
    function applyEvo(itemId, slotId) {
        return new Promise(function (resolve, reject) {
            var sid = getUtasSid();
            if (!sid) { reject(new Error("无法获取 UT 会话令牌")); return; }
            GM_xmlhttpRequest({
                method: "POST",
                url: EA + GAME + "/academy/slots",
                headers: { "Content-Type": "application/json", "X-UT-SID": sid },
                data: JSON.stringify({ currency: null, itemId: itemId, slotId: slotId }),
                onload: function (resp) {
                    if (resp.status >= 200 && resp.status < 300) {
                        resolve();
                    } else {
                        var errText = (resp.responseText || "").substring(0, 200);
                        reject(new Error(resp.status + ": " + errText));
                    }
                },
                onerror: function () { reject(new Error("Network error")); },
                ontimeout: function () { reject(new Error("Timeout")); },
                timeout: 15000
            });
        });
    }

    async function applyEvoWithRetry(itemId, slotId) {
        for (var attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try { await applyEvo(itemId, slotId); return; }
            catch (e) {
                if (attempt >= MAX_RETRIES) throw e;
                log("  重试 " + attempt + "/" + MAX_RETRIES + "...", "warn");
                await delay(1500);
            }
        }
    }

    // ═══════════════ EXECUTION ENGINE ═══════════════
    function buildQueue() {
        queue = [];
        selPlayers.forEach(function (pid) {
            var effective = getEffectiveSlots(pid);
            effective.gold.forEach(function (sid) {
                var key = pid + ":" + sid;
                if (!completedEvo[key]) queue.push({ pid: pid, sid: sid });
            });
            effective.silver.forEach(function (sid) {
                var key = pid + ":" + sid;
                if (!completedEvo[key]) queue.push({ pid: pid, sid: sid });
            });
        });
        qi = 0;
    }

    async function runExec() {
        if (running || queue.length === 0) return;
        running = true; wasStopped = false; stopFlag = false; updateBtns();
        for (; qi < queue.length; qi++) {
            if (stopFlag) break;
            var t = queue[qi];
            var p = null;
            for (var i = 0; i < players.length; i++) { if (players[i].id === t.pid) { p = players[i]; break; } }
            var s = slotById(t.sid);
            var sn = s ? s.slotName : "ID:" + t.sid;
            var pn = (p && p.name) ? p.name : ("#" + (p ? p.resourceId : t.pid));
            renderProgress();
            try {
                await applyEvoWithRetry(t.pid, t.sid);
                completedEvo[t.pid + ":" + t.sid] = true;
                log(pn + " ← " + sn + " ✅", "ok");
            } catch (ex) {
                log(pn + " ← " + sn + " ❌ " + (ex.message || ""), "err");
            }
            renderProgress();
            if (qi < queue.length - 1 && !stopFlag) await delay(randomInterval());
        }
        if (stopFlag) {
            log("已中止 (已完成 " + qi + "/" + queue.length + ")", "warn");
            wasStopped = true;
        } else {
            log("全部完成！共 " + queue.length + " 次进化", "ok");
            queue = []; qi = 0; wasStopped = false; completedEvo = {};
        }
        running = false; stopFlag = false; updateBtns(); renderProgress();
    }

    function startExec() {
        if (wasStopped) {
            // Rebuild queue from current selections, skipping completed items
            buildQueue();
            if (queue.length === 0) { log("没有待执行的进化", "warn"); wasStopped = false; completedEvo = {}; updateBtns(); return; }
            log("继续执行 " + queue.length + " 次进化 (间隔 " + (EXEC_INTERVAL / 1000) + "s)...", "info");
            qi = 0;
            wasStopped = false;
            runExec();
            return;
        }
        completedEvo = {};
        buildQueue();
        if (queue.length === 0) { log("请先选择球员和特技", "warn"); return; }
        qi = 0;
        log("开始执行 " + queue.length + " 次进化 (间隔 " + (EXEC_INTERVAL_MIN / 1000) + "-" + (EXEC_INTERVAL_MAX / 1000) + "s 随机)...", "info");
        runExec();
    }
    function stopExec() { stopFlag = true; }

    function updateBtns() {
        var sb = $("fc-batch-btn-start");
        if (!sb) return;
        if (running) {
            sb.textContent = "⏹ 停止进化";
            sb.className = "fc-btn fc-btn-red";
        } else if (wasStopped) {
            sb.textContent = "▶ 继续进化 (" + (queue.length - qi) + " 次)";
            sb.className = "fc-btn fc-btn-primary";
        } else {
            sb.textContent = queue.length > 0 ? "▶ 执行进化 (" + queue.length + " 次)" : "▶ 执行进化";
            sb.className = "fc-btn fc-btn-primary";
        }
    }

    // ═══════════════ APPLY / CLEAR LOGIC ═══════════════
    function applyGroupToPlayers() {
        var gGold = groupGoldPs[activeTab] || [];
        var gSilver = groupSilverPs[activeTab] || [];
        var gGoldTraitIds = slotIdsToTraitIds(gGold);
        var gSilverTraitIds = slotIdsToTraitIds(gSilver);
        var applied = 0, skipped = 0;

        players.forEach(function (p) {
            if (getPosGroup(p) !== activeTab) return;

            if (!hasExistingEvo(p)) {
                playerGoldPs[p.id] = gGold.slice();
                playerSilverPs[p.id] = gSilver.slice();
                applied++;
                return;
            }

            // Gather existing trait IDs by type
            var existingGoldIds = [];
            var existingSilverIds = [];
            p.academyAttributes.forEach(function (a) {
                if (a.totalBonus === 2) existingGoldIds.push(a.id);
                else if (a.totalBonus === 1) existingSilverIds.push(a.id);
            });

            // Filter group traits: exclude traits the player already has
            var newGold = gGold.filter(function (sid) {
                var s = slotById(sid);
                return s && existingGoldIds.indexOf(s.traitId) === -1;
            });
            var newSilver = gSilver.filter(function (sid) {
                var s = slotById(sid);
                return s && existingSilverIds.indexOf(s.traitId) === -1;
            });
            var newGoldIds = slotIdsToTraitIds(newGold);
            var newSilverIds = slotIdsToTraitIds(newSilver);

            // --- Gold: subset check + count check ---
            var goldTotal = existingGoldIds.length + newGoldIds.length;
            var goldSubset = existingGoldIds.every(function (id) { return gGoldTraitIds.indexOf(id) !== -1; });
            var goldOk = gGoldTraitIds.length === 0 || (goldSubset && goldTotal <= MAX_GOLD);

            // --- Silver: subset check + count check ---
            var silverTotal = existingSilverIds.length + newSilverIds.length;
            var silverSubset = existingSilverIds.every(function (id) { return gSilverTraitIds.indexOf(id) !== -1; });
            var silverOk = gSilverTraitIds.length === 0 || (silverSubset && silverTotal <= MAX_SILVER);

            if (!goldOk && !silverOk) {
                skipped++;
                var parts = [];
                if (gGoldTraitIds.length > 0 && existingGoldIds.length > 0) {
                    var goldNames = existingGoldIds.map(function (id) {
                        var s = slotByTraitId(id);
                        return traitDisplayName(s ? s.slotName : ("ID:" + id), true);
                    }).join("/");
                    parts.push("金特技" + goldNames);
                }
                if (gSilverTraitIds.length > 0 && existingSilverIds.length > 0) {
                    var silverNames = existingSilverIds.map(function (id) {
                        var s = slotByTraitId(id);
                        return traitDisplayName(s ? s.slotName : ("ID:" + id), false);
                    }).join("/");
                    parts.push("银特技" + silverNames);
                }
                if (parts.length === 0) parts.push("不兼容的特技");
                var groupGoldNames = gGoldTraitIds.map(function (id) {
                    var s = slotByTraitId(id);
                    return traitDisplayName(s ? s.slotName : "?", true);
                }).join("/");
                var groupSilverNames = gSilverTraitIds.map(function (id) {
                    var s = slotByTraitId(id);
                    return traitDisplayName(s ? s.slotName : "?", false);
                }).join("/");
                var groupStr = [];
                if (gGoldTraitIds.length > 0) groupStr.push("金" + groupGoldNames);
                if (gSilverTraitIds.length > 0) groupStr.push("银" + groupSilverNames);
                log(p.name + " 已有" + parts.join("、") + "，无法应用分组特技" + groupStr.join("、") + "，请手动配置", "warn");
                return;
            }

            if (!goldOk) {
                var gNames = existingGoldIds.map(function (id) { var s = slotByTraitId(id); return traitDisplayName(s ? s.slotName : ("ID:" + id), true); }).join("/");
                log(p.name + " 已有金特技" + gNames + "，与分组金特技不兼容，已跳过金特技应用", "warn");
                playerSilverPs[p.id] = newSilver;
            } else if (!silverOk) {
                var sNames = existingSilverIds.map(function (id) { var s = slotByTraitId(id); return traitDisplayName(s ? s.slotName : ("ID:" + id), false); }).join("/");
                log(p.name + " 已有银特技" + sNames + "，与分组银特技不兼容，已跳过银特技应用", "warn");
                playerGoldPs[p.id] = newGold;
            } else {
                playerGoldPs[p.id] = newGold;
                playerSilverPs[p.id] = newSilver;
            }
            applied++;
        });

        saveConfigToStorage();
        groupApplied[activeTab] = true;
        if (skipped > 0) {
            log("已应用分组模板到 " + applied + " 名球员 (" + skipped + " 名无法应用)", "ok");
        } else {
            log("已应用分组模板到 " + applied + " 名球员", "ok");
        }
        renderPlayerList();
        renderSummary();
    }

    function clearGroupFromPlayers() {
        var cleared = 0;
        players.forEach(function (p) {
            if (getPosGroup(p) !== activeTab) return;
            var hadAny = (playerGoldPs[p.id] && playerGoldPs[p.id].length > 0) ||
                         (playerSilverPs[p.id] && playerSilverPs[p.id].length > 0);
            if (hadAny) cleared++;
            playerGoldPs[p.id] = [];
            playerSilverPs[p.id] = [];
        });
        saveConfigToStorage();
        groupApplied[activeTab] = false;
        log("已重置 " + cleared + " 名球员的个人特技配置 (已有进化特技不受影响)", "ok");
        renderPlayerList();
        renderSummary();
    }

    // ═══════════════ DROPDOWN COMPONENT ═══════════════

    // Convert slot IDs to trait IDs
    function slotIdsToTraitIds(sids) {
        var result = [];
        sids.forEach(function (sid) {
            var s = slotById(sid);
            if (s) result.push(s.traitId);
        });
        return result;
    }

    function getDropdownInfo() {
        if (ddType === "group-gold") {
            // Silver slots that share traitId with selected gold → mutual exclusion
            var oppTraitIds = slotIdsToTraitIds(groupSilverPs[activeTab] || []);
            var exclusive = [];
            goldSlots.forEach(function (s) {
                if (oppTraitIds.indexOf(s.traitId) !== -1) exclusive.push(s.id);
            });
            return {
                slots: goldSlots,
                selected: groupGoldPs[activeTab] || [],
                locked: [],
                exclusive: exclusive,
                maxSlots: MAX_GOLD,
                label: "🏅 " + activeTab + " 金特技",
            };
        }
        if (ddType === "group-silver") {
            var oppTraitIds = slotIdsToTraitIds(groupGoldPs[activeTab] || []);
            var exclusive = [];
            silverSlots.forEach(function (s) {
                if (oppTraitIds.indexOf(s.traitId) !== -1) exclusive.push(s.id);
            });
            return {
                slots: silverSlots,
                selected: groupSilverPs[activeTab] || [],
                locked: [],
                exclusive: exclusive,
                maxSlots: MAX_SILVER,
                label: "🥈 " + activeTab + " 银特技",
            };
        }

        // Player dropdowns: ddType = 'player-{pid}-gold' or 'player-{pid}-silver'
        var m = ddType.match(/^player-(\d+)-(gold|silver)$/);
        if (!m) return null;
        var pid = parseInt(m[1]);
        var isGold = m[2] === "gold";

        var p = null;
        for (var i = 0; i < players.length; i++) { if (players[i].id === pid) { p = players[i]; break; } }
        if (!p) return null;

        var slots = isGold ? goldSlots : silverSlots;
        var maxSlots = isGold ? MAX_GOLD : MAX_SILVER;
        var existingCount = isGold ? getAcademyGoldCount(p) : getAcademySilverCount(p);
        var effectiveMax = maxSlots - existingCount;

        var selected = isGold ? (playerGoldPs[pid] || []) : (playerSilverPs[pid] || []);

        // Build locked (🔒 cannot deselect) vs exclusive (✓ mutual exclusion, cannot select):
        // - locked: same-type existing academy traits (already on the card)
        // - exclusive: opposite-type existing OR opposite-type planned (same playstyle used on other side)
        var lockedIds = [];
        var exclusiveIds = [];
        var oppPlanned = isGold ? (playerSilverPs[pid] || []) : (playerGoldPs[pid] || []);
        var oppPlannedTraitIds = slotIdsToTraitIds(oppPlanned);
        var existingGoldTraitIds = [];
        var existingSilverTraitIds = [];
        if (p.academyAttributes) {
            p.academyAttributes.forEach(function (a) {
                if (a.totalBonus === 2) existingGoldTraitIds.push(a.id);
                else existingSilverTraitIds.push(a.id);
            });
        }
        var sameTypeExisting = isGold ? existingGoldTraitIds : existingSilverTraitIds;
        var oppTypeExisting = isGold ? existingSilverTraitIds : existingGoldTraitIds;

        slots.forEach(function (s) {
            // Same-type already evolved → locked
            if (sameTypeExisting.indexOf(s.traitId) !== -1) lockedIds.push(s.id);
            // Opposite-type existing (mutual exclusion with evolved traits)
            else if (oppTypeExisting.indexOf(s.traitId) !== -1) exclusiveIds.push(s.id);
            // Opposite-type planned (mutual exclusion with new selections)
            else if (oppPlannedTraitIds.indexOf(s.traitId) !== -1) exclusiveIds.push(s.id);
        });

        var displayName = p.name || ("#" + p.resourceId);
        var icon = isGold ? "🏅" : "🥈";
        return {
            slots: slots,
            selected: selected,
            locked: lockedIds,
            exclusive: exclusiveIds,
            maxSlots: effectiveMax,
            label: icon + " " + displayName + " " + (isGold ? "金" : "银") + "特技",
        };
    }

    function openDropdown(type) {
        if (ddOpen && ddType === type) { closeDropdown(); return; }
        ddOpen = true;
        ddType = type;
        renderDropdown();
    }

    function closeDropdown() {
        ddOpen = false;
        ddType = null;
        var dd = $("fc-dd");
        if (dd) dd.style.display = "none";
        var rb = $("fc-rarity-btn");
        if (rb) rb.classList.remove("active");
        var allTriggers = document.querySelectorAll(".fc-dd-trigger");
        allTriggers.forEach(function (t) { t.classList.remove("active"); });
    }

    function renderDropdown() {
        var dd = $("fc-dd");
        if (!dd) return;

        if (!ddOpen) { dd.style.display = "none"; return; }

        var info = getDropdownInfo();
        if (!info) { closeDropdown(); return; }

        // Compute max slot name length for uniform item width
        var maxLen = 0;
        info.slots.forEach(function (s) { if (s.slotName.length > maxLen) maxLen = s.slotName.length; });
        var itemWidth = Math.max(maxLen * 9 + 30, 80); // ~9px per char + checkbox

        var h = '<div class="fc-dd-header">' + esc(info.label) +
            ' (' + info.selected.length + '/' + info.maxSlots + ')' +
            '<span class="fc-dd-close" id="fc-dd-close">✕</span></div>';
        h += '<div class="fc-dd-list">';

        if (info.slots.length === 0) {
            h += '<div class="fc-dd-empty">暂无可用特技</div>';
        } else {
            info.slots.forEach(function (s) {
                var isLocked = (info.locked || []).indexOf(s.id) !== -1;
                var isExclusive = (info.exclusive || []).indexOf(s.id) !== -1;
                var isSelected = info.selected.indexOf(s.id) !== -1;
                var isBlocked = isLocked || isExclusive;
                var atMax = !isSelected && !isBlocked && info.selected.length >= info.maxSlots;

                var cls = "fc-dd-item";
                if (isLocked) cls += " locked";
                else if (isExclusive) cls += " exclusive";
                else if (isSelected) cls += " selected";
                else if (atMax) cls += " disabled";

                h += '<div class="' + cls + '" data-sid="' + s.id + '" style="min-width:' + itemWidth + 'px">';
                h += '<span class="fc-dd-chk">';
                if (isLocked) h += "🔒";
                else if (isExclusive || isSelected) h += "✓";
                h += "</span>";
                h += '<span class="fc-dd-name">' + esc(s.slotName) + "</span>";
                h += "</div>";
            });
        }
        h += "</div>";

        dd.innerHTML = h;
        dd.style.display = "block";

        // Bind close button
        var closeBtn = $("fc-dd-close");
        if (closeBtn) closeBtn.addEventListener("click", function (e) { e.stopPropagation(); closeDropdown(); });

        // Position near the trigger button (find by data-dd type, not just .active)
        setTimeout(function () {
            var anchor = document.querySelector('[data-dd="' + ddType + '"]');
            if (!anchor) anchor = document.querySelector(".fc-dd-trigger.active");
            if (anchor) {
                var rect = anchor.getBoundingClientRect();
                var ddH = dd.offsetHeight;
                var spaceBelow = window.innerHeight - rect.bottom;
                if (spaceBelow < ddH + 8 && rect.top > ddH + 8) {
                    dd.style.top = (rect.top - ddH - 4) + "px";
                } else {
                    dd.style.top = (rect.bottom + 4) + "px";
                }
                dd.style.left = Math.min(rect.left, window.innerWidth - 260) + "px";
            }
        }, 10);
    }

    function handleDropdownClick(sid) {
        var info = getDropdownInfo();
        if (!info) return;

        // Block locked (already evolved) and exclusive (mutual exclusion) items
        if ((info.locked || []).indexOf(sid) !== -1) return;
        if ((info.exclusive || []).indexOf(sid) !== -1) return;

        var isSelected = info.selected.indexOf(sid) !== -1;
        if (!isSelected && info.selected.length >= info.maxSlots) return;

        // Determine what to update
        if (ddType === "group-gold") {
            if (!groupGoldPs[activeTab]) groupGoldPs[activeTab] = [];
            if (isSelected) {
                groupGoldPs[activeTab] = groupGoldPs[activeTab].filter(function (s) { return s !== sid; });
            } else {
                groupGoldPs[activeTab].push(sid);
            }
            saveConfigToStorage();
            renderDropdown();
            renderGroupConfig();
        } else if (ddType === "group-silver") {
            if (!groupSilverPs[activeTab]) groupSilverPs[activeTab] = [];
            if (isSelected) {
                groupSilverPs[activeTab] = groupSilverPs[activeTab].filter(function (s) { return s !== sid; });
            } else {
                groupSilverPs[activeTab].push(sid);
            }
            saveConfigToStorage();
            renderDropdown();
            renderGroupConfig();
        } else {
            // Player dropdown
            var m = ddType.match(/^player-(\d+)-(gold|silver)$/);
            if (!m) return;
            var pid = parseInt(m[1]);
            var isGold = m[2] === "gold";
            var storage = isGold ? playerGoldPs : playerSilverPs;
            if (!storage[pid]) storage[pid] = [];
            if (isSelected) {
                storage[pid] = storage[pid].filter(function (s) { return s !== sid; });
            } else {
                storage[pid].push(sid);
            }
            saveConfigToStorage();
            // Render player list FIRST, then dropdown — so the trigger exists for positioning
            renderPlayerList();
            renderSummary();
            renderGroupConfig();
            // Restore active class on the re-created trigger
            var newTrigger = document.querySelector('[data-dd="' + ddType + '"]');
            if (newTrigger) newTrigger.classList.add("active");
            renderDropdown();
        }
    }

    // ═══════════════ RENDER ═══════════════
    function renderAll() {
        renderRarityFilter();
        renderTabs();
        renderGroupConfig();
        renderPlayerList();
        renderSummary();
    }

    function renderRarityFilter() {
        var btn = $("fc-rarity-btn"); if (!btn) return;
        var count = selRarities.size;
        btn.innerHTML = '稀有度 <span class="fc-rarity-count">(' + count + ')</span> ▼';

        // Update hideCompleted chip state
        var hc = $("fc-chip-hide-completed");
        if (hc) {
            if (hideCompleted) { hc.classList.add("on"); hc.querySelector(".fc-chk").textContent = "✓"; }
            else { hc.classList.remove("on"); hc.querySelector(".fc-chk").textContent = ""; }
        }
    }

    function openRarityDropdown() {
        var dd = $("fc-dd"); if (!dd) return;
        ddOpen = true;
        ddType = "rarity";
        var btn = $("fc-rarity-btn");
        if (btn) btn.classList.add("active");

        var h = '<div class="fc-dd-title">选择稀有度</div>';
        RARITY_OPTIONS.forEach(function (r) {
            var ck = selRarities.has(r.key);
            h += '<div class="fc-dd-item' + (ck ? " on" : "") + '" data-rk="' + r.key + '">' +
                '<span class="fc-chk">' + (ck ? "✓" : "") + '</span>' + r.label + '</div>';
        });
        h += '<div class="fc-dd-actions"><button class="fc-btn fc-btn-sm fc-btn-primary" id="fc-rarity-confirm">确认</button></div>';
        dd.innerHTML = h;

        // Position dropdown near the rarity button
        var rect = btn.getBoundingClientRect();
        dd.style.top = (rect.bottom + 4) + "px";
        dd.style.left = Math.min(rect.left, window.innerWidth - 220) + "px";
        dd.style.display = "block";

        $("fc-rarity-confirm").addEventListener("click", function (e) {
            e.stopPropagation();
            closeDropdown();
            renderRarityFilter();
            refilterPlayers();
        });
    }

    function handleRarityClick(rk) {
        if (selRarities.has(rk)) selRarities.delete(rk); else selRarities.add(rk);
        saveConfigToStorage();
        // Re-render dropdown items in place
        var dd = $("fc-dd");
        if (!dd) return;
        var items = dd.querySelectorAll(".fc-dd-item");
        items.forEach(function (item) {
            var rk2 = item.getAttribute("data-rk");
            var ck = selRarities.has(rk2);
            if (ck) { item.classList.add("on"); item.querySelector(".fc-chk").textContent = "✓"; }
            else { item.classList.remove("on"); item.querySelector(".fc-chk").textContent = ""; }
        });
    }

    function tabLabel(group) {
        var label = group.label || group.name;
        if (label.length > 5) label = label.substring(0, 4) + "…";
        return label;
    }

    function renderTabs() {
        var el = $("fc-batch-tabs"); if (!el) return;
        var counts = {}, filteredCounts = {};
        POS_GROUPS.forEach(function (g) { counts[g.name] = 0; filteredCounts[g.name] = 0; });
        players.forEach(function (p) {
            var g = getPosGroup(p);
            counts[g]++;
            var full = getAcademyGoldCount(p) >= MAX_GOLD && getAcademySilverCount(p) >= MAX_SILVER;
            if (!full && !isCardLocked(p)) filteredCounts[g]++;
        });

        var h = "";
        POS_GROUPS.forEach(function (g) {
            if (counts[g.name] === 0) return;
            var isActive = activeTab === g.name;
            h += '<div class="fc-tab' + (isActive ? " active" : "") + '" data-tab="' + g.name + '" title="' + (g.label || g.name) + '">' +
                tabLabel(g) + ' (' + filteredCounts[g.name] + '/' + counts[g.name] + ')</div>';
        });
        el.innerHTML = h;
    }

    function renderGroupConfig() {
        var el = $("fc-batch-group-config"); if (!el) return;
        var gGold = groupGoldPs[activeTab] || [];
        var gSilver = groupSilverPs[activeTab] || [];

        var h = "";
        var cfgGroup = POS_GROUPS.find(function(g) { return g.name === activeTab; });
        var cfgLabel = cfgGroup ? (cfgGroup.label || cfgGroup.name) : activeTab;
        h += '<div class="fc-config-title">' + cfgLabel + ' 分组特技模板</div>';
        var hasGroupTraits = gGold.length > 0 || gSilver.length > 0;
        var hasPlayerConfigs = false;
        players.forEach(function (p) {
            if (getPosGroup(p) !== activeTab) return;
            if ((playerGoldPs[p.id] && playerGoldPs[p.id].length > 0) ||
                (playerSilverPs[p.id] && playerSilverPs[p.id].length > 0)) { hasPlayerConfigs = true; }
        });
        var isApplied = groupApplied[activeTab] || false;
        var applyDisabled = !hasGroupTraits || isApplied || running;
        var resetDisabled = (!hasPlayerConfigs && !isApplied) || running;
        var applyCls = "fc-btn fc-btn-sm " + (applyDisabled ? "fc-btn-gray" : "fc-btn-primary");
        var resetCls = "fc-btn fc-btn-sm " + (resetDisabled ? "fc-btn-gray" : "fc-btn-primary");

        // ── 分组特技区域 ──
        h += '<div class="fc-config-row">';
        h += '<div class="fc-config-col">';
        h += '<button class="fc-dd-trigger" data-dd="group-gold">金特技 (' + gGold.length + '/' + MAX_GOLD + ') ▼</button>';
        h += '</div>';
        h += '<div class="fc-config-col">';
        h += '<button class="fc-dd-trigger" data-dd="group-silver">银特技 (' + gSilver.length + '/' + MAX_SILVER + ') ▼</button>';
        h += '</div>';
        h += '<div class="fc-config-col fc-config-actions">';
        h += '<button class="' + applyCls + '" id="fc-btn-apply-group"' + (applyDisabled ? " disabled" : "") + '>应用</button>';
        h += '<button class="' + resetCls + '" id="fc-btn-clear-group"' + (resetDisabled ? " disabled" : "") + '>重置</button>';
        h += '</div>';
        h += '</div>';

        // 分组特技图标
        if (gGold.length > 0 || gSilver.length > 0) {
            h += '<div class="fc-config-chips">';
            gGold.forEach(function (sid) {
                var s = slotById(sid);
                var traitId = s ? s.traitId : null;
                if (traitId != null) {
                    var label = s ? traitDisplayName(s.slotName, true) : ("ID:" + traitId);
                    h += '<img class="fc-trait-icon" src="' + _traitIconBase + 'icontrait' + traitIconId(traitId) + '.png" title="' + esc(label) + '" data-fc-name="' + esc(label) + '" data-fc-gold="1" onerror="_fcTraitImgErr(this)">';
                }
            });
            gSilver.forEach(function (sid) {
                var s = slotById(sid);
                var traitId = s ? s.traitId : null;
                if (traitId != null) {
                    var label = s ? traitDisplayName(s.slotName, false) : ("ID:" + traitId);
                    h += '<img class="fc-trait-icon" src="' + _traitIconBase + 'basetrait' + traitIconId(traitId) + '.png" title="' + esc(label) + '" data-fc-name="' + esc(label) + '" data-fc-gold="0" onerror="_fcTraitImgErr(this)">';
                }
            });
            h += '</div>';
        }

        // ── 球员搜索区域 ──
        var groupPlayers = players.filter(function (p) { return getPosGroup(p) === activeTab; });
        var eligible = groupPlayers.filter(function (p) {
            if (getAcademyGoldCount(p) >= MAX_GOLD && getAcademySilverCount(p) >= MAX_SILVER) return false;
            if (isCardLocked(p)) return false;
            return true;
        });
        var allSelected = eligible.length > 0 && eligible.every(function (p) { return selPlayers.has(p.id); });
        var selBtnCls = "fc-btn fc-btn-sm fc-btn-gray";
        if (allSelected) selBtnCls += " fc-sel-all-on";
        h += '<div class="fc-player-toolbar">';
        h += '<input id="fc-batch-search-group" placeholder="搜索球员..." style="width:160px;padding:5px 8px;border:1px solid rgba(59,130,246,0.2);border-radius:4px;background:rgba(0,0,0,0.3);color:#ddd;font-size:11px;outline:none">';
        h += '<div class="fc-config-spacer" style="flex:1"></div>';
        h += '<button class="' + selBtnCls + '" id="fc-btn-select-all">' + (allSelected ? "✓ 全选" : "☐ 全选") + ' (' + eligible.length + ')</button>';
        h += '</div>';

        el.innerHTML = h;

        // Bind search input
        var searchEl = $("fc-batch-search-group");
        if (searchEl) searchEl.addEventListener("input", renderPlayerList);

        // Bind Apply/Clear/SelectAll buttons
        var btnApply = $("fc-btn-apply-group");
        var btnClear = $("fc-btn-clear-group");
        var btnSelectAll = $("fc-btn-select-all");
        if (btnApply && !applyDisabled) btnApply.addEventListener("click", function () { applyGroupToPlayers(); renderGroupConfig(); });
        if (btnClear && !resetDisabled) btnClear.addEventListener("click", function () { clearGroupFromPlayers(); renderGroupConfig(); });
        if (btnSelectAll) btnSelectAll.addEventListener("click", function () {
            var groupPlayers = players.filter(function (p) { return getPosGroup(p) === activeTab; });
            var eligible = groupPlayers.filter(function (p) {
                if (getAcademyGoldCount(p) >= MAX_GOLD && getAcademySilverCount(p) >= MAX_SILVER) return false;
                if (isCardLocked(p)) return false;
                return true;
            });
            // Toggle: if all eligible are selected, deselect all; otherwise select all
            var allSelected = eligible.every(function (p) { return selPlayers.has(p.id); });
            if (allSelected) {
                groupPlayers.forEach(function (p) { selPlayers.delete(p.id); });
                log("已取消全选 " + activeTab + " 分组 (" + groupPlayers.length + " 人)", "info");
            } else {
                // Select eligible players, but only one per resourceId for unevolved cards
                var seenRid = {};
                eligible.forEach(function (p) {
                    if (hasExistingEvo(p)) { selPlayers.add(p.id); return; }
                    if (seenRid[p.resourceId]) return; // Already selected one of this card
                    seenRid[p.resourceId] = true;
                    selPlayers.add(p.id);
                });
                var added = eligible.filter(function (p) { return selPlayers.has(p.id); }).length;
                log("已全选 " + activeTab + " 分组球员 (" + added + "/" + groupPlayers.length + " 人)", "info");
            }
            saveConfigToStorage();
            renderPlayerList();
            renderSummary();
            renderGroupConfig();
        });
    }

    function renderPlayerList() {
        var el = $("fc-batch-player-list"); if (!el) return;
        var q = ($("fc-batch-search-group") && $("fc-batch-search-group").value || "").toLowerCase();

        var groupPlayers = players.filter(function (p) {
            if (q && p.name && p.name.toLowerCase().indexOf(q) === -1) return false;
            return getPosGroup(p) === activeTab;
        });

        if (hideCompleted) {
            groupPlayers = groupPlayers.filter(function (p) {
                var full = getAcademyGoldCount(p) >= MAX_GOLD && getAcademySilverCount(p) >= MAX_SILVER;
                if (full) return false;
                if (isCardLocked(p)) return false;
                return true;
            });
        }

        if (groupPlayers.length === 0) {
            el.innerHTML = '<div class="fc-empty">该分组暂无球员</div>';
            return;
        }

        var h = "";
        groupPlayers.forEach(function (p, idx) {
            var ck = selPlayers.has(p.id);
            var pGold = playerGoldPs[p.id] || [];
            var pSilver = playerSilverPs[p.id] || [];
            var existingGold = getAcademyGoldCount(p);
            var existingSilver = getAcademySilverCount(p);
            var isCompleted = existingGold >= MAX_GOLD && existingSilver >= MAX_SILVER;
            var locked = isCardLocked(p);
            var dupBlocked = !locked && !isCompleted && isCardDupBlocked(p);
            var canSelect = !isCompleted && !locked && !dupBlocked;

            var displayName = p.name || ("#" + (p.resourceId || "?"));
            var cardCls = "fc-player-card";
            if (ck) cardCls += " selected";
            if (isCompleted) cardCls += " completed";
            if (locked) cardCls += " locked-card";
            if (dupBlocked) cardCls += " dup-blocked";
            var lockTitle = locked ? ' title="另一张同名卡已进化，不可再选"' : '';
            var dupTitle = dupBlocked ? ' title="同名卡已选中一张，不可同时进化多张"' : '';
            h += '<div class="' + cardCls + '" data-pid="' + p.id + '" data-cansel="' + (canSelect ? "1" : "0") + '"' + lockTitle + dupTitle + '>';

            // Row 1: checkbox + EA card view slot + name + rating + position
            h += '<div class="fc-player-main">';
            var chkCls = "fc-chk-box";
            if (!canSelect) chkCls += " fc-chk-disabled";
            if (isCompleted) chkCls += " fc-chk-completed";
            var chkText = "";
            if (isCompleted) chkText = "✓";
            else if (locked) chkText = "🔒";
            else if (dupBlocked) chkText = "⊘";
            else if (ck) chkText = "✓";
            h += '<span class="' + chkCls + '">' + chkText + '</span>';

            // Card slot for EA native card view (populated by _renderCardViews after innerHTML)
            h += '<div class="fc-card-slot" data-pidx="' + idx + '"></div>';

            h += '<span class="fc-player-name">' + esc(displayName) + '</span>';
            h += '<span class="fc-player-rating">' + (p.rating || "?") + '</span>';
            h += '<span class="fc-player-pos">' + (p.position || "?") + '</span>';
            h += '</div>';

            // Row 2: per-player gold + silver dropdowns
            h += '<div class="fc-player-dd-row">';
            h += '<button class="fc-dd-trigger fc-dd-trigger-sm" data-dd="player-' + p.id + '-gold">' +
                '🏅 金 (' + (existingGold + pGold.length) + '/' + MAX_GOLD + ') ▼</button>';
            h += '<button class="fc-dd-trigger fc-dd-trigger-sm" data-dd="player-' + p.id + '-silver">' +
                '🥈 银 (' + (existingSilver + pSilver.length) + '/' + MAX_SILVER + ') ▼</button>';
            h += '</div>';

            // Row 3: trait icons — show PNG icon, fallback to Chinese name on error
            h += '<div class="fc-player-traits">';
            if (p.academyAttributes && p.academyAttributes.length > 0) {
                p.academyAttributes.forEach(function (a) {
                    if (a.id < 100) return; // Skip non-playstyle attributes (SM, WF, etc.)
                    var isGold = a.totalBonus === 2;
                    var s = slotByTraitId(a.id);
                    var label = s ? traitDisplayName(s.slotName, isGold) : ("ID:" + a.id);
                    var prefix = isGold ? "icontrait" : "basetrait";
                    var iconId = traitIconId(a.id);
                    h += '<img class="fc-trait-icon" src="' + _traitIconBase + prefix + iconId + '.png" title="' + esc(label) + '" data-fc-name="' + esc(label) + '" data-fc-gold="' + (isGold ? "1" : "0") + '" onerror="_fcTraitImgErr(this)">';
                });
            }
            pGold.forEach(function (sid) {
                var s = slotById(sid);
                var traitId = s ? s.traitId : null;
                if (traitId != null) {
                    var label = s ? traitDisplayName(s.slotName, true) : ("ID:" + traitId);
                    h += '<img class="fc-trait-icon planned" src="' + _traitIconBase + 'icontrait' + traitIconId(traitId) + '.png" title="' + esc(label) + '" data-fc-name="' + esc(label) + '" data-fc-gold="1" onerror="_fcTraitImgErr(this)">';
                }
            });
            pSilver.forEach(function (sid) {
                var s = slotById(sid);
                var traitId = s ? s.traitId : null;
                if (traitId != null) {
                    var label = s ? s.slotName : ("ID:" + traitId);
                    h += '<img class="fc-trait-icon planned" src="' + _traitIconBase + 'basetrait' + traitIconId(traitId) + '.png" title="' + esc(label) + '" data-fc-name="' + esc(label) + '" data-fc-gold="0" onerror="_fcTraitImgErr(this)">';
                }
            });
            h += '</div></div>';
        });
        el.innerHTML = h;

        // Render EA native card views into slots
        _renderCardViews(el, groupPlayers);
    }

    // Render EA-native player card views using UTItemViewFactory.
    // Uses the same lifecycle as FCEnhancer: init → renderRestrictions=true → render(item, false).
    var _cardViewCache = {}; // playerId → view (for destroy/reuse)

    function _renderCardViews(container, groupPlayers) {
        try {
            var uw = unsafeWindow;
            var factory = uw.UTItemViewFactory;
            if (!factory || typeof factory.createSmallItem !== "function") {
                _renderCardPlaceholders(container, groupPlayers);
                return;
            }
        } catch (e) {
            _renderCardPlaceholders(container, groupPlayers);
            return;
        }

        var rendered = 0, placeholders = 0;

        for (var i = 0; i < groupPlayers.length; i++) {
            var p = groupPlayers[i];
            var slot = container.querySelector('.fc-card-slot[data-pidx="' + i + '"]');
            if (!slot) continue;

            // Reuse cached view if available
            if (_cardViewCache[p.id]) {
                var cachedView = _cardViewCache[p.id];
                try {
                    var cachedRoot = cachedView.getRootElement();
                    if (cachedRoot) {
                        slot.innerHTML = "";
                        slot.appendChild(cachedRoot);
                        rendered++;
                        continue;
                    }
                } catch(e) {}
                delete _cardViewCache[p.id];
            }

            // Create EA-native card view
            try {
                var itemData = p._raw || p;
                var view = factory.createSmallItem(itemData);
                if (!view) { _renderCardPlaceholder(slot, p); placeholders++; continue; }

                // FCEnhancer lifecycle
                view.init();
                view.renderRestrictions = true;
                view.render(itemData, false);

                // Hook renderComplete to know when canvas is ready
                var originalComplete = view.renderComplete;
                view.renderComplete = function () {
                    if (originalComplete) originalComplete.apply(this, arguments);
                    // Canvas is now rendered — mark for later verification
                    view._fcRendered = true;
                };

                // Get root element and insert into slot
                var rootEl = view.getRootElement();
                if (rootEl) {
                    _cardViewCache[p.id] = view;
                    slot.innerHTML = "";
                    slot.appendChild(rootEl);
                    rendered++;
                } else {
                    _renderCardPlaceholder(slot, p);
                    placeholders++;
                }
            } catch (e) {
                _renderCardPlaceholder(slot, p);
                placeholders++;
            }
        }

        if (rendered + placeholders > 0) {
        }
    }

    // Cleanup card view cache
    function _clearCardViewCache() {
        Object.keys(_cardViewCache).forEach(function (k) { delete _cardViewCache[k]; });
    }

    function _renderCardPlaceholders(container, groupPlayers) {
        var slots = container.querySelectorAll(".fc-card-slot");
        for (var i = 0; i < slots.length; i++) {
            var p = groupPlayers[parseInt(slots[i].dataset.pidx)];
            if (p) _renderCardPlaceholder(slots[i], p);
        }
    }

    function _renderCardPlaceholder(slot, p) {
        var rc = p.rating >= 94 ? "#f59e0b" : p.rating >= 88 ? "#1d4ed8" : p.rating >= 82 ? "#22c55e" : "#888";
        slot.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;background:linear-gradient(135deg,' + rc + '33,' + rc + '11);border-radius:6px;border:1px solid rgba(255,255,255,0.06);">' +
            '<span style="font-size:20px;font-weight:800;color:' + rc + '">' + (p.rating || "?") + '</span>' +
            '<span style="font-size:8px;font-weight:600;color:' + rc + ';opacity:0.7">' + (p.position || "?") + '</span></div>';
    }



    function renderSummary() {
        var el = $("fc-batch-summary"); if (!el) return;
        var totalEvo = 0;
        selPlayers.forEach(function (pid) {
            var effective = getEffectiveSlots(pid);
            totalEvo += effective.gold.length + effective.silver.length;
        });
        el.innerHTML = "已选 <strong>" + selPlayers.size + "</strong> 球员, 总计 <strong>" + totalEvo + "</strong> 次进化" +
            (totalEvo === 0 && selPlayers.size > 0 ? ' <span style="color:#f87171">(请使用「应用到当前分组」配置球员特技)</span>' : '');
        updateBtns();
    }

    function renderLogs() {
        var el = $("fc-batch-logs"); if (!el) return;
        var h = "";
        var start = Math.max(0, logs.length - 100);
        for (var i = start; i < logs.length; i++) {
            var l = logs[i];
            var cls = l.type === "ok" ? "ok" : l.type === "err" ? "err" : l.type === "warn" ? "warn" : "info";
            h += '<div class="fc-log-' + cls + '">' + l.time + "  " + esc(l.msg) + '</div>';
        }
        el.innerHTML = h;
        el.scrollTop = el.scrollHeight;
    }

    function renderProgress() {
        var el = $("fc-batch-progress"); if (!el) return;
        if (queue.length === 0) { el.innerHTML = ""; return; }
        var t = queue.length, d = qi, pct = t > 0 ? Math.round(d / t * 100) : 0;
        el.innerHTML = '<div class="fc-pbar"><div class="fc-pfill" style="width:' + pct + '%"></div></div>' +
            '<span class="fc-ptext">' + d + '/' + t + ' (' + pct + '%)</span>';
    }

    // ═══════════════ EVENT DELEGATION ═══════════════
    function delegate(id, selector, handler) {
        var el = $(id); if (!el) return;
        el.addEventListener("click", function (e) {
            var t = e.target.closest(selector);
            if (t && el.contains(t)) handler(t, e);
        });
    }

    // ═══════════════ PERSISTENCE ═══════════════
    function saveConfigToStorage() {
        var config = {
            groupGoldPs: groupGoldPs,
            groupSilverPs: groupSilverPs,
            playerGoldPs: playerGoldPs,
            playerSilverPs: playerSilverPs,
            selRarities: Array.from(selRarities),
            hideCompleted: hideCompleted,
            selPlayers: Array.from(selPlayers),
            groupApplied: groupApplied
        };
        GM_setValue("fc-evo-batch-config", JSON.stringify(config));
    }

    function saveConfig() {
        saveConfigToStorage();
        var config = {
            groupGoldPs: groupGoldPs,
            groupSilverPs: groupSilverPs,
            playerGoldPs: playerGoldPs,
            playerSilverPs: playerSilverPs,
            selRarities: Array.from(selRarities),
            hideCompleted: hideCompleted,
            selPlayers: Array.from(selPlayers),
            timestamp: new Date().toISOString()
        };
        var blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "fc_evo_batch_config_" + new Date().toISOString().slice(0, 10) + ".json";
        a.click();
        URL.revokeObjectURL(a.href);
        log("配置已导出 (分组模板 + 球员配置)", "ok");
    }

    function loadConfig(file) {
        var reader = new FileReader();
        reader.onload = function (e) {
            try {
                var c = JSON.parse(e.target.result);
                groupGoldPs = c.groupGoldPs || {};
                groupSilverPs = c.groupSilverPs || {};
                playerGoldPs = c.playerGoldPs || {};
                playerSilverPs = c.playerSilverPs || {};
                if (c.selRarities) selRarities = new Set(c.selRarities);
                hideCompleted = c.hasOwnProperty("hideCompleted") ? c.hideCompleted : true;
                if (c.selPlayers) selPlayers = new Set(c.selPlayers);
                saveConfigToStorage();
                renderRarityFilter();
                renderGroupConfig();
                renderPlayerList();
                renderSummary();
                log("配置已加载", "ok");
            } catch (err) { log("配置加载失败: " + err.message, "err"); }
        };
        reader.readAsText(file);
    }

    function loadConfigFromStorage() {
        try {
            var raw = GM_getValue("fc-evo-batch-config", "");
            if (!raw) return;
            var c = JSON.parse(raw);
            groupGoldPs = c.groupGoldPs || {};
            groupSilverPs = c.groupSilverPs || {};
            playerGoldPs = c.playerGoldPs || {};
            playerSilverPs = c.playerSilverPs || {};
            if (c.selRarities && c.selRarities.length > 0) selRarities = new Set(c.selRarities);
            hideCompleted = c.hasOwnProperty("hideCompleted") ? c.hideCompleted : true;
            if (c.selPlayers && c.selPlayers.length > 0) selPlayers = new Set(c.selPlayers);
            groupApplied = c.groupApplied || {};
        } catch (e) {}
    }

    // ═══════════════ PANEL BUILD ═══════════════
    function build() {
        if (document.getElementById("fc-batch-style")) return;

        initPosCodeMap();
        loadConfigFromStorage();

        _traitIconBase = "images/traits/bio/";

        // Register trait icon error fallback — shows Chinese name when PNG not available
        unsafeWindow._fcTraitImgErr = function (img) {
            var name = img.getAttribute("data-fc-name") || "?";
            var isGold = img.getAttribute("data-fc-gold") === "1";
            var cls = isGold ? "fc-tag gold" : "fc-tag silver";
            img.outerHTML = '<span class="' + cls + '" style="font-size:10px;line-height:1.4">' + name + '</span>';
        };

        var style = document.createElement("style"); style.id = "fc-batch-style";
        style.textContent = "\
#fc-batch-overlay{position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483646;background:rgba(0,0,0,0.85);display:none;align-items:center;justify-content:center;}\
#fc-batch-overlay.show{display:flex;}\
#fc-batch-panel{position:relative;width:1100px;max-width:97vw;height:720px;max-height:94vh;background:linear-gradient(180deg,#0f0f23,#1a1a2e);border-radius:12px;display:flex;flex-direction:column;font-family:Arial,sans-serif;font-size:13px;color:#e0e0e0;box-shadow:0 0 60px rgba(59,130,246,0.3),0 8px 40px rgba(0,0,0,0.6);overflow:hidden;border:1px solid rgba(59,130,246,0.25);}\
#fc-batch-header{display:flex;flex-direction:column;padding:8px 14px;border-bottom:1px solid rgba(59,130,246,0.15);flex-shrink:0;background:rgba(59,130,246,0.06);gap:6px;}.fc-header-row{display:flex;align-items:center;gap:8px;}.fc-header-spacer{flex:1;}#fc-batch-header h2{margin:0;font-size:14px;color:#93c5fd;white-space:nowrap;flex-shrink:0;}.fc-rarity-btn{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid rgba(59,130,246,0.3);border-radius:5px;background:rgba(59,130,246,0.12);color:#bfdbfe;font-size:11px;cursor:pointer;user-select:none;transition:all 0.15s;}.fc-rarity-btn:hover{background:rgba(59,130,246,0.2);border-color:rgba(59,130,246,0.5);}\
.fc-rarity-btn .fc-rarity-count{color:#f59e0b;font-weight:700;}\
.fc-wrap{display:flex;gap:3px;flex-wrap:wrap;}\
.fc-chip{display:inline-flex;align-items:center;gap:3px;padding:4px 8px;border-radius:4px;font-size:11px;cursor:pointer;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);user-select:none;transition:all 0.1s;}\
.fc-chip:hover{background:rgba(59,130,246,0.15);border-color:rgba(59,130,246,0.3);}\
.fc-chip.on{background:rgba(59,130,246,0.2);border-color:rgba(59,130,246,0.5);color:#bfdbfe;}\
.fc-chk{width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;border-radius:3px;border:1px solid rgba(255,255,255,0.2);font-size:9px;flex-shrink:0;}\
.fc-chip.on .fc-chk{background:#3b82f6;border-color:#3b82f6;color:#fff;}\
#fc-batch-body{flex:1;display:flex;overflow:hidden;}\
#fc-batch-tabs{display:flex;align-items:center;gap:4px;padding:8px 10px;border-bottom:1px solid rgba(59,130,246,0.12);overflow-x:auto;flex-shrink:0;background:rgba(0,0,0,0.15);}#fc-batch-tabs::-webkit-scrollbar{height:3px;}#fc-batch-tabs::-webkit-scrollbar-thumb{background:rgba(59,130,246,0.2);border-radius:2px;}.fc-tab{padding:5px 10px;font-size:11px;cursor:pointer;border-radius:5px;color:#888;transition:all 0.15s;user-select:none;white-space:nowrap;flex-shrink:0;border:1px solid transparent;}.fc-tab:hover{background:rgba(59,130,246,0.06);color:#ccc;}.fc-tab.active{background:rgba(59,130,246,0.12);color:#bfdbfe;font-weight:600;border-color:rgba(59,130,246,0.3);}\
#fc-batch-main{flex:1;display:flex;flex-direction:column;overflow:hidden;}\
#fc-batch-group-config{padding:10px 14px;border-bottom:1px solid rgba(59,130,246,0.1);flex-shrink:0;}\
.fc-player-toolbar{display:flex;align-items:center;gap:8px;padding:8px 0 4px;margin-top:2px;border-top:1px solid rgba(59,130,246,0.12);}\
.fc-config-title{margin-bottom:8px;font-size:12px;color:#bfdbfe;font-weight:600;}\
.fc-config-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}\
.fc-config-col{flex-shrink:0;}\
.fc-config-actions{display:flex;gap:6px;}\
.fc-config-spacer{flex:1;}\
.fc-sel-all-on{background:rgba(59,130,246,0.18);color:#bfdbfe;border-color:rgba(59,130,246,0.4);}\
.fc-config-chips{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px;}\
.fc-tag{display:inline-block;padding:2px 8px;border-radius:3px;font-size:10px;line-height:1.4;}\
.fc-tag.gold{background:rgba(245,158,11,0.15);color:#f59e0b;border:1px solid rgba(245,158,11,0.3);}\
.fc-tag.silver{background:rgba(59,130,246,0.1);color:#93c5fd;border:1px solid rgba(59,130,246,0.2);}\
#fc-batch-player-list{flex:1;overflow-y:auto;padding:8px;}\
.fc-empty{text-align:center;color:#555;padding:40px 20px;font-size:12px;}\
.fc-player-card{padding:8px 10px;border-bottom:1px solid rgba(255,255,255,0.03);cursor:pointer;transition:background 0.1s;}\
.fc-player-card:hover{background:rgba(59,130,246,0.04);}\
.fc-player-card.selected{background:rgba(59,130,246,0.08);}\
.fc-player-card.completed{opacity:0.45;}\
.fc-player-card.completed:hover{background:transparent;}\
.fc-player-card.locked-card{opacity:0.4;}\
.fc-player-card.locked-card:hover{background:transparent;}\
.fc-player-card.dup-blocked{opacity:0.5;}\
.fc-player-card.dup-blocked:hover{background:transparent;}\
.fc-player-main{display:flex;align-items:center;gap:8px;}\
.fc-chk-box{width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border-radius:3px;border:2px solid rgba(255,255,255,0.2);font-size:10px;flex-shrink:0;transition:all 0.1s;}\
.fc-chk-box.fc-chk-disabled{border-color:rgba(255,255,255,0.06);color:rgba(255,255,255,0.15);background:rgba(255,255,255,0.02);cursor:not-allowed;}\
.fc-player-card.selected .fc-chk-box{background:#3b82f6;border-color:#3b82f6;color:#fff;}\
.fc-player-card.completed .fc-chk-box{background:rgba(34,197,94,0.2);border-color:rgba(34,197,94,0.3);color:#22c55e;}\
.fc-card-slot{width:48px;height:67px;flex-shrink:0;overflow:hidden;position:relative;border-radius:4px;border:1px solid rgba(255,255,255,0.06);background:#1a1a2e;}\
.fc-card-slot .small.player.item{transform:scale(0.585);transform-origin:top left;width:82px;height:114px;}\
.fc-card-img{width:100%;height:100%;object-fit:cover;display:block;}\
.fc-card-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;font-size:20px;font-weight:800;}\
.fc-card-placeholder span:first-child{font-size:20px;font-weight:800;}\
.fc-card-placeholder span:last-child{font-size:8px;font-weight:600;}\
.fc-trait-icon{width:24px;height:24px;flex-shrink:0;}\
.fc-trait-icon.planned{opacity:0.5;}\
.fc-player-name{flex:1;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:100px;}\
.fc-player-rating{font-weight:700;color:#f59e0b;font-size:13px;min-width:24px;text-align:center;}\
.fc-player-pos{font-size:11px;color:#888;min-width:30px;text-align:center;}\
.fc-player-dd-row{padding:4px 0 0 28px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;}\
.fc-player-traits{padding:4px 0 0 28px;display:flex;align-items:center;gap:4px;flex-wrap:wrap;}\
.fc-btn{padding:6px 12px;border:none;border-radius:5px;cursor:pointer;font-size:11px;font-weight:600;user-select:none;transition:all 0.15s;}\
.fc-btn-sm{padding:4px 8px;font-size:10px;border-radius:4px;}\
.fc-btn-primary{background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:#fff;box-shadow:0 2px 8px rgba(59,130,246,0.3);}\
.fc-btn-primary:hover{transform:translateY(-1px);}\
.fc-btn-red{background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;}\
.fc-btn-gray{background:rgba(255,255,255,0.06);color:#93c5fd;border:1px solid rgba(59,130,246,0.2);}\
.fc-btn-gray:hover{background:rgba(59,130,246,0.12);}\
#fc-batch-footer{flex-shrink:0;border-top:1px solid rgba(59,130,246,0.15);}\
#fc-batch-summary{padding:8px 16px;font-size:10px;color:#666;background:rgba(59,130,246,0.04);border-bottom:1px solid rgba(59,130,246,0.08);}\
#fc-batch-summary strong{color:#e0e0e0;}\
#fc-batch-actions{padding:8px 14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;}\
#fc-batch-progress{padding:2px 14px 6px;display:flex;align-items:center;gap:8px;}\
.fc-pbar{flex:1;height:4px;background:rgba(255,255,255,0.05);border-radius:2px;overflow:hidden;}\
.fc-pfill{height:100%;background:linear-gradient(90deg,#3b82f6,#1d4ed8);border-radius:2px;transition:width 0.3s;}\
.fc-ptext{font-size:10px;color:#666;min-width:55px;text-align:right;}\
#fc-batch-logs{height:130px;overflow-y:auto;padding:8px 14px;background:rgba(0,0,0,0.25);font-family:monospace;font-size:10px;line-height:1.6;border-top:1px solid rgba(255,255,255,0.04);user-select:text;}\
.fc-log-ok{color:#34d399;}.fc-log-err{color:#f87171;}.fc-log-warn{color:#fbbf24;}.fc-log-info{color:#9ca3af;}\
#fc-batch-loading{display:none;position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:10;align-items:center;justify-content:center;flex-direction:column;gap:12px;}\
#fc-batch-loading.show{display:flex;}\
.fc-spinner{width:36px;height:36px;border:3px solid rgba(59,130,246,0.2);border-top-color:#3b82f6;border-radius:50%;animation:fc-spin 0.8s linear infinite;}\
@keyframes fc-spin{to{transform:rotate(360deg);}}\
.fc-loading-text{color:#93c5fd;font-size:13px;}\
\
/* ── Dropdown Trigger ── */\
.fc-dd-trigger{display:inline-flex;align-items:center;gap:4px;padding:6px 10px;border:1px solid rgba(59,130,246,0.25);border-radius:5px;background:rgba(0,0,0,0.3);color:#bfdbfe;font-size:11px;cursor:pointer;user-select:none;transition:all 0.15s;white-space:nowrap;}\
.fc-dd-trigger:hover{background:rgba(59,130,246,0.15);border-color:rgba(59,130,246,0.5);}\
.fc-dd-trigger.active{background:rgba(59,130,246,0.2);border-color:#3b82f6;}\
.fc-dd-trigger-sm{padding:3px 7px;font-size:10px;}\
\
/* ── Dropdown Panel ── */\
.fc-dropdown{position:fixed;z-index:2147483648;min-width:300px;max-width:620px;max-height:360px;overflow-y:auto;background:#1a1a2e;border:1px solid rgba(59,130,246,0.4);border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.7);display:none;}\
.fc-dd-header{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;font-size:11px;font-weight:600;color:#bfdbfe;border-bottom:1px solid rgba(59,130,246,0.15);position:sticky;top:0;background:#1a1a2e;z-index:1;}\
.fc-dd-close{cursor:pointer;color:#888;font-size:14px;line-height:1;padding:2px 4px;border-radius:3px;}\
.fc-dd-close:hover{color:#fff;background:rgba(255,255,255,0.1);}\
.fc-dd-list{padding:4px;display:flex;flex-wrap:wrap;}\
.fc-dd-item{display:inline-flex;align-items:center;gap:4px;padding:3px 7px;font-size:11px;cursor:pointer;user-select:none;transition:background 0.1s;border-radius:3px;white-space:nowrap;}\
.fc-dd-item:hover{background:rgba(59,130,246,0.08);}\
.fc-dd-item.selected{color:#f59e0b;}\
.fc-dd-item.locked{color:#666;cursor:not-allowed;}\
.fc-dd-item.exclusive{color:#555;cursor:not-allowed;opacity:.55;}\
.fc-dd-item.disabled{opacity:.35;cursor:not-allowed;pointer-events:none;}\
.fc-dd-item.on{color:#bfdbfe;background:rgba(59,130,246,0.12);}.fc-dd-item.on .fc-chk{background:#3b82f6;border-color:#3b82f6;color:#fff;}.fc-dd-title{font-size:12px;font-weight:600;color:#bfdbfe;padding:6px 10px;border-bottom:1px solid rgba(59,130,246,0.12);}.fc-dd-actions{display:flex;justify-content:flex-end;padding:6px 10px;border-top:1px solid rgba(59,130,246,0.12);}\
.fc-dd-chk{width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;border-radius:3px;border:1px solid rgba(255,255,255,0.15);font-size:9px;flex-shrink:0;}\
.fc-dd-item.selected .fc-dd-chk{background:#3b82f6;border-color:#3b82f6;color:#fff;}\
.fc-dd-item.locked .fc-dd-chk{border-color:rgba(255,255,255,0.05);}\
.fc-dd-item.exclusive .fc-dd-chk{border-color:rgba(255,255,255,0.06);color:rgba(255,255,255,0.2);}\
.fc-dd-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}\
.fc-dd-empty{text-align:center;color:#555;padding:16px;font-size:11px;}\
";
        document.head.appendChild(style);

        // Overlay
        var ov = document.createElement("div"); ov.id = "fc-batch-overlay";
        ov.innerHTML = '\
<div id="fc-batch-panel">\
<div id="fc-batch-loading"><div class="fc-spinner"></div><div class="fc-loading-text">数据加载中...</div></div>\
<div id="fc-batch-header">\
<div class="fc-header-row">\
<h2>FutKit-批量进化工具</h2>\
<div class="fc-header-spacer"></div>\
<button class="fc-btn fc-btn-gray fc-btn-sm" id="fc-batch-close">✕</button>\
</div>\
<div class="fc-header-row">\
<button class="fc-rarity-btn" id="fc-rarity-btn">稀有度 ▼</button>\
<label class="fc-chip on" id="fc-chip-hide-completed"><span class="fc-chk">✓</span>隐藏不可进化</label>\
</div></div>\
<div id="fc-batch-body">\
<div id="fc-batch-main">\
<div id="fc-batch-tabs"></div>\
<div id="fc-batch-group-config"></div>\
<div id="fc-batch-player-list"><div class="fc-empty">打开面板后将自动加载数据...</div></div>\
</div></div>\
<div id="fc-batch-footer">\
<div id="fc-batch-summary">等待加载...</div>\
<div id="fc-batch-progress"></div>\
<div id="fc-batch-actions">\
<button class="fc-btn fc-btn-primary" id="fc-batch-btn-start">▶ 执行进化</button>\
<button class="fc-btn fc-btn-gray fc-btn-sm" id="fc-batch-btn-copylog">📋 复制日志</button>\
</div>\
<div id="fc-batch-logs"><div style="color:#555">日志 — 脚本已加载，打开面板将自动拉取数据</div></div>\
</div></div>';
        document.body.appendChild(ov);

        // Dropdown panel (shared, appended to body for fixed positioning)
        var dd = document.createElement("div"); dd.id = "fc-dd"; dd.className = "fc-dropdown";
        document.body.appendChild(dd);

        // ── Static bindings ──
        $("fc-batch-close").addEventListener("click", function () { ov.classList.remove("show"); });
        $("fc-chip-hide-completed").addEventListener("click", function () {
            hideCompleted = !hideCompleted;
            saveConfigToStorage();
            renderRarityFilter();
            renderPlayerList();
            renderSummary();
        });
        $("fc-batch-btn-start").addEventListener("click", function () { running ? stopExec() : startExec(); });
        $("fc-batch-btn-copylog").addEventListener("click", function () {
            var text = logs.map(function (l) { return l.time + "  " + l.msg; }).join("\n");
            navigator.clipboard.writeText(text).then(function () { log("已复制", "ok"); });
        });

        // ── Close dropdown on outside click ──
        document.addEventListener("click", function (e) {
            if (!ddOpen) return;
            var trigger = e.target.closest(".fc-dd-trigger");
            var rarityBtn = e.target.closest(".fc-rarity-btn");
            var panel = e.target.closest("#fc-dd");
            if (!trigger && !rarityBtn && !panel) closeDropdown();
        });

        // ── Dropdown trigger click (global delegation) ──
        document.addEventListener("click", function (e) {
            var trigger = e.target.closest(".fc-dd-trigger");
            if (!trigger) return;
            e.stopPropagation();
            var type = trigger.getAttribute("data-dd");
            if (!type) return;

            // Remove active from all triggers
            var allTriggers = document.querySelectorAll(".fc-dd-trigger");
            allTriggers.forEach(function (t) { t.classList.remove("active"); });

            if (ddOpen && ddType === type) {
                closeDropdown();
                return;
            }

            trigger.classList.add("active");
            openDropdown(type);
        });

        // ── Dropdown item click ──
        dd.addEventListener("click", function (e) {
            var item = e.target.closest(".fc-dd-item");
            if (!item) return;
            e.stopPropagation(); // 防止 renderDropdown 重写 innerHTML 后事件冒泡触发关闭
            var sid = parseInt(item.getAttribute("data-sid"));
            if (isNaN(sid)) return;
            handleDropdownClick(sid);
        });

        // ── Event delegation within panel ──
        var rarityBtn = $("fc-rarity-btn");
        if (rarityBtn) {
            rarityBtn.addEventListener("click", function (e) {
                e.stopPropagation();
                if (ddOpen && ddType === "rarity") { closeDropdown(); return; }
                openRarityDropdown();
            });
        }

        // Handle rarity dropdown item clicks
        var ddEl = $("fc-dd");
        if (ddEl) {
            ddEl.addEventListener("click", function (e) {
                var item = e.target.closest(".fc-dd-item[data-rk]");
                if (!item) return;
                e.stopPropagation();
                handleRarityClick(item.getAttribute("data-rk"));
            });
        }

        delegate("fc-batch-tabs", ".fc-tab", function (el) {
            activeTab = el.getAttribute("data-tab");
            closeDropdown();
            renderTabs();
            renderGroupConfig();
            renderPlayerList();
        });

        delegate("fc-batch-player-list", ".fc-player-card", function (el) {
            if (el.getAttribute("data-cansel") === "0") return; // Skip locked/blocked/completed
            var pid = parseInt(el.getAttribute("data-pid"));
            if (isNaN(pid)) return;
            if (selPlayers.has(pid)) { selPlayers.delete(pid); }
            else {
                // Deselect other duplicates of the same card (same resourceId)
                var p = null;
                for (var i = 0; i < players.length; i++) { if (players[i].id === pid) { p = players[i]; break; } }
                if (p && !hasExistingEvo(p)) {
                    var same = sameCardGroup(p);
                    same.forEach(function (sp) { if (sp.id !== pid) selPlayers.delete(sp.id); });
                }
                selPlayers.add(pid);
            }
            saveConfigToStorage();
            renderPlayerList();
            renderSummary();
        });

        renderRarityFilter();
        renderTabs();
        renderGroupConfig();
        renderSummary();

        log("FutKit-批量进化工具 已就绪", "ok");

        // 匿名统计上报
        (function () {
            try {
                var uid = GM_getValue("fc-evo-uid");
                if (!uid) { uid = crypto.randomUUID(); GM_setValue("fc-evo-uid", uid); }
                fetch("https://fc-stats.polarspark.workers.dev/ping", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ u: uid, v: "2.0.0", n: "evo_batch" })
                }).catch(function () {});
            } catch (e) {}
        })();

        // ── 注入 Academy 页面按钮 ──
        injectAcademyButton();
    }

    function injectAcademyButton() {
        function tryInject() {
            // Already injected
            if (document.getElementById("fc-academy-btn")) return;

            // Find the academy hub list container
            var listEl = document.querySelector('[class*="ut-academy-hub-view--list"]');
            if (!listEl) return;

            // Create wrapper at the bottom-right of the list
            var insertParent = document.createElement("div");
            insertParent.style.cssText = "display:flex;justify-content:flex-end;width:100%;margin:12px 0;";
            listEl.appendChild(insertParent);

            // Create the button with all-inline styles (no dependency on external CSS)
            var ourBtn = document.createElement("button");
            ourBtn.id = "fc-academy-btn";
            ourBtn.type = "button";
            ourBtn.textContent = "批量进化工具";
            ourBtn.style.cssText =
                "display:inline-flex;align-items:center;justify-content:center;" +
                "height:32px;padding:0 16px;border:none;border-radius:8px;" +
                "background:linear-gradient(135deg,#3b82f6,#06b6d4);color:#fff;" +
                "font-size:13px;font-weight:600;white-space:nowrap;cursor:pointer;" +
                "box-shadow:0 2px 8px rgba(59,130,246,0.3);" +
                "transition:transform 0.15s,box-shadow 0.15s;" +
                "-webkit-tap-highlight-color:transparent;" +
                "user-select:none;outline:none;";
            insertParent.appendChild(ourBtn);

            // Hover effect
            ourBtn.addEventListener("mouseenter", function () {
                ourBtn.style.transform = "translateY(-1px)";
                ourBtn.style.boxShadow = "0 4px 14px rgba(59,130,246,0.45)";
            });
            ourBtn.addEventListener("mouseleave", function () {
                ourBtn.style.transform = "";
                ourBtn.style.boxShadow = "0 2px 8px rgba(59,130,246,0.3)";
            });

            // Click/tap handler
            function openTool() {
                var ov = $("fc-batch-overlay");
                if (ov) {
                    ov.classList.toggle("show");
                    if (ov.classList.contains("show") && !dataLoaded) {
                        setTimeout(doFullDataLoad, 300);
                    }
                }
            }
            ourBtn.addEventListener("click", openTool);
            ourBtn.addEventListener("touchend", function (e) {
                e.preventDefault();
                openTool();
            });

        }

        // Try immediately
        tryInject();

        // Watch for DOM changes (SPA navigation)
        var observer = new MutationObserver(function () {
            tryInject();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    setTimeout(build, 500);
})();
