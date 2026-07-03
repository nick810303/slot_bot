/**
 * 小泰空位儀表板 v2 — Cloudflare Worker 後端
 *
 * v2 改動：
 * 1. 老師名單不再寫死：每次從客立樂選單 API 動態解析
 *    （老師、分店歸屬、培訓新師標記、頭像網址，全部自動同步）
 * 2. 方案分「南京三民」「中山」兩分店，各自對應 120/90/60 與培訓方案
 * 3. slot 回傳多帶 staffId / branch / avatar，前端可組老師專屬預約深層連結
 * 4. 回傳 staff 名單（roster），前端老師膠囊動態生成
 */

const BOOKING_CODE     = "a33MS6uxvrwXxin2jHTk4N";
const BOOKING_API_BASE = "https://booking-api.qlieer.app";

const BRANCHES  = ["南京三民", "中山"];
const DURATIONS = [120, 90, 60];
const CACHE_TTL = 180; // 秒（3分鐘）

// ── CORS headers（GitHub Pages 需要）─────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type":                 "application/json;charset=UTF-8",
};

function jsonResp(data, ttl = 0) {
  const headers = { ...CORS };
  if (ttl > 0) headers["Cache-Control"] = `public, max-age=${ttl}`;
  return new Response(JSON.stringify(data), { headers });
}

// ── 日期工具 ──────────────────────────────────────────────────
function tpe(date) {
  const str = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
  return str.replace(", ", "T");
}

function formatDateKey(date) {
  return tpe(date).substring(0, 10); // "YYYY-MM-DD"
}

function formatTimestamp(ts) {
  const date    = new Date(ts * 1000);
  const iso     = tpe(date);
  const dateKey = iso.substring(0, 10);
  const timeStr = iso.substring(11, 16);
  return { dateKey, timeStr };
}

function dayStart(now, offsetDays) {
  const iso  = tpe(now).substring(0, 10);
  const [y, m, d] = iso.split("-").map(Number);
  const utc  = Date.UTC(y, m - 1, d + offsetDays, 0 - 8, 0, 0); // TPE = UTC+8
  return Math.floor(utc / 1000);
}

function dayEnd(now, offsetDays) {
  const iso  = tpe(now).substring(0, 10);
  const [y, m, d] = iso.split("-").map(Number);
  const utc  = Date.UTC(y, m - 1, d + offsetDays, 23 - 8, 59, 59);
  return Math.floor(utc / 1000);
}

// ── Qlieer API helpers ────────────────────────────────────────
async function getMenuData() {
  const url = `${BOOKING_API_BASE}/bookings/menu/service?code=${BOOKING_CODE}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return json.data || null;
}

async function fetchSlots(productId, userId, startTime, endTime) {
  const url = `${BOOKING_API_BASE}/bookings/duration?code=${BOOKING_CODE}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startTime, endTime,
      events: [{ productId, addOnIds: [], userId, isAssigned: true }],
      parallel: false, customerCount: 1,
    }),
  });
  if (!res.ok) return {};
  const json = await res.json();
  return json.result || {};
}

// ── 從選單動態建立「老師目錄」──────────────────────────────────
// staffId → { staffId, name, avatar, branch, isTrainee, jobs:[{productId, dur, branch}] }
function buildCatalog(menuData) {
  const users = {};
  for (const u of menuData.users || []) {
    users[u.id] = { name: (u.name || "").trim(), avatar: u.avatar || "" };
  }

  const staff = {};
  for (const p of menuData.products || []) {
    const pname = p.name || "";
    const branch = BRANCHES.find(b => pname.startsWith(b));
    if (!branch) continue;                 // 不屬於兩分店的方案跳過
    if (pname.includes("不指定")) continue; // 不指定優惠方案不用（本工具是指定老師查詢）
    if (!DURATIONS.includes(p.duration)) continue;

    const isTraineeProduct = pname.includes("培訓");

    for (const pr of p.providers || []) {
      if (!pr.isProvided) continue;
      const u = users[pr.userId];
      if (!u) continue; // 不在公開名單的人員（隱藏帳號）不列

      if (!staff[pr.userId]) {
        staff[pr.userId] = {
          staffId: pr.userId,
          name: u.name,
          avatar: u.avatar,
          branch,
          isTrainee: false,
          jobs: [],
        };
      }
      const s = staff[pr.userId];
      if (isTraineeProduct) s.isTrainee = true;
      s.jobs.push({ productId: p.id, dur: p.duration, branch });
    }
  }
  return staff;
}

function rosterFromCatalog(catalog) {
  const arr = Object.values(catalog).map(s => ({
    staffId: s.staffId,
    name: s.name,
    avatar: s.avatar,
    branch: s.branch,
    isTrainee: s.isTrainee,
  }));
  arr.sort((a, b) => {
    const bi = BRANCHES.indexOf(a.branch) - BRANCHES.indexOf(b.branch);
    if (bi !== 0) return bi;
    if (a.isTrainee !== b.isTrainee) return a.isTrainee ? 1 : -1; // 正規在前、培訓在後
    return a.name < b.name ? -1 : 1;
  });
  return arr;
}

// ── 並行抓取 ─────────────────────────────────────────────────
async function fetchSlotsForStaffList(staffList, now) {
  const startTime = dayStart(now, 0);
  const endTime   = dayEnd(now, 14);

  const tasks = [];
  const meta  = [];
  for (const s of staffList) {
    for (const job of s.jobs) {
      tasks.push(fetchSlots(job.productId, s.staffId, startTime, endTime));
      meta.push({ s, job });
    }
  }

  const results = await Promise.all(tasks);

  // Grouping：key = staffId__branch__dateKey__time
  const grouped = {};
  results.forEach((slotsData, i) => {
    const { s, job } = meta[i];
    for (const dateStr of Object.keys(slotsData)) {
      const info = slotsData[dateStr];
      if (info.status !== "Available" || !info.cells?.length) continue;
      for (const ts of info.cells) {
        const { dateKey, timeStr } = formatTimestamp(ts);
        const key = `${s.staffId}__${job.branch}__${dateKey}__${timeStr}`;
        if (!grouped[key]) {
          grouped[key] = {
            teacher: s.name,
            staffId: s.staffId,
            avatar: s.avatar,
            branch: job.branch,
            time: timeStr,
            dateKey,
            durations: [],
            isTrainee: s.isTrainee,
          };
        }
        if (!grouped[key].durations.includes(job.dur)) grouped[key].durations.push(job.dur);
      }
    }
  });

  Object.values(grouped).forEach(s => s.durations.sort((a, b) => b - a));
  return Object.values(grouped).sort((a, b) => {
    if (a.dateKey !== b.dateKey) return a.dateKey < b.dateKey ? -1 : 1;
    return a.time < b.time ? -1 : 1;
  });
}

// ── action=today ──────────────────────────────────────────────
async function handleToday(now) {
  const menuData = await getMenuData();
  if (!menuData) return { todayHasSlots: false, slots: [], staff: [] };

  const catalog = buildCatalog(menuData);
  const slots   = await fetchSlotsForStaffList(Object.values(catalog), now);

  const todayKey      = formatDateKey(now);
  const todayHasSlots = slots.some(s => s.dateKey === todayKey);
  return {
    todayHasSlots,
    slots,
    staff: rosterFromCatalog(catalog),
    fetchedAt: now.toISOString(),
  };
}

// ── action=staff（可用 staffId 或名字查）───────────────────────
async function handleStaff(staffKey, now) {
  const menuData = await getMenuData();
  if (!menuData) return { todayHasSlots: false, slots: [], staff: [] };

  const catalog = buildCatalog(menuData);
  const target  = catalog[staffKey] ||
    Object.values(catalog).find(s => s.name === (staffKey || "").trim());
  if (!target) return { todayHasSlots: false, slots: [], staff: rosterFromCatalog(catalog) };

  const slots = await fetchSlotsForStaffList([target], now);

  const todayKey      = formatDateKey(now);
  const todayHasSlots = slots.some(s => s.dateKey === todayKey);
  return {
    todayHasSlots,
    slots: slots.slice(0, 3),
    staff: rosterFromCatalog(catalog),
    fetchedAt: now.toISOString(),
  };
}

// ── Workers Cache API 包裝 ────────────────────────────────────
async function withCache(cacheKey, ttl, fn) {
  const cache    = caches.default;
  const cacheReq = new Request(`https://cache.internal/${cacheKey}`);

  const cached = await cache.match(cacheReq);
  if (cached) {
    try {
      const data = await cached.json();
      return jsonResp(data, ttl);
    } catch (e) { /* 快取損壞，重新抓 */ }
  }

  const data = await fn();
  await cache.put(cacheReq, jsonResp(data, ttl));
  return jsonResp(data, ttl);
}

// ── 主 handler ────────────────────────────────────────────────
export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const url    = new URL(request.url);
    const action = url.searchParams.get("action");
    const staff  = url.searchParams.get("staff"); // staffId 或 老師名字
    const now    = new Date();

    if (action === "ping") {
      return jsonResp({ status: "pong" });
    }

    if (action === "debug") {
      const report = { ts: now.toISOString(), steps: [] };
      let menuData = null;
      try {
        const res = await fetch(`${BOOKING_API_BASE}/bookings/menu/service?code=${BOOKING_CODE}`);
        menuData  = res.ok ? (await res.json()).data || null : null;
        report.steps.push({ step: "menu_api", httpCode: res.status, ok: res.ok });
      } catch (e) {
        report.steps.push({ step: "menu_api", error: String(e), ok: false });
      }
      if (!menuData) {
        report.conclusion = "FAIL: menu API 無回應";
        return jsonResp(report);
      }
      const catalog = buildCatalog(menuData);
      const roster  = rosterFromCatalog(catalog);
      const totalJobs = Object.values(catalog).reduce((a, s) => a + s.jobs.length, 0);
      report.steps.push({
        step: "catalog",
        staffCount: roster.length,
        totalJobs,
        subrequestBudget: `${totalJobs + 1}/50`,
        roster: roster.map(r => `${r.branch}|${r.name}${r.isTrainee ? "(培訓)" : ""}`),
        ok: roster.length > 0,
      });
      // 抽測第一位老師的第一個方案
      const first = Object.values(catalog)[0];
      if (first) {
        try {
          const r = await fetchSlots(first.jobs[0].productId, first.staffId, dayStart(now, 0), dayEnd(now, 14));
          const slotCount = Object.values(r).reduce((a, v) => a + (v.cells?.length ?? 0), 0);
          report.steps.push({ step: "slot_sample", staff: first.name, slotCount, ok: true });
        } catch (e) {
          report.steps.push({ step: "slot_sample", error: String(e), ok: false });
        }
      }
      const failed = report.steps.filter(s => !s.ok).map(s => s.step);
      report.conclusion = failed.length === 0 ? "ALL OK" : "FAIL at: " + failed.join(", ");
      return jsonResp(report);
    }

    if (action === "today") {
      const dateKey = formatDateKey(now);
      return withCache(`v2_today_${dateKey}`, CACHE_TTL, () => handleToday(now));
    }

    if (action === "staff" && staff) {
      const dateKey = formatDateKey(now);
      return withCache(`v2_staff_${encodeURIComponent(staff)}_${dateKey}`, CACHE_TTL, () => handleStaff(staff, now));
    }

    return jsonResp({ error: "unknown action" });
  },
};
