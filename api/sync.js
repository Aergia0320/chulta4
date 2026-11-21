// api/sync.js
const pad2 = (n) => String(n).padStart(2, "0");
const toYMD = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

function shiftYMD(ymd, delta) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return toYMD(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function unesc(v) {
  return String(v || "").replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim();
}

function parseDate(param, val) {
  val = String(val || "").trim();
  if (/VALUE=DATE/i.test(param || "") || /^\d{8}$/.test(val)) {
    const m = val.match(/^(\d{4})(\d{2})(\d{2})/);
    return m ? { ymd: toYMD(+m[1], +m[2], +m[3]), time: "", allDay: true } : null;
  }
  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  let [, y, mo, d, hh, mm] = m.map(Number);
  if (m[7]) {
    const dt = new Date(Date.UTC(y, mo - 1, d, hh + 9, mm));
    y = dt.getUTCFullYear(); mo = dt.getUTCMonth() + 1; d = dt.getUTCDate();
    hh = dt.getUTCHours(); mm = dt.getUTCMinutes();
  }
  return { ymd: toYMD(y, mo, d), time: `${pad2(hh)}:${pad2(mm)}`, allDay: false };
}

function parseICS(text) {
  const lines = String(text || "").replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") {
      if (cur && cur.start && cur.st !== "CANCELLED") {
        let s = cur.start.ymd, e = cur.end ? cur.end.ymd : s;
        let st = cur.start.allDay ? "" : cur.start.time;
        let et = cur.end && !cur.end.allDay ? cur.end.time : "";
        if (cur.start.allDay && cur.end && cur.end.allDay && e > s) e = shiftYMD(e, -1);
        else if (!cur.start.allDay && cur.end && et === "00:00" && e > s) { e = shiftYMD(e, -1); et = ""; }
        if (e < s) e = s;
        const raw = unesc(cur.summary || "일정");
        let title = raw, authorOverride = "";
        const tm = title.match(/^\[([^\]]{1,12})\]\s*(.*)$/);
        if (tm && !["출타","휴가","공유","가안","확정","알바","개인","외박","외출"].includes(tm[1].trim()) && tm[2].trim()) {
          authorOverride = tm[1].trim(); title = tm[2].trim();
        }
        const status = /(가안|미정|\(\?\)|조율)/.test(raw) ? "draft" : "confirmed";
        const kind = /(알바|대타|근무|약속|개인|회의|시험|과제|수업)/.test(raw) ? "work" : "outing";
        let subtype = kind === "outing" ? "기타 출타" : "기타";
        if (/정기/.test(raw)) subtype = "정기휴가";
        else if (/포상/.test(raw)) subtype = "포상휴가";
        else if (/(위로|청원|신병|보상)/.test(raw)) subtype = "위로/청원";
        else if (/외박/.test(raw)) subtype = "외박";
        else if (/외출/.test(raw)) subtype = "외출";
        else if (/알바/.test(raw)) subtype = "알바";
        else if (/대타/.test(raw)) subtype = "대타";
        else if (/약속/.test(raw)) subtype = "약속";
        const note = [cur.loc ? `장소: ${unesc(cur.loc)}` : "", unesc(cur.desc || "")].filter(Boolean).join("\n");
        events.push({ uid: cur.uid || `${s}_${raw}`, startDate: s, endDate: e, startTime: st, endTime: et, title, rawSummary: raw, authorOverride, kind, subtype, status, note });
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const ci = line.indexOf(":");
    if (ci < 0) continue;
    const left = line.slice(0, ci), val = line.slice(ci + 1);
    const si = left.indexOf(";");
    const prop = (si < 0 ? left : left.slice(0, si)).toUpperCase();
    const param = si < 0 ? "" : left.slice(si + 1);
    if (prop === "UID") cur.uid = val.trim();
    else if (prop === "SUMMARY") cur.summary = val;
    else if (prop === "DESCRIPTION") cur.desc = val;
    else if (prop === "LOCATION") cur.loc = val;
    else if (prop === "STATUS") cur.st = val.trim().toUpperCase();
    else if (prop === "DTSTART") cur.start = parseDate(param, val);
    else if (prop === "DTEND") cur.end = parseDate(param, val);
  }
  return events.sort((a, b) => a.startDate.localeCompare(b.startDate));
}

function sendJson(res, code, data) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

module.exports = async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

    const cleanEnv = (v) => String(v || "").trim().replace(/^["']|["']$/g, "");
    const gcalUrl = cleanEnv(process.env.GCAL_ICS_URL);
    const discordUrl = cleanEnv(process.env.DISCORD_WEBHOOK_URL);

    if (req.method === "GET") {
      const u = new URL(req.url || "/", "http://localhost");
      const fresh = u.searchParams.get("fresh") === "1";
      res.setHeader("Cache-Control", fresh ? "no-store" : "s-maxage=120, stale-while-revalidate=300");
      if (!gcalUrl) return sendJson(res, 200, { ok: true, gcalConfigured: false, discordConfigured: Boolean(discordUrl), events: [], fetchedAt: Date.now() });
      const resp = await fetch(gcalUrl, { headers: { "User-Agent": "chulta4/1.0" } });
      if (!resp.ok) return sendJson(res, 200, { ok: false, gcalConfigured: true, discordConfigured: Boolean(discordUrl), error: `Google 오류 (${resp.status})`, events: [], fetchedAt: Date.now() });
      const txt = await resp.text();
      if (!txt.includes("BEGIN:VCALENDAR")) return sendJson(res, 200, { ok: false, gcalConfigured: true, discordConfigured: Boolean(discordUrl), error: "유효한 .ics 주소가 아닙니다", events: [], fetchedAt: Date.now() });
      return sendJson(res, 200, { ok: true, gcalConfigured: true, discordConfigured: Boolean(discordUrl), events: parseICS(txt), fetchedAt: Date.now() });
    }

    if (req.method === "POST") {
      if (!discordUrl) return sendJson(res, 200, { ok: false, configured: false, error: "DISCORD_WEBHOOK_URL 미설정" });
      const body = await readBody(req);
      const action = String(body.action || "INFO").toUpperCase();
      const actor = String(body.actor || "익명").slice(0, 32);
      const summary = String(body.summary || "").slice(0, 300);
      const detail = String(body.detail || "").slice(0, 300);
      const targetDate = String(body.targetDate || "").slice(0, 20);
      const roomId = String(body.roomId || "main").slice(0, 32);
      const pageUrl = String(body.url || "").slice(0, 300);
      if (!summary) return sendJson(res, 400, { ok: false, error: "summary required" });

      const labels = { CREATE: "일정 등록", UPDATE: "일정 수정", DELETE: "일정 삭제", COMMENT: "새 댓글", RSVP: "참석 반응", DOODLE: "메모·낙서", TEST: "연동 테스트" };
      const colors = { CREATE: 0xFF6B00, UPDATE: 0x0EA5E9, DELETE: 0xEF4444, COMMENT: 0xA855F7, RSVP: 0x14B8A6, DOODLE: 0xF59E0B, TEST: 0x22C55E };
      const desc = [summary, detail ? `> ${detail}` : "", /^https?:\/\//i.test(pageUrl) ? `\n[chulta4 열기](${pageUrl})` : ""].filter(Boolean).join("\n");

      const resp = await fetch(discordUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "chulta4",
          embeds: [{ title: `[${labels[action] || action}] ${actor}`, description: desc, color: colors[action] || 0xFF6B00, footer: { text: `chulta4${roomId !== "main" ? ` (#${roomId})` : ""}${targetDate ? ` · ${targetDate}` : ""}` }, timestamp: new Date().toISOString() }]
        })
      });
      if (!resp.ok) return sendJson(res, 200, { ok: false, configured: true, error: `Discord 오류 (${resp.status})` });
      return sendJson(res, 200, { ok: true, configured: true });
    }

    return sendJson(res, 405, { ok: false, error: "Method not allowed" });
  } catch (err) {
    return sendJson(res, 200, { ok: false, error: String(err && err.message || err) });
  }
};
